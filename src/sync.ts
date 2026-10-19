import { applyStorePage, applyStoreResults, expenseStore, todoStore, getPreferences, type SyncStore } from "./db";
import type { Member, MutationResult, SyncPage, VersionedRecord } from "../shared/model";

export interface Identity {
  member: Member;
  nameA: string;
  nameB: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
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

let syncing: Promise<void> | null = null;

async function pull<T extends VersionedRecord>(path: string, store: SyncStore<T>): Promise<void> {
  let more = true;
  while (more) {
    const cursor = (await getPreferences(store.database))[store.cursorField] ?? 0;
    const page = await api<SyncPage<T>>(`${path}?since=${cursor}`);
    if (page.cursor < cursor || (page.more && page.cursor === cursor)) throw new Error("Sync did not make progress.");
    await applyStorePage(page, store);
    more = page.more;
  }
}

async function synchronizeStore<T extends VersionedRecord>(path: string, store: SyncStore<T>, batchSize: number): Promise<void> {
  await pull(path, store);
  const blocked = new Set((await store.conflicts.toArray()).map((c) => c.entryId));
  const queue = (await store.outbox.toArray()).sort((a, b) =>
    a.entry.id.localeCompare(b.entry.id) || a.expectedRevision - b.expectedRevision);
  for (let offset = 0; offset < queue.length; offset += batchSize) {
    const batch = queue.slice(offset, offset + batchSize).filter((m) => !blocked.has(m.entry.id));
    if (!batch.length) continue;
    const results = await api<MutationResult<T>[]>(path, { mutations: batch });
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
  await pull(path, store);
}

export function synchronize(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    await synchronizeStore("sync", expenseStore(), 20);
    // Leave room for JSON escaping of long descriptions within the API's body limit.
    await synchronizeStore("todo-sync", todoStore(), 5);
  })().finally(() => { syncing = null; });
  return syncing;
}
