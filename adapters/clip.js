/**
 * ClipAdapter — read and write the system clipboard via the active tab's
 * content script context (background SW has no clipboard access).
 *
 * Tools:
 *   clip.read()              → clipboard text content
 *   clip.write({text})       → "written"
 */

export const ClipAdapter = {
  async read()        { return sendToContent("read",  null); },
  async write(input)  { return sendToContent("write", input); },
};

// ---------------------------------------------------------------------------

async function sendToContent(method, input) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "bb_clip", method, input });
  } catch (e) {
    if (e.message?.includes("Could not establish connection")) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "bb_clip", method, input });
    } else {
      throw e;
    }
  }

  if (!response) throw new Error("no response from content script");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
