/**
 * BrowserBox content script — injected into every page.
 *
 * Listens for DOM tool calls from the background service worker
 * (sent via chrome.tabs.sendMessage) and executes them against the live DOM.
 *
 * Message format in:
 *   { type: "bb_dom", method: "query"|"query_all"|..., input: "..." }
 *
 * Returns a result string or throws (background converts throw → error response).
 */

const MAX_ELEMENTS = 50;   // cap on query_all results
const MAX_HTML_BYTES = 64 * 1024;  // 64 KB — prevent flooding context window

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "bb_dom") {
    (async () => {
      try {
        sendResponse({ ok: true, result: await dispatch(msg.method, msg.input) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "bb_clip") {
    (async () => {
      try {
        sendResponse({ ok: true, result: await clipDispatch(msg.method, msg.input) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function clipDispatch(method, input) {
  switch (method) {
    case "read":  return navigator.clipboard.readText();
    case "write": {
      const text = typeof input === "string"
        ? (() => { try { return JSON.parse(input).text; } catch { return input; } })()
        : (input?.text ?? "");
      await navigator.clipboard.writeText(text);
      return "written";
    }
    default: throw new Error(`unknown clip method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(method, input) {
  switch (method) {
    case "query":      return domQuery(input);
    case "query_all":  return domQueryAll(input);
    case "get_text":   return domGetText(input);
    case "get_html":   return domGetHtml(input);
    case "get_url":    return location.href;
    case "get_title":  return document.title;
    case "click":      return domClick(input);
    case "fill":       return domFill(input);
    case "scroll":     return domScroll(input);
    case "wait_for":   return domWaitFor(input);
    case "snapshot":   return domSnapshot();
    default:
      throw new Error(`unknown dom method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseInput(input) {
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return { selector: input }; }
  }
  return input || {};
}

function elementInfo(el) {
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  return {
    tag:       el.tagName.toLowerCase(),
    id:        el.id || undefined,
    className: el.className || undefined,
    text:      el.innerText?.trim().slice(0, 500) || undefined,
    value:     el.value ?? undefined,
    href:      el.href || undefined,
    src:       el.src || undefined,
    attrs,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function domQuery(input) {
  const { selector } = parseInput(input);
  if (!selector) throw new Error("query requires a CSS selector");
  const el = document.querySelector(selector);
  if (!el) return null;
  return JSON.stringify(elementInfo(el));
}

function domQueryAll(input) {
  const { selector, limit } = parseInput(input);
  if (!selector) throw new Error("query_all requires a CSS selector");
  const els = Array.from(document.querySelectorAll(selector))
    .slice(0, Math.min(limit ?? MAX_ELEMENTS, MAX_ELEMENTS));
  return JSON.stringify(els.map(elementInfo));
}

function domGetText(input) {
  const { selector } = parseInput(input);
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    return el.innerText?.trim() ?? null;
  }
  // No selector = full page text
  return document.body.innerText?.trim().slice(0, MAX_HTML_BYTES) ?? null;
}

function domGetHtml(input) {
  const { selector, outer } = parseInput(input);
  let html;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    html = outer ? el.outerHTML : el.innerHTML;
  } else {
    html = document.documentElement.outerHTML;
  }
  if (html.length > MAX_HTML_BYTES) {
    return html.slice(0, MAX_HTML_BYTES) + "\n<!-- truncated -->";
  }
  return html;
}

function domClick(input) {
  const { selector } = parseInput(input);
  if (!selector) throw new Error("click requires a CSS selector");
  const el = document.querySelector(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  el.click();
  return "clicked";
}

function domFill(input) {
  const params = parseInput(input);
  const { selector, value } = params;
  if (!selector) throw new Error("fill requires {selector, value}");
  const el = document.querySelector(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  el.focus();
  el.value = value ?? "";
  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "filled";
}

function domScroll(input) {
  const params = parseInput(input);
  if (params.selector) {
    const el = document.querySelector(params.selector);
    if (!el) throw new Error(`element not found: ${params.selector}`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return "scrolled to element";
  }
  const x = params.x ?? 0;
  const y = params.y ?? 0;
  window.scrollTo({ top: y, left: x, behavior: "smooth" });
  return `scrolled to (${x}, ${y})`;
}

function domWaitFor(input) {
  const { selector, timeout_ms } = parseInput(input);
  if (!selector) throw new Error("wait_for requires a CSS selector");
  const limit = Math.min(timeout_ms ?? 5000, 15000);

  return new Promise((resolve, reject) => {
    // Already present?
    if (document.querySelector(selector)) {
      return resolve(JSON.stringify(elementInfo(document.querySelector(selector))));
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(JSON.stringify(elementInfo(el)));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`wait_for: element not found within ${limit}ms: ${selector}`));
    }, limit);
  });
}

function domSnapshot() {
  // Compact summary of the visible page structure — useful for LLM orientation
  const title = document.title;
  const url   = location.href;

  const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
    .slice(0, 20)
    .map(h => `${"#".repeat(parseInt(h.tagName[1]))} ${h.innerText.trim()}`)
    .join("\n");

  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 30)
    .map(a => `[${a.innerText.trim().slice(0, 60)}](${a.href})`)
    .join("\n");

  const inputs = Array.from(document.querySelectorAll("input,textarea,select,button"))
    .slice(0, 20)
    .map(el => {
      const label = el.labels?.[0]?.innerText || el.placeholder || el.name || el.id || el.type;
      return `<${el.tagName.toLowerCase()} ${label ? `label="${label}"` : ""} selector="${cssSelector(el)}">`;
    })
    .join("\n");

  return JSON.stringify({ title, url, headings, links, inputs });
}

/** Best-effort unique CSS selector for an element */
function cssSelector(el) {
  if (el.id) return `#${el.id}`;
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) { seg = `#${cur.id}`; parts.unshift(seg); break; }
    if (cur.className) seg += "." + [...cur.classList].slice(0, 2).join(".");
    const siblings = cur.parentElement
      ? Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName)
      : [];
    if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}
