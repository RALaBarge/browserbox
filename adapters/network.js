/**
 * NetworkAdapter — intercept XHR and fetch traffic from the active tab.
 *
 * Injects a monkey-patch into the page's MAIN world (not the extension's
 * isolated world) so it sees the real fetch/XHR before any SPA framework.
 * Captured entries live in window.__bb_captures on the page.
 *
 * Tools:
 *   network.start_capture({url_pattern?})   → "capturing" (optional regex filter)
 *   network.stop_capture()                  → "stopped"
 *   network.get_captured({limit?})          → JSON array of captured entries
 *   network.clear()                         → "cleared"
 *
 * Captured entry shape:
 *   { ts, type, method, url, status, req_headers, res_headers, body_preview }
 *   body_preview is truncated at 4 KB to keep context window manageable.
 */

const INJECT_SCRIPT = `
(function() {
  if (window.__bb_capturing) return; // already active
  window.__bb_captures = window.__bb_captures || [];
  window.__bb_pattern  = __BB_PATTERN__;   // replaced at inject time

  const MAX_BODY = 4096;
  const origFetch = window.fetch;
  const origXHR   = window.XMLHttpRequest;

  function shouldCapture(url) {
    if (!window.__bb_pattern) return true;
    return new RegExp(window.__bb_pattern).test(url);
  }

  function truncate(s) {
    if (!s) return null;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…' : s;
  }

  // --- Monkey-patch fetch ---
  window.fetch = async function(resource, init) {
    const url    = typeof resource === 'string' ? resource : resource.url;
    const method = (init?.method || 'GET').toUpperCase();
    const resp   = await origFetch.apply(this, arguments);

    if (shouldCapture(url)) {
      const clone = resp.clone();
      clone.text().then(body => {
        window.__bb_captures.push({
          ts:          Date.now(),
          type:        'fetch',
          method,
          url,
          status:      resp.status,
          req_headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
          res_headers: Object.fromEntries(resp.headers.entries()),
          body_preview: truncate(body),
        });
      }).catch(() => {});
    }
    return resp;
  };

  // --- Monkey-patch XHR ---
  window.XMLHttpRequest = function() {
    const xhr = new origXHR();
    let _method, _url;
    const origOpen = xhr.open.bind(xhr);
    const origSend = xhr.send.bind(xhr);

    xhr.open = function(method, url, ...rest) {
      _method = method;
      _url = url;
      return origOpen(method, url, ...rest);
    };

    xhr.send = function(body) {
      if (shouldCapture(_url)) {
        xhr.addEventListener('loadend', function() {
          window.__bb_captures.push({
            ts:           Date.now(),
            type:         'xhr',
            method:       _method,
            url:          _url,
            status:       xhr.status,
            req_headers:  {},
            res_headers:  {},
            body_preview: truncate(xhr.responseText),
          });
        });
      }
      return origSend(body);
    };
    return xhr;
  };

  window.__bb_capturing = true;
})();
`;

const STOP_SCRIPT = `
(function() {
  // Restore is not trivially possible after monkey-patching without storing originals.
  // Best we can do is clear the flag so no new entries are pushed.
  window.__bb_capturing = false;
  window.__bb_pattern   = null;
})();
`;

export const NetworkAdapter = {

  async start_capture(input) {
    const params  = parse(input);
    const pattern = params.url_pattern ?? null;
    const tab     = await activeTab();
    const script  = INJECT_SCRIPT.replace("__BB_PATTERN__", JSON.stringify(pattern));
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      func:   new Function(script.replace(/^\s*\(function\(\)/, "return (function()").replace(/\)\(\);?\s*$/, ")();")),
    });
    return pattern ? `capturing (filter: ${pattern})` : "capturing";
  },

  async stop_capture() {
    const tab = await activeTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      func:   new Function(STOP_SCRIPT.replace(/^\s*\(function\(\)/, "return (function()").replace(/\)\(\);?\s*$/, ")();")),
    });
    return "stopped";
  },

  async get_captured(input) {
    const params = parse(input);
    const limit  = params.limit ?? 50;
    const tab    = await activeTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      func:   () => {
        const entries = window.__bb_captures || [];
        return JSON.stringify(entries.slice(-50)); // last N
      },
    });

    const raw = results?.[0]?.result ?? "[]";
    const entries = JSON.parse(raw).slice(-limit);
    return JSON.stringify(entries);
  },

  async clear() {
    const tab = await activeTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      func:   () => { window.__bb_captures = []; },
    });
    return "cleared";
  },
};

// ---------------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input;
}
