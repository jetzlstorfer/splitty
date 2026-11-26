import { odata, type TableClient } from "@azure/data-tables";
import { collect, day, deleteUnchanged, entities, isTime, type DeleteResult, type VersionedKey } from "./common";
import type { DataTables } from "./tables";

export interface CleanupSummary {
  transactions: number;
  bootstraps: number;
  invitations: number;
  rateLimits: number;
  failures: number;
}

// The API rewrites rate-limit windows with ETags; keep rows well past the longest (24 h) window.
const rateLimitRetention = 2 * day;

type Row = Record<string, unknown> & { partitionKey?: string; rowKey?: string; etag?: string };

async function sweep(
  table: TableClient, filter: string, select: string[], isStale: (row: Row) => boolean
): Promise<DeleteResult> {
  const stale: VersionedKey[] = [];
  let unversioned = 0;
  for (const row of await collect(entities<Row>(table, { filter, select: ["PartitionKey", "RowKey", ...select] }))) {
    if (!isStale(row)) continue;
    if (row.partitionKey && row.rowKey && row.etag) {
      stale.push({ partitionKey: row.partitionKey, rowKey: row.rowKey, etag: row.etag });
    } else {
      unversioned += 1;
    }
  }
  const result = await deleteUnchanged(table, stale);
  return { deleted: result.deleted, failed: result.failed + unversioned };
}

const expired = (now: number) => (row: Row) => isTime(row.expiresAt) && row.expiresAt < now;

/** Removes expired sign-in state, invitations and stale rate-limit counters. Sessions are not expired here. */
export async function cleanupExpired(tables: DataTables, now: number): Promise<CleanupSummary> {
  const { auth } = tables;
  const transactions = await sweep(auth, odata`PartitionKey eq ${"entra-transactions"}`, ["expiresAt"], expired(now));
  const bootstraps = await sweep(auth, odata`PartitionKey eq ${"device-bootstrap"}`, ["expiresAt"], expired(now));
  const invitations = await sweep(
    auth,
    odata`PartitionKey ge ${"h-"} and PartitionKey lt ${"h."} and RowKey ge ${"i"} and RowKey lt ${"j"}`,
    ["expiresAt"],
    (row) => (row.rowKey?.startsWith("i-") === true || row.rowKey?.startsWith("invite-slot-") === true) && expired(now)(row)
  );
  const rateLimits = await sweep(
    auth,
    odata`PartitionKey ge ${"limit-"} and PartitionKey lt ${"limit."} and RowKey eq ${"window"}`,
    ["windowStart"],
    (row) => isTime(row.windowStart) && row.windowStart < now - rateLimitRetention
  );
  return {
    transactions: transactions.deleted,
    bootstraps: bootstraps.deleted,
    invitations: invitations.deleted,
    rateLimits: rateLimits.deleted,
    failures: transactions.failed + bootstraps.failed + invitations.failed + rateLimits.failed
  };
}
