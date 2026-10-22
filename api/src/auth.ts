import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import { HttpError, type Config } from "./config";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const partition = (config: Config) => `auth-${config.household}`;
const sessionName = (config: Config) => config.local ? "splitty-local" : "__Host-splitty";
const sessionMaxAge = 365 * 24 * 60 * 60;
interface AuthEntity { member: Member; credentialDigest: string }

export function sessionCookie(config: Config, value: string, maxAge = sessionMaxAge): string {
  return `${sessionName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.local ? "" : "; Secure"}`;
}

function readCookie(request: Request, config: Config): string | null {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${sessionName(config)}=`));
  return cookie?.slice(cookie.indexOf("=") + 1) ?? null;
}

export async function authenticate(request: Request, config: Config, table: TableClient): Promise<{ member: Member; cookie: string }> {
  const value = readCookie(request, config);
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new HttpError(401, "Sign in to sync this device.");
  const session = await optionalEntity<AuthEntity>(table, partition(config), `s-${digest(value)}`);
  if (!session || !/^[a-f0-9]{64}$/.test(session.credentialDigest)) throw new HttpError(401, "Sign in to sync this device.");
  const expectedDigest = digest(session.member === "a" ? config.memberAToken : config.memberBToken);
  if (!timingSafeEqual(Buffer.from(session.credentialDigest, "hex"), Buffer.from(expectedDigest, "hex"))) {
    throw new HttpError(401, "Your member token was rotated. Sign in again.");
  }
  return { member: session.member, cookie: sessionCookie(config, value) };
}

export async function signInWithToken(value: string, config: Config, table: TableClient): Promise<string> {
  const provided = Buffer.from(digest(value));
  const tokenA = timingSafeEqual(provided, Buffer.from(digest(config.memberAToken)));
  const tokenB = timingSafeEqual(provided, Buffer.from(digest(config.memberBToken)));
  if (!tokenA && !tokenB) throw new HttpError(401, "Invalid member token.");
  const member: Member = tokenA ? "a" : "b";
  const pk = partition(config), raw = randomToken();
  await table.createEntity({
    partitionKey: pk, rowKey: `s-${digest(raw)}`, member, credentialDigest: digest(value)
  });
  return sessionCookie(config, raw);
}

export async function logout(request: Request, config: Config, table: TableClient): Promise<void> {
  const raw = readCookie(request, config);
  if (!raw) return;
  try { await table.deleteEntity(partition(config), `s-${digest(raw)}`); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
}
