import { extractReceipt, type ReceiptDraft } from "./receipt";
import { RECEIPT_ASSET_PATH, RECEIPT_CACHE, receiptAssets } from "./receiptAssets";

export interface OcrProgress { phase: "download" | "prepare" | "recognize"; progress: number }
export type OcrMessage =
  | { type: "progress"; value: OcrProgress }
  | { type: "result"; text: string; confidence: number }
  | { type: "error" };

const assetUrls = Object.keys(receiptAssets).map((name) => `${RECEIPT_ASSET_PATH}/${name}`);
const validAsset = (response?: Response) => response?.ok && !response.headers.get("content-type")?.includes("text/html");

export async function receiptScannerReady(): Promise<boolean> {
  const cache = await caches.open(RECEIPT_CACHE);
  const responses = await Promise.all(assetUrls.map((url) => cache.match(url)));
  return responses.every(validAsset);
}

export async function downloadReceiptScanner(signal: AbortSignal, progress: (value: OcrProgress) => void): Promise<void> {
  const cache = await caches.open(RECEIPT_CACHE);
  for (const [index, url] of assetUrls.entries()) {
    signal.throwIfAborted();
    progress({ phase: "download", progress: index / assetUrls.length });
    if (validAsset(await cache.match(url))) continue;
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error("Could not download the scanner. Connect to the internet and try again; manual entry still works.", { cause });
    }
    if (!validAsset(response)) {
      throw new Error("Could not download the scanner. Connect to the internet and try again; manual entry still works.");
    }
    try {
      await cache.put(url, response);
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error("Scanner storage is unavailable. Check your browser storage settings; manual entry still works.", { cause });
    }
  }
  signal.throwIfAborted();
}

async function prepareImage(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG or WebP receipt photo.");
  }
  if (file.size > 20 * 1024 * 1024) throw new Error("The receipt photo is too large. Choose an image under 20 MB.");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch (cause) {
    throw new Error("Could not read this receipt. Try a clearer photo or enter it manually.", { cause });
  }
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, 4000 / Math.max(image.width, image.height), Math.sqrt(6_000_000 / (image.width * image.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read this receipt. Try a clearer photo or enter it manually.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("Could not read this receipt. Try a clearer photo or enter it manually."));
    }, "image/png"));
    return await blob.arrayBuffer();
  } finally { image.close(); }
}

export async function scanReceipt(file: File, signal: AbortSignal, progress: (value: OcrProgress) => void): Promise<ReceiptDraft> {
  progress({ phase: "prepare", progress: 0 });
  const image = await prepareImage(file, signal);
  signal.throwIfAborted();
  // Owning Tesseract in a dedicated parent worker makes even initialization cancellable.
  const worker = new Worker(new URL("./receipt.worker.ts", import.meta.url), { type: "module" });
  try {
    const result = await new Promise<{ text: string; confidence: number }>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: { text: string; confidence: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const abort = () => finish(new DOMException("Receipt scan cancelled", "AbortError"));
      const timer = window.setTimeout(() => finish(new Error("Scanning took too long. Try a smaller, clearer photo or enter it manually.")), 120_000);
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => finish(new Error("Could not read this receipt. Try a clearer photo or enter it manually."));
      worker.onmessage = ({ data }: MessageEvent<OcrMessage>) => {
        if (settled) return;
        if (data.type === "progress") progress(data.value);
        else if (data.type === "error") finish(new Error("Could not read this receipt. Try a clearer photo or enter it manually."));
        else finish(undefined, data);
      };
      worker.postMessage({ image, assetPath: new URL(RECEIPT_ASSET_PATH, location.origin).href }, [image]);
    });
    signal.throwIfAborted();
    return extractReceipt(result.text, result.confidence);
  } finally {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
}
