/**
 * TabsAdapter — manage browser tabs and capture screenshots.
 *
 * Tools:
 *   tabs.list()                              → array of {id, url, title, active, index}
 *   tabs.get_current()                       → {id, url, title, index}
 *   tabs.open({url, background?})            → {id, url}
 *   tabs.close({id?})                        → "closed"  (defaults to active tab)
 *   tabs.switch({id})                        → "switched"
 *   tabs.screenshot({quality?, format?})     → data URL (jpeg default, quality 0-100)
 */

export const TabsAdapter = {

  async list() {
    const tabs = await chrome.tabs.query({});
    return JSON.stringify(tabs.map(tabInfo));
  },

  async get_current() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    return JSON.stringify(tabInfo(tab));
  },

  async open(input) {
    const params = parse(input);
    if (!params.url) throw new Error("open requires {url}");
    const tab = await chrome.tabs.create({
      url:    params.url,
      active: params.background ? false : true,
    });
    return JSON.stringify(tabInfo(tab));
  },

  async close(input) {
    const params = parse(input);
    let id = params.id;
    if (!id) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("no active tab to close");
      id = tab.id;
    }
    await chrome.tabs.remove(id);
    return "closed";
  },

  async switch(input) {
    const params = parse(input);
    if (!params.id) throw new Error("switch requires {id}");
    await chrome.tabs.update(params.id, { active: true });
    return "switched";
  },

  async screenshot(input) {
    const params = parse(input);
    const format  = params.format  ?? "jpeg";
    const quality = params.quality ?? 60;    // default lower quality to keep size sane

    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format, quality });
    return dataUrl;  // "data:image/jpeg;base64,..."
  },
};

// ---------------------------------------------------------------------------

function tabInfo(t) {
  return { id: t.id, url: t.url, title: t.title, active: t.active, index: t.index };
}

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return { url: input }; }
  }
  return input;
}
