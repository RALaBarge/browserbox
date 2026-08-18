/**
 * TabsAdapter — manage browser tabs and capture screenshots.
 *
* Tools:
 *   tabs.list()                              → array of tab info objects
 *   tabs.windows()                           → array of {id, focused, state, type, incognito, tabs: [...]}
 *   tabs.focus_window({id})                  → "window focused"
 *   tabs.get_current()                       → {id, url, title, index, ...}
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

  async windows() {
    const windows = await chrome.windows.getAll({ populate: true });
    return JSON.stringify(windows.map(w => ({
      id:        w.id,
      focused:   w.focused,
      state:     w.state,       // "normal", "minimized", "maximized", "fullscreen"
      type:      w.type,        // "normal", "popup", "panel", "devtools"
      incognito: w.incognito,
      tabs:      (w.tabs || []).map(tabInfo),
    })));
  },

  async focus_window(input) {
    const params = parse(input);
    if (!params.id) throw new Error("focus_window requires {id}");
    await chrome.windows.update(params.id, { focused: true });
    return "window focused";
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
  return {
    id:           t.id,
    url:          t.url,
    title:        t.title,
    active:       t.active,
    index:        t.index,
    windowId:     t.windowId,
    status:       t.status,        // "loading" | "complete"
    pinned:       t.pinned,
    audible:      t.audible,
    discarded:    t.discarded,
    groupId:      t.groupId,
    favIconUrl:   t.favIconUrl || null,
    lastAccessed: t.lastAccessed,
    mutedInfo:    t.mutedInfo ? { muted: t.mutedInfo.muted, reason: t.mutedInfo.reason || null } : null,
  };
}

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return { url: input }; }
  }
  return input;
}
