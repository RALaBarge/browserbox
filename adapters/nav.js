/**
 * NavAdapter — navigate the active tab.
 *
 * Tools:
 *   nav.go({url})      → "navigated to <url>"
 *   nav.back()         → "back"
 *   nav.forward()      → "forward"
 *   nav.reload()       → "reloaded"
 */

export const NavAdapter = {

  async go(input) {
    const params = parse(input);
    const url = params.url ?? (typeof input === "string" ? input.trim() : null);
    if (!url) throw new Error("go requires a URL");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    await chrome.tabs.update(tab.id, { url });
    return `navigated to ${url}`;
  },

  async back() {
    await chrome.tabs.goBack();
    return "back";
  },

  async forward() {
    await chrome.tabs.goForward();
    return "forward";
  },

  async reload(input) {
    const params = parse(input);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    await chrome.tabs.reload(tab.id, { bypassCache: params.bypass_cache ?? false });
    return "reloaded";
  },
};

// ---------------------------------------------------------------------------

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input;
}
