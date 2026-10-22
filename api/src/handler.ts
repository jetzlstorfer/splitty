import type { TableClient } from "@azure/data-tables";
import { validateChange, validateEntry, type MutationResult, type VersionedRecord } from "../../shared/model";
import { validateTodo } from "../../shared/todo";
import { authenticate, logout, sessionCookie, signInWithToken } from "./auth";
import { getConfig, HttpError } from "./config";
import { expenseLedger, todoLedger, type createLedger } from "./ledger";
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
    if (request.method === "POST") {
      if (request.headers.get("origin") !== config.origin) throw new HttpError(403, "Request origin is not allowed.");
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "Use application/json.");
    }
    const { auth, ledger } = await tables(config);
    if (path === "auth/token" && request.method === "POST") {
      const data = await body(request);
      if (typeof data.token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(data.token)) throw new HttpError(400, "Enter a valid member token.");
      const cookie = await signInWithToken(data.token, config, auth);
      return json({ signedIn: true }, 200, { "Set-Cookie": cookie });
    }
    if (path === "auth/logout" && request.method === "POST") {
      await logout(request, config, auth);
      return json({ signedOut: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    const { member, cookie } = await authenticate(request, config, auth);
    let response: Response;
    if (path === "me" && request.method === "GET") response = json({ member, nameA: config.nameA, nameB: config.nameB });
    else if (path === "sync") response = await syncRequest(request, url, ledger, config.household, validateEntry, expenseLedger);
    else if (path === "todo-sync") response = await syncRequest(request, url, ledger, config.household, validateTodo, todoLedger);
    else throw new HttpError(404, "Endpoint not found.");
    // Renew active devices and upgrade legacy session-only cookies without another sign-in.
    response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
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
