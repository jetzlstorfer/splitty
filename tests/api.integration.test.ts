import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handler } from "../api/src/handler";
import { getConfig } from "../api/src/config";
import { statusCode, tables } from "../api/src/storage";
import { createMembership, createUserSession, revokeMembership } from "../api/src/auth";
import { applyMutation, readChanges, todoLedger } from "../api/src/ledger";
import { consumeInvitation, createInvitation, inspectInvitation, revokeInvitation } from "../api/src/invitations";
import { createAdditionalHousehold, joinHousehold } from "../api/src/households";
import { listUserMemberships } from "../api/src/membershipIndex";
import { beginEntraSignIn, completeEntraSignIn } from "../api/src/entra";
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
  requestContext?: { userId: string; householdId: string } | null
) {
  let context = requestContext;
  if (cookie && context === undefined) {
    const raw = cookie.slice(cookie.indexOf("=") + 1);
    try {
      const { auth } = await tables(getConfig());
      const session = await auth.getEntity<{ userId: string; householdId: string }>(
        "sessions", `s-${createHash("sha256").update(raw).digest("hex")}`
      );
      context = { userId: session.userId, householdId: session.householdId };
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }
  return handler(new Request(`${origin}/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(context ? {
        "X-Splitty-User": context.userId,
        "X-Splitty-Household": context.householdId
      } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json", Origin: requestOrigin })
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  }), logger);
}

async function login(member: "a" | "b"): Promise<string> {
  const signedIn = await call("auth/local", { member });
  expect(signedIn.status).toBe(200);
  return signedIn.headers.get("set-cookie")!.split(";")[0];
}

async function seedAccounts(...ids: string[]) {
  const { auth } = await tables(getConfig());
  for (const userId of ids) await auth.createEntity({ partitionKey: "users", rowKey: `u-${userId}`, userId });
}

describe.skipIf(!enabled)("Azure Table Storage integration (Azurite)", () => {
  beforeAll(() => {
    household = `test-${crypto.randomUUID()}`;
    partitions.push(household);
    Object.assign(process.env, {
      APP_ORIGIN: origin, LOCAL_HOUSEHOLD_ID: household,
      TABLE_STORAGE_CONNECTION_STRING: process.env.TABLE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true",
      TABLE_STORAGE_ACCOUNT_NAME: "", TABLE_STORAGE_TENANT_ID: "",
      TABLE_STORAGE_CLIENT_ID: "", TABLE_STORAGE_CLIENT_SECRET: "",
      LOCAL_MEMBER_A_NAME: "Alex", LOCAL_MEMBER_B_NAME: "Sam", LOCAL_DEVELOPMENT: "true",
      ALLOW_NEW_HOUSEHOLDS: "true",
      ENTRA_AUTHORITY: "https://splittytest.ciamlogin.com/00000000-0000-4000-8000-000000000003",
      ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
      ENTRA_CLIENT_SECRET: "test-client-secret"
    });
  });
  afterAll(async () => {
    const clients = await tables(getConfig());
    for (const pk of partitions) {
      for (const table of [clients.ledger, clients.auth]) {
        for (const partitionKey of [pk, `h-${pk}`]) {
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
    expect((await call("auth/local", { member: "a" }, undefined, "https://evil.example")).status).toBe(403);
    expect((await call("auth/local", { member: "invalid" })).status).toBe(400);
  });
  it("rejects local sign-in outside development before initializing storage", async () => {
    const previous = {
      local: process.env.LOCAL_DEVELOPMENT,
      origin: process.env.APP_ORIGIN,
      household: process.env.LOCAL_HOUSEHOLD_ID
    };
    process.env.LOCAL_DEVELOPMENT = "false";
    process.env.APP_ORIGIN = "https://splitty.example";
    delete process.env.LOCAL_HOUSEHOLD_ID;
    try {
      expect((await call("auth/local", { member: "a" }, undefined, "https://splitty.example")).status).toBe(404);
    } finally {
      process.env.LOCAL_DEVELOPMENT = previous.local!;
      process.env.APP_ORIGIN = previous.origin!;
      if (previous.household === undefined) delete process.env.LOCAL_HOUSEHOLD_ID;
      else process.env.LOCAL_HOUSEHOLD_ID = previous.household;
    }
  });
  it("advertises configured provider sign-in and rejects an unverified callback", async () => {
    const options = await call("auth/config");
    expect(await options.json()).toEqual({
      entraEnabled: true, localSignInEnabled: true, newHouseholdsEnabled: true
    });
    const callback = await call("auth/callback?state=not-the-cookie&code=unused", undefined, "wrong-state");
    expect(callback.status).toBe(400);
  });
  it("returns the current session's provider and profile after sign-in and cookie restoration", async () => {
    const config = getConfig();
    const { auth } = await tables(config);
    const subject = crypto.randomUUID();
    const email = "alex@example.invalid";
    const account = { username: email, environment: "splittytest.ciamlogin.com", tenantId: "test", localAccountId: subject, homeAccountId: subject };
    const token = {
      authority: config.entra!.authority, uniqueId: subject, tenantId: "test", account,
      idToken: "", accessToken: "", fromCache: false, expiresOn: null, tokenType: "Bearer", correlationId: "", scopes: []
    };
    const acquireTokenSilent = vi.fn(async () => ({ ...token, accessToken: "synthetic-graph-token" }));
    async function signIn(idp: string | undefined, name: string, picture?: string) {
      const start = await beginEntraSignIn(config, auth, {
        getAuthCodeUrl: async () => "https://splittytest.ciamlogin.com/authorize"
      });
      const cookie = start.headers.get("set-cookie")!.split(";")[0];
      const state = cookie.slice(cookie.indexOf("=") + 1);
      return completeEntraSignIn(new Request(`${origin}/api/auth/callback?state=${state}&code=synthetic-code`, {
        headers: { cookie }
      }), config, auth, {
        acquireTokenByCode: async () => ({
          ...token, idTokenClaims: { iss: config.entra!.authority, sub: subject, email, name, idp, picture }
        }),
        acquireTokenSilent
      });
    }
    const first = await signIn("google.com", "Alex Sample", "https://profiles.example.invalid/alex.png");
    const firstCookie = first.headers.get("set-cookie")!.split(";")[0];
    const firstMe = await call("me", undefined, firstCookie);
    expect(firstMe.status).toBe(200);
    const profile = await firstMe.json();
    partitions.push(profile.householdId);
    expect(profile).toMatchObject({
      signInProvider: "google", displayName: "Alex Sample", email: "alex@example.invalid",
      pictureUrl: "https://profiles.example.invalid/alex.png"
    });
    expect(profile).not.toHaveProperty("subject");
    const resumed = await call("auth/resume", { deviceKey: firstCookie.slice(firstCookie.indexOf("=") + 1) });
    expect(resumed.status).toBe(200);
    expect(await (await call("me", undefined, resumed.headers.get("set-cookie")!.split(";")[0])).json())
      .toEqual(profile);

    const second = await signIn("live.com", "Alex Updated");
    const secondProfile = await (await call("me", undefined, second.headers.get("set-cookie")!.split(";")[0])).json();
    expect(secondProfile).toMatchObject({ signInProvider: "microsoft", displayName: "Alex Updated" });
    expect(secondProfile).not.toHaveProperty("pictureUrl");
    expect(acquireTokenSilent).not.toHaveBeenCalled();
    const graph = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    try {
      for (const [expected, identity] of [
        ["email", { signInType: "emailAddress", issuer: "example.onmicrosoft.com" }],
        ["microsoft", { signInType: "federated", issuer: "MicrosoftAccount" }]
      ] as const) {
        graph.mockResolvedValueOnce(Response.json({ identities: [identity, { signInType: "userPrincipalName" }] }));
        const session = await signIn(undefined, "Alex");
        const me = await call("me", undefined, session.headers.get("set-cookie")!.split(";")[0]);
        expect(await me.json()).toMatchObject({ userId: profile.userId, email, signInProvider: expected });
        expect(acquireTokenSilent).toHaveBeenLastCalledWith({ account, scopes: ["https://graph.microsoft.com/User.Read"] });
        expect(graph).toHaveBeenLastCalledWith("https://graph.microsoft.com/v1.0/me?$select=identities", expect.objectContaining({
          headers: { Authorization: "Bearer synthetic-graph-token" }, redirect: "error"
        }));
      }
      acquireTokenSilent.mockRejectedValueOnce(new Error("Missing delegated consent"));
      const session = await signIn(undefined, "Alex");
      const me = await call("me", undefined, session.headers.get("set-cookie")!.split(";")[0]);
      expect(await me.json()).toMatchObject({ userId: profile.userId, signInProvider: "unknown" });
      expect(graph).toHaveBeenCalledTimes(2);
    } finally { graph.mockRestore(); }
    expect(await (await call("me", undefined, firstCookie)).json()).toEqual(profile);
    const local = await (await call("me", undefined, await login("a"))).json();
    expect(local).toMatchObject({ signInProvider: "local", displayName: "Alex" });
    expect(local).not.toHaveProperty("email");
    expect(local).not.toHaveProperty("pictureUrl");
  });
  it("shares the insurance reminder setting only within the authenticated household and rejects stale changes", async () => {
    const path = "household/insurance-todos", a = await login("a"), b = await login("b");
    const change = { enabled: false, revision: 0 };
    expect((await call(path, change)).status).toBe(401);
    expect((await call(path, change, a, origin, { userId: "other", householdId: "other" })).status).toBe(409);
    expect((await call(path, { ...change, enabled: "false" }, a)).status).toBe(400);
    expect(await (await call(path, undefined, b)).json()).toEqual({ enabled: true, revision: 0 });
    expect(await (await call(path, change, a)).json()).toEqual({ enabled: false, revision: 1 });
    expect(await (await call(path, undefined, b)).json()).toEqual({ enabled: false, revision: 1 });
    expect(await (await call(path, { enabled: true, revision: 1 }, b)).json()).toEqual({ enabled: true, revision: 2 });
    expect(await (await call(path, change, a)).json()).toEqual({ enabled: true, revision: 2 });
  });
  it("supports local-development sign-in and revokes sessions", async () => {
    const consumed = await call("auth/local", { member: "a" });
    expect(consumed.status).toBe(200);
    const cookie = consumed.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=34560000");
    const secondSession = await call("auth/local", { member: "a" });
    expect(secondSession.status).toBe(200);
    const me = await call("me", undefined, cookie);
    expect(await me.json()).toMatchObject({ member: "a" });
    const signedOut = await call("auth/logout", {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("me", undefined, cookie)).status).toBe(401);
  });
  it("restores a lost cookie from the device key until the session is revoked", async () => {
    const signedIn = await call("auth/local", { member: "b" });
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
    await seedAccounts(userId);
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
    expect((await call("sync", {
      mutations: [{ id: "missing-context-write", expectedRevision: 0, entry: example() }]
    }, cookie, origin, null)).status).toBe(409);
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
    await seedAccounts(userId, otherUserId);
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
    await seedAccounts(userId);
    await auth.createEntity({
      partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: ""
    });
    await createMembership(auth, householdId, userId, "a");
    const owner = await createUserSession(getConfig(), auth, { userId, householdId, member: "a" });
    const cookie = owner.cookie.split(";")[0];
    expect(await (await call("me", undefined, cookie)).json()).toMatchObject({ otherMemberJoined: false });

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
    await seedAccounts(otherUser);
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
    const lateUser = `user-${crypto.randomUUID()}`;
    await seedAccounts(joinedUser, lateUser);
    await consumeInvitation(auth, target, joinedUser);
    expect(await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, `m-${joinedUser}`)).toMatchObject({
      userId: joinedUser, member: "b", active: true
    });
    expect((await call("household/invitations", undefined, cookie).then((response) => response.json())).invitations).toEqual([]);
    // A pending invitation is not a member; only the consumed one is.
    expect(await (await call("me", undefined, cookie)).json()).toMatchObject({ otherMemberJoined: true });
    await expect(consumeInvitation(auth, target, lateUser)).rejects.toMatchObject({ status: 410 });
    expect((await call("household/invitations", {}, cookie)).status).toBe(409);
  });
  it("uses the Entra name for an empty member slot without overwriting chosen names", async () => {
    const householdId = `entra-name-${crypto.randomUUID()}`;
    const ownerId = `user-${crypto.randomUUID()}`;
    await seedAccounts(ownerId);
    partitions.push(householdId);
    const { auth } = await tables(getConfig());
    await auth.createEntity({ partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Alex", nameB: "" });
    await createMembership(auth, householdId, ownerId, "a");
    const owner = await createUserSession(getConfig(), auth, { userId: ownerId, householdId, member: "a" });
    const ownerCookie = owner.cookie.split(";")[0];
    const { code } = await (await call("household/invitations", {}, ownerCookie)).json() as { code: string };
    const issuer = "https://issuer.example", subject = crypto.randomUUID();
    let displayName = "Sam Synthetic";
    const authorizationClient: NonNullable<Parameters<typeof completeEntraSignIn>[3]> = {
      acquireTokenSilent: async () => { throw new Error("Unexpected Graph token request"); },
      acquireTokenByCode: async () => ({
        authority: issuer, uniqueId: subject, tenantId: "test", scopes: [], account: null, idToken: "",
        idTokenClaims: { iss: issuer, sub: subject, email: "sam@example.invalid", name: displayName },
        accessToken: "", fromCache: false, expiresOn: null, tokenType: "Bearer", correlationId: ""
      })
    };
    async function signIn(invite?: string) {
      const start = await beginEntraSignIn(getConfig(), auth, {
        getAuthCodeUrl: async () => "https://splittytest.ciamlogin.com/authorize"
      }, invite, true);
      const cookie = start.headers.get("set-cookie")!.split(";")[0];
      const state = cookie.slice(cookie.indexOf("=") + 1);
      return completeEntraSignIn(new Request(`${origin}/api/auth/callback?state=${state}&code=synthetic-code`, {
        headers: { cookie }
      }), getConfig(), auth, authorizationClient);
    }

    expect((await signIn(code)).status).toBe(302);
    expect(await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, "household"))
      .toMatchObject({ nameA: "Alex", nameB: "Sam Synthetic" });
    expect((await call("household/member-name", { slot: "b", name: "Sammy" }, ownerCookie)).status).toBe(200);
    displayName = "Samuel Synthetic";
    expect((await signIn()).status).toBe(302);
    expect(await auth.getEntity<Record<string, unknown>>(`h-${householdId}`, "household"))
      .toMatchObject({ nameA: "Alex", nameB: "Sammy" });
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
    expect(await (await call("me", undefined, ownerCookie)).json()).toMatchObject({ nameB: "Sammy", otherMemberJoined: true });
    expect((await call("household/remove-member", {}, ownerCookie)).status).toBe(200);
    expect((await call("me", undefined, otherCookie)).status).toBe(401);
    expect(await (await call("me", undefined, ownerCookie)).json()).toMatchObject({ nameB: "", otherMemberJoined: false });
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
  it("lets one account join, create, switch between, and leave several households", async () => {
    const { auth } = await tables(getConfig());
    const userId = `user-${crypto.randomUUID()}`, ownerId = `user-${crypto.randomUUID()}`;
    const first = `multi-first-${crypto.randomUUID()}`, invited = `multi-invited-${crypto.randomUUID()}`;
    partitions.push(first, invited);
    for (const [householdId, id, name] of [[first, userId, "Una"], [invited, ownerId, "Olli"]] as const) {
      await auth.createEntity({ partitionKey: `h-${householdId}`, rowKey: "household", nameA: name, nameB: "" });
      await auth.createEntity({
        partitionKey: "users", rowKey: `u-${id}`, userId: id, issuer: "test", subject: id,
        name, householdId, member: "a", membershipInitialized: true
      });
      await createMembership(auth, householdId, id, "a");
    }
    const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
    const indexRows = async () => {
      const rows: string[] = [];
      for await (const row of auth.listEntities({ queryOptions: {
        filter: `PartitionKey eq 'users' and RowKey ge 'm-${userId}.' and RowKey lt 'm-${userId}/'`
      } })) rows.push(row.rowKey!);
      return rows;
    };
    // Each change replaces the device session, so the previous cookie stops working.
    async function change(path: string, data: unknown, cookie: string) {
      const response = await call(path, data, cookie);
      expect(response.status).toBe(200);
      const result = await response.json() as { householdId: string; member: string; deviceKey: string };
      expect(result.deviceKey).toMatch(/^[a-zA-Z0-9_-]{43}$/);
      expect((await call("me", undefined, cookie)).status).toBe(401);
      expect((await call("auth/resume", { deviceKey: cookie.slice(cookie.indexOf("=") + 1) })).status).toBe(401);
      const next = cookieOf(response);
      expect(await (await call("me", undefined, next)).json()).toMatchObject({
        userId, householdId: result.householdId, member: result.member
      });
      return { ...result, cookie: next };
    }

    const start = (await createUserSession(getConfig(), auth, { userId, householdId: first, member: "a" })).cookie.split(";")[0];
    // Memberships from before the index are found through the default household and indexed.
    await auth.deleteEntity("users", `m-${userId}.${first}`);
    expect(await (await call("households", undefined, start)).json()).toEqual({
      households: [{ householdId: first, member: "a", nameA: "Una", nameB: "", current: true }], canCreate: true
    });
    expect(await indexRows()).toEqual([`m-${userId}.${first}`]);

    const ownInvite = await (await call("household/invitations", {}, start)).json() as { code: string };
    const alreadyMember = await call("households/join", { inviteCode: ownInvite.code }, start);
    expect(alreadyMember.status).toBe(409);
    expect(await alreadyMember.json()).toEqual({ error: "This account is already a member of this household." });

    const owner = (await createUserSession(getConfig(), auth, { userId: ownerId, householdId: invited, member: "a" })).cookie.split(";")[0];
    const { code } = await (await call("household/invitations", {}, owner)).json() as { code: string };
    const joined = await change("households/join", { inviteCode: code }, start);
    expect(joined).toMatchObject({ householdId: invited, member: "b" });
    expect(await auth.getEntity<Record<string, unknown>>(`h-${invited}`, "household")).toMatchObject({ nameA: "Olli", nameB: "Una" });
    expect((await call("me", undefined, owner)).status).toBe(200);

    const created = await change("households/create", {}, joined.cookie);
    partitions.push(created.householdId);
    expect(created.member).toBe("a");
    expect(await auth.getEntity<Record<string, unknown>>(`h-${created.householdId}`, "household"))
      .toMatchObject({ nameA: "Una", nameB: "" });
    expect(await (await call("households", undefined, created.cookie)).json()).toEqual({
      households: [
        { householdId: first, member: "a", nameA: "Una", nameB: "", current: false },
        { householdId: invited, member: "b", nameA: "Olli", nameB: "Una", current: false },
        { householdId: created.householdId, member: "a", nameA: "Una", nameB: "", current: true }
      ],
      canCreate: true
    });
    expect(await auth.getEntity<Record<string, unknown>>("users", `u-${userId}`))
      .toMatchObject({ householdId: created.householdId, member: "a" });

    expect((await call("households/switch", { householdId: "not valid!" }, created.cookie)).status).toBe(400);
    expect((await call("households/switch", { householdId: `missing-${crypto.randomUUID()}` }, created.cookie)).status).toBe(404);
    const prepared = await (await call("households/prepare", {}, created.cookie)).json();
    expect((await call("auth/resume", { deviceKey: prepared.deviceKey })).status).toBe(401);
    const switched = await change("households/switch", { householdId: first, source: prepared.source }, created.cookie);
    expect(switched).toMatchObject({ householdId: first, member: "a" });
    // Even if no switch response headers arrive, the previously stored successor resumes only the target.
    const recovered = await call("auth/resume", { deviceKey: prepared.deviceKey });
    expect(recovered.status).toBe(200);
    expect(cookieOf(recovered)).toBe(switched.cookie);

    // A confirmation or editor in a stale tab still belongs to the household it displayed.
    for (const path of ["household/delete", "household/leave", "household/remove-member", "household/member-name",
      "household/invitations", "household/invitations/revoke", "households/create", "account/delete"]) {
      const stale = await call(path, {}, switched.cookie, origin, { userId, householdId: created.householdId });
      expect(stale.status, path).toBe(409);
      expect(await stale.json()).toEqual({ error: "The signed-in household changed. Retry sync on this device." });
    }
    expect((await call("household/delete", {}, switched.cookie, origin, null)).status).toBe(409);
    expect((await call("household/delete", {}, switched.cookie, origin, { userId: ownerId, householdId: first })).status).toBe(409);
    expect((await call("me", undefined, switched.cookie)).status).toBe(200);

    // Leaving or deleting continues in the account's next household instead of signing the device out.
    const left = await call("household/leave", {}, switched.cookie);
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ left: true, continued: true, userId, householdId: invited, member: "b" });
    expect((await call("me", undefined, switched.cookie)).status).toBe(401);
    expect(await (await call("me", undefined, cookieOf(left))).json()).toMatchObject({ householdId: invited, member: "b" });
    expect(await auth.getEntity<Record<string, unknown>>(`h-${first}`, "household"))
      .toMatchObject({ deletedAt: expect.any(Number) });

    const backToCreated = await change("households/switch", { householdId: created.householdId }, cookieOf(left));
    const deleted = await call("household/delete", {}, backToCreated.cookie);
    expect(await deleted.json()).toMatchObject({ deleted: true, continued: true, householdId: invited, member: "b" });
    const current = cookieOf(deleted);
    expect(await indexRows()).toEqual([`m-${userId}.${invited}`]);

    for (let index = 0; index < 9; index++) {
      const householdId = `multi-cap-${index}-${crypto.randomUUID()}`;
      partitions.push(householdId);
      await createMembership(auth, householdId, userId, "a");
    }
    expect(await (await call("households", undefined, current)).json()).toMatchObject({ canCreate: false });
    const overLimit = await call("households/create", {}, current);
    expect(overLimit.status).toBe(409);
    expect(await overLimit.json()).toEqual({ error: "This account already belongs to the maximum number of households." });

    const removed = await call("account/delete", {}, current);
    expect(await removed.json()).toEqual({ deletionScheduled: true });
    expect(removed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await indexRows()).toEqual([]);
    await expect(auth.getEntity("h-" + invited, `m-${userId}`)).rejects.toMatchObject({ statusCode: 404 });
    expect((await call("me", undefined, owner)).status).toBe(200);
  });
  it("reserves one final place across concurrent create, join and Entra invitation sign-in", async () => {
    const config = getConfig(), { auth } = await tables(config);
    const issuer = "https://issuer.example", subject = crypto.randomUUID();
    const userId = `user-${createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 40)}`;
    const homes = Array.from({ length: 11 }, () => `cap-${crypto.randomUUID()}`);
    partitions.push(...homes);
    const account = { userId, householdId: homes[0], member: "a" as const };
    await auth.createEntity({ partitionKey: "users", rowKey: `u-${userId}`, ...account, issuer, subject, membershipInitialized: true });
    for (const id of homes) await auth.createEntity({ partitionKey: `h-${id}`, rowKey: "household", nameA: "A", nameB: "" });
    for (const id of homes.slice(0, 9)) await createMembership(auth, id, userId, "a");
    const invite = async (id: string) => createInvitation(auth, { userId: "owner", householdId: id, member: "a" });
    const [join, entra] = await Promise.all([invite(homes[9]), invite(homes[10])]);
    const start = await beginEntraSignIn(config, auth, { getAuthCodeUrl: async () => "https://issuer.example/authorize" }, entra.code);
    const cookie = start.headers.get("set-cookie")!.split(";")[0], state = cookie.slice(cookie.indexOf("=") + 1);

    // Hold the first write so every contender reads nine, even on a fast local emulator.
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submit = auth.submitTransaction.bind(auth);
    const barrier = vi.spyOn(auth, "submitTransaction").mockImplementation(async (actions, options) => {
      if (actions.some(([, entity]) => entity.rowKey === `u-${userId}` && entity.pendingMembership)) {
        if (++arrived === 3) release();
        await gate;
      }
      return submit(actions, options);
    });
    try {
      const results = await Promise.allSettled([
        createAdditionalHousehold(auth, config, account), joinHousehold(auth, account, join.code),
        completeEntraSignIn(new Request(`${origin}/api/auth/callback?state=${state}&code=test`, { headers: { cookie } }), config, auth, {
          acquireTokenByCode: async () => ({
            authority: issuer, uniqueId: subject, tenantId: "test", scopes: [], account: null, idToken: "",
            idTokenClaims: { iss: issuer, sub: subject, email: "cap@example.invalid", name: "Member" },
            accessToken: "", fromCache: false, expiresOn: null, tokenType: "Bearer", correlationId: ""
          }),
          acquireTokenSilent: async () => { throw new Error("Unexpected Graph token request"); }
        })
      ]);
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({
        status: 409, message: "This account already belongs to the maximum number of households."
      });
      const memberships = await listUserMemberships(auth, userId);
      expect(memberships).toHaveLength(10);
      partitions.push(...memberships.map((m) => m.householdId).filter((id) => !homes.includes(id)));
      const actual = [];
      for await (const row of auth.listEntities({ queryOptions: { filter: `RowKey eq 'm-${userId}' and active eq true` } })) actual.push(row.partitionKey);
      expect(actual.sort()).toEqual(memberships.map((m) => `h-${m.householdId}`).sort());
      for (const [index, invitation] of [join, entra].entries()) {
        if (results[index + 1].status === "rejected") expect(await inspectInvitation(auth, invitation.code)).toMatchObject({ slot: "b" });
      }
    } finally { release(); barrier.mockRestore(); }
  }, 30_000);

  it("recovers an interrupted invitation reservation without charging a revoked invitation a place", async () => {
    const { auth } = await tables(getConfig());
    const userId = `user-${crypto.randomUUID()}`, householdId = `cap-${crypto.randomUUID()}`;
    partitions.push(householdId);
    await seedAccounts(userId);
    const owner = { userId: "owner", householdId, member: "a" as const };
    await auth.createEntity({ partitionKey: `h-${householdId}`, rowKey: "household", nameA: "Owner", nameB: "" });
    const invitation = await createInvitation(auth, owner);
    const target = await inspectInvitation(auth, invitation.code);
    const submit = auth.submitTransaction.bind(auth);
    const interrupted = vi.spyOn(auth, "submitTransaction").mockImplementation(async (actions, options) => {
      if (actions.some(([, entity]) => entity.rowKey === `m-${userId}`)) throw new Error("interrupted before household commit");
      return submit(actions, options);
    });
    try { await expect(consumeInvitation(auth, target, userId)).rejects.toThrow("interrupted before household commit"); }
    finally { interrupted.mockRestore(); }
    await revokeInvitation(auth, owner, target.id);
    const next = await createInvitation(auth, owner);
    await consumeInvitation(auth, await inspectInvitation(auth, next.code), userId);
    expect(await listUserMemberships(auth, userId)).toMatchObject([{ householdId, member: "b" }]);
    expect((await auth.getEntity("users", `u-${userId}`)).pendingMembership).toBe("");
  });
  it("finishes an unacknowledged household commit without reviving a membership that has since left", async () => {
    const { auth } = await tables(getConfig());
    const userId = `user-${crypto.randomUUID()}`, first = `cap-${crypto.randomUUID()}`, second = `cap-${crypto.randomUUID()}`;
    partitions.push(first, second);
    await seedAccounts(userId);
    const submit = auth.submitTransaction.bind(auth);
    const lostResponse = vi.spyOn(auth, "submitTransaction").mockImplementation(async (actions, options) => {
      const result = await submit(actions, options);
      if (actions.some(([, entity]) => entity.rowKey === `m-${userId}`)) throw new Error("lost commit response");
      return result;
    });
    try { await expect(createMembership(auth, first, userId, "a")).rejects.toThrow("lost commit response"); }
    finally { lostResponse.mockRestore(); }
    await revokeMembership(auth, first, userId);
    await createMembership(auth, second, userId, "a");
    expect(await listUserMemberships(auth, userId)).toMatchObject([{ householdId: second }]);
    await expect(auth.getEntity(`h-${first}`, `m-${userId}`)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("enforces active-record and daily household quotas with retry guidance", async () => {
    const expenseHousehold = `quota-expenses-${crypto.randomUUID()}`;
    process.env.LOCAL_HOUSEHOLD_ID = expenseHousehold;
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
    process.env.LOCAL_HOUSEHOLD_ID = todoHousehold;
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
    process.env.LOCAL_HOUSEHOLD_ID = dailyHousehold;
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
    process.env.LOCAL_HOUSEHOLD_ID = `test-${crypto.randomUUID()}`;
    partitions.push(process.env.LOCAL_HOUSEHOLD_ID);
    const a = await login("a"), b = await login("b");
    const mutation = { id: "new-entry", expectedRevision: 0, entry: example({ skipInsuranceTodo: true }) };
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
    expect((await replay.json() as MutationResult[])[0]).toMatchObject({ status: "ok", entry: { revision: 2, description: "Updated on B", skipInsuranceTodo: true } });
    const stale = { id: "stale-edit", expectedRevision: 1, entry: example({ revision: 2, description: "Stale A edit" }) };
    const conflict = await call("sync", { mutations: [stale] }, a);
    expect((await conflict.json() as MutationResult[])[0]).toMatchObject({ status: "conflict", entry: { revision: 2 } });
    const deletion = { id: "delete-entry", expectedRevision: 2, entry: example({ revision: 3, deleted: true }) };
    await call("sync", { mutations: [deletion] }, b);
    const final = await call("sync?since=1", undefined, a);
    expect((await final.json() as SyncPage).entries.map((entry) => entry.deleted)).toEqual([false, true]);
  });
  it("shares manual todos between both members while keeping expense history compatible", async () => {
    process.env.LOCAL_HOUSEHOLD_ID = `test-${crypto.randomUUID()}`;
    partitions.push(process.env.LOCAL_HOUSEHOLD_ID);
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
    const history = await todoLedger.readChanges(ledger, process.env.LOCAL_HOUSEHOLD_ID!, 0);
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
