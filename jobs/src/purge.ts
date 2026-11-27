import { odata, type TableClient } from "@azure/data-tables";
import {
  collect, deleteKeys, describeError, entities, identifier, isTime, type EntityKey, type Logger
} from "./common";
import type { DataTables } from "./tables";

export interface PurgeSummary {
  households: number;
  accounts: number;
  rows: number;
  skipped: number;
  failures: number;
}

interface SessionIndex { byHousehold: Map<string, EntityKey[]>; byUser: Map<string, EntityKey[]> }

function push(index: Map<string, EntityKey[]>, id: string, key: EntityKey) {
  index.set(id, [...(index.get(id) ?? []), key]);
}

async function sessionIndex(auth: TableClient): Promise<SessionIndex> {
  const index: SessionIndex = { byHousehold: new Map(), byUser: new Map() };
  for await (const row of entities<{ userId?: unknown; householdId?: unknown }>(auth, {
    filter: odata`PartitionKey eq ${"sessions"}`,
    select: ["PartitionKey", "RowKey", "userId", "householdId"]
  })) {
    const key = { partitionKey: row.partitionKey as string, rowKey: row.rowKey as string };
    if (typeof row.householdId === "string") push(index.byHousehold, row.householdId, key);
    if (typeof row.userId === "string") push(index.byUser, row.userId, key);
  }
  return index;
}

async function keysOf(table: TableClient, filter: string): Promise<EntityKey[]> {
  const rows = await collect(entities(table, { filter, select: ["PartitionKey", "RowKey"] }));
  return rows.map((row) => ({ partitionKey: row.partitionKey as string, rowKey: row.rowKey as string }));
}

async function hasActiveMember(auth: TableClient, partition: string): Promise<boolean> {
  for await (const row of entities<{ active?: unknown }>(auth, {
    filter: odata`PartitionKey eq ${partition}`,
    select: ["PartitionKey", "RowKey", "active"]
  })) {
    if (row.rowKey?.startsWith("m-") && row.active === true) return true;
  }
  return false;
}

async function purgeHousehold(
  { auth, ledger }: DataTables, householdId: string, sessions: SessionIndex
): Promise<{ rows: number; failed: number; skipped: boolean }> {
  const partition = `h-${householdId}`;
  if (await hasActiveMember(auth, partition)) return { rows: 0, failed: 0, skipped: true };

  let rows = 0;
  const steps: Array<[TableClient, EntityKey[]]> = [
    [ledger, await keysOf(ledger, odata`PartitionKey eq ${householdId}`)],
    [auth, await keysOf(auth, odata`PartitionKey eq ${`auth-${householdId}`}`)],
    [auth, sessions.byHousehold.get(householdId) ?? []],
    [auth, (await keysOf(auth, odata`PartitionKey eq ${partition}`)).filter((key) => key.rowKey !== "household")]
  ];
  for (const [table, keys] of steps) {
    const result = await deleteKeys(table, keys);
    rows += result.deleted;
    if (result.failed) return { rows, failed: result.failed, skipped: false };
  }
  // The tombstone goes last so an interrupted purge is found and finished on the next run.
  const final = await deleteKeys(auth, [{ partitionKey: partition, rowKey: "household" }]);
  return { rows: rows + final.deleted, failed: final.failed, skipped: false };
}

async function purgeAccount(
  { auth }: DataTables, userId: string, sessions: SessionIndex
): Promise<{ rows: number; failed: number }> {
  const owned = await deleteKeys(auth, sessions.byUser.get(userId) ?? []);
  if (owned.failed) return { rows: owned.deleted, failed: owned.failed };
  // Membership index rows (`m-<userId>.<householdId>`) let an account list its households.
  const index = await deleteKeys(auth, await keysOf(
    auth, odata`PartitionKey eq ${"users"} and RowKey ge ${`m-${userId}.`} and RowKey lt ${`m-${userId}/`}`
  ));
  if (index.failed) return { rows: owned.deleted + index.deleted, failed: index.failed };
  const final = await deleteKeys(auth, [{ partitionKey: "users", rowKey: `u-${userId}` }]);
  return { rows: owned.deleted + index.deleted + final.deleted, failed: final.failed };
}

/** Permanently removes households and accounts whose 30-day deletion grace has ended. */
export async function purgeExpired(tables: DataTables, now: number, log: Logger): Promise<PurgeSummary> {
  const summary: PurgeSummary = { households: 0, accounts: 0, rows: 0, skipped: 0, failures: 0 };

  const households: string[] = [];
  for await (const row of entities<{ deletedAt?: unknown; purgeAfter?: unknown }>(tables.auth, {
    filter: odata`PartitionKey ge ${"h-"} and PartitionKey lt ${"h."} and RowKey eq ${"household"}`,
    select: ["PartitionKey", "RowKey", "deletedAt", "purgeAfter"]
  })) {
    const id = row.partitionKey?.slice(2) ?? "";
    if (!isTime(row.deletedAt) || !isTime(row.purgeAfter) || row.purgeAfter > now) continue;
    if (identifier.test(id)) households.push(id);
    else { summary.skipped += 1; log.warn("Skipped a household with an unexpected identifier."); }
  }

  const accounts: string[] = [];
  for await (const row of entities<{ userId?: unknown; deletionRequestedAt?: unknown; purgeAfter?: unknown }>(tables.auth, {
    filter: odata`PartitionKey eq ${"users"}`,
    select: ["PartitionKey", "RowKey", "userId", "deletionRequestedAt", "purgeAfter"]
  })) {
    if (!isTime(row.deletionRequestedAt) || !isTime(row.purgeAfter) || row.purgeAfter > now) continue;
    const id = row.rowKey?.startsWith("u-") ? row.rowKey.slice(2) : "";
    if (identifier.test(id) && row.userId === id) accounts.push(id);
    else { summary.skipped += 1; log.warn("Skipped an account with an unexpected identifier."); }
  }

  if (!households.length && !accounts.length) return summary;
  const sessions = await sessionIndex(tables.auth);

  for (const id of households) {
    try {
      const result = await purgeHousehold(tables, id, sessions);
      summary.rows += result.rows;
      if (result.skipped) { summary.skipped += 1; log.warn("Skipped a deleted household that still has an active member."); }
      else if (result.failed) summary.failures += 1;
      else summary.households += 1;
    } catch (error) {
      summary.failures += 1;
      log.error(`Household purge failed (${describeError(error)}).`);
    }
  }
  for (const id of accounts) {
    try {
      const result = await purgeAccount(tables, id, sessions);
      summary.rows += result.rows;
      if (result.failed) summary.failures += 1;
      else summary.accounts += 1;
    } catch (error) {
      summary.failures += 1;
      log.error(`Account purge failed (${describeError(error)}).`);
    }
  }
  return summary;
}
