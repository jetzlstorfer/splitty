import { createHash } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { HttpError } from "./config";
import { optionalEntity, statusCode } from "./storage";

interface RateLimitEntity {
  windowStart: number;
  count: number;
}

const partition = (key: string) => `limit-${createHash("sha256").update(key).digest("hex")}`;

export async function consumeRateLimit(
  table: TableClient, key: string, limit: number, windowMs: number, now = Date.now()
): Promise<void> {
  const partitionKey = partition(key);
  const rowKey = "window";
  const windowStart = Math.floor(now / windowMs) * windowMs;
  for (let attempt = 0; attempt < 8; attempt++) {
    const counter = await optionalEntity<RateLimitEntity>(table, partitionKey, rowKey);
    if (counter && (!Number.isSafeInteger(counter.windowStart) || !Number.isSafeInteger(counter.count)
      || counter.count < 0)) {
      throw new Error("Rate-limit metadata is invalid.");
    }
    if (counter && counter.windowStart > windowStart) {
      throw new HttpError(429, "Too many requests. Try again after the limit resets.",
        Math.max(1, Math.ceil((counter.windowStart + windowMs - now) / 1000)));
    }
    if (counter && counter.windowStart === windowStart && counter.count >= limit) {
      throw new HttpError(429, "Too many requests. Try again after the limit resets.",
        Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)));
    }
    try {
      if (!counter) {
        await table.createEntity({ partitionKey, rowKey, windowStart, count: 1 });
      } else {
        await table.updateEntity({
          partitionKey, rowKey, windowStart,
          count: counter.windowStart === windowStart ? counter.count + 1 : 1
        }, "Replace", { etag: counter.etag });
      }
      return;
    } catch (error) {
      if (statusCode(error) !== 409 && statusCode(error) !== 412) throw error;
    }
  }
  throw new HttpError(503, "Request limits are temporarily unavailable. Retry shortly.", 30);
}
