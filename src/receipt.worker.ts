import { createWorker, OEM } from "tesseract.js";
import type { OcrMessage } from "./receiptOcr";

const send = (message: OcrMessage) => self.postMessage(message);

self.onmessage = async ({ data }: MessageEvent<{ image: ArrayBuffer; assetPath: string }>) => {
  try {
    const worker = await createWorker(["deu", "eng"], OEM.LSTM_ONLY, {
      workerPath: `${data.assetPath}/worker.min.js`,
      corePath: data.assetPath,
      langPath: data.assetPath,
      workerBlobURL: false,
      // The app caches the compressed models together with the runtime for offline use.
      cacheMethod: "none",
      logger: ({ status, progress }) => send({
        type: "progress", value: { phase: status === "recognizing text" ? "recognize" : "prepare", progress }
      }),
      errorHandler: () => send({ type: "error" })
    });
    try {
      const { data: result } = await worker.recognize(new Blob([data.image], { type: "image/png" }));
      send({ type: "result", text: result.text, confidence: result.confidence });
    } finally { await worker.terminate(); }
  } catch {
    send({ type: "error" });
  }
};
