/**
 * BrowserBox — background service worker
 *
 * Connects to the local ws_relay.py as the "browser" role.
 * Receives tool calls from agents via the relay, dispatches them to adapters,
 * and sends responses back through the relay.
 *
 * Message format (both directions):
 *   { "id": "string", "tool": "namespace.method", "input": "..." }  — call
 *   { "id": "string", "result": "..." }                              — success
 *   { "id": "string", "error": "..." }                               — failure
 */

import { StorageAdapter }  from "./adapters/storage.js";
import { FetchAdapter }    from "./adapters/fetch.js";
import { DomAdapter }      from "./adapters/dom.js";
import { TabsAdapter }     from "./adapters/tabs.js";
import { NavAdapter }      from "./adapters/nav.js";
import { ClipAdapter }     from "./adapters/clip.js";
import { NetworkAdapter }  from "./adapters/network.js";
import { InjectAdapter }   from "./adapters/inject.js";
import { PdfAdapter }      from "./adapters/pdf.js";

const RELAY_URL    = "ws://localhost:9009";
const RECONNECT_MS = 3000;

const ADAPTERS = {
  storage: StorageAdapter,
  fetch:   FetchAdapter,
  dom:     DomAdapter,
  tabs:    TabsAdapter,
  nav:     NavAdapter,
  clip:    ClipAdapter,
  network: NetworkAdapter,
  inject:  InjectAdapter,
  pdf:     PdfAdapter,
};

// Shared state visible to popup via chrome.storage.session
const state = {
  connected: false,
  callCount: 0,
  lastTool: null,
  lastError: null,
};

async function saveState() {
  await chrome.storage.session.set({ bb_state: state });
}

// ---------------------------------------------------------------------------
// WebSocket connection + reconnect loop
// ---------------------------------------------------------------------------

let ws = null;

function connect() {
  ws = new WebSocket(RELAY_URL);

  ws.addEventListener("open", async () => {
    console.log("[BrowserBox] connected to relay");
    ws.send(JSON.stringify({ role: "browser" }));
    state.connected = true;
    state.lastError = null;
    await saveState();
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn("[BrowserBox] non-JSON message ignored:", event.data);
      return;
    }
    const response = await dispatch(msg);
    ws.send(JSON.stringify(response));
  });

  ws.addEventListener("close", async () => {
    console.log("[BrowserBox] relay disconnected — reconnecting in", RECONNECT_MS, "ms");
    state.connected = false;
    await saveState();
    setTimeout(connect, RECONNECT_MS);
  });

  ws.addEventListener("error", async (e) => {
    state.lastError = "relay connection error";
    await saveState();
  });
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatch(msg) {
  const { id, tool, input } = msg;
  if (!tool) return { id, error: "missing 'tool' field" };

  const dot = tool.indexOf(".");
  if (dot === -1) return { id, error: `tool must be namespace.method, got: ${tool}` };

  const ns     = tool.slice(0, dot);
  const method = tool.slice(dot + 1);
  const adapter = ADAPTERS[ns];

  if (!adapter) return { id, error: `unknown namespace '${ns}' — available: ${Object.keys(ADAPTERS).join(", ")}` };
  if (typeof adapter[method] !== "function") {
    return { id, error: `unknown method '${method}' on namespace '${ns}'` };
  }

  try {
    const result = await adapter[method](input);
    state.callCount++;
    state.lastTool = tool;
    await saveState();
    return { id, result: result ?? null };
  } catch (e) {
    state.lastError = `${tool}: ${e.message}`;
    await saveState();
    return { id, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connect();
