import type { ContainerClient } from "@azure/storage-blob";
import type { Upload } from "./backup";
import { statusCode } from "./common";

/** Uploads with If-None-Match so an existing (possibly immutable) backup is never replaced. */
export function blobUploader(container: ContainerClient): Upload {
  return async (blobName, data) => {
    try {
      await container.getBlockBlobClient(blobName).uploadStream(data, 4 * 1024 * 1024, 2, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: blobName.endsWith(".json") ? "application/json" : "application/gzip" }
      });
      return "created";
    } catch (error) {
      if (statusCode(error) === 409 || statusCode(error) === 412) {
        data.destroy();
        return "exists";
      }
      throw error;
    }
  };
}
