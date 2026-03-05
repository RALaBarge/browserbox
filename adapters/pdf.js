/**
 * PdfAdapter — fetch the current tab as a PDF and return base64 bytes.
 *
 * The background context carries session cookies, so authenticated PDFs
 * (behind a login) are fetched correctly.
 *
 * The BeigeBox tool shim (browserbox.py) detects pdf.extract responses and
 * saves the bytes to workspace/in/ so the pdf_reader tool can process them.
 *
 * Tools:
 *   pdf.extract({url?})    → {filename, bytes_b64, size_bytes}
 *                            url defaults to current tab URL
 */

const MAX_PDF_BYTES = 50 * 1024 * 1024;  // 50 MB sanity cap

export const PdfAdapter = {

  async extract(input) {
    const params = parse(input);

    // Resolve URL — explicit param or active tab
    let url = params.url;
    if (!url) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) throw new Error("no active tab URL");
      url = tab.url;
    }

    // Fetch via background context (carries session cookies)
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) {
      // Warn but don't block — user may know what they're doing
      console.warn(`[BrowserBox] pdf.extract: content-type is '${contentType}', not PDF`);
    }

    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) {
      throw new Error(`PDF too large: ${buf.byteLength} bytes (limit ${MAX_PDF_BYTES})`);
    }

    // Base64 encode
    const bytes = new Uint8Array(buf);
    let binary  = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const bytes_b64 = btoa(binary);

    // Derive filename from URL
    const filename = url.split("/").pop()?.split("?")[0] || "document.pdf";

    return JSON.stringify({
      filename,
      bytes_b64,
      size_bytes: buf.byteLength,
      url,
    });
  },
};

// ---------------------------------------------------------------------------

function parse(input) {
  if (!input) return {};
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input;
}
