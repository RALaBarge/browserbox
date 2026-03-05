async function refresh() {
  const { bb_state } = await chrome.storage.session.get("bb_state");
  const s = bb_state || { connected: false, callCount: 0, lastTool: null, lastError: null };

  const dot    = document.getElementById("dot");
  const status = document.getElementById("status");
  dot.className    = "dot " + (s.connected ? "connected" : "disconnected");
  status.className = "status-text " + (s.connected ? "connected" : "disconnected");
  status.textContent = s.connected ? "connected" : "disconnected";

  document.getElementById("count").textContent = s.callCount ?? 0;
  document.getElementById("last-tool").textContent = s.lastTool ?? "—";

  const errRow = document.getElementById("error-row");
  if (s.lastError) {
    errRow.style.display = "block";
    document.getElementById("last-error").textContent = s.lastError;
  } else {
    errRow.style.display = "none";
  }
}

refresh();
setInterval(refresh, 1000);
