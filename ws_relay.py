"""
BrowserBox WebSocket relay.

Sits between the browser extension and any agent/tool client.
The extension connects as "browser" role, agents connect as "agent" role.
Messages from either side are forwarded to the other.

Usage:
    pip install websockets
    python ws_relay.py [--port 9009]

Wire protocol:
    First message after connect must be a role announcement:
        {"role": "browser"}   — from the extension
        {"role": "agent"}     — from any agent/tool client

    Subsequent messages are JSON tool calls or responses,
    forwarded verbatim between browser and agent.
"""
import asyncio
import json
import logging
import argparse
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("browserbox-relay")


class Relay:
    def __init__(self):
        self.browser = None   # single extension connection
        self.agents = set()   # multiple agent connections allowed

    async def handle(self, ws):
        # First message must declare role
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
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
                # Forward agent tool calls to the browser
                log.debug("agent → browser: %s", raw[:120])
                if self.browser is None:
                    err = json.dumps({"id": None, "error": "browser not connected"})
                    try:
                        # Try to parse id from message for proper error
                        mid = json.loads(raw).get("id")
                        err = json.dumps({"id": mid, "error": "browser not connected"})
                    except Exception:
                        pass
                    await ws.send(err)
                else:
                    try:
                        await self.browser.send(raw)
                    except Exception as e:
                        err = json.dumps({"id": None, "error": f"send to browser failed: {e}"})
                        await ws.send(err)
        finally:
            self.agents.discard(ws)
            log.info("Agent disconnected  (total agents: %d)", len(self.agents))


async def main(port: int):
    relay = Relay()
    log.info("BrowserBox relay listening on ws://localhost:%d", port)
    async with websockets.serve(relay.handle, "localhost", port):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9009)
    args = parser.parse_args()
    asyncio.run(main(args.port))
