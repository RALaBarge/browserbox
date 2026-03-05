/**
 * FetchAdapter — makes fetch requests from the extension's background context.
 *
 * Key property: requests carry the browser's real session cookies for the
 * matching origin, bypassing CORS restrictions that would apply in a web page.
 *
 * Tools:
 *   fetch.get(url)                                → response body (text)
 *   fetch.post({url, body, headers?, json?})      → {status, body}
 *   fetch.head(url)                               → headers object
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB — prevent context window flooding

export const FetchAdapter = {

  async get(input) {
    const url = typeof input === "string" ? input.trim() : input.url;
    if (!url) throw new Error("fetch.get requires a URL string");

    const resp = await timedFetch(url, { method: "GET" });
    const text = await readBody(resp);
    return text;
  },

  async post(input) {
    const params = typeof input === "string" ? JSON.parse(input) : input;
    if (!params.url) throw new Error("fetch.post requires {url, body}");

    const headers = params.headers || {};
    let body = params.body ?? "";

    // Convenience: if json key provided, serialize and set Content-Type
    if (params.json !== undefined) {
      body = JSON.stringify(params.json);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    const resp = await timedFetch(params.url, {
      method: "POST",
      headers,
      body,
    });

    const text = await readBody(resp);
    return JSON.stringify({ status: resp.status, body: text });
  },

  async head(input) {
    const url = typeof input === "string" ? input.trim() : input.url;
    if (!url) throw new Error("fetch.head requires a URL string");

    const resp = await timedFetch(url, { method: "HEAD" });
    const headers = {};
    resp.headers.forEach((value, key) => { headers[key] = value; });
    return JSON.stringify(headers);
  },
};

// ---------------------------------------------------------------------------

async function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`fetch timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(resp) {
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      reader.cancel();
      // Return what we have with a truncation notice
      const partial = new TextDecoder().decode(concat(chunks));
      return partial + `\n\n[truncated — response exceeded ${MAX_BODY_BYTES} bytes]`;
    }
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
