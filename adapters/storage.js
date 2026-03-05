/**
 * StorageAdapter — exposes chrome.storage.local, chrome.storage.session,
 * and chrome.cookies via the BrowserBox tool API.
 *
 * All methods are async and return a result value or throw on error.
 *
 * Tools:
 *   storage.get(key)                          → value | null
 *   storage.set({key, value, ns?})            → "ok"
 *   storage.delete({key, ns?})                → "ok"
 *   storage.list({ns?})                       → string[] of keys
 *   storage.get_cookie({name, url})           → cookie object | null
 *   storage.list_cookies({url?})              → cookie[]
 */

export const StorageAdapter = {

  async get(input) {
    const { key, ns } = parseInput(input);
    const store = resolveStore(ns);
    return new Promise((resolve, reject) => {
      store.get(key, (result) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        resolve(result[key] ?? null);
      });
    });
  },

  async set(input) {
    const { key, value, ns } = typeof input === "string" ? JSON.parse(input) : input;
    if (!key) throw new Error("set requires {key, value}");
    const store = resolveStore(ns);
    return new Promise((resolve, reject) => {
      store.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        resolve("ok");
      });
    });
  },

  async delete(input) {
    const { key, ns } = parseInput(input);
    const store = resolveStore(ns);
    return new Promise((resolve, reject) => {
      store.remove(key, () => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        resolve("ok");
      });
    });
  },

  async list(input) {
    const { ns } = typeof input === "string" ? { ns: input } : (input || {});
    const store = resolveStore(ns);
    return new Promise((resolve, reject) => {
      store.get(null, (items) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        resolve(JSON.stringify(Object.keys(items)));
      });
    });
  },

  async get_cookie(input) {
    const params = typeof input === "string" ? JSON.parse(input) : input;
    if (!params.url || !params.name) throw new Error("get_cookie requires {url, name}");
    return new Promise((resolve, reject) => {
      chrome.cookies.get({ url: params.url, name: params.name }, (cookie) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        resolve(cookie ? JSON.stringify(cookie) : null);
      });
    });
  },

  async list_cookies(input) {
    const params = typeof input === "string" ? JSON.parse(input) : (input || {});
    const details = params.url ? { url: params.url } : {};
    return new Promise((resolve, reject) => {
      chrome.cookies.getAll(details, (cookies) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        // Strip out sensitive value field unless explicitly requested
        const safe = cookies.map(c => ({
          name: c.name, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
        }));
        resolve(JSON.stringify(safe));
      });
    });
  },
};

// ---------------------------------------------------------------------------

function resolveStore(ns) {
  if (ns === "session") return chrome.storage.session;
  return chrome.storage.local; // default
}

function parseInput(input) {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return { key: input };
    }
  }
  return input || {};
}
