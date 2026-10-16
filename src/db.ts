import Dexie, { type EntityTable } from "dexie";
import { validateEntry, type Entry, type Member, type Mutation, type MutationResult, type SyncPage } from "../shared/model";
import type { Language } from "../shared/i18n";

export interface Preferences {
  id: "preferences";
  member: Member;
  nameA: string;
  nameB: string;
  cursor: number;
  language?: Language;
}

export interface Conflict {
  entryId: string;
  remote: Entry | null;
}

export class SplittyDatabase extends Dexie {
  entries!: EntityTable<Entry, "id">;
  outbox!: EntityTable<Mutation, "id">;
  preferences!: EntityTable<Preferences, "id">;
  conflicts!: EntityTable<Conflict, "entryId">;

  constructor(name = "splitty") {
    super(name);
    this.version(1).stores({
      entries: "id, date",
      outbox: "id, entry.id",
      preferences: "id",
      conflicts: "entryId"
    });
  }
}

export const db = new SplittyDatabase();

export async function getPreferences(database = db): Promise<Preferences> {
  const preferences: Preferences = await database.preferences.get("preferences")
    ?? { id: "preferences", member: "a", nameA: "You", nameB: "Your wife", cursor: 0 };
  return { ...preferences, language: preferences.language === "en" ? "en" : "de" };
}

export async function updatePreferences(changes: Partial<Omit<Preferences, "id" | "cursor">>, database = db): Promise<void> {
  await database.transaction("rw", database.preferences, async () => {
    await database.preferences.put({ ...await getPreferences(database), ...changes });
  });
}

export async function queueEntries(entries: Entry[], database = db): Promise<void> {
  await database.transaction("rw", database.entries, database.outbox, database.conflicts, async () => {
    for (const input of entries) {
      if (await database.conflicts.get(input.id)) throw new Error("Resolve this expense's sync conflict before editing it.");
      const previous = await database.entries.get(input.id);
      if (input.importKey && previous && input.revision === 0) continue;
      const revision = previous?.revision ?? 0;
      const entry = validateEntry({ ...input, revision: revision + 1, updatedAt: new Date().toISOString() });
      await database.entries.put(entry);
      await database.outbox.add({
        id: entry.importKey && !previous ? `importop-${entry.importKey}` : crypto.randomUUID(),
        entry, expectedRevision: revision
      });
    }
  });
}

export async function applyPage(page: SyncPage, database = db): Promise<void> {
  if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.entries) || typeof page.more !== "boolean") {
    throw new Error("The server returned an invalid sync response.");
  }
  const entries = page.entries.map(validateEntry);
  await database.transaction("rw", database.entries, database.outbox, database.preferences, database.conflicts, async () => {
    const pending = new Set((await database.outbox.toArray()).map((m) => m.entry.id));
    for (const entry of entries) {
      const current = await database.entries.get(entry.id);
      if (!pending.has(entry.id) && (!current || entry.revision >= current.revision)) await database.entries.put(entry);
      if (pending.has(entry.id)) {
        const conflict = await database.conflicts.get(entry.id);
        if (conflict && entry.revision > (conflict.remote?.revision ?? 0)) {
          await database.conflicts.put({ entryId: entry.id, remote: entry });
        }
      }
    }
    const preferences = await getPreferences(database);
    await database.preferences.put({ ...preferences, cursor: Math.max(preferences.cursor, page.cursor) });
  });
}

export async function applyResults(results: MutationResult[], database = db): Promise<void> {
  await database.transaction("rw", database.entries, database.outbox, database.conflicts, async () => {
    for (const result of results) {
      const mutation = await database.outbox.get(result.id);
      if (!mutation) continue;
      if (result.status === "conflict") {
        const remote = result.entry ? validateEntry(result.entry) : null;
        if (remote && remote.id !== mutation.entry.id) throw new Error("The server returned a different expense's conflict.");
        const existing = await database.conflicts.get(mutation.entry.id);
        if (!existing || (remote?.revision ?? 0) >= (existing.remote?.revision ?? 0)) {
          await database.conflicts.put({ entryId: mutation.entry.id, remote });
        }
        continue;
      }
      const entry = validateEntry(result.entry);
      if (entry.id !== mutation.entry.id) throw new Error("The server acknowledged a different expense.");
      await database.outbox.delete(result.id);
      const remaining = await database.outbox.where("entry.id").equals(entry.id).count();
      const current = await database.entries.get(entry.id);
      if (!remaining && (!current || current.revision <= entry.revision)) await database.entries.put(entry);
    }
  });
}

export async function resolveConflict(entryId: string, keepLocal: boolean, database = db): Promise<void> {
  await database.transaction("rw", database.entries, database.outbox, database.conflicts, async () => {
    const conflict = await database.conflicts.get(entryId);
    const local = await database.entries.get(entryId);
    if (!conflict || !local) throw new Error("This conflict is no longer available.");
    await database.outbox.where("entry.id").equals(entryId).delete();
    await database.conflicts.delete(entryId);
    if (!keepLocal) {
      if (conflict.remote) await database.entries.put(conflict.remote);
      else await database.entries.delete(entryId);
    } else {
      const revision = conflict.remote?.revision ?? 0;
      const entry = { ...local, revision: revision + 1, updatedAt: new Date().toISOString() };
      await database.entries.put(entry);
      await database.outbox.add({ id: crypto.randomUUID(), entry, expectedRevision: revision });
    }
  });
}
