import { createHash, randomBytes } from "node:crypto";
import { EmailClient } from "@azure/communication-email";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import { HttpError, type Config } from "./config";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const partition = (config: Config) => `auth-${config.household}`;
const sessionName = (config: Config) => config.local ? "splitty-local" : "__Host-splitty";
interface AuthEntity { member: Member; expiresAt: number }

export function sessionCookie(config: Config, value: string, maxAge = 30 * 24 * 3600): string {
  return `${sessionName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.local ? "" : "; Secure"}`;
}

function readCookie(request: Request, config: Config): string | null {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${sessionName(config)}=`));
  return cookie?.slice(cookie.indexOf("=") + 1) ?? null;
}

export async function authenticate(request: Request, config: Config, table: TableClient): Promise<Member> {
  const value = readCookie(request, config);
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new HttpError(401, "Sign in to sync this device.");
  const session = await optionalEntity<AuthEntity>(table, partition(config), `s-${digest(value)}`);
  if (!session || session.expiresAt <= Date.now()) throw new HttpError(401, "Your session expired. Sign in again to sync.");
  return session.member;
}

export async function requestLink(email: string, config: Config, table: TableClient): Promise<{ message: string; developmentLink?: string }> {
  const message = "If this is one of your household email addresses, a sign-in link is on its way. Check your inbox.";
  const normalized = email.trim().toLowerCase();
  const member = normalized === config.emailA ? "a" : normalized === config.emailB ? "b" : null;
  if (!member) return { message };
  const pk = partition(config), rateKey = `rate-${member}`;
  const previous = await optionalEntity<{ nextAllowed: number }>(table, pk, rateKey);
  if (previous && previous.nextAllowed > Date.now()) return { message };
  try {
    const rate = { partitionKey: pk, rowKey: rateKey, nextAllowed: Date.now() + 60_000 };
    if (previous) await table.updateEntity(rate, "Replace", { etag: previous.etag });
    else await table.createEntity(rate);
  } catch (error) {
    if (statusCode(error) === 409 || statusCode(error) === 412) return { message };
    throw error;
  }
  const raw = token(), rowKey = `t-${digest(raw)}`;
  await table.createEntity({ partitionKey: pk, rowKey, member, expiresAt: Date.now() + 15 * 60_000 });
  const link = `${config.origin}/#signin=${raw}`;
  if (config.local) return { message: "Local mode: use the link below. No email was sent.", developmentLink: link };
  try {
    const client = new EmailClient(config.emailConnection!);
    const poller = await client.beginSend({
      senderAddress: config.emailSender!,
      recipients: { to: [{ address: normalized }] },
      content: {
        subject: "Your Splitty sign-in link",
        plainText: `Sign in to your shared expense ledger:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. Open it on the device you want to sign in on. If you did not request this, ignore this email.`
      }
    });
    const result = await poller.pollUntilDone();
    if (result.status !== "Succeeded") throw new Error("Email delivery was not accepted.");
  } catch (error) {
    await table.deleteEntity(pk, rowKey);
    throw error;
  }
  return { message };
}

export async function consumeLink(value: string, config: Config, table: TableClient): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new HttpError(400, "Invalid sign-in link.");
  const pk = partition(config), row = `t-${digest(value)}`;
  const entity = await optionalEntity<AuthEntity>(table, pk, row);
  if (!entity || entity.expiresAt <= Date.now()) throw new HttpError(401, "This link expired or was already used. Request a new one.");
  const raw = token();
  try {
    await table.submitTransaction([
      ["delete", { partitionKey: pk, rowKey: row }],
      ["create", { partitionKey: pk, rowKey: `s-${digest(raw)}`, member: entity.member, expiresAt: Date.now() + 30 * 24 * 3600_000 }]
    ]);
  } catch (error) {
    if (statusCode(error) === 404 || statusCode(error) === 409 || statusCode(error) === 412) {
      throw new HttpError(401, "This link has already been used. Request a new one.");
    }
    throw error;
  }
  return sessionCookie(config, raw);
}

export async function logout(request: Request, config: Config, table: TableClient): Promise<void> {
  const raw = readCookie(request, config);
  if (!raw) return;
  try { await table.deleteEntity(partition(config), `s-${digest(raw)}`); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
}
