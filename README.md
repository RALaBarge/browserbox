# BrowserBox

**v1.0** — Chrome extension + WebSocket relay that exposes browser APIs to local LLM agents.

Agents call tools like `dom.snapshot`, `tabs.screenshot`, `nav.go`, and `fetch.get` — the extension executes them against the live browser and returns results. Requests carry real session cookies, so authenticated pages work without re-login.

---

## Architecture

```
Agent / BeigeBox operator
        │
        │ WebSocket (ws://localhost:9009)
        ▼
  ws_relay.py  ◄──── GET /tools (http://localhost:9010/tools)
        │
        │ WebSocket
        ▼
  background.js (Chrome extension service worker)
        │
        ├── adapters/storage.js
        ├── adapters/fetch.js
        ├── adapters/dom.js       ◄── chrome.tabs.sendMessage ──► content.js
        ├── adapters/tabs.js
        ├── adapters/nav.js
        ├── adapters/clip.js      ◄── content script clipboard bridge
        ├── adapters/network.js   ◄── MAIN world monkey-patch
        ├── adapters/inject.js
        └── adapters/pdf.js
```

The relay is a pure forwarder. One browser extension, multiple agents.

---

## Setup

**1. Start the relay**

```bash
pip install websockets
python ws_relay.py
# WebSocket on ws://localhost:9009
# Schema endpoint on http://localhost:9010/tools
```

Options:
```
--port       WebSocket port (default: 9009)
--http-port  Schema HTTP port (default: 9010, set 0 to disable)
```

**2. Load the extension**

- Open `chrome://extensions`
- Enable Developer mode
- Load unpacked → select the `browserbox/` directory
- The popup should show **connected** once the relay is running

> **Note:** The `browserbox/` directory must not contain a `__pycache__` folder — Chrome will refuse to load the extension if any filename starts with `_`. Run the relay and client from outside the `browserbox/` directory (e.g. `python3 -c "import sys; sys.path.insert(0, 'browserbox'); ..."`) to avoid generating one there.

---

## Tool Reference

All tools follow the `namespace.method` naming convention.

| Namespace | Methods | Description |
|---|---|---|
| `dom` | `snapshot`, `query`, `query_all`, `get_text`, `get_html`, `get_url`, `get_title`, `click`, `fill`, `scroll`, `wait_for` | DOM inspection and interaction on the active tab |
| `tabs` | `list`, `get_current`, `open`, `close`, `switch`, `screenshot` | Tab management; screenshot returns a data URL |
| `nav` | `go`, `back`, `forward`, `reload` | Navigate the active tab |
| `fetch` | `get`, `post`, `head` | HTTP requests from the extension context (carries session cookies, bypasses CORS) |
| `storage` | `get`, `set`, `delete`, `list`, `get_cookie`, `list_cookies` | chrome.storage.local/session and cookies |
| `clip` | `read`, `write` | System clipboard via content script — requires Chrome window to have focus |
| `network` | `start_capture`, `stop_capture`, `get_captured`, `clear` | Intercept fetch/XHR traffic in the active tab |
| `inject` | `js`, `css`, `css_remove` | Execute JS or inject CSS into the active tab; `inject.js` requires the page to allow `unsafe-eval` — returns null silently on strict `script-src` CSP pages |
| `pdf` | `extract` | Fetch a PDF with session cookies, returns base64 bytes |

Full input/output schema: `GET http://localhost:9010/tools`

---

## Python Agent Client

```python
import asyncio, json
from client import BrowserBoxClient

async def main():
    async with BrowserBoxClient() as bb:
        # Discover all tools
        schema = await bb.discover()

        # Get a structural snapshot of the active page
        snap = json.loads(await bb.call("dom.snapshot"))
        print(snap["url"], snap["title"])

        # Navigate and scrape
        await bb.call("nav.go", {"url": "https://example.com"})
        text = await bb.call("dom.get_text")

        # Concurrent calls
        url, title = await asyncio.gather(
            bb.call("dom.get_url"),
            bb.call("dom.get_title"),
        )

asyncio.run(main())
```

`BrowserBoxClient` manages the WebSocket lifecycle, assigns UUIDs per call, and resolves concurrent calls independently. Default timeout is 30s, overridable per call.

---

## Schema Discovery

Two ways to get the full tool schema:

**WebSocket** (inside an agent session):
```python
schema = await bb.discover()   # {"version": "0.1.0", "tools": [...]}
```

**HTTP** (external tooling, beigebox integration, etc.):
```bash
curl http://localhost:9010/tools | jq '.tools[].name'
```

---

## BeigeBox Integration

BeigeBox's operator agent can use BrowserBox as a tool. Enable in `config.yaml`:

```yaml
tools:
  enabled: true
  browserbox:
    enabled: true
    ws_url: ws://localhost:9009
    timeout: 10
```

The operator calls it with JSON: `{"tool": "dom.snapshot", "input": ""}`.
`pdf.extract` results are automatically saved to `workspace/in/` for the `pdf_reader` tool.

---

## Known Limitations

- **`inject.js`** — executes code via `eval()` in the page's MAIN world. Pages with a strict `script-src` CSP that blocks `unsafe-eval` will silently return `null`. Works on most internal tools, SPAs, and admin panels. Use `dom.*` tools for read-only DOM access on public sites.
- **`clip.read` / `clip.write`** — the browser's Clipboard API requires the Chrome window to have focus. Works when a human is at the keyboard; will fail when Chrome is backgrounded.

---

## Wire Protocol

```
# Handshake (first message after connect)
→ {"role": "agent"}

# Tool call
→ {"id": "<uuid>", "tool": "dom.snapshot", "input": ""}

# Success response
← {"id": "<uuid>", "result": "{\"title\": ..., \"url\": ...}"}

# Error response
← {"id": "<uuid>", "error": "no active tab"}

# Schema discovery (relay intercepts, does not forward to browser)
→ {"id": "<uuid>", "discover": true}
← {"id": "<uuid>", "result": {"version": "0.1.0", "tools": [...]}}
```
