"""
BrowserBox WebSocket relay.

Sits between the browser extension and any agent/tool client.
The extension connects as "browser" role, agents connect as "agent" role.
Messages from either side are forwarded to the other.

Usage:
    pip install websockets
    python ws_relay.py [--port 9009] [--http-port 9010]

Wire protocol:
    First message after connect must be a role announcement:
        {"role": "browser"}   — from the extension
        {"role": "agent"}     — from any agent/tool client

    Subsequent messages are JSON tool calls or responses,
    forwarded verbatim between browser and agent, with two exceptions:

    Discovery request (agent → relay, NOT forwarded to browser):
        {"id": "<uuid>", "discover": true}
        → relay responds: {"id": "<uuid>", "result": <TOOL_SCHEMA>}

Schema endpoint:
    GET http://localhost:<http-port>/tools  →  TOOL_SCHEMA as JSON
    (http-port defaults to 9010; set --http-port 0 to disable)
"""
import asyncio
import json
import logging
import argparse
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("browserbox-relay")

# ---------------------------------------------------------------------------
# Tool schema — authoritative description of every adapter method.
# Kept here so both WS discovery and the HTTP endpoint serve the same data.
# ---------------------------------------------------------------------------

TOOL_SCHEMA = {
    "version": "0.1.0",
    "tools": [
        # ---- storage ----
        {
            "name": "storage.get",
            "description": "Read a value from chrome.storage.local (or .session if ns='session').",
            "input": {
                "oneOf": [
                    {"type": "string", "description": "Key name"},
                    {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string"},
                            "ns":  {"type": "string", "enum": ["local", "session"], "default": "local"},
                        },
                        "required": ["key"],
                    },
                ]
            },
            "returns": "Stored value, or null if not found.",
        },
        {
            "name": "storage.set",
            "description": "Write a value to chrome.storage.",
            "input": {
                "type": "object",
                "properties": {
                    "key":   {"type": "string"},
                    "value": {},
                    "ns":    {"type": "string", "enum": ["local", "session"], "default": "local"},
                },
                "required": ["key", "value"],
            },
            "returns": '"ok"',
        },
        {
            "name": "storage.delete",
            "description": "Delete a key from chrome.storage.",
            "input": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "ns":  {"type": "string", "enum": ["local", "session"], "default": "local"},
                },
                "required": ["key"],
            },
            "returns": '"ok"',
        },
        {
            "name": "storage.list",
            "description": "List all keys in chrome.storage.",
            "input": {
                "type": "object",
                "properties": {
                    "ns": {"type": "string", "enum": ["local", "session"], "default": "local"},
                },
            },
            "returns": "JSON array of key strings.",
        },
        {
            "name": "storage.get_cookie",
            "description": "Get a single cookie by name and URL.",
            "input": {
                "type": "object",
                "properties": {
                    "url":  {"type": "string"},
                    "name": {"type": "string"},
                },
                "required": ["url", "name"],
            },
            "returns": "Cookie object as JSON string, or null.",
        },
        {
            "name": "storage.list_cookies",
            "description": "List cookies (values omitted for safety). Optionally filter by URL.",
            "input": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                },
            },
            "returns": "JSON array of cookie objects (name, domain, path, secure, httpOnly, expirationDate).",
        },

        # ---- fetch ----
        {
            "name": "fetch.get",
            "description": "HTTP GET from the extension context. Carries session cookies for the origin. Response truncated at 512 KB.",
            "input": {
                "oneOf": [
                    {"type": "string", "description": "URL"},
                    {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
                ]
            },
            "returns": "Response body as text.",
        },
        {
            "name": "fetch.post",
            "description": "HTTP POST from the extension context.",
            "input": {
                "type": "object",
                "properties": {
                    "url":     {"type": "string"},
                    "body":    {"type": "string", "description": "Raw body string"},
                    "json":    {"description": "Will be JSON-serialized and Content-Type set automatically"},
                    "headers": {"type": "object"},
                },
                "required": ["url"],
            },
            "returns": 'JSON string: {"status": <int>, "body": <string>}',
        },
        {
            "name": "fetch.head",
            "description": "HTTP HEAD — returns response headers only.",
            "input": {
                "oneOf": [
                    {"type": "string", "description": "URL"},
                    {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
                ]
            },
            "returns": "JSON object of response headers.",
        },

        # ---- dom ----
        {
            "name": "dom.query",
            "description": "Find the first element matching a CSS selector in the active tab.",
            "input": {"type": "object", "properties": {"selector": {"type": "string"}}, "required": ["selector"]},
            "returns": "Element info JSON, or null if not found.",
        },
        {
            "name": "dom.query_all",
            "description": "Find all elements matching a CSS selector.",
            "input": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "limit":    {"type": "integer", "default": 50},
                },
                "required": ["selector"],
            },
            "returns": "JSON array of element info objects.",
        },
        {
            "name": "dom.get_text",
            "description": "Get innerText of a matched element, or the full page text if no selector.",
            "input": {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
            },
            "returns": "Text content string.",
        },
        {
            "name": "dom.get_html",
            "description": "Get innerHTML (or outerHTML) of a matched element, or full document HTML.",
            "input": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "outer":    {"type": "boolean", "default": False},
                },
            },
            "returns": "HTML string.",
        },
        {
            "name": "dom.get_url",
            "description": "Get the current tab URL.",
            "input": None,
            "returns": "URL string.",
        },
        {
            "name": "dom.get_title",
            "description": "Get the current page title.",
            "input": None,
            "returns": "Title string.",
        },
        {
            "name": "dom.click",
            "description": "Click an element matching the selector.",
            "input": {"type": "object", "properties": {"selector": {"type": "string"}}, "required": ["selector"]},
            "returns": '"clicked"',
        },
        {
            "name": "dom.fill",
            "description": "Set the value of an input element.",
            "input": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "value":    {"type": "string"},
                },
                "required": ["selector", "value"],
            },
            "returns": '"filled"',
        },
        {
            "name": "dom.scroll",
            "description": "Scroll to an element or to absolute coordinates.",
            "input": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "x":        {"type": "number"},
                    "y":        {"type": "number"},
                },
            },
            "returns": '"scrolled to <target>"',
        },
        {
            "name": "dom.wait_for",
            "description": "Wait for an element to appear in the DOM.",
            "input": {
                "type": "object",
                "properties": {
                    "selector":   {"type": "string"},
                    "timeout_ms": {"type": "integer", "default": 5000},
                },
                "required": ["selector"],
            },
            "returns": "Element info JSON when found, or error if timeout.",
        },
        {
            "name": "dom.snapshot",
            "description": "Return a lightweight structural snapshot of the active page: title, URL, headings, links, and form inputs.",
            "input": None,
            "returns": 'JSON string: {"title", "url", "headings": [], "links": [], "inputs": []}',
        },

        # ---- tabs ----
        {
            "name": "tabs.list",
            "description": "List all open tabs.",
            "input": None,
            "returns": "JSON array of {id, url, title, active, index}.",
        },
        {
            "name": "tabs.get_current",
            "description": "Get info about the currently active tab.",
            "input": None,
            "returns": "JSON string: {id, url, title, index}.",
        },
        {
            "name": "tabs.open",
            "description": "Open a new tab.",
            "input": {
                "type": "object",
                "properties": {
                    "url":        {"type": "string"},
                    "background": {"type": "boolean", "default": False},
                },
                "required": ["url"],
            },
            "returns": "JSON string: {id, url}.",
        },
        {
            "name": "tabs.close",
            "description": "Close a tab by id, or the active tab if no id given.",
            "input": {
                "type": "object",
                "properties": {"id": {"type": "integer"}},
            },
            "returns": '"closed"',
        },
        {
            "name": "tabs.switch",
            "description": "Switch focus to a tab by id.",
            "input": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]},
            "returns": '"switched"',
        },
        {
            "name": "tabs.screenshot",
            "description": "Capture a screenshot of the active tab as a data URL.",
            "input": {
                "type": "object",
                "properties": {
                    "format":  {"type": "string", "enum": ["jpeg", "png"], "default": "jpeg"},
                    "quality": {"type": "integer", "minimum": 0, "maximum": 100, "default": 60},
                },
            },
            "returns": 'Data URL string: "data:image/jpeg;base64,..."',
        },

        # ---- nav ----
        {
            "name": "nav.go",
            "description": "Navigate the active tab to a URL.",
            "input": {
                "oneOf": [
                    {"type": "string", "description": "URL"},
                    {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
                ]
            },
            "returns": '"navigated to <url>"',
        },
        {
            "name": "nav.back",
            "description": "Navigate back in the active tab's history.",
            "input": None,
            "returns": '"back"',
        },
        {
            "name": "nav.forward",
            "description": "Navigate forward in the active tab's history.",
            "input": None,
            "returns": '"forward"',
        },
        {
            "name": "nav.reload",
            "description": "Reload the active tab.",
            "input": {
                "type": "object",
                "properties": {
                    "bypass_cache": {"type": "boolean", "default": False},
                },
            },
            "returns": '"reloaded"',
        },

        # ---- clip ----
        {
            "name": "clip.read",
            "description": "Read the system clipboard text via the active tab's content script context.",
            "input": None,
            "returns": "Clipboard text string.",
        },
        {
            "name": "clip.write",
            "description": "Write text to the system clipboard.",
            "input": {
                "oneOf": [
                    {"type": "string"},
                    {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
                ]
            },
            "returns": '"written"',
        },

        # ---- network ----
        {
            "name": "network.start_capture",
            "description": "Monkey-patch fetch/XHR in the active tab to capture network traffic. Optional regex filter.",
            "input": {
                "type": "object",
                "properties": {
                    "url_pattern": {"type": "string", "description": "Regex to filter captured URLs"},
                },
            },
            "returns": '"capturing" or "capturing (filter: <pattern>)"',
        },
        {
            "name": "network.stop_capture",
            "description": "Stop capturing network traffic in the active tab.",
            "input": None,
            "returns": '"stopped"',
        },
        {
            "name": "network.get_captured",
            "description": "Retrieve captured network entries from the active tab.",
            "input": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 50},
                },
            },
            "returns": "JSON array of {ts, type, method, url, status, req_headers, res_headers, body_preview}.",
        },
        {
            "name": "network.clear",
            "description": "Clear captured network entries from the active tab.",
            "input": None,
            "returns": '"cleared"',
        },

        # ---- inject ----
        {
            "name": "inject.js",
            "description": "Execute JavaScript in the active tab's page context (MAIN world). Return value of last expression is returned.",
            "input": {
                "oneOf": [
                    {"type": "string", "description": "JS code string"},
                    {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]},
                ]
            },
            "returns": "JSON-encoded return value, or null.",
        },
        {
            "name": "inject.css",
            "description": "Inject CSS into the active tab.",
            "input": {
                "type": "object",
                "properties": {
                    "css": {"type": "string"},
                    "id":  {"type": "string", "description": "Optional id for later removal via inject.css_remove"},
                },
                "required": ["css"],
            },
            "returns": '"injected"',
        },
        {
            "name": "inject.css_remove",
            "description": "Remove previously injected CSS by id.",
            "input": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
            "returns": '"removed"',
        },

        # ---- pdf ----
        {
            "name": "pdf.extract",
            "description": "Fetch a PDF (authenticated via session cookies) and return base64-encoded bytes. Defaults to the current tab URL.",
            "input": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "PDF URL — defaults to active tab URL"},
                },
            },
            "returns": 'JSON string: {"filename", "bytes_b64", "size_bytes", "url"}',
        },
    ],
}


