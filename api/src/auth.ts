import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import type { AccountProfile } from "../../shared/profile";
import { HttpError, type Config } from "./config";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const sessionPartition = "sessions";
const householdPartition = (householdId: string) => `h-${householdId}`;
const sessionName = (config: Config) => config.local ? "splitty-local" : "__Host-splitty";
const sessionMaxAge = 400 * 24 * 60 * 60;

export interface AuthContext extends AccountProfile {
  userId: string;
  householdId: string;
  member: Member;
  sessionId?: string;
}

type SessionEntity = AuthContext & { membershipId: string };
interface MembershipEntity { userId: string; member: Member; active: boolean; membershipId: string }
interface UserAuthorizationEntity { userId: string; householdId: string; member: Member; deletionRequestedAt?: number }
interface HouseholdAuthorizationEntity { deletedAt?: number }

const isStableId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function sessionCookie(config: Config, value: string, maxAge?: number): string {
  return `${sessionName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}${config.local ? "" : "; Secure"}`;
}

function readCookie(request: Request, config: Config): string | null {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${sessionName(config)}=`));
  return cookie?.slice(cookie.indexOf("=") + 1) ?? null;
}

export const isSessionKey = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value);

export async function authenticate(request: Request, config: Config, table: TableClient): Promise<AuthContext> {
  return verifySession(readCookie(request, config), config, table);
}

/**
 * Some Android Chrome installs lose the session cookie while keeping IndexedDB.
 * The device keeps the same session value there and exchanges it for a new cookie.
 */
export async function resumeSession(value: string, config: Config, table: TableClient): Promise<string> {
  await verifySession(value, config, table);
  return sessionCookie(config, value, sessionMaxAge);
}

export async function createMembership(
  table: TableClient, householdId: string, userId: string, member: Member
): Promise<void> {
  if (!isStableId(householdId) || !isStableId(userId)) throw new HttpError(400, "Invalid household membership.");
  await table.createEntity({
    partitionKey: householdPartition(householdId),
    rowKey: `m-${userId}`,
    userId,
    member,
    active: true,
    membershipId: randomUUID()
  });
}

export async function revokeMembership(table: TableClient, householdId: string, userId: string): Promise<void> {
  if (!isStableId(householdId) || !isStableId(userId)) throw new HttpError(400, "Invalid household membership.");
  try { await table.deleteEntity(householdPartition(householdId), `m-${userId}`); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
}

export async function createUserSession(
  config: Config, table: TableClient, context: AuthContext
): Promise<{ cookie: string; deviceKey: string }> {
  if (!isStableId(context.userId) || !isStableId(context.householdId)
    || (context.member !== "a" && context.member !== "b")) {
    throw new HttpError(400, "Invalid sign-in context.");
  }
  const membership = await requireMembership(table, context);
  const raw = randomToken();
  await table.createEntity({
    partitionKey: sessionPartition,
    rowKey: `s-${digest(raw)}`,
    userId: context.userId,
    householdId: context.householdId,
    member: context.member,
    membershipId: membership.membershipId,
    signInProvider: context.signInProvider,
    displayName: context.displayName,
    email: context.email,
    pictureUrl: context.pictureUrl
  });
  return { cookie: sessionCookie(config, raw, sessionMaxAge), deviceKey: raw };
}

async function requireMembership(table: TableClient, context: AuthContext): Promise<MembershipEntity> {
  const household = await optionalEntity<HouseholdAuthorizationEntity>(
    table, householdPartition(context.householdId), "household"
  );
  if (household?.deletedAt) throw new HttpError(401, "Your household access has been revoked. Sign in again.");
  const user = await optionalEntity<UserAuthorizationEntity>(table, "users", `u-${context.userId}`);
  if (user && (user.userId !== context.userId || user.householdId !== context.householdId
    || user.member !== context.member || user.deletionRequestedAt)) {
    throw new HttpError(401, "Your household access has been revoked. Sign in again.");
  }
  const membership = await optionalEntity<MembershipEntity>(
    table, householdPartition(context.householdId), `m-${context.userId}`
  );
  if (!membership || membership.active !== true || membership.userId !== context.userId
    || membership.member !== context.member || !isStableId(membership.membershipId)) {
    throw new HttpError(401, "Your household access has been revoked. Sign in again.");
  }
  return membership;
}

async function verifySession(value: string | null, config: Config, table: TableClient): Promise<AuthContext> {
  if (!isSessionKey(value)) throw new HttpError(401, "Sign in to sync this device.");
  const key = `s-${digest(value)}`;
  const session = await optionalEntity<SessionEntity>(table, sessionPartition, key);
  if (session) {
    if (!isStableId(session.userId) || !isStableId(session.householdId)
      || (session.member !== "a" && session.member !== "b") || !isStableId(session.membershipId)) {
      throw new HttpError(401, "Sign in to sync this device.");
    }
    const context: AuthContext = {
      userId: session.userId,
      householdId: session.householdId,
      member: session.member,
      sessionId: key,
      signInProvider: session.signInProvider,
      displayName: session.displayName,
      email: session.email,
      pictureUrl: session.pictureUrl
    };
    const membership = await requireMembership(table, context);
    if (session.membershipId !== membership.membershipId) {
      throw new HttpError(401, "Your household access has been revoked. Sign in again.");
    }
    return context;
  }
  throw new HttpError(401, "Sign in to sync this device.");
}

export async function logout(request: Request, config: Config, table: TableClient, deviceKey?: string): Promise<void> {
  const cookie = readCookie(request, config);
  const sessions = new Set([cookie, deviceKey].filter(isSessionKey));
  for (const raw of sessions) {
    try { await table.deleteEntity(sessionPartition, `s-${digest(raw)}`); }
    catch (error) { if (statusCode(error) !== 404) throw error; }
  }
}
