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
 *
 * Re-injectable: removes prior __bb_on_message listener so code updates take
 * effect without a full extension reload.
 */

(() => {
  if (globalThis.__bb_on_message) {
    try { chrome.runtime.onMessage.removeListener(globalThis.__bb_on_message); } catch (_) {}
  }

  const MAX_ELEMENTS = 50;
  const MAX_HTML_BYTES = 64 * 1024;

  const __bb_on_message = (msg, _sender, sendResponse) => {
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

    if (msg.type === "bb_ping") {
      sendResponse({ ok: true, result: "pong", v: globalThis.__bb_content_v });
      return true;
    }

    return false;
  };

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

  async function dispatch(method, input) {
    switch (method) {
      case "query":      return domQuery(input);
      case "query_all":  return domQueryAll(input);
      case "get_text":   return domGetText(input);
      case "get_html":   return domGetHtml(input);
      case "get_url":    return location.href;
      case "get_title":  return document.title;
      case "click":      return domClick(input);
      case "click_text": return domClickText(input);
      case "fill":       return domFill(input);
      case "scroll":     return domScroll(input);
      case "wait_for":   return domWaitFor(input);
      case "snapshot":   return domSnapshot();
      case "eval":       return domEval(input);
      default:
        throw new Error(`unknown dom method: ${method}`);
    }
  }

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

  function domClickText(input) {
    const params = parseInput(input);
    const want = (params.text || params.label || "").replace(/\s+/g, " ").trim();
    if (!want) throw new Error("click_text requires {text}");
    const exact = params.exact !== false;
    const re = params.regex ? new RegExp(params.regex, params.flags || "i") : null;
    const excludeTestId = params.exclude_testid || params.excludeTestId || null;
    const preferLast = params.last === true || params.index === -1;
    const index = typeof params.index === "number" ? params.index : null;
    const nodes = [
      ...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
    ];
    const norm = (el) =>
      (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
    let matches = nodes.filter((el) => {
      if (excludeTestId && el.getAttribute("data-testid") === excludeTestId) return false;
      const t = norm(el);
      if (re) return re.test(t);
      if (exact) return t === want;
      return t.includes(want);
    });
    if (!matches.length) {
      const sample = nodes.map(norm).filter(Boolean).slice(0, 25).join("|");
      throw new Error(`click_text: no match for "${want}" buttons=${sample}`);
    }
    let hit;
    if (index != null && index >= 0 && index < matches.length) hit = matches[index];
    else if (preferLast) hit = matches[matches.length - 1];
    else hit = matches[0];
    hit.click();
    return "clicked:" + norm(hit).slice(0, 80);
  }

  function domFill(input) {
    const params = parseInput(input);
    const { selector, value } = params;
    if (!selector) throw new Error("fill requires {selector, value}");
    const el = document.querySelector(selector);
    if (!el) throw new Error(`element not found: ${selector}`);
    el.focus();
    if (el.isContentEditable) return fillContentEditable(el, value ?? "");
    if (el.tagName === "SELECT") {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
      if (value != null) {
        if (desc && desc.set) desc.set.call(el, String(value));
        else el.value = String(value);
      }
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "filled:select=" + el.value;
    }
    const isTa = el.tagName === "TEXTAREA";
    const proto = isTa ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (value != null) {
      if (desc && desc.set) desc.set.call(el, String(value));
      else el.value = String(value);
    }
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "filled";
  }

  // Fill a contenteditable rich-text editor (Draft.js, ProseMirror, …).
  // Selects all existing content, then replaces it via a synthetic paste
  // (Draft.js handles paste), falling back to execCommand/textContent.
  function fillContentEditable(el, value) {
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const read = () => (el.textContent || "").replace(/\s+/g, " ").trim();
    const wantNorm = String(value).replace(/\s+/g, " ").trim();

    // 1) synthetic paste over select-all (Draft.js path)
    try {
      selectAll();
      const dt = new DataTransfer();
      dt.setData("text/plain", String(value));
      const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
      el.dispatchEvent(ev);
    } catch (_) { /* continue to fallback */ }
    if (read() === wantNorm) return "filled:contenteditable:paste";

    // 2) execCommand insertText over select-all
    try {
      selectAll();
      document.execCommand("insertText", false, String(value));
    } catch (_) { /* continue */ }
    if (read() === wantNorm) return "filled:contenteditable:execCommand";

    // 3) last resort: raw textContent + input event (may not sync framework state)
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    return read() === wantNorm
      ? "filled:contenteditable:textContent(unsynced-framework-state-possible)"
      : "fill-failed:contenteditable:got=" + read().slice(0, 120);
  }

  function domEval(input) {
    const params = parseInput(input);
    const code = params.code ?? (typeof input === "string" ? input : null);
    if (!code) throw new Error("eval requires {code}");
    // Content-script isolated world — DOM yes, page globals no.
    // Prefer over inject.js on CSP-strict sites (Stripe Dashboard).
    const val = eval(`(function(){ ${code} })()`);
    if (val === undefined || val === null) return null;
    if (typeof val === "string") return val;
    try { return JSON.stringify(val); } catch { return String(val); }
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

  function domSnapshot() {
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
      .slice(0, 40)
      .map(el => {
        const label = el.labels?.[0]?.innerText || el.placeholder || el.name || el.id || el.type || (el.innerText || "").trim().slice(0, 40);
        return `<${el.tagName.toLowerCase()} ${label ? `label="${label}"` : ""} selector="${cssSelector(el)}">`;
      })
      .join("\n");

    return JSON.stringify({ title, url, headings, links, inputs });
  }

  globalThis.__bb_on_message = __bb_on_message;
  chrome.runtime.onMessage.addListener(__bb_on_message);
  globalThis.__bb_content_v = 4;
})();
