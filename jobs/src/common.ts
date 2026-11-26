import type { TableClient, ListTableEntitiesOptions } from "@azure/data-tables";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface EntityKey { partitionKey: string; rowKey: string }
export interface VersionedKey extends EntityKey { etag: string }

export const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export const day = 24 * 60 * 60 * 1000;

export function statusCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
}

// Only the error class and HTTP status are logged; messages can embed request URLs.
export function describeError(error: unknown): string {
  const status = statusCode(error);
  const name = error instanceof Error ? error.name : "Error";
  return status ? `${name} ${status}` : name;
}

export function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// A table that was never created holds nothing to purge, clean or back up.
export async function* entities<T extends object = Record<string, unknown>>(
  table: TableClient, queryOptions: NonNullable<ListTableEntitiesOptions["queryOptions"]>
) {
  try {
    for await (const entity of table.listEntities<T>({ queryOptions })) yield entity;
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function deleteOne(table: TableClient, key: EntityKey, etag?: string): Promise<boolean> {
  try {
    await table.deleteEntity(key.partitionKey, key.rowKey, etag ? { etag } : undefined);
    return true;
  } catch (error) {
    if (statusCode(error) === 404 || (etag && statusCode(error) === 412)) return false;
    throw error;
  }
}

export interface DeleteResult { deleted: number; failed: number }

/** Deletes unconditionally in same-partition transactions, falling back to single deletes. */
export async function deleteKeys(table: TableClient, keys: EntityKey[]): Promise<DeleteResult> {
  const partitions = new Map<string, EntityKey[]>();
  for (const key of keys) partitions.set(key.partitionKey, [...(partitions.get(key.partitionKey) ?? []), key]);
  const result: DeleteResult = { deleted: 0, failed: 0 };
  for (const group of partitions.values()) {
    for (let start = 0; start < group.length; start += 100) {
      const batch = group.slice(start, start + 100);
      try {
        await table.submitTransaction(batch.map(({ partitionKey, rowKey }) => ["delete", { partitionKey, rowKey }] as const));
        result.deleted += batch.length;
        continue;
      } catch {
        // A row removed meanwhile fails the whole transaction; retry row by row.
      }
      for (const key of batch) {
        try {
          if (await deleteOne(table, key)) result.deleted += 1;
        } catch {
          result.failed += 1;
        }
      }
    }
  }
  return result;
}

/** Deletes only rows still at the observed version, so a concurrent API write is never lost. */
export async function deleteUnchanged(table: TableClient, keys: VersionedKey[]): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      try {
        if (await deleteOne(table, key, key.etag)) result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
  return result;
}
