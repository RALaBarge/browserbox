# BrowserBox

**v1.2.3** — Chrome extension + WebSocket relay that exposes browser APIs to local LLM agents.

Agents call tools like dom.snapshot, tabs.screenshot, nav.go, and fetch.get — the extension executes them against the live browser and returns results. Requests carry real session cookies, so authenticated pages work without re-login.

---

## Architecture

```
Agent / BeigeBox operator
        │
        │ WebSocket (ws://localhost:9009)
        ▼
  ws_relay.py  ◄──── GET /tools (http://localhost:9010/tools)
                     ◄──── GET /status (http://localhost:9010/status)
        │
        │ WebSocket
        ▼
  background.js (Chrome extension service worker)
        │
        ├── adapters/storage.js
        ├── adapters/fetch.js    ← HTTP with session cookies + CORS bypass
        ├── adapters/dom.js      ← chrome.tabs.sendMessage → content.js
        ├── adapters/tabs.js     ← Tab management + screenshots
        ├── adapters/nav.js      ← Navigation (go, back, forward, reload)
        ├── adapters/clip.js     ← Content script clipboard bridge
        ├── adapters/network.js  ← MAIN world monkey-patch
        ├── adapters/inject.js   ← JS/CSS injection in page context
        └── adapters/pdf.js      ← Authenticated PDF fetching
```

The relay is a pure forwarder. One browser extension, multiple agents.

---

## Setup

**1. Start relay**

```bash
pip install websockets
python ws_relay.py
# WebSocket: ws://localhost:9009
# HTTP schema: http://localhost:9010/tools
# HTTP status: http://localhost:9010/status
```

Options:
```
--port       WebSocket port (default: 9009)
--http-port  Schema port (default: 9010, set 0 to disable)
--host       Bind address (default: localhost; use 0.0.0.0 for LAN/Docker)
```

**2. Load the extension**

- Open `chrome://extensions`
- Enable Developer mode
- Load unpacked → select the `browserbox/` directory
- The popup shows "connected" once the relay is running

> **Note**: The `browserbox/` directory must not contain a `__pycache__` folder — Chrome refuses to load extensions if any filename starts with `_`. Run the relay and client from outside the `browserbox/` directory to avoid generating one there (`python3 -c "import sys; sys.path.insert(0, 'browserbox'); ..."`).

---

## Tool Reference (v1.2.3)

All tools follow the `namespace.method` naming convention.

| Namespace | Methods | Description |
|---|---|---|
| `dom` | `snapshot`, `query`, `query_all`, `get_text`, `get_html`, `get_url`, `get_title`, `click`, `fill`, `scroll`, `wait_for`, `click_text`, `eval` | DOM inspection and interaction — accepts optional `tabId` parameter to target any tab |
| `tabs` | `list`, `get_current`, `open`, `close`, `switch`, `screenshot`, `windows`, `focus_window` | Tab management; `windows()` lists all windows with tabs; `focus_window({id})` focuses a window; `screenshot` returns JPEG data URL |
| `nav` | `go`, `back`, `forward`, `reload` | Navigate the active tab |
| `fetch` | `get`, `post`, `put`, `patch`, `delete`, `head` | HTTP requests from extension context — carries real browser session cookies, bypasses CORS. PUT/PATCH/DELETE added in v1.2.3 |
| `storage` | `get`, `set`, `delete`, `list`, `get_cookie`, `list_cookies` | chrome.storage.local/session and cookies |
| `clip` | `read`, `write` | System clipboard via content script — requires Chrome window to have focus |
| `network` | `start_capture`, `stop_capture`, `get_captured`, `clear` | Intercept fetch/XHR traffic in active tab — accepts optional `url_pattern` regex filter |
| `inject` | `js`, `css`, `css_remove` | Execute JS or inject CSS into active tab; `inject.js` returns `null` on strict CSP pages |
| `pdf` | `extract` | Fetch a PDF (authenticated via session cookies), returns base64 bytes |

Full input/output schema: `GET http://localhost:9010/tools`

---

## Python Agent Client

```python
from client import BrowserBoxClient
import asyncio, json

async def main():
    async with BrowserBoxClient() as bb:
        # Discover all tools
        schema = await bb.discover()

        # Get page snapshot — can target any tab by ID
        snap = json.loads(await bb.call("dom.snapshot", {"tabId": 123}))
        print(snap["url"], snap["title"])

        # Background tab operations
        await bb.call("dom.fill", {"tabId": 123, "selector": "input", "value": "test"})
        await bb.call("dom.click_text", {"text": "Login", "exact": False})

        # New HTTP methods
        await bb.call("fetch.put", {"url": "/api/data", "json": {"key": "val"}})
        await bb.call("fetch.patch", {"url": "/api/data", "body": "..."})
        await bb.call("fetch.delete", {"url": "/api/data"})

        # Window management
        await bb.call("tabs.windows")       # List all windows with tabs
        await bb.call("tabs.focus_window", {"id": 2})  # Focus window

        # Concurrent calls
        url, title = await asyncio.gather(
            bb.call("dom.get_url"),
            bb.call("dom.get_title"),
        )

asyncio.run(main())
```

`BrowserBoxClient` manages the WebSocket lifecycle, assigns UUIDs per call, and resolves concurrent calls independently. Default timeout is 30s, overridable per call. Includes `sys.dont_write_bytecode = True` to prevent `__pycache__` in extension dir.

---

## HTTP Endpoints

| Endpoint | Method | Response | Description |
|---|---|---|---|
| `/tools` | GET | Tool schema JSON | Full API specification |
| `/status` | GET | JSON | **v1.2.3**: Real-time relay status `{"relay": "ok", "browser_connected": true, "agent_count": 2}` |
| `/ping` | GET | `{"pong": true}` | Health check |

---

## Popup Dashboard

The extension popup provides a live dashboard:
- Connection status to WebSocket relay
- Browser extension connection status
- Live agent count
- Total call counter
- Last 10 call log with success/failure
- Last error indicator
- Manual refresh button
- Reconnect button

---

## Wire Protocol

### Connection
- **Agent → Relay**: `{"role": "agent"}`
- **Browser → Relay**: `{"role": "browser"}`

### Tool Call
```
→ {"id": "<uuid>", "tool": "dom.snapshot", "input": null}
← {"id": "<uuid>", "result": "{\"title\": ..., \"url\": ...}"}
```

### Error Response
```
← {"id": "<uuid>", "error": "no active tab"}
```

### Schema Discovery
```
→ {"id": "<uuid>", "discover": true}
← {"id": "<uuid>", "result": {"version": "0.1.0", "tools": [...]}}
```

### Keepalive
Extension sends ping every 20s: `{"type": "ping"}`
Relay discards these — they just keep the service worker alive.

---

## Known Limitations

1. **`inject.js`** — Returns `null` on pages with strict CSP blocking `unsafe-eval`
2. **`clip.read`/`clip.write`** — Requires Chrome window to have focus
3. **DOM tools** — Only work on active (focused) tab unless `tabId` parameter provided
4. **Service worker** — MV3 workers can be suspended after ~30s inactivity

---

## Version

`4542665` — All sources aligned with `github.com/ralabarge/browserbox`:
- `tabId` parameter in all DOM tools (`adapters/dom.js`)
- `fetch.put/patch/delete` in `ws_relay.py` schema
- `tabs.windows()` / `tabs.focus_window()` in `adapters/tabs.js`
- `dom.click_text()` in `content.js`
- `sys.dont_write_bytecode` in `client.py` + `ws_relay.py`
- Re-injectable content script (`__bb_on_message` guard in content.js)
- HTTP `/status` endpoint
