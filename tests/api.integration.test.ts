import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handler } from "../api/src/handler";
import { getConfig } from "../api/src/config";
import { tables } from "../api/src/storage";
import { applyMutation, readChanges } from "../api/src/ledger";
import { example } from "./fixtures";
import type { MutationResult, SyncPage } from "../shared/model";

const enabled = process.env.RUN_AZURE_TESTS === "1";
const origin = "http://127.0.0.1:5173";
let household: string;
const partitions: string[] = [];
const logger = vi.fn();

async function call(path: string, data?: unknown, cookie?: string, requestOrigin = origin) {
  return handler(new Request(`${origin}/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json", Origin: requestOrigin })
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  }), logger);
}

async function login(member: "a" | "b"): Promise<string> {
  const result = await call("auth/request", { email: `${member}@example.com` });
  expect(result.status).toBe(202);
  const data = await result.json() as { developmentLink: string };
  const token = new URL(data.developmentLink).hash.slice("#signin=".length);
  const signedIn = await call("auth/consume", { token });
  expect(signedIn.status).toBe(200);
  return signedIn.headers.get("set-cookie")!.split(";")[0];
}

describe.skipIf(!enabled)("Azure Table Storage integration (Azurite)", () => {
  beforeAll(() => {
    household = `test-${crypto.randomUUID()}`;
    partitions.push(household);
    Object.assign(process.env, {
      APP_ORIGIN: origin, HOUSEHOLD_ID: household, TABLE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      MEMBER_A_EMAIL: "a@example.com", MEMBER_B_EMAIL: "b@example.com",
      MEMBER_A_NAME: "Alex", MEMBER_B_NAME: "Sam", LOCAL_DEVELOPMENT: "true"
    });
  });
  afterAll(async () => {
    const clients = await tables(getConfig());
    for (const pk of partitions) {
      for (const table of [clients.ledger, clients.auth]) {
        for (const partitionKey of [pk, `auth-${pk}`]) {
          for await (const entity of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${partitionKey}'` } })) {
            await table.deleteEntity(partitionKey, entity.rowKey!);
          }
        }
      }
    }
    expect(logger).not.toHaveBeenCalled();
  }, 30_000);
  it("requires authentication and rejects cross-origin writes", async () => {
    expect((await call("sync")).status).toBe(401);
    expect((await call("auth/request", { email: "a@example.com" }, undefined, "https://evil.example")).status).toBe(403);
    const unknown = await call("auth/request", { email: "stranger@example.com" });
    expect(await unknown.json()).not.toHaveProperty("developmentLink");
  });
  it("makes links single-use, identifies the member, and revokes sessions", async () => {
    const response = await call("auth/request", { email: "a@example.com" });
    const data = await response.json() as { developmentLink: string };
    const token = new URL(data.developmentLink).hash.slice("#signin=".length);
    const consumed = await call("auth/consume", { token });
    expect(consumed.status).toBe(200);
    const cookie = consumed.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect((await call("auth/consume", { token })).status).toBe(401);
    const me = await call("me", undefined, cookie);
    expect(await me.json()).toMatchObject({ member: "a" });
    expect((await call("auth/logout", {}, cookie)).status).toBe(200);
    expect((await call("me", undefined, cookie)).status).toBe(401);
  });
  it("syncs two devices, retries safely, and returns explicit conflicts", async () => {
    // Use a fresh household so rate limits and earlier sessions do not affect this test.
    process.env.HOUSEHOLD_ID = `test-${crypto.randomUUID()}`;
    partitions.push(process.env.HOUSEHOLD_ID);
    const a = await login("a"), b = await login("b");
    const mutation = { id: "new-entry", expectedRevision: 0, entry: example() };
    const written = await call("sync", { mutations: [mutation] }, a);
    expect(written.status).toBe(200);
    expect((await written.json() as MutationResult[])[0].status).toBe("ok");
    const first = await call("sync?since=0", undefined, b);
    const page = await first.json() as SyncPage;
    expect(page.entries).toHaveLength(1);
    expect(page.cursor).toBe(1);
    const edit = { id: "edit-entry", expectedRevision: 1, entry: example({ revision: 2, description: "Updated on B" }) };
    expect((await call("sync", { mutations: [edit] }, b)).status).toBe(200);
    const replay = await call("sync", { mutations: [mutation] }, a);
    expect((await replay.json() as MutationResult[])[0]).toMatchObject({ status: "ok", entry: { revision: 2, description: "Updated on B" } });
    const stale = { id: "stale-edit", expectedRevision: 1, entry: example({ revision: 2, description: "Stale A edit" }) };
    const conflict = await call("sync", { mutations: [stale] }, a);
    expect((await conflict.json() as MutationResult[])[0]).toMatchObject({ status: "conflict", entry: { revision: 2 } });
    const deletion = { id: "delete-entry", expectedRevision: 2, entry: example({ revision: 3, deleted: true }) };
    await call("sync", { mutations: [deletion] }, b);
    const final = await call("sync?since=1", undefined, a);
    expect((await final.json() as SyncPage).entries.map((entry) => entry.deleted)).toEqual([false, true]);
  });
  it("serializes concurrent writers without losing changes", async () => {
    const { ledger } = await tables(getConfig());
    const pk = `test-${crypto.randomUUID()}`; partitions.push(pk);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => applyMutation(ledger, pk, {
      id: `concurrent-${i}`, expectedRevision: 0, entry: example({ description: `Edit ${i}` })
    })));
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(7);
    const changes = await readChanges(ledger, pk, 0);
    expect(changes.entries).toHaveLength(1);
    expect(changes.cursor).toBe(1);
  });
  it("rejects a reused operation identifier with a different payload", async () => {
    const { ledger } = await tables(getConfig());
    const pk = `test-${crypto.randomUUID()}`; partitions.push(pk);
    await applyMutation(ledger, pk, { id: "reused", expectedRevision: 0, entry: example() });
    expect(await applyMutation(ledger, pk, {
      id: "reused", expectedRevision: 0, entry: example({ description: "Different" })
    })).toMatchObject({ status: "conflict" });
  });
  it("paginates history without losing entries", async () => {
    const { ledger } = await tables(getConfig());
    const pk = `test-${crypto.randomUUID()}`; partitions.push(pk);
    await ledger.createEntity({ partitionKey: pk, rowKey: "sequence", sequence: 501 });
    for (let start = 1; start <= 501; start += 100) {
      await ledger.submitTransaction(Array.from({ length: Math.min(100, 502 - start) }, (_, i) => [
        "create" as const,
        {
          partitionKey: pk, rowKey: `c-${String(start + i).padStart(16, "0")}`,
          json: JSON.stringify(example({ id: `entry-${start + i}` }))
        }
      ]));
    }
    const first = await readChanges(ledger, pk, 0);
    expect(first.entries).toHaveLength(500);
    expect(first).toMatchObject({ cursor: 500, more: true });
    const second = await readChanges(ledger, pk, first.cursor);
    expect(second.entries).toHaveLength(1);
    expect(second).toMatchObject({ cursor: 501, more: false });
  });
});
