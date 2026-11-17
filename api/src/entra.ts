import { createHash, randomBytes } from "node:crypto";
import { ConfidentialClientApplication } from "@azure/msal-node";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import { createMembership, createUserSession, type AuthContext } from "./auth";
import { HttpError, type Config } from "./config";
import { consumeInvitation, inspectInvitation, type InvitationTarget } from "./invitations";
import { consumeRateLimit } from "./rateLimit";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const randomValue = () => randomBytes(32).toString("base64url");
const transactionPartition = "entra-transactions";
const bootstrapPartition = "device-bootstrap";
const householdPartition = (householdId: string) => `h-${householdId}`;
const userPartition = "users";
const scopes = ["openid", "profile", "email"];
const transactionCookie = (config: Config) => config.local ? "splitty-entra-state" : "__Host-splitty-entra-state";

interface LoginTransaction {
  state: string; nonce: string; verifier: string; expiresAt: number;
  inviteHouseholdId?: string; inviteId?: string; inviteSlot?: Member;
}
interface UserRecord {
  userId: string; subject: string; issuer: string; householdId: string;
  member: Member | ""; membershipInitialized?: boolean; deletionRequestedAt?: number;
}
interface HouseholdRecord { nameA: string; nameB: string; deletedAt?: number }
interface BootstrapRecord { userId: string; deviceKey: string; expiresAt: number }

function client(config: Config): ConfidentialClientApplication {
  if (!config.entra) throw new HttpError(404, "Provider sign-in is not configured.");
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.entra.clientId,
      clientSecret: config.entra.clientSecret,
      authority: config.entra.authority,
      knownAuthorities: [new URL(config.entra.authority).hostname]
    }
  });
}

function redirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      ...(cookie ? { "Set-Cookie": cookie } : {})
    }
  });
}

export async function beginEntraSignIn(
  config: Config,
  table: Pick<TableClient, "createEntity" | "getEntity">,
  authorizationClient: Pick<ConfidentialClientApplication, "getAuthCodeUrl"> = client(config),
  invitationCode?: unknown,
  returnAuthorizationUrl = false
): Promise<Response> {
  const invitation = invitationCode === undefined ? undefined : await inspectInvitation(table, invitationCode);
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue() + randomValue().slice(0, 22);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${config.origin}/api/auth/callback`;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await table.createEntity({
    partitionKey: transactionPartition,
    rowKey: `t-${digest(state)}`,
    state,
    nonce,
    verifier,
    expiresAt,
    ...(invitation ? {
      inviteHouseholdId: invitation.householdId,
      inviteId: invitation.id,
      inviteSlot: invitation.slot
    } : {})
  });
  const url = await authorizationClient.getAuthCodeUrl({
    scopes,
    redirectUri,
    responseMode: "query",
    state,
    nonce,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    prompt: "select_account"
  });
  const secure = config.local ? "" : "; Secure";
  const path = config.local ? "/api/auth" : "/";
  const cookie = `${transactionCookie(config)}=${state}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
  if (returnAuthorizationUrl) {
    return new Response(JSON.stringify({ authorizationUrl: url }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": cookie }
    });
  }
  return redirect(url, cookie);
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return cookie?.slice(cookie.indexOf("=") + 1) ?? null;
}

function identityClaims(value: unknown): { issuer: string; subject: string; name: string; email: string } {
  if (!value || typeof value !== "object") throw new HttpError(401, "The identity provider returned an invalid sign-in response.");
  const claims = value as Record<string, unknown>;
  const issuer = claims.iss, subject = claims.sub;
  const emails = claims.emails;
  const email = claims.email ?? (Array.isArray(emails) ? emails[0] : undefined) ?? claims.preferred_username;
  if (typeof issuer !== "string" || typeof subject !== "string" || !subject
    || typeof email !== "string" || !email || email.length > 320) {
    throw new HttpError(401, "The identity provider did not return a usable account.");
  }
  const name = typeof claims.name === "string" && claims.name.trim()
    ? claims.name.trim().slice(0, 80)
    : email.slice(0, email.indexOf("@") > 0 ? email.indexOf("@") : 80);
  return { issuer, subject, name, email };
}

