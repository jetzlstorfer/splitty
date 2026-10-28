// Bump the path/cache version whenever the OCR runtime or language data changes.
export const RECEIPT_ASSET_PATH = "/receipt-ocr-v1";
export const RECEIPT_CACHE = "splitty-receipt-ocr-v1";
export const receiptAssets = {
  "worker.min.js": "tesseract.js/dist/worker.min.js",
  "tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js": "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "deu.traineddata.gz": "@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz",
  "eng.traineddata.gz": "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "worker.min.js.LICENSE.txt": "tesseract.js/dist/worker.min.js.LICENSE.txt",
  "LICENSE-tesseract.txt": "tesseract.js/LICENSE.md",
  "LICENSE-core.txt": "tesseract.js-core/LICENSE"
};
