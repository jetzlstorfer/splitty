import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadReceiptScanner, receiptScannerReady, scanReceipt } from "./receiptOcr";
import { RECEIPT_ASSET_PATH, RECEIPT_CACHE, receiptAssets } from "./receiptAssets";

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const files = new Map<string, Response>();
  const match = vi.fn(async (url: string) => files.get(url));
  const put = vi.fn(async (url: string, response: Response) => { files.set(url, response); });
  const open = vi.fn(async () => ({ match, put }));
  vi.stubGlobal("caches", { open });
  return { files, open, put };
}

describe("optional offline OCR assets", () => {
  it("downloads only same-origin static assets and reuses a complete cache", async () => {
    const { open, files } = storage();
    const fetch = vi.fn(async () => new Response("asset", { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await receiptScannerReady()).toBe(false);
    const progress = vi.fn();
    await downloadReceiptScanner(new AbortController().signal, progress);
    expect(open).toHaveBeenCalledWith(RECEIPT_CACHE);
    expect(fetch.mock.calls).toHaveLength(Object.keys(receiptAssets).length);
    expect([...files.keys()]).toEqual(Object.keys(receiptAssets).map((file) => `${RECEIPT_ASSET_PATH}/${file}`));
    expect(await receiptScannerReady()).toBe(true);
    fetch.mockClear();
    await downloadReceiptScanner(new AbortController().signal, progress);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a partial download retryable without claiming offline readiness", async () => {
    const { files } = storage();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("worker")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadReceiptScanner(new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(files.size).toBe(1);
    expect(await receiptScannerReady()).toBe(false);
    fetch.mockResolvedValue(new Response("asset"));
    await downloadReceiptScanner(new AbortController().signal, vi.fn());
    expect(await receiptScannerReady()).toBe(true);
  });

  it.each([
    new Response("Not found", { status: 404 }),
    new Response("<html>App fallback</html>", { headers: { "content-type": "text/html" } })
  ])("rejects failed downloads and HTML app fallbacks", async (response) => {
    const { put } = storage();
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(downloadReceiptScanner(new AbortController().signal, vi.fn())).rejects.toThrow("Could not download the scanner");
    expect(put).not.toHaveBeenCalled();
  });

  it("stops downloading on cancellation", async () => {
    storage();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(downloadReceiptScanner(controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported and oversized photos before decoding or starting OCR", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(scanReceipt(new File(["test"], "receipt.pdf", { type: "application/pdf" }), new AbortController().signal, vi.fn()))
      .rejects.toThrow("Choose a JPEG");
    const large = new File([new Uint8Array(21 * 1024 * 1024)], "large.jpg", { type: "image/jpeg" });
    await expect(scanReceipt(large, new AbortController().signal, vi.fn())).rejects.toThrow("too large");
    expect(decode).not.toHaveBeenCalled();
  });
});
