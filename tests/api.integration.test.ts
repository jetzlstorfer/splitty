import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handler } from "../api/src/handler";
import { getConfig } from "../api/src/config";
import { tables } from "../api/src/storage";
import { createMembership, createUserSession, revokeMembership } from "../api/src/auth";
import { applyMutation, readChanges, todoLedger } from "../api/src/ledger";
import { consumeInvitation, inspectInvitation } from "../api/src/invitations";
import { beginEntraSignIn } from "../api/src/entra";
import { consumeRateLimit } from "../api/src/rateLimit";
import { example, exampleTodo } from "./fixtures";
import type { MutationResult, SyncPage } from "../shared/model";
import type { Todo } from "../shared/todo";

const enabled = process.env.RUN_AZURE_TESTS === "1";
const origin = "http://127.0.0.1:5173";
let household: string;
const partitions: string[] = [];
const logger = vi.fn();

async function call(
  path: string, data?: unknown, cookie?: string, requestOrigin = origin,
  requestContext?: { userId: string; householdId: string }
) {
  return handler(new Request(`${origin}/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestContext ? {
        "X-Splitty-User": requestContext.userId,
        "X-Splitty-Household": requestContext.householdId
      } : {}),
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
      APP_ORIGIN: origin, HOUSEHOLD_ID: household,
      TABLE_STORAGE_CONNECTION_STRING: process.env.TABLE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true",
      TABLE_STORAGE_ACCOUNT_NAME: "", TABLE_STORAGE_TENANT_ID: "",
      TABLE_STORAGE_CLIENT_ID: "", TABLE_STORAGE_CLIENT_SECRET: "",
      MEMBER_A_TOKEN: "A".repeat(43), MEMBER_B_TOKEN: "B".repeat(43),
      MEMBER_A_NAME: "Alex", MEMBER_B_NAME: "Sam", LOCAL_DEVELOPMENT: "true",
      ENTRA_AUTHORITY: "https://splittytest.ciamlogin.com/00000000-0000-4000-8000-000000000003",
      ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
      ENTRA_CLIENT_SECRET: "test-client-secret"
    });
  });
  afterAll(async () => {
    const clients = await tables(getConfig());
    for (const pk of partitions) {
      for (const table of [clients.ledger, clients.auth]) {
        for (const partitionKey of [pk, `auth-${pk}`, `h-${pk}`]) {
          for await (const entity of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${partitionKey}'` } })) {
            await table.deleteEntity(partitionKey, entity.rowKey!);
          }
        }
      }
    }
    for await (const entity of clients.auth.listEntities({ queryOptions: { filter: "PartitionKey eq 'sessions'" } })) {
      await clients.auth.deleteEntity("sessions", entity.rowKey!);
    }
    for (const partitionKey of ["entra-transactions", "device-bootstrap", "users"]) {
      for await (const entity of clients.auth.listEntities({ queryOptions: { filter: `PartitionKey eq '${partitionKey}'` } })) {
        await clients.auth.deleteEntity(partitionKey, entity.rowKey!);
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
  it("advertises configured provider sign-in and rejects an unverified callback", async () => {
    const options = await call("auth/config");
    expect(await options.json()).toEqual({ entraEnabled: true, legacyEnabled: true });
    const callback = await call("auth/callback?state=not-the-cookie&code=unused", undefined, "wrong-state");
    expect(callback.status).toBe(400);
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
    process.env.MEMBER_A_TOKEN = "C".repeat(43);
    expect((await call("me", undefined, cookie)).status).toBe(401);
    process.env.MEMBER_A_TOKEN = token;
    const signedOut = await call("auth/logout", {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("me", undefined, cookie)).status).toBe(401);
  });
  it("restores a lost cookie from the device key until the session is revoked", async () => {
    const token = "B".repeat(43);
    const signedIn = await call("auth/token", { token });
    const { deviceKey } = await signedIn.json() as { deviceKey: string };
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toBe(`splitty-local=${deviceKey}`);
    expect((await call("me")).status).toBe(401);

    const resumed = await call("auth/resume", { deviceKey });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("set-cookie")).toBe(`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect(await (await call("me", undefined, cookie)).json()).toMatchObject({ member: "b" });
    expect((await call("auth/resume", { deviceKey }, undefined, "https://evil.example")).status).toBe(403);
    expect((await call("auth/resume", { deviceKey: "short" })).status).toBe(400);
    expect((await call("auth/resume", { deviceKey: "X".repeat(43) })).status).toBe(401);

    process.env.MEMBER_B_TOKEN = "D".repeat(43);
    try {
      const rotated = await call("auth/resume", { deviceKey });
      expect(rotated.status).toBe(401);
      expect(rotated.headers.has("set-cookie")).toBe(false);
    } finally { process.env.MEMBER_B_TOKEN = token; }

    // A device that already lost its cookie can still revoke its session.
    expect((await call("auth/logout", { deviceKey })).status).toBe(200);
    expect((await call("auth/resume", { deviceKey })).status).toBe(401);
    expect((await call("me", undefined, cookie)).status).toBe(401);
  });
  it("binds a session to its active household membership, not a request parameter", async () => {
    const householdId = `tenant-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    partitions.push(householdId);
    const { auth, ledger } = await tables(getConfig());
    const context = { userId, householdId, member: "b" as const };
    await createMembership(auth, householdId, userId, context.member);
    const { cookie, deviceKey } = await createUserSession(getConfig(), auth, context);

    expect(await (await call("me", undefined, cookie)).json()).toMatchObject({
      userId, householdId, member: "b"
    });
    const write = await call("sync?householdId=attacker-household", {
      householdId: "attacker-household",
      mutations: [{ id: "tenant-write", expectedRevision: 0, entry: example() }]
    }, cookie, origin, context);
    expect(write.status).toBe(200);
    expect((await readChanges(ledger, householdId, 0)).entries).toHaveLength(1);
    expect(await readChanges(ledger, "attacker-household", 0)).toMatchObject({ entries: [], cursor: 0 });
    const staleContext = await call("sync", {
      mutations: [{ id: "cross-account-write", expectedRevision: 0, entry: example() }]
    }, cookie, origin, { userId: "user-other", householdId });
    expect(staleContext.status).toBe(409);
    expect((await readChanges(ledger, householdId, 0)).entries).toHaveLength(1);

    await revokeMembership(auth, householdId, userId);
    expect((await call("me", undefined, cookie)).status).toBe(401);
    expect((await call("auth/resume", { deviceKey })).status).toBe(401);
    expect((await call("sync", { mutations: [{ id: "after-revocation", expectedRevision: 1, entry: example({ revision: 2 }) }] }, cookie, origin, context)).status).toBe(401);
    await createMembership(auth, householdId, userId, context.member);
    expect((await call("auth/resume", { deviceKey })).status).toBe(401);
  });
  it("redeems device bootstrap codes once and only for the signed-in user", async () => {
    const householdId = `bootstrap-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const otherUserId = `user-${crypto.randomUUID()}`;
    partitions.push(householdId);
    const { auth } = await tables(getConfig());
    await createMembership(auth, householdId, userId, "a");
    await createMembership(auth, householdId, otherUserId, "b");
    const owner = await createUserSession(getConfig(), auth, { userId, householdId, member: "a" });
    const other = await createUserSession(getConfig(), auth, { userId: otherUserId, householdId, member: "b" });
    const code = randomBytes(32).toString("base64url");
    const deviceKey = "D".repeat(43);
    await auth.createEntity({
      partitionKey: "device-bootstrap",
      rowKey: `b-${createHash("sha256").update(code).digest("hex")}`,
      userId,
      deviceKey,
      expiresAt: Date.now() + 60_000
    });

    expect((await call("auth/device-key", { code }, other.cookie.split(";")[0])).status).toBe(401);
    expect(await (await call("auth/device-key", { code }, owner.cookie.split(";")[0])).json()).toEqual({ deviceKey });
    expect((await call("auth/device-key", { code }, owner.cookie.split(";")[0])).status).toBe(401);
  });
  it("creates, lists, and revokes household invitations without storing the secret", async () => {
    const householdId = `invite-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    partitions.push(householdId);
    const { auth } = await tables(getConfig());
    await auth.createEntity({
      partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: ""
    });
    await createMembership(auth, householdId, userId, "a");
    const owner = await createUserSession(getConfig(), auth, { userId, householdId, member: "a" });
    const cookie = owner.cookie.split(";")[0];

    const created = await call("household/invitations", {}, cookie);
    expect(created.status).toBe(201);
    const { invitation, code } = await created.json() as {
      invitation: { id: string; slot: string; expiresAt: number };
      code: string;
    };
    expect(invitation).toMatchObject({ slot: "b" });
    expect(invitation.expiresAt).toBeGreaterThan(Date.now());
    const storedInvitation = await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, `i-${invitation.id}`);
    expect(invitation.expiresAt - Number(storedInvitation.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(code).toMatch(new RegExp(`^${householdId}\\.[a-zA-Z0-9_-]{43}$`));
    expect(invitation.id).not.toBe(code);
    expect(JSON.stringify(storedInvitation)).not.toContain(code);
    expect(await (await call("household/invitations", undefined, cookie)).json()).toEqual({ invitations: [invitation] });
    expect((await call("household/invitations", {}, cookie)).status).toBe(409);

    const otherHousehold = `invite-other-${crypto.randomUUID()}`;
    const otherUser = `user-${crypto.randomUUID()}`;
    partitions.push(otherHousehold);
    await auth.createEntity({
      partitionKey: `h-${otherHousehold}`, rowKey: "household", nameA: "Other", nameB: ""
    });
    await createMembership(auth, otherHousehold, otherUser, "a");
    const outsider = await createUserSession(getConfig(), auth, { userId: otherUser, householdId: otherHousehold, member: "a" });
    expect((await call("household/invitations/revoke", { id: invitation.id }, outsider.cookie.split(";")[0])).status).toBe(404);

    expect((await call("household/invitations/revoke", { id: invitation.id }, cookie)).status).toBe(200);
    expect(await (await call("household/invitations", undefined, cookie)).json()).toEqual({ invitations: [] });
    expect((await call("household/invitations/revoke", { id: invitation.id }, cookie)).status).toBe(404);
    expect((await call("household/invitations/revoke", { id: "invalid" }, cookie)).status).toBe(400);

    const second = await (await call("household/invitations", {}, cookie)).json() as {
      invitation: { id: string };
      code: string;
    };
    const signIn = await beginEntraSignIn(
      getConfig(), auth, { getAuthCodeUrl: async () => "https://splittytest.ciamlogin.com/authorize" },
      second.code, true
    );
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toContain("splitty-entra-state=");
    const transactions = [];
    for await (const transaction of auth.listEntities<Record<string, unknown>>({
      queryOptions: { filter: "PartitionKey eq 'entra-transactions'" }
    })) transactions.push(transaction);
    const loginTransaction = transactions.find((transaction) => transaction.inviteId === second.invitation.id);
    expect(loginTransaction).toBeDefined();
    expect(JSON.stringify(loginTransaction)).not.toContain(second.code);
    if (typeof loginTransaction?.rowKey === "string") {
      await auth.deleteEntity("entra-transactions", loginTransaction.rowKey);
    }

    const target = await inspectInvitation(auth, second.code);
    const joinedUser = `user-${crypto.randomUUID()}`;
    await consumeInvitation(auth, target, joinedUser);
    expect(await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, `m-${joinedUser}`)).toMatchObject({
      userId: joinedUser, member: "b", active: true
    });
    expect((await call("household/invitations", undefined, cookie).then((response) => response.json())).invitations).toEqual([]);
    await expect(consumeInvitation(auth, target, `user-${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 410 });
    expect((await call("household/invitations", {}, cookie)).status).toBe(409);
  });
  it("renames members, removes access, and schedules empty-household deletion", async () => {
    const householdId = `lifecycle-${crypto.randomUUID()}`;
    const userA = `user-${crypto.randomUUID()}`, userB = `user-${crypto.randomUUID()}`;
    partitions.push(householdId);
    const { auth } = await tables(getConfig());
    await auth.createEntity({
      partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: "Sam"
    });
    for (const [userId, member] of [[userA, "a"], [userB, "b"]] as const) {
      await auth.createEntity({
        partitionKey: "users", rowKey: `u-${userId}`, userId, issuer: "test", subject: userId,
        householdId, member, membershipInitialized: true
      });
      await createMembership(auth, householdId, userId, member);
    }
    const ownerContext = { userId: userA, householdId, member: "a" as const };
    const owner = await createUserSession(getConfig(), auth, ownerContext);
    const other = await createUserSession(getConfig(), auth, { userId: userB, householdId, member: "b" });
    const ownerCookie = owner.cookie.split(";")[0], otherCookie = other.cookie.split(";")[0];

    expect((await call("household/member-name", { slot: "b", name: "Sammy" }, ownerCookie)).status).toBe(200);
    expect(await (await call("me", undefined, ownerCookie)).json()).toMatchObject({ nameB: "Sammy" });
    expect((await call("household/remove-member", {}, ownerCookie)).status).toBe(200);
    expect((await call("me", undefined, otherCookie)).status).toBe(401);
    expect(await auth.getEntity<Record<string, unknown>>("users", `u-${userB}`)).toMatchObject({
      householdId: "", member: "", membershipInitialized: false
    });

    const inviteResponse = await call("household/invitations", {}, ownerCookie);
    expect(inviteResponse.status).toBe(201);
    const { code } = await inviteResponse.json() as { code: string };
    expect((await call("household/leave", {}, ownerCookie)).status).toBe(200);
    expect((await call("me", undefined, ownerCookie)).status).toBe(401);
    await expect(inspectInvitation(auth, code)).rejects.toMatchObject({ status: 410 });
    const household = await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, "household");
    expect(household.deletedAt).toEqual(expect.any(Number));
    expect(household.purgeAfter).toBeGreaterThan(Number(household.deletedAt));
  });
  it("deletes an account without interrupting the other member's household access", async () => {
    const householdId = `delete-account-${crypto.randomUUID()}`;
    const userA = `user-${crypto.randomUUID()}`, userB = `user-${crypto.randomUUID()}`;
    partitions.push(householdId);
    const { auth } = await tables(getConfig());
    await auth.createEntity({
      partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: "Sam"
    });
    for (const [userId, member] of [[userA, "a"], [userB, "b"]] as const) {
      await auth.createEntity({
        partitionKey: "users", rowKey: `u-${userId}`, userId, issuer: "test", subject: userId,
        householdId, member, membershipInitialized: true
      });
      await createMembership(auth, householdId, userId, member);
    }
    const owner = await createUserSession(getConfig(), auth, { userId: userA, householdId, member: "a" });
    const other = await createUserSession(getConfig(), auth, { userId: userB, householdId, member: "b" });
    expect((await call("account/delete", {}, owner.cookie.split(";")[0])).status).toBe(200);
    expect((await call("me", undefined, owner.cookie.split(";")[0])).status).toBe(401);
    expect((await call("me", undefined, other.cookie.split(";")[0])).status).toBe(200);
    expect(await auth.getEntity<Record<string, unknown>>("users", `u-${userA}`)).toMatchObject({
      deletionRequestedAt: expect.any(Number), purgeAfter: expect.any(Number)
    });
    expect(await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, "household"))
      .toMatchObject({ nameA: "", nameB: "Sam" });
  });
  it("enforces active-record and daily household quotas with retry guidance", async () => {
    const expenseHousehold = `quota-expenses-${crypto.randomUUID()}`;
    process.env.HOUSEHOLD_ID = expenseHousehold;
    partitions.push(expenseHousehold);
    const { ledger } = await tables(getConfig());
    await ledger.createEntity({
      partitionKey: expenseHousehold, rowKey: "usage", day: new Date().toISOString().slice(0, 10),
      dailyChanges: 0, activeExpenses: 20_000, activeTodos: 0
    });
    const expenseResponse = await call("sync", {
      mutations: [{ id: "over-expense-limit", expectedRevision: 0, entry: example() }]
    }, await login("a"));
    expect(expenseResponse.status).toBe(429);
    expect(expenseResponse.headers.get("retry-after")).toBe("3600");

    const todoHousehold = `quota-todos-${crypto.randomUUID()}`;
    process.env.HOUSEHOLD_ID = todoHousehold;
    partitions.push(todoHousehold);
    await ledger.createEntity({
      partitionKey: todoHousehold, rowKey: "usage", day: new Date().toISOString().slice(0, 10),
      dailyChanges: 0, activeExpenses: 0, activeTodos: 2_000
    });
    const todoResponse = await call("todo-sync", {
      mutations: [{ id: "over-todo-limit", expectedRevision: 0, entry: exampleTodo() }]
    }, await login("a"));
    expect(todoResponse.status).toBe(429);
    expect(todoResponse.headers.get("retry-after")).toBe("3600");

    const dailyHousehold = `quota-daily-${crypto.randomUUID()}`;
    process.env.HOUSEHOLD_ID = dailyHousehold;
    partitions.push(dailyHousehold);
    await ledger.createEntity({
      partitionKey: dailyHousehold, rowKey: "usage", day: new Date().toISOString().slice(0, 10),
      dailyChanges: 4_999, activeExpenses: 0, activeTodos: 0
    });
    const cookie = await login("a");
    const finalAllowedChange = await call("sync", {
      mutations: [{ id: "final-daily-change", expectedRevision: 0, entry: example() }]
    }, cookie);
    expect(finalAllowedChange.status).toBe(200);
    const dailyResponse = await call("todo-sync", {
      mutations: [{ id: "over-daily-limit", expectedRevision: 0, entry: exampleTodo() }]
    }, cookie);
    expect(dailyResponse.status).toBe(429);
    expect(Number(dailyResponse.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(dailyResponse.headers.get("retry-after"))).toBeLessThanOrEqual(86_400);
  });
  it("enforces atomic fixed-window rate limits and resets after the window", async () => {
    const { auth } = await tables(getConfig());
    const key = `integration-${crypto.randomUUID()}`;
    const start = 1_000_000;
    await consumeRateLimit(auth, key, 2, 10_000, start);
    await consumeRateLimit(auth, key, 2, 10_000, start + 1);
    await expect(consumeRateLimit(auth, key, 2, 10_000, start + 2))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 10 });
    await consumeRateLimit(auth, key, 2, 10_000, start + 10_000);
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
