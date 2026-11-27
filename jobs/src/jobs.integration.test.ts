import { TableClient } from "@azure/data-tables";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { createMembership, createUserSession, type AuthContext } from "../../api/src/auth";
import { getConfig } from "../../api/src/config";
import { deleteAccount, deleteHousehold } from "../../api/src/households";
import { createInvitation } from "../../api/src/invitations";
import { consumeRateLimit } from "../../api/src/rateLimit";
import { backupTables } from "./backup";
import { cleanupExpired } from "./cleanup";
import { day, deleteUnchanged } from "./common";
import { purgeExpired } from "./purge";
import type { DataTables } from "./tables";
import { memoryUpload } from "./testing";

const enabled = process.env.RUN_AZURE_TESTS === "1";
const connection = process.env.TABLE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true";
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function open(name: string): TableClient {
  return TableClient.fromConnectionString(connection, `${name}${randomUUID().replaceAll("-", "").slice(0, 12)}`, {
    allowInsecureConnection: true
  });
}

async function exists(table: TableClient, partitionKey: string, rowKey: string): Promise<boolean> {
  try { await table.getEntity(partitionKey, rowKey); return true; }
  catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return false; throw error; }
}

async function count(table: TableClient, filter: string): Promise<number> {
  let rows = 0;
  for await (const entity of table.listEntities({ queryOptions: { filter } })) {
    if (entity.rowKey !== undefined) rows += 1;
  }
  return rows;
}

// Everything is created through the API's own functions so key formats cannot drift unnoticed.
async function seedHousehold(tables: DataTables, householdId: string, members: Array<"a" | "b">) {
  const { auth, ledger } = tables;
  const contexts: Array<AuthContext> = [];
  await auth.createEntity({ partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: "Sam" });
  for (const member of members) {
    const userId = `user-${randomUUID()}`;
    await auth.createEntity({
      partitionKey: "users", rowKey: `u-${userId}`, userId, issuer: "test", subject: userId,
      householdId, member, membershipInitialized: true
    });
    await createMembership(auth, householdId, userId, member);
    const context: AuthContext = { userId, householdId, member };
    await createUserSession(getConfig(), auth, context);
    contexts.push(context);
  }
  await ledger.createEntity({ partitionKey: householdId, rowKey: "e-1", json: "{}" });
  await ledger.createEntity({ partitionKey: householdId, rowKey: "todo-e-1", json: "{}" });
  await ledger.createEntity({ partitionKey: householdId, rowKey: "sequence", sequence: 2 });
  await auth.createEntity({ partitionKey: `auth-${householdId}`, rowKey: "s-legacy", member: "a" });
  return contexts;
}