# ---------------------------------------------------------------------------
# Relay
# ---------------------------------------------------------------------------

class Relay:
    def __init__(self):
        self.browser = None   # single extension connection
        self.agents  = set()  # multiple agent connections allowed

    async def handle(self, ws):
        # First message must declare role
        try:
            raw  = await asyncio.wait_for(ws.recv(), timeout=10)
            msg  = json.loads(raw)
            role = msg.get("role")
        except Exception as e:
            log.warning("Bad handshake: %s", e)
            await ws.close()
            return

        if role == "browser":
            await self._handle_browser(ws)
        elif role == "agent":
            await self._handle_agent(ws)
        else:
            log.warning("Unknown role: %s", role)
            await ws.close()

    async def _handle_browser(self, ws):
        if self.browser is not None:
            log.warning("Second browser connection — replacing old one")
        self.browser = ws
        log.info("Browser extension connected")
        try:
            async for raw in ws:
                # Forward browser responses to all connected agents
                log.debug("browser → agents: %s", raw[:120])
                dead = set()
                for agent in self.agents:
                    try:
                        await agent.send(raw)
                    except Exception:
                        dead.add(agent)
                self.agents -= dead
        finally:
            self.browser = None
            log.info("Browser extension disconnected")

    async def _handle_agent(self, ws):
        self.agents.add(ws)
        log.info("Agent connected  (total agents: %d)", len(self.agents))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("Agent sent non-JSON: %s", raw[:80])
                    continue

                # Intercept discovery requests — respond directly, don't forward
                if msg.get("discover"):
                    call_id = msg.get("id")
                    log.debug("agent discovery request id=%s", call_id)
                    await ws.send(json.dumps({"id": call_id, "result": TOOL_SCHEMA}))
                    continue

                tool_name = msg.get("tool", "?")

                # Forward tool calls to the browser
                if self.browser is None:
                    log.warning("agent → [no browser] tool=%s  (extension not connected)", tool_name)
                    call_id = msg.get("id")
                    err = json.dumps({"id": call_id, "error": "browser not connected"})
                    await ws.send(err)
                else:
                    log.info("agent → browser: %s", tool_name)
                    try:
                        await self.browser.send(raw)
                    except Exception as e:
                        log.warning("send to browser failed for %s: %s", tool_name, e)
                        call_id = msg.get("id")
                        err = json.dumps({"id": call_id, "error": f"send to browser failed: {e}"})
                        await ws.send(err)
        finally:
            self.agents.discard(ws)
            log.info("Agent disconnected  (total agents: %d)", len(self.agents))


