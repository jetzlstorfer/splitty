import type { Upload } from "./backup";

/** In-memory Upload with the same "never replace" contract as the blob uploader. */
export function memoryUpload(store: Map<string, Buffer>): Upload {
  return async (name, data) => {
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk));
    if (store.has(name)) return "exists";
    store.set(name, Buffer.concat(chunks));
    return "created";
  };
}
