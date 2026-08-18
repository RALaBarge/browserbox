/**
 * InjectAdapter — run JavaScript or inject CSS into the active tab.
 *
 * JS runs in the page's MAIN world (full access to page globals, no extension
 * APIs). Return value of the last expression is sent back as the result.
 * CSS is injected persistently until the page navigates or inject.css_remove is called.
 *
 * Tools:
 *   inject.js({code})                     → return value of last expression (JSON)
 *   inject.js({code, all_frames: true})   → [{frameId, url, result}] for every frame
 *   inject.js({code, frame: "<substr>"})  → result from the first frame whose URL
 *                                           contains <substr> (needed for Zendesk
 *                                           app iframes like *.apps.zdusercontent.com,
 *                                           which are cross-origin from the agent page)
 *   inject.css({css, id?})          → "injected" (id for later removal)
 *   inject.css_remove({id})         → "removed"
 *
 * Frame support note (added 2026-07-29): Zendesk apps run in cross-origin
 * iframes, so top-frame injection can't see them. allFrames needs no extra
 * permission (scripting + <all_urls> host perms cover it).
 */

// Track injected CSS keys so we can remove them
const _cssKeys = new Map();   // id → injectionKey (unused in MV3 removeCSS which uses same params)

export const InjectAdapter = {

  async js(input) {
    const params = parse(input);
    const code = params.code ?? (typeof input === "string" ? input : null);
    if (!code) throw new Error("js requires {code}");
    const frameFilter = params.frame ? String(params.frame) : null;
    const allFrames = !!(params.all_frames || frameFilter);

    let tab;
    if (params.tabId != null) {
      tab = await chrome.tabs.get(params.tabId);
      if (!tab) throw new Error(`tab ${params.tabId} not found`);
    } else {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = t;
    }
    if (!tab?.id) throw new Error("no tab");

    const target = allFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id };

    // Try MAIN world first (needed for DOM access), fall back to ISOLATED.
    // eval() in MAIN is blocked by strict script-src CSP on some pages.
    // When framing, wrap the value with the frame's own location.href —
    // InjectionResult.url is NOT populated by Chrome, so the frame filter
    // must match on what the code itself reports.
    const fn = allFrames
      ? (userCode) => {
          try {
            return { href: location.href,
                     value: eval(`(function() { ${userCode} })()`) };
          } catch (e) {
            throw new Error(e.message || String(e));
          }
        }
      : (userCode) => {
          try {
            return eval(`(function() { ${userCode} })()`);
          } catch (e) {
            throw new Error(e.message || String(e));
          }
        };
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target, world: "MAIN", func: fn, args: [code],
      });
    } catch (_) {
      results = await chrome.scripting.executeScript({
        target, world: "ISOLATED", func: fn, args: [code],
      });
    }

    const rows = (results || []).map((r) => {
      const res = r.result;
      const wrapped = allFrames && res && typeof res === "object" &&
                      "href" in res;
      return {
        frameId: r.frameId,
        url: wrapped ? String(res.href || "") : String(r.url || ""),
        result: wrapped ? (res.value === undefined ? null : res.value)
                        : (res === undefined ? null : res),
        error: r.error ? String(r.error) : null,
      };
    });

    if (frameFilter) {
      const hit = rows.find((r) => r.url.includes(frameFilter));
      if (!hit) {
        throw new Error(`no frame matching '${frameFilter}' — frames: ` +
          rows.map((r) => r.url.slice(0, 80)).join(" | "));
      }
      return serialize(hit.result);
    }
    if (allFrames) return JSON.stringify(rows);

    const val = results?.[0]?.result;
    if (val === undefined || val === null) return null;
    return serialize(val);
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

function serialize(val) {
  if (val === undefined || val === null) return null;
  try { return JSON.stringify(val); } catch { return String(val); }
}

function parse(input) {
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return { code: input }; }
  }
  return input || {};
}