# ---------------------------------------------------------------------------
# HTTP schema / status endpoint (asyncio raw server — no extra dependencies)
# ---------------------------------------------------------------------------

_SCHEMA_BYTES = json.dumps(TOOL_SCHEMA, indent=2).encode()
_HTTP_404 = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


def _json_response(body: dict) -> bytes:
    payload = json.dumps(body).encode()
    return (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: application/json\r\n"
        b"Access-Control-Allow-Origin: *\r\n"
        + f"Content-Length: {len(payload)}\r\n".encode()
        + b"Connection: close\r\n\r\n"
        + payload
    )


def _make_http_handler(relay: "Relay"):
    _schema_resp = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: application/json\r\n"
        b"Access-Control-Allow-Origin: *\r\n"
        + f"Content-Length: {len(_SCHEMA_BYTES)}\r\n".encode()
        + b"Connection: close\r\n\r\n"
        + _SCHEMA_BYTES
    )

    async def _http_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            data = await asyncio.wait_for(reader.read(1024), timeout=5)
            line = data.decode(errors="replace").split("\r\n")[0]
            parts = line.split(" ")
            method = parts[0] if parts else ""
            path   = parts[1] if len(parts) > 1 else ""
            if method == "GET":
                if path == "/tools":
                    writer.write(_schema_resp)
                elif path == "/ping":
                    writer.write(_json_response({"pong": True}))
                elif path == "/status":
                    writer.write(_json_response({
                        "relay": "ok",
                        "browser_connected": relay.browser is not None,
                        "agent_count": len(relay.agents),
                    }))
                else:
                    writer.write(_HTTP_404)
            else:
                writer.write(_HTTP_404)
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    return _http_handler


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main(ws_port: int, http_port: int, host: str) -> None:
    relay = Relay()
    log.info("BrowserBox WS relay listening on ws://%s:%d", host, ws_port)
    ws_server = websockets.serve(relay.handle, host, ws_port)

    tasks = [asyncio.ensure_future(ws_server.__aenter__())]

    if http_port:
        http_handler = _make_http_handler(relay)
        http_server = await asyncio.start_server(http_handler, host, http_port)
        log.info(
            "BrowserBox HTTP endpoints at http://%s:%d  (GET /tools  /ping  /status)",
            host, http_port,
        )
        tasks.append(asyncio.ensure_future(http_server.serve_forever()))

    await asyncio.Future()  # run forever


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",      type=int, default=9009,        help="WebSocket relay port (default: 9009)")
    parser.add_argument("--http-port", type=int, default=9010,        help="HTTP schema port (default: 9010, 0 to disable)")
    parser.add_argument("--host",      default="localhost",            help="Bind address (default: localhost; use 0.0.0.0 to accept Docker/LAN connections)")
    args = parser.parse_args()
    asyncio.run(main(args.port, args.http_port, args.host))
