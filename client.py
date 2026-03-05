"""
BrowserBox Python agent client.

Connects to ws_relay.py as an agent and provides an async API for
calling browser tools and discovering the tool schema.

Quick start:
    import asyncio, json
    from client import BrowserBoxClient

    async def main():
        async with BrowserBoxClient() as bb:
            schema = await bb.discover()
            snap   = await bb.call("dom.snapshot")
            print(json.loads(snap))

    asyncio.run(main())

Tool naming: "namespace.method" — e.g. "dom.snapshot", "tabs.list", "nav.go"
See discover() or GET http://localhost:9010/tools for the full schema.
"""

import asyncio
import json
import uuid
from typing import Any

import websockets

DEFAULT_URL     = "ws://localhost:9009"
DEFAULT_TIMEOUT = 30.0


class BrowserBoxError(Exception):
    """Raised when the browser extension returns a tool error."""


class BrowserBoxClient:
    """
    Async client for the BrowserBox WebSocket relay.

    Usage — context manager (recommended):
        async with BrowserBoxClient() as bb:
            result = await bb.call("dom.snapshot")

    Usage — manual lifecycle:
        bb = BrowserBoxClient()
        await bb.connect()
        try:
            result = await bb.call("tabs.list")
        finally:
            await bb.close()

    Multiple concurrent calls are safe — each gets its own UUID and
    is resolved independently when the response arrives.
    """

    def __init__(self, url: str = DEFAULT_URL, timeout: float = DEFAULT_TIMEOUT):
        self._url     = url
        self._timeout = timeout
        self._ws:        websockets.WebSocketClientProtocol | None = None
        self._pending:   dict[str, asyncio.Future]                 = {}
        self._recv_task: asyncio.Task | None                       = None

    # ------------------------------------------------------------------
    # Context manager

    async def __aenter__(self) -> "BrowserBoxClient":
        await self.connect()
        return self

    async def __aexit__(self, *_) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Connection lifecycle

    async def connect(self) -> None:
        """Open the WebSocket connection and register as an agent."""
        self._ws = await websockets.connect(self._url)
        await self._ws.send(json.dumps({"role": "agent"}))
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def close(self) -> None:
        """Close the connection and cancel the receive loop."""
        if self._recv_task:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
            self._recv_task = None
        if self._ws:
            await self._ws.close()
            self._ws = None

    # ------------------------------------------------------------------
    # Public API

    async def call(
        self,
        tool: str,
        input: Any = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        """
        Call a browser tool and return its result.

        Args:
            tool:    "namespace.method"  e.g. "dom.snapshot", "nav.go"
            input:   dict, string, or None passed as the tool input
            timeout: per-call timeout in seconds (overrides default)

        Returns:
            Tool result — a string or JSON-encoded string depending on adapter.
            Call json.loads() if you expect structured data.

        Raises:
            BrowserBoxError:  browser returned a tool error
            TimeoutError:     no response within timeout
            ConnectionError:  relay disconnected mid-call
        """
        return await self._send({"tool": tool, "input": input}, timeout=timeout)

    async def discover(self, *, timeout: float = 5.0) -> dict:
        """
        Return the relay's tool schema via WebSocket discovery.

        Sends {"discover": true} to the relay. The relay intercepts this
        and responds directly with the schema — the browser extension is
        not involved.

        Returns:
            dict with "version" and "tools" keys.
        """
        return await self._send({"discover": True}, timeout=timeout)

    # ------------------------------------------------------------------
    # Internals

    async def _send(self, payload: dict, *, timeout: float | None = None) -> Any:
        if self._ws is None:
            raise ConnectionError("not connected — call connect() or use as async context manager")

        call_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = fut

        await self._ws.send(json.dumps({"id": call_id, **payload}))

        t = timeout if timeout is not None else self._timeout
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=t)
        except asyncio.TimeoutError:
            self._pending.pop(call_id, None)
            label = payload.get("tool", "discover")
            raise TimeoutError(f"'{label}' timed out after {t}s")

    async def _recv_loop(self) -> None:
        """Background task — routes incoming messages to waiting futures."""
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                call_id = msg.get("id")
                fut = self._pending.pop(call_id, None) if call_id else None
                if fut is None or fut.done():
                    continue

                if "error" in msg:
                    fut.set_exception(BrowserBoxError(msg["error"]))
                else:
                    fut.set_result(msg.get("result"))

        except Exception:
            # Fail all in-flight calls on any disconnect or error
            exc = ConnectionError("BrowserBox relay disconnected")
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(exc)
            self._pending.clear()
