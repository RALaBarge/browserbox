/**
 * DomAdapter — bridges background service worker to content.js via
 * chrome.tabs.sendMessage. The content script does the actual DOM work.
 *
 * Tools:
 *   dom.query({selector})                    → element info JSON | null
 *   dom.query_all({selector, limit?})        → element array JSON
 *   dom.get_text({selector?})                → innerText | full page text
 *   dom.get_html({selector?, outer?})        → innerHTML / outerHTML
 *   dom.get_url()                            → current URL string
 *   dom.get_title()                          → page title string
 *   dom.click({selector})                    → "clicked"
 *   dom.fill({selector, value})              → "filled"
 *   dom.scroll({selector?} | {x, y})        → "scrolled ..."
 *   dom.wait_for({selector, timeout_ms?})    → element info JSON | error
 *   dom.snapshot()                           → {title, url, headings, links, inputs}
 */

export const DomAdapter = {};

// Dynamically create method stubs for all dom tools — they all go through
// the same sendToContent bridge.
const DOM_METHODS = [
  "query", "query_all", "get_text", "get_html",
  "get_url", "get_title",
  "click", "fill", "scroll",
  "wait_for", "snapshot",
];

for (const method of DOM_METHODS) {
  DomAdapter[method] = (input) => sendToContent(method, input);
}

// ---------------------------------------------------------------------------

async function sendToContent(method, input) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error("no active tab");
  if (!tab.id) throw new Error("active tab has no id (chrome:// pages are not accessible)");

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type:   "bb_dom",
      method,
      input,
    });
  } catch (e) {
    // Content script not yet injected — inject it on demand and retry once
    if (e.message?.includes("Could not establish connection")) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files:  ["content.js"],
      });
      response = await chrome.tabs.sendMessage(tab.id, {
        type:   "bb_dom",
        method,
        input,
      });
    } else {
      throw e;
    }
  }

  if (!response) throw new Error("no response from content script");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