describe.skipIf(!enabled)("scheduled jobs against Azurite", () => {
  let tables: DataTables;

  beforeAll(async () => {
    Object.assign(process.env, {
      APP_ORIGIN: "http://127.0.0.1:5173", LOCAL_DEVELOPMENT: "true", ALLOW_NEW_HOUSEHOLDS: "true",
      TABLE_STORAGE_CONNECTION_STRING: connection,
      ENTRA_AUTHORITY: "https://splittytest.ciamlogin.com/00000000-0000-4000-8000-000000000003",
      ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
      ENTRA_CLIENT_SECRET: "test-client-secret"
    });
    tables = { auth: open("JobsAuth"), ledger: open("JobsLedger") };
    await Promise.all([tables.auth.createTable(), tables.ledger.createTable()]);
  });

  it("purges households and accounts only after their grace period, leaving others intact", async () => {
    const doomed = `purge-${randomUUID()}`;
    const kept = `keep-${randomUUID()}`;
    const [owner] = await seedHousehold(tables, doomed, ["a", "b"]);
    const [stayer, leaver] = await seedHousehold(tables, kept, ["a", "b"]);
    await deleteHousehold(tables.auth, owner);
    await deleteAccount(tables.auth, leaver);
    // An interrupted membership change can leave an index row behind; purging the account removes it.
    await tables.auth.createEntity({
      partitionKey: "users", rowKey: `m-${leaver.userId}.stale-${randomUUID()}`, userId: leaver.userId, joinedAt: 0
    });
    const indexRows = (userId: string) =>
      count(tables.auth, `PartitionKey eq 'users' and RowKey ge 'm-${userId}.' and RowKey lt 'm-${userId}/'`);
    expect(await indexRows(stayer.userId)).toBe(1);

    const early = await purgeExpired(tables, Date.now(), silent);
    expect(early).toMatchObject({ households: 0, accounts: 0, failures: 0 });
    expect(await exists(tables.auth, `h-${doomed}`, "household")).toBe(true);

    const late = await purgeExpired(tables, Date.now() + 31 * day, silent);
    expect(late).toMatchObject({ households: 1, accounts: 1, failures: 0 });
    expect(await count(tables.ledger, `PartitionKey eq '${doomed}'`)).toBe(0);
    expect(await count(tables.auth, `PartitionKey eq 'h-${doomed}' or PartitionKey eq 'auth-${doomed}'`)).toBe(0);
    expect(await count(tables.auth, `PartitionKey eq 'sessions' and householdId eq '${doomed}'`)).toBe(0);

    expect(await exists(tables.auth, "users", `u-${leaver.userId}`)).toBe(false);
    expect(await indexRows(leaver.userId)).toBe(0);
    expect(await count(tables.auth, `PartitionKey eq 'sessions' and userId eq '${leaver.userId}'`)).toBe(0);
    expect(await exists(tables.auth, "users", `u-${stayer.userId}`)).toBe(true);
    expect(await indexRows(stayer.userId)).toBe(1);
    expect(await count(tables.auth, `PartitionKey eq 'sessions' and userId eq '${stayer.userId}'`)).toBe(1);
    expect(await count(tables.ledger, `PartitionKey eq '${kept}'`)).toBe(3);
    expect(await exists(tables.auth, `h-${kept}`, "household")).toBe(true);
  });

  it("is idempotent and finishes an interrupted purge", async () => {
    const householdId = `interrupted-${randomUUID()}`;
    const [owner] = await seedHousehold(tables, householdId, ["a"]);
    await deleteHousehold(tables.auth, owner);
    // An earlier run removed the ledger but stopped before deleting the tombstone.
    await tables.ledger.deleteEntity(householdId, "e-1");
    const now = Date.now() + 31 * day;
    expect(await purgeExpired(tables, now, silent)).toMatchObject({ households: 1, failures: 0 });
    expect(await count(tables.ledger, `PartitionKey eq '${householdId}'`)).toBe(0);
    expect(await purgeExpired(tables, now, silent)).toMatchObject({ households: 0, accounts: 0, failures: 0 });
  });

  it("never purges a household that still has an active member", async () => {
    const householdId = `active-${randomUUID()}`;
    await seedHousehold(tables, householdId, ["a"]);
    const past = Date.now() - day;
    await tables.auth.updateEntity(
      { partitionKey: `h-${householdId}`, rowKey: "household", deletedAt: past, purgeAfter: past }, "Merge"
    );
    expect(await purgeExpired(tables, Date.now(), silent)).toMatchObject({ households: 0, skipped: 1, failures: 0 });
    expect(await count(tables.ledger, `PartitionKey eq '${householdId}'`)).toBe(3);
    expect(await exists(tables.auth, `h-${householdId}`, "household")).toBe(true);
  });

  it("removes expired sign-in state, invitations and old rate limits but keeps live and reserved rows", async () => {
    const { auth } = tables;
    const householdId = `cleanup-${randomUUID()}`;
    const [owner] = await seedHousehold(tables, householdId, ["a"]);
    const now = Date.now();

    await auth.createEntity({ partitionKey: "entra-transactions", rowKey: "t-old", expiresAt: now - 1000 });
    await auth.createEntity({ partitionKey: "entra-transactions", rowKey: "t-live", expiresAt: now + 60_000 });
    await auth.createEntity({ partitionKey: "device-bootstrap", rowKey: "b-old", userId: "u", expiresAt: now - 1000 });
    await auth.createEntity({ partitionKey: "device-bootstrap", rowKey: "b-live", userId: "u", expiresAt: now + 60_000 });

    await createInvitation(auth, owner);
    const partition = `h-${householdId}`;
    await auth.createEntity({ partitionKey: partition, rowKey: "i-expired", slot: "a", expiresAt: now - 1000 });
    await auth.createEntity({ partitionKey: partition, rowKey: "invite-slot-a", id: "expired", expiresAt: now - 1000 });
    const other = `h-reserved-${randomUUID()}`;
    await auth.createEntity({
      partitionKey: other, rowKey: "invite-slot-b", id: "legacy", expiresAt: Number.MAX_SAFE_INTEGER
    });

    await consumeRateLimit(auth, `old-${householdId}`, 10, 60_000, now - 3 * day);
    await consumeRateLimit(auth, `recent-${householdId}`, 10, 60_000, now - day);

    const summary = await cleanupExpired(tables, now);
    expect(summary).toMatchObject({ transactions: 1, bootstraps: 1, failures: 0 });
    expect(summary.invitations).toBe(2);
    expect(summary.rateLimits).toBe(1);

    expect(await exists(auth, "entra-transactions", "t-old")).toBe(false);
    expect(await exists(auth, "entra-transactions", "t-live")).toBe(true);
    expect(await exists(auth, "device-bootstrap", "b-old")).toBe(false);
    expect(await exists(auth, "device-bootstrap", "b-live")).toBe(true);
    expect(await exists(auth, partition, "i-expired")).toBe(false);
    expect(await exists(auth, other, "invite-slot-b")).toBe(true);
    expect(await count(auth, `PartitionKey eq '${partition}' and RowKey ge 'i' and RowKey lt 'j'`)).toBe(2);
    // The recent counter and the invitation limiter created above are both inside the retention window.
    expect(await count(auth, "PartitionKey ge 'limit-' and PartitionKey lt 'limit.'")).toBe(2);
  });

  it("does not delete a row the API changed after it was listed", async () => {
    const { auth } = tables;
    await auth.createEntity({ partitionKey: "limit-race", rowKey: "window", windowStart: 1, count: 1 });
    const listed = await auth.getEntity("limit-race", "window");
    await auth.updateEntity({ partitionKey: "limit-race", rowKey: "window", count: 2 }, "Merge");
    const result = await deleteUnchanged(auth, [
      { partitionKey: "limit-race", rowKey: "window", etag: listed.etag }
    ]);
    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect(await exists(auth, "limit-race", "window")).toBe(true);
    await auth.deleteEntity("limit-race", "window");
  });

  it("backs up durable data as gzip NDJSON without credentials, then skips an existing backup", async () => {
    const backupTables_ = { auth: open("BackupAuth"), ledger: open("BackupLedger") };
    await Promise.all([backupTables_.auth.createTable(), backupTables_.ledger.createTable()]);
    const householdId = `backup-${randomUUID()}`;
    await seedHousehold(backupTables_, householdId, ["a"]);
    await backupTables_.auth.createEntity({ partitionKey: "entra-transactions", rowKey: "t-1", verifier: "secret-verifier" });
    await consumeRateLimit(backupTables_.auth, "sign-in:shared", 10, 60_000);
    await backupTables_.ledger.createEntity({
      partitionKey: householdId, rowKey: "typed",
      big: { value: "9007199254740993", type: "Int64" }, bytes: new Uint8Array([1, 2, 3])
    });

    const store = new Map<string, Buffer>();
    const now = new Date("2025-01-02T03:04:05Z");
    const first = await backupTables(backupTables_, memoryUpload(store), now);
    const authBlob = `2025-01-02/${backupTables_.auth.tableName}.ndjson.gz`;
    const ledgerBlob = `2025-01-02/${backupTables_.ledger.tableName}.ndjson.gz`;
    expect([...store.keys()].sort()).toEqual([authBlob, ledgerBlob, "2025-01-02/manifest.json"].sort());

    const read = (blob: string) => gunzipSync(store.get(blob)!).toString("utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const authRows = read(authBlob);
    const ledgerRows = read(ledgerBlob);
    expect(first.tables).toEqual({
      [backupTables_.auth.tableName]: authRows.length, [backupTables_.ledger.tableName]: ledgerRows.length
    });
    // The user row and its membership index row are both durable account data.
    expect(authRows.map((row) => row.partitionKey).sort()).toEqual(
      ["h-" + householdId, "h-" + householdId, "users", "users"]
    );
    expect(authRows.filter((row) => row.partitionKey === "users").map((row) => String(row.rowKey).slice(0, 2)).sort())
      .toEqual(["m-", "u-"]);
    expect(JSON.stringify(authRows)).not.toMatch(/sessions|entra-transactions|limit-|secret-verifier|auth-backup/);
    expect(authRows.every((row) => !("etag" in row))).toBe(true);
    const typed = ledgerRows.find((row) => row.rowKey === "typed")!;
    expect(typed.bytes).toEqual({ $base64: "AQID" });
    expect(String(typed.big)).toBe("9007199254740993");
    expect(ledgerRows).toHaveLength(4);

    const manifest = JSON.parse(store.get("2025-01-02/manifest.json")!.toString("utf8"));
    expect(manifest.tables[backupTables_.ledger.tableName]).toEqual({ blob: ledgerBlob, rows: 4 });

    const again = await backupTables(backupTables_, memoryUpload(store), now);
    expect(again.tables).toEqual({ [backupTables_.auth.tableName]: null, [backupTables_.ledger.tableName]: null });
  });
});
