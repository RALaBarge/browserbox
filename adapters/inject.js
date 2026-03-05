/**
 * InjectAdapter — run JavaScript or inject CSS into the active tab.
 *
 * JS runs in the page's MAIN world (full access to page globals, no extension
 * APIs). Return value of the last expression is sent back as the result.
 * CSS is injected persistently until the page navigates or inject.css_remove is called.
 *
 * Tools:
 *   inject.js({code})               → return value of last expression (JSON)
 *   inject.css({css, id?})          → "injected" (id for later removal)
 *   inject.css_remove({id})         → "removed"
 */

// Track injected CSS keys so we can remove them
const _cssKeys = new Map();   // id → injectionKey (unused in MV3 removeCSS which uses same params)

export const InjectAdapter = {

  async js(input) {
    const params = parse(input);
    const code = params.code ?? (typeof input === "string" ? input : null);
    if (!code) throw new Error("js requires {code}");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");

    // Wrap in an async IIFE so top-level await works and we capture the return
    const wrapped = `(async () => { ${code} })()`;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      func:   new Function("__code", "return eval(__code)"),
      args:   [wrapped],
    });

    const val = results?.[0]?.result;
    if (val === undefined || val === null) return null;
    try { return JSON.stringify(val); } catch { return String(val); }
  },

  async css(input) {
    const params = parse(input);
    const css = params.css ?? (typeof input === "string" ? input : null);
    if (!css) throw new Error("css requires {css}");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");

    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      css,
    });

    if (params.id) _cssKeys.set(params.id, { tabId: tab.id, css });
    return "injected";
  },

  async css_remove(input) {
    const params = parse(input);
    if (!params.id) throw new Error("css_remove requires {id}");

    const entry = _cssKeys.get(params.id);
    if (!entry) throw new Error(`no injected CSS with id: ${params.id}`);

    await chrome.scripting.removeCSS({
      target: { tabId: entry.tabId },
      css:    entry.css,
    });
    _cssKeys.delete(params.id);
    return "removed";
  },
};

// ---------------------------------------------------------------------------

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return { code: input }; }
  }
  return input;
}
