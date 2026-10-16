import { applyPage, applyResults, db, getPreferences } from "./db";
import type { Member, MutationResult, SyncPage } from "../shared/model";

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

async function pull(): Promise<void> {
  let more = true;
  while (more) {
    const { cursor } = await getPreferences();
    const page = await api<SyncPage>(`sync?since=${cursor}`);
    if (page.cursor < cursor || (page.more && page.cursor === cursor)) throw new Error("Sync did not make progress.");
    await applyPage(page);
    more = page.more;
  }
}

export function synchronize(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    await pull();
    const blocked = new Set((await db.conflicts.toArray()).map((c) => c.entryId));
    const queue = (await db.outbox.toArray()).sort((a, b) =>
      a.entry.id.localeCompare(b.entry.id) || a.expectedRevision - b.expectedRevision);
    for (let offset = 0; offset < queue.length; offset += 20) {
      const batch = queue.slice(offset, offset + 20).filter((m) => !blocked.has(m.entry.id));
      if (!batch.length) continue;
      const results = await api<MutationResult[]>("sync", { mutations: batch });
      if (!Array.isArray(results) || results.length !== batch.length
        || results.some((result, i) => result.id !== batch[i].id || !["ok", "conflict"].includes(result.status))) {
        throw new Error("The server returned an invalid acknowledgement.");
      }
      await applyResults(results);
      for (const result of results) {
        if (result.status === "conflict") {
          blocked.add(batch.find((mutation) => mutation.id === result.id)!.entry.id);
        }
      }
    }
    await pull();
  })().finally(() => { syncing = null; });
  return syncing;
}
