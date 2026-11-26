import type { TableClient } from "@azure/data-tables";
import { isInsuranceTodoSetting, validateChange, validateEntry, type MutationResult, type VersionedRecord } from "../../shared/model";
import { validateTodo } from "../../shared/todo";
import { authenticate, isSessionKey, logout, resumeSession, sessionCookie, signInWithToken } from "./auth";
import { getConfig, HttpError } from "./config";
import { beginEntraSignIn, completeEntraSignIn, getHouseholdNames, isLegacyClaimed, redeemDeviceKey } from "./entra";
import { expenseLedger, todoLedger, type createLedger } from "./ledger";
import { createInvitation, listInvitations, revokeInvitation } from "./invitations";
import {
  deleteAccount, deleteHousehold, insuranceTodoSetting, leaveHousehold, removeOtherMember, renameHouseholdMember
} from "./households";
import { consumeRateLimit, signInRateLimitKey } from "./rateLimit";
import { tables } from "./storage";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
const json = (data: unknown, status = 200, extra?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 128_000) throw new HttpError(413, "Request too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > 128_000) throw new HttpError(413, "Request too large.");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Expected a JSON object.");
  return data as Record<string, unknown>;
}

export async function handler(request: Request, logError: (message: string) => void = console.error): Promise<Response> {
  try {
    const config = getConfig();
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "Method not allowed.");
    const { auth, ledger } = await tables(config);
    if (path === "auth/config" && request.method === "GET") {
      return json({
        entraEnabled: !!config.entra,
        legacyEnabled: !!(config.household && config.memberAToken && config.memberBToken),
        newHouseholdsEnabled: config.allowNewHouseholds
      });
    }
    if (["auth/start", "auth/callback", "auth/token", "auth/resume"].includes(path)) {
      if (!config.local) {
        await consumeRateLimit(auth, signInRateLimitKey(request.headers.get("x-forwarded-for")), 20, 60_000);
      }
    }
    if (path === "auth/start" && request.method === "GET") return await beginEntraSignIn(config, auth);
    if (path === "auth/callback" && request.method === "GET") return await completeEntraSignIn(request, config, auth);
    if (request.method === "POST") {
      if (request.headers.get("origin") !== config.origin) throw new HttpError(403, "Request origin is not allowed.");
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "Use application/json.");
    }
    if (path === "auth/start" && request.method === "POST") {
      const data = await body(request);
      return await beginEntraSignIn(config, auth, undefined, data.inviteCode, true, data.legacyToken);
    }
    if (path === "auth/token" && request.method === "POST") {
      const data = await body(request);
      if (typeof data.token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(data.token)) throw new HttpError(400, "Enter a valid member token.");
      const { cookie, deviceKey } = await signInWithToken(data.token, config, auth);
      return json({ signedIn: true, deviceKey }, 200, { "Set-Cookie": cookie });
    }
    if (path === "auth/resume" && request.method === "POST") {
      const data = await body(request);
      if (!isSessionKey(data.deviceKey)) throw new HttpError(400, "Invalid device key.");
      const cookie = await resumeSession(data.deviceKey, config, auth);
      return json({ resumed: true }, 200, { "Set-Cookie": cookie });
    }
    if (path === "auth/logout" && request.method === "POST") {
      const data = await body(request);
      await logout(request, config, auth, isSessionKey(data.deviceKey) ? data.deviceKey : undefined);
      return json({ signedOut: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    const identity = await authenticate(request, config, auth);
    if (identity.sessionId) await consumeRateLimit(auth, `session:${identity.sessionId}`, 600, 10 * 60_000);
    if (path === "auth/device-key" && request.method === "POST") {
      const data = await body(request);
      return json({ deviceKey: await redeemDeviceKey(auth, identity, data.code) });
    }
    if (path === "me" && request.method === "GET") {
      return json({
        userId: identity.userId,
        householdId: identity.householdId,
        member: identity.member,
        legacyClaimed: await isLegacyClaimed(auth, identity.userId, identity.householdId),
        ...(await getHouseholdNames(auth, identity.householdId) ?? { nameA: config.nameA, nameB: config.nameB })
      });
    }
    if (path === "household/invitations" && request.method === "GET") {
      return json({ invitations: await listInvitations(auth, identity) });
    }
    if (path === "household/invitations" && request.method === "POST") {
      const created = await createInvitation(auth, identity);
      return json(created, 201);
    }
    if (path === "household/invitations/revoke" && request.method === "POST") {
      const data = await body(request);
      await revokeInvitation(auth, identity, data.id);
      return json({ revoked: true });
    }
    if (path === "household/member-name" && request.method === "POST") {
      const data = await body(request);
      await renameHouseholdMember(auth, identity, data.slot, data.name);
      return json({ renamed: true });
    }
    if (path === "household/leave" && request.method === "POST") {
      await leaveHousehold(auth, identity);
      await logout(request, config, auth);
      return json({ left: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    if (path === "household/remove-member" && request.method === "POST") {
      await removeOtherMember(auth, identity);
      return json({ removed: true });
    }
    if (path === "household/delete" && request.method === "POST") {
      await deleteHousehold(auth, identity);
      await logout(request, config, auth);
      return json({ deleted: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    if (path === "account/delete" && request.method === "POST") {
      await deleteAccount(auth, identity);
      await logout(request, config, auth);
      return json({ deletionScheduled: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    if (path === "sync" || path === "todo-sync" || path === "household/insurance-todos") {
      const requestUser = request.headers.get("x-splitty-user");
      const requestHousehold = request.headers.get("x-splitty-household");
      const hasContext = requestUser !== null || requestHousehold !== null;
      if ((!identity.userId.startsWith("legacy-") && (!requestUser || !requestHousehold))
        || (hasContext && (requestUser !== identity.userId || requestHousehold !== identity.householdId))) {
        throw new HttpError(409, "The signed-in household changed. Retry sync on this device.");
      }
      if (path === "household/insurance-todos") {
        if (request.method === "GET") return json(await insuranceTodoSetting(ledger, identity.householdId));
        const change = await body(request);
        if (!isInsuranceTodoSetting(change)) throw new HttpError(400, "Invalid insurance to-do setting.");
        return json(await insuranceTodoSetting(ledger, identity.householdId, change));
      }
    }
    if (path === "sync") return await syncRequest(request, url, ledger, identity.householdId, validateEntry, expenseLedger);
    if (path === "todo-sync") return await syncRequest(request, url, ledger, identity.householdId, validateTodo, todoLedger);
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    if (error instanceof HttpError) return json(
      { error: error.message },
      error.status,
      error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined
    );
    // Avoid logging financial payloads, cookies or member tokens.
    logError(`Splitty request failed (${error instanceof Error ? error.name : "unknown error"}).`);
    return json({ error: "The server could not complete this request. Your changes remain saved on your device. Retry shortly." }, 500);
  }
}

async function syncRequest<T extends VersionedRecord>(
  request: Request, url: URL, table: TableClient, household: string,
  validate: (value: unknown) => T, ledger: ReturnType<typeof createLedger<T>>
): Promise<Response> {
  if (request.method === "GET") {
    const raw = url.searchParams.get("since") ?? "0";
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, "Invalid sync cursor.");
    return json(await ledger.readChanges(table, household, Number(raw)));
  }
  const data = await body(request);
  if (!Array.isArray(data.mutations) || data.mutations.length < 1 || data.mutations.length > 20) throw new HttpError(400, "Send between 1 and 20 changes.");
  let mutations;
  try { mutations = data.mutations.map((mutation) => validateChange(mutation, validate)); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid changes."); }
  const results: MutationResult<T>[] = [], blocked = new Map<string, MutationResult<T>>();
  for (const mutation of mutations) {
    const previous = blocked.get(mutation.entry.id);
    const result: MutationResult<T> = previous?.status === "conflict"
      ? { ...previous, id: mutation.id }
      : await ledger.applyMutation(table, household, mutation);
    if (result.status === "conflict") blocked.set(mutation.entry.id, result);
    results.push(result);
  }
  return json(results);
}
