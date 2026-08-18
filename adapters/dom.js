/**
 * DomAdapter — bridges background service worker to content.js via
 * chrome.tabs.sendMessage. The content script does the actual DOM work.
 *
 * Every method accepts an optional `tabId` in the input to target a specific
 * tab (otherwise defaults to the active tab of the current window).
 *
 * Tools:
 *   dom.query({selector, tabId?})            → element info JSON | null
 *   dom.query_all({selector, limit?, tabId?})→ element array JSON
 *   dom.get_text({selector?, tabId?})        → innerText | full page text
 *   dom.get_html({selector?, outer?, tabId?})→ innerHTML / outerHTML
 *   dom.get_url({tabId?})                    → current URL string
 *   dom.get_title({tabId?})                  → page title string
 *   dom.click({selector, tabId?})            → "clicked"
 *   dom.fill({selector, value, tabId?})      → "filled"
 *   dom.scroll({selector?, x, y?, tabId?})   → "scrolled ..."
 *   dom.wait_for({selector, timeout_ms?, tabId?}) → element info JSON | error
 *   dom.snapshot({tabId?})                   → {title, url, headings, links, inputs}
 */

export const DomAdapter = {};

// Dynamically create method stubs for all dom tools — they all go through
// the same sendToContent bridge.
const DOM_METHODS = [
  "query", "query_all", "get_text", "get_html",
  "get_url", "get_title",
  "click", "click_text", "fill", "scroll",
  "wait_for", "snapshot", "eval",
];

for (const method of DOM_METHODS) {
  DomAdapter[method] = (input) => sendToContent(method, input);
}

// ---------------------------------------------------------------------------

async function sendToContent(method, rawInput) {
  const input = parseInput(rawInput);
  const targetTabId = input ? input.tabId : undefined;

  let tab;
  if (targetTabId != null) {
    tab = await chrome.tabs.get(targetTabId);
    if (!tab) throw new Error(`tab ${targetTabId} not found`);
    // Inject content script into the target tab if needed
    await ensureContentScript(tab.id);
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    if (!tab) throw new Error("no active tab");
    if (!tab.id) throw new Error("active tab has no id (chrome:// pages are not accessible)");
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type:   "bb_dom",
      method,
      input:  input ?? undefined,
    });
  } catch (e) {
    if (e.message?.includes("Could not establish connection")) {
      await ensureContentScript(tab.id);
      response = await chrome.tabs.sendMessage(tab.id, {
        type:   "bb_dom",
        method,
        input:  input ?? undefined,
      });
    } else {
      throw e;
    }
  }

  if (!response) throw new Error("no response from content script");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

async function ensureContentScript(tabId) {
  // Always re-inject so code changes on disk take effect without a full
  // extension reload. content.js is idempotent (see __bb_on_message guard).
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ["content.js"],
    });
  } catch (e) {
    // Fall back: maybe already present and page is chrome:// restricted
    try {
      await chrome.tabs.sendMessage(tabId, { type: "bb_ping" });
    } catch {
      throw e;
    }
  }
}

function parseInput(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}
