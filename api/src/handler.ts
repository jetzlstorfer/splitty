import { validateMutation, type MutationResult } from "../../shared/model";
import { authenticate, consumeLink, logout, requestLink, sessionCookie } from "./auth";
import { getConfig, HttpError } from "./config";
import { applyMutation, readChanges } from "./ledger";
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
    if (path === "auth/request" && request.method === "POST") {
      const data = await body(request);
      if (typeof data.email !== "string" || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new HttpError(400, "Enter a valid email address.");
      if (data.language !== undefined && data.language !== "de" && data.language !== "en") throw new HttpError(400, "Invalid language.");
      return json(await requestLink(data.email, config, auth, data.language === "de" ? "de" : "en"), 202);
    }
    if (path === "auth/consume" && request.method === "POST") {
      const data = await body(request);
      if (typeof data.token !== "string") throw new HttpError(400, "Missing sign-in token.");
      const cookie = await consumeLink(data.token, config, auth);
      return json({ signedIn: true }, 200, { "Set-Cookie": cookie });
    }
    if (path === "auth/logout" && request.method === "POST") {
      await logout(request, config, auth);
      return json({ signedOut: true }, 200, { "Set-Cookie": sessionCookie(config, "", 0) });
    }
    const member = await authenticate(request, config, auth);
    if (path === "me" && request.method === "GET") return json({ member, nameA: config.nameA, nameB: config.nameB });
    if (path === "sync" && request.method === "GET") {
      const raw = url.searchParams.get("since") ?? "0";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, "Invalid sync cursor.");
      return json(await readChanges(ledger, config.household, Number(raw)));
    }
    if (path === "sync" && request.method === "POST") {
      const data = await body(request);
      if (!Array.isArray(data.mutations) || data.mutations.length < 1 || data.mutations.length > 20) throw new HttpError(400, "Send between 1 and 20 changes.");
      let mutations;
      try { mutations = data.mutations.map(validateMutation); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid changes."); }
      const results: MutationResult[] = [], blocked = new Map<string, MutationResult>();
      for (const mutation of mutations) {
        const previous = blocked.get(mutation.entry.id);
        const result: MutationResult = previous?.status === "conflict"
          ? { ...previous, id: mutation.id }
          : await applyMutation(ledger, config.household, mutation);
        if (result.status === "conflict") blocked.set(mutation.entry.id, result);
        results.push(result);
      }
      return json(results);
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    // Avoid logging financial payloads, email addresses, cookies or sign-in tokens.
    logError(`Splitty request failed (${error instanceof Error ? error.name : "unknown error"}).`);
    return json({ error: "The server could not complete this request. Your changes remain saved on your device. Retry shortly." }, 500);
  }
}