async function ensureUser(
  table: TableClient, config: Config, claims: ReturnType<typeof identityClaims>, invitation?: InvitationTarget
): Promise<AuthContext> {
  const userId = `user-${digest(`${claims.issuer}\0${claims.subject}`).slice(0, 40)}`;
  let user = await optionalEntity<UserRecord>(table, userPartition, `u-${userId}`);
  let createdUser = false;
  if (!user) {
    if (!invitation) await consumeRateLimit(table, `new-households:${userId}`, 3, 30 * 24 * 60 * 60 * 1000);
    const householdId = invitation?.householdId ?? `household-${randomValue().slice(0, 32)}`;
    const member = invitation?.slot ?? "a";
    try {
      await table.createEntity({
        partitionKey: userPartition,
        rowKey: `u-${userId}`,
        userId,
        issuer: claims.issuer,
        subject: claims.subject,
        email: claims.email,
        name: claims.name,
        householdId,
        member,
        membershipInitialized: false
      });
      createdUser = true;
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
    }
    user = await optionalEntity<UserRecord>(table, userPartition, `u-${userId}`);
  }
  if (!user || user.issuer !== claims.issuer || user.subject !== claims.subject
    || typeof user.householdId !== "string" || (user.member !== "a" && user.member !== "b" && user.member !== "")) {
    throw new HttpError(500, "Could not load the signed-in account.");
  }
  if (user.deletionRequestedAt) throw new HttpError(410, "This account is scheduled for deletion.");
  if (!user.householdId || !user.member) {
    if (!invitation) await consumeRateLimit(table, `new-households:${userId}`, 3, 30 * 24 * 60 * 60 * 1000);
    const householdId = invitation?.householdId ?? `household-${randomValue().slice(0, 32)}`;
    const member = invitation?.slot ?? "a";
    await table.updateEntity({
      partitionKey: userPartition,
      rowKey: `u-${userId}`,
      householdId,
      member,
      membershipInitialized: false
    }, "Merge", { etag: user.etag });
    user = { ...user, householdId, member, membershipInitialized: false };
  } else if (invitation && (user.householdId !== invitation.householdId || user.member !== invitation.slot)) {
    throw new HttpError(409, "This account already belongs to another household. Leave it before joining this one.");
  }

  const household = await optionalEntity<HouseholdRecord>(
    table, householdPartition(user.householdId), "household"
  );
  if (household?.deletedAt) throw new HttpError(410, "This household is scheduled for deletion.");
  if (!household) {
    if (invitation) throw new HttpError(410, "This invitation has expired or was already used.");
    try {
      await table.createEntity({
        partitionKey: householdPartition(user.householdId),
        rowKey: "household",
        nameA: claims.name,
        nameB: ""
      });
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
    }
  }

  if (user.member !== "a" && user.member !== "b") throw new HttpError(500, "Could not load the signed-in account.");
  const context: AuthContext = { userId, householdId: user.householdId, member: user.member };
  const membership = await optionalEntity<{ userId: string; member: Member }>(
    table, householdPartition(user.householdId), `m-${userId}`
  );
  if (!membership) {
    if (user.membershipInitialized) {
      throw new HttpError(401, "The account is not an active member of this household.");
    }
    if (invitation) {
      try { await consumeInvitation(table, invitation, userId); }
      catch (error) {
        const recoveredMembership = await optionalEntity<{ userId: string; member: Member }>(
          table, householdPartition(user.householdId), `m-${userId}`
        );
        if (!recoveredMembership && createdUser) {
          try { await table.deleteEntity(userPartition, `u-${userId}`); }
          catch (cleanupError) { if (statusCode(cleanupError) !== 404) throw cleanupError; }
        }
        if (!recoveredMembership) throw error;
      }
    } else {
      try { await createMembership(table, user.householdId, userId, user.member); }
      catch (error) {
        if (statusCode(error) !== 409) throw error;
      }
    }
  }
  const confirmedMembership = await optionalEntity<{ userId: string; member: Member }>(
    table, householdPartition(user.householdId), `m-${userId}`
  );
  if (!confirmedMembership || confirmedMembership.userId !== userId || confirmedMembership.member !== user.member) {
    throw new HttpError(401, "The account is not an active member of this household.");
  }
  if (!user.membershipInitialized) {
    await table.updateEntity({
      partitionKey: userPartition,
      rowKey: `u-${userId}`,
      membershipInitialized: true
    }, "Merge");
  }
  return context;
}

export async function completeEntraSignIn(
  request: Request, config: Config, table: TableClient
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== cookieValue(request, transactionCookie(config)) || !code) {
    throw new HttpError(400, "The sign-in request expired or could not be verified. Please try again.");
  }
  const transaction = await optionalEntity<LoginTransaction>(
    table, transactionPartition, `t-${digest(state)}`
  );
  if (!transaction || transaction.state !== state || transaction.expiresAt < Date.now()) {
    throw new HttpError(400, "The sign-in request expired or could not be verified. Please try again.");
  }
  await table.deleteEntity(transactionPartition, `t-${digest(state)}`);

  const result = await client(config).acquireTokenByCode({
    code,
    scopes,
    redirectUri: `${config.origin}/api/auth/callback`,
    state: transaction.state,
    nonce: transaction.nonce,
    codeVerifier: transaction.verifier
  });
  const claims = identityClaims(result?.idTokenClaims);
  const invitation = transaction.inviteHouseholdId && transaction.inviteId
    && (transaction.inviteSlot === "a" || transaction.inviteSlot === "b")
    ? { householdId: transaction.inviteHouseholdId, id: transaction.inviteId, slot: transaction.inviteSlot }
    : undefined;
  if (transaction.inviteId && !invitation) throw new HttpError(400, "Invalid invitation.");
  const context = await ensureUser(table, config, claims, invitation);
  const { cookie, deviceKey } = await createUserSession(config, table, context);
  const bootstrapCode = randomValue();
  await table.createEntity({
    partitionKey: bootstrapPartition,
    rowKey: `b-${digest(bootstrapCode)}`,
    userId: context.userId,
    deviceKey,
    expiresAt: Date.now() + 2 * 60 * 1000
  });
  return redirect(`${config.origin}/#auth=${bootstrapCode}`, cookie);
}

export async function redeemDeviceKey(
  table: TableClient, identity: AuthContext, code: unknown
): Promise<string> {
  if (typeof code !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(code)) {
    throw new HttpError(400, "Invalid device setup code.");
  }
  const rowKey = `b-${digest(code)}`;
  const record = await optionalEntity<BootstrapRecord>(table, bootstrapPartition, rowKey);
  if (!record || record.expiresAt < Date.now() || record.userId !== identity.userId) {
    throw new HttpError(401, "The device setup code expired. Sign in again.");
  }
  await table.deleteEntity(bootstrapPartition, rowKey);
  return record.deviceKey;
}

export async function getHouseholdNames(
  table: TableClient, householdId: string
): Promise<{ nameA: string; nameB: string } | null> {
  const household = await optionalEntity<HouseholdRecord>(table, householdPartition(householdId), "household");
  if (!household) return null;
  if (typeof household.nameA !== "string" || typeof household.nameB !== "string") {
    throw new HttpError(500, "Could not load the household.");
  }
  return { nameA: household.nameA, nameB: household.nameB };
}
