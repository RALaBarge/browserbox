const STATUS_URL = "http://localhost:9010/status";

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function setDot(id, cls) {
  const el = document.getElementById(id);
  el.className = "dot " + cls;
}

function setText(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls || "";
}

async function pingRelay() {
  try {
    const resp = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function refresh() {
  // 1. Ping relay directly
  const relayStatus = await pingRelay();
  const relayUp = relayStatus !== null;

  setDot("relay-dot", relayUp ? "ok" : "err");
  setText("relay-status", relayUp ? "running" : "not running", relayUp ? "ok" : "err");
  document.getElementById("relay-notice").style.display = relayUp ? "none" : "block";

  if (relayUp) {
    const extConnected = relayStatus.browser_connected;
    setDot("ext-dot", extConnected ? "ok" : "warn");
    setText("ext-status", extConnected ? "connected" : "not connected", extConnected ? "ok" : "warn");
    document.getElementById("agent-count").textContent = relayStatus.agent_count ?? "—";
  } else {
    setDot("ext-dot", "err");
    setText("ext-status", "—");
    document.getElementById("agent-count").textContent = "—";
  }

  // 2. Extension state (call history, error, etc.)
  const { bb_state } = await chrome.storage.session.get("bb_state");
  const s = bb_state || { connected: false, callCount: 0, lastTool: null, lastError: null, callLog: [] };

  document.getElementById("count").textContent = s.callCount ?? 0;
  document.getElementById("last-tool").textContent = s.lastTool ?? "—";

  const errRow = document.getElementById("error-row");
  if (s.lastError) {
    errRow.style.display = "block";
    document.getElementById("last-error").textContent = s.lastError;
  } else {
    errRow.style.display = "none";
  }

  // 3. Call log
  const logEl = document.getElementById("call-log");
  const log = s.callLog || [];
  if (log.length === 0) {
    logEl.innerHTML = "";
  } else {
    logEl.innerHTML = log.map(e => `
      <div class="log-entry">
        <span class="log-tool" title="${e.tool}">${e.tool}</span>
        <span class="${e.ok ? "log-ok" : "log-err"}">${e.ok ? "✓" : "✗"}</span>
        <span class="log-ts">${timeSince(e.ts)}</span>
      </div>`).join("");
  }
}

async function reconnect() {
  try {
    await chrome.runtime.sendMessage({ action: "reconnect" });
  } catch (e) {
    console.warn("reconnect message failed:", e);
  }
  // Wait a moment then refresh to show updated state
  setTimeout(refresh, 600);
}

refresh();
setInterval(refresh, 1500);
