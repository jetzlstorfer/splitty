import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handler } from "../api/src/handler";
import { getConfig } from "../api/src/config";
import { tables } from "../api/src/storage";
import { applyMutation, readChanges, todoLedger } from "../api/src/ledger";
import { example, exampleTodo } from "./fixtures";
import type { MutationResult, SyncPage } from "../shared/model";
import type { Todo } from "../shared/todo";

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
  const token = member === "a" ? "A".repeat(43) : "B".repeat(43);
  const signedIn = await call("auth/token", { token });
  expect(signedIn.status).toBe(200);
  return signedIn.headers.get("set-cookie")!.split(";")[0];
}

describe.skipIf(!enabled)("Azure Table Storage integration (Azurite)", () => {
  beforeAll(() => {
    household = `test-${crypto.randomUUID()}`;
    partitions.push(household);
    Object.assign(process.env, {
      APP_ORIGIN: origin, HOUSEHOLD_ID: household, TABLE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      MEMBER_A_TOKEN: "A".repeat(43), MEMBER_B_TOKEN: "B".repeat(43),
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
    expect((await call("todo-sync")).status).toBe(401);
    expect((await call("todo-sync", { mutations: [] }, undefined, "https://evil.example")).status).toBe(403);
    expect((await call("auth/token", { token: "A".repeat(43) }, undefined, "https://evil.example")).status).toBe(403);
    expect((await call("auth/token", { token: "X".repeat(43) })).status).toBe(401);
  });
  it("reuses member tokens, identifies the member, and revokes sessions", async () => {
    const token = "A".repeat(43);
    const consumed = await call("auth/token", { token });
    expect(consumed.status).toBe(200);
    const cookie = consumed.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=34560000");
    const secondSession = await call("auth/token", { token });
    expect(secondSession.status).toBe(200);
    const me = await call("me", undefined, cookie);
    expect(await me.json()).toMatchObject({ member: "a" });
    expect(me.headers.get("set-cookie")).toBe(cookie);
    process.env.MEMBER_A_TOKEN = "C".repeat(43);
    try {
      const revoked = await call("me", undefined, cookie);
      expect(revoked.status).toBe(401);
      expect(revoked.headers.has("set-cookie")).toBe(false);
    } finally { process.env.MEMBER_A_TOKEN = token; }
    const signedOut = await call("auth/logout", {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("splitty-local=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    const revoked = await call("me", undefined, cookie);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.has("set-cookie")).toBe(false);
    expect((await call("me", undefined, secondSession.headers.get("set-cookie")!)).status).toBe(200);
  });
  it("upgrades existing cookies and renews both sync streams without creating a new session", async () => {
    const cookie = await login("b");
    const expected = `${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
    for (const path of ["me", "sync?since=0", "todo-sync?since=0"]) {
      const response = await call(path, undefined, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBe(expected);
    }
    for (const [path, entry] of [
      ["sync", example({ id: crypto.randomUUID() })],
      ["todo-sync", exampleTodo({ id: crypto.randomUUID() })]
    ] as const) {
      const response = await call(path, {
        mutations: [{ id: crypto.randomUUID(), expectedRevision: 0, entry }]
      }, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBe(expected);
    }
    for (const invalid of [undefined, "splitty-local=invalid", `splitty-local=${"X".repeat(43)}`]) {
      const response = await call("me", undefined, invalid);
      expect(response.status).toBe(401);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    const invalidRequest = await call("sync?since=-1", undefined, cookie);
    expect(invalidRequest.status).toBe(400);
    expect(invalidRequest.headers.has("set-cookie")).toBe(false);
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
  it("shares manual todos between both members while keeping expense history compatible", async () => {
    process.env.HOUSEHOLD_ID = `test-${crypto.randomUUID()}`;
    partitions.push(process.env.HOUSEHOLD_ID);
    const a = await login("a"), b = await login("b");
    const todo = exampleTodo({ id: "same-id", description: "Call after lunch" });
    const mutation = { id: "same-operation", entry: todo, expectedRevision: 0 };
    expect((await call("todo-sync", { mutations: [mutation] }, a)).status).toBe(200);
    const expense = { id: "same-operation", entry: example({ id: "same-id" }), expectedRevision: 0 };
    expect((await call("sync", { mutations: [expense] }, b)).status).toBe(200);
    expect(await (await call("todo-sync?since=0", undefined, b)).json()).toMatchObject({
      entries: [{ id: "same-id", title: todo.title, description: "Call after lunch", done: false }], cursor: 1
    });
    expect(await (await call("sync?since=0", undefined, a)).json()).toMatchObject({
      entries: [{ id: "same-id", kind: "expense" }], cursor: 1
    });

    const completed = { id: "complete", expectedRevision: 1, entry: { ...todo, title: "Booked", done: true, revision: 2 } };
    expect((await call("todo-sync", { mutations: [completed] }, b)).status).toBe(200);
    const replay = await call("todo-sync", { mutations: [mutation] }, a);
    expect((await replay.json() as MutationResult<Todo>[])[0]).toMatchObject({ status: "ok", entry: { title: "Booked", done: true, revision: 2 } });
    const stale = { id: "stale", expectedRevision: 1, entry: { ...todo, title: "Stale A edit", revision: 2 } };
    const conflict = await call("todo-sync", { mutations: [stale] }, a);
    expect((await conflict.json() as MutationResult<Todo>[])[0]).toMatchObject({ status: "conflict", entry: { title: "Booked", revision: 2 } });
    const reopened = { id: "reopen", expectedRevision: 2, entry: { ...todo, description: "", revision: 3 } };
    await call("todo-sync", { mutations: [reopened] }, b);
    const deleted = { id: "delete", expectedRevision: 3, entry: { ...todo, revision: 4, deleted: true } };
    await call("todo-sync", { mutations: [deleted] }, a);
    const changes = await (await call("todo-sync?since=1", undefined, b)).json() as SyncPage<Todo>;
    expect(changes.entries.map((entry) => [entry.done, entry.deleted])).toEqual([[true, false], [false, false], [false, true]]);
    expect(changes.entries[1]).not.toHaveProperty("description");
    expect(await (await call("sync?since=1", undefined, b)).json()).toEqual({ entries: [], cursor: 1, more: false });
  });
  it("validates todo fields and versions before applying any member's batch", async () => {
    const cookie = await login("a");
    const todo = exampleTodo({ id: crypto.randomUUID() });
    const change = { id: crypto.randomUUID(), expectedRevision: 0, entry: todo };
    expect((await call("todo-sync", { mutations: [change, { ...change, id: "invalid", entry: { ...todo, title: " " } }] }, cookie)).status).toBe(400);
    expect((await call("todo-sync", { mutations: [{ ...change, expectedRevision: 1 }] }, cookie)).status).toBe(400);
    expect((await call("todo-sync?since=-1", undefined, cookie)).status).toBe(400);
    expect((await call("todo-sync", { mutations: [{ ...change, entry: { ...todo, description: "a".repeat(2001) } }] }, cookie)).status).toBe(400);
    const { ledger } = await tables(getConfig());
    const history = await todoLedger.readChanges(ledger, process.env.HOUSEHOLD_ID!, 0);
    expect(history.entries.some((entry) => entry.id === todo.id)).toBe(false);
  });
  it("isolates todo history by household and serializes concurrent writers", async () => {
    const { ledger } = await tables(getConfig());
    const pk = `test-${crypto.randomUUID()}`, other = `test-${crypto.randomUUID()}`;
    partitions.push(pk, other);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => todoLedger.applyMutation(ledger, pk, {
      id: `concurrent-${i}`, expectedRevision: 0, entry: exampleTodo({ title: `Edit ${i}` })
    })));
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(7);
    expect((await todoLedger.readChanges(ledger, pk, 0)).entries).toHaveLength(1);
    expect(await todoLedger.readChanges(ledger, other, 0)).toEqual({ entries: [], cursor: 0, more: false });
    expect(await readChanges(ledger, pk, 0)).toEqual({ entries: [], cursor: 0, more: false });
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
