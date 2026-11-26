import { activateAccountDatabase, applyStorePage, applyStoreResults, db, expenseStore, todoStore, getDeviceKey, getPreferences, importLegacyDatabase, isActiveDatabase, setDeviceKey, SplittyDatabase, type SyncStore } from "./db";
import type { Member, MutationResult, SyncPage, VersionedRecord } from "../shared/model";
import type { AccountProfile } from "../shared/profile";

export interface Identity extends AccountProfile {
  member: Member;
  nameA: string;
  nameB: string;
  userId?: string;
  householdId?: string;
  legacyClaimed?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface SyncContext { userId: string; householdId: string }

export function syncPollingInterval(now: number, lastActivityAt: number): number {
  return now - lastActivityAt >= 5 * 60_000 ? 5 * 60_000 : 60_000;
}

export async function api<T>(path: string, body?: unknown, context?: SyncContext): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(context ? { "X-Splitty-User": context.userId, "X-Splitty-Household": context.householdId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000)
  });
  const data: unknown = await response.json().catch(() => {
    throw new ApiError("The sync API is not available. Your changes are saved on this device.", response.status);
  });
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : "Sync request failed.";
    throw new ApiError(message, response.status);
  }
  return data as T;
}

/** Returns the signed-in member, restoring a lost session cookie from this device's key when possible. */
export async function identify(): Promise<Identity> {
  let identity: Identity;
  try { identity = await api<Identity>("me"); }
  catch (error) {
    const deviceKey = error instanceof ApiError && error.status === 401 ? await getDeviceKey() : null;
    if (!deviceKey) throw error;
    try { await api("auth/resume", { deviceKey }); }
    catch (resumeError) {
      // Only a definite rejection revokes the key; network failures keep it for the next attempt.
      if (resumeError instanceof ApiError && (resumeError.status === 401 || resumeError.status === 400)) await setDeviceKey(null);
      throw resumeError;
    }
    identity = await api<Identity>("me");
  }
  if (typeof identity.userId === "string" && typeof identity.householdId === "string") {
    await activateAccountDatabase(identity.userId, identity.householdId);
  }
  const bootstrapCode = typeof location === "undefined"
    ? null
    : new URLSearchParams(location.hash.slice(1)).get("auth");
  if (bootstrapCode) {
    const { deviceKey } = await api<{ deviceKey?: unknown }>("auth/device-key", { code: bootstrapCode });
    if (typeof deviceKey !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(deviceKey)) throw new Error("Invalid device setup response.");
    await setDeviceKey(deviceKey);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  if (identity.legacyClaimed) await importLegacyDatabase(identity);
  return identity;
}

export async function signInDevice(token: string): Promise<void> {
  const { deviceKey } = await api<{ deviceKey?: unknown }>("auth/token", { token });
  await setDeviceKey(typeof deviceKey === "string" ? deviceKey : null);
}

export async function signOutDevice(): Promise<void> {
  await api("auth/logout", { deviceKey: await getDeviceKey() ?? undefined });
  await setDeviceKey(null);
}

let syncing: { database: SplittyDatabase; promise: Promise<void> } | null = null;

async function pull<T extends VersionedRecord>(path: string, store: SyncStore<T>, context?: SyncContext): Promise<boolean> {
  let more = true;
  while (more) {
    const cursor = (await getPreferences(store.database))[store.cursorField] ?? 0;
    const page = await api<SyncPage<T>>(`${path}?since=${cursor}`, undefined, context);
    if (!isActiveDatabase(store.database)) return false;
    if (page.cursor < cursor || (page.more && page.cursor === cursor)) throw new Error("Sync did not make progress.");
    await applyStorePage(page, store);
    more = page.more;
  }
  return true;
}

async function synchronizeStore<T extends VersionedRecord>(
  path: string, store: SyncStore<T>, batchSize: number, context?: SyncContext
): Promise<boolean> {
  if (!await pull(path, store, context)) return false;
  const blocked = new Set((await store.conflicts.toArray()).map((c) => c.entryId));
  const queue = (await store.outbox.toArray()).sort((a, b) =>
    a.entry.id.localeCompare(b.entry.id) || a.expectedRevision - b.expectedRevision);
  for (let offset = 0; offset < queue.length; offset += batchSize) {
    if (!isActiveDatabase(store.database)) return false;
    const batch = queue.slice(offset, offset + batchSize).filter((m) => !blocked.has(m.entry.id));
    if (!batch.length) continue;
    const results = await api<MutationResult<T>[]>(path, { mutations: batch }, context);
    if (!isActiveDatabase(store.database)) return false;
    if (!Array.isArray(results) || results.length !== batch.length
      || results.some((result, i) => result.id !== batch[i].id || !["ok", "conflict"].includes(result.status))) {
      throw new Error("The server returned an invalid acknowledgement.");
    }
    await applyStoreResults(results, store);
    for (const result of results) {
      if (result.status === "conflict") {
        blocked.add(batch.find((mutation) => mutation.id === result.id)!.entry.id);
      }
    }
  }
  return pull(path, store, context);
}

export function synchronize(database = db, context?: SyncContext): Promise<void> {
  if (syncing?.database === database) return syncing.promise;
  const previous = syncing?.promise;
  const current = (async () => {
    await previous;
    if (!await synchronizeStore("sync", expenseStore(database), 20, context)
      || !isActiveDatabase(database)) return;
    // Leave room for JSON escaping of long descriptions within the API's body limit.
    await synchronizeStore("todo-sync", todoStore(database), 5, context);
  })();
  const task = { database, promise: current };
  syncing = task;
  void current.then(
    () => { if (syncing === task) syncing = null; },
    () => { if (syncing === task) syncing = null; }
  );
  return current;
}
