import Dexie, { type EntityTable, type Table } from "dexie";
import { validateEntry, type Entry, type Member, type Mutation, type MutationResult, type SyncPage, type VersionedRecord } from "../shared/model";
import type { Language } from "../shared/i18n";
import { validateTodo, type Todo } from "../shared/todo";

export interface Preferences {
  id: "preferences";
  member: Member;
  nameA: string;
  nameB: string;
  cursor: number;
  todoCursor?: number;
  language?: Language;
}

export interface Conflict<T = Entry> {
  entryId: string;
  remote: T | null;
}

/** Recovers the sign-in when a browser drops the session cookie but keeps IndexedDB. Never exported in backups. */
export interface DeviceSession {
  id: "session";
  key: string;
}

export class SplittyDatabase extends Dexie {
  entries!: Table<Entry, string>;
  outbox!: Table<Mutation, string>;
  preferences!: EntityTable<Preferences, "id">;
  conflicts!: Table<Conflict, string>;
  todos!: Table<Todo, string>;
  todoOutbox!: Table<Mutation<Todo>, string>;
  todoConflicts!: Table<Conflict<Todo>, string>;
  session!: EntityTable<DeviceSession, "id">;

  constructor(name = "splitty") {
    super(name);
    this.version(1).stores({
      entries: "id, date",
      outbox: "id, entry.id",
      preferences: "id",
      conflicts: "entryId"
    });
    this.version(2).stores({
      todos: "id, createdAt",
      todoOutbox: "id, entry.id",
      todoConflicts: "entryId"
    });
    this.version(3).stores({ session: "id" });
  }
}

export const db = new SplittyDatabase();

export async function getDeviceKey(database = db): Promise<string | null> {
  return (await database.session.get("session"))?.key ?? null;
}

export async function setDeviceKey(key: string | null, database = db): Promise<void> {
  if (key) await database.session.put({ id: "session", key });
  else await database.session.delete("session");
}

export async function getPreferences(database = db): Promise<Preferences> {
  const preferences: Preferences = await database.preferences.get("preferences")
    ?? { id: "preferences", member: "a", nameA: "You", nameB: "Your wife", cursor: 0 };
  return { ...preferences, todoCursor: preferences.todoCursor ?? 0, language: preferences.language === "en" ? "en" : "de" };
}

export async function updatePreferences(changes: Partial<Omit<Preferences, "id" | "cursor" | "todoCursor">>, database = db): Promise<void> {
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
      if (previous && input.revision !== previous.revision) throw new Error("This expense changed. Reopen it before saving.");
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

export async function queueTodos(todos: Todo[], database = db): Promise<void> {
  await database.transaction("rw", database.todos, database.todoOutbox, database.todoConflicts, async () => {
    for (const input of todos) {
      if (await database.todoConflicts.get(input.id)) throw new Error("Resolve this to-do's sync conflict before editing it.");
      const previous = await database.todos.get(input.id);
      if (previous && input.revision !== previous.revision) throw new Error("This to-do changed. Reopen it before saving.");
      const revision = previous?.revision ?? 0;
      const entry = validateTodo({ ...input, revision: revision + 1, updatedAt: new Date().toISOString() });
      await database.todos.put(entry);
      await database.todoOutbox.add({ id: crypto.randomUUID(), entry, expectedRevision: revision });
    }
  });
}

export interface SyncStore<T extends VersionedRecord> {
  database: SplittyDatabase;
  entries: Table<T, string, T>;
  outbox: Table<Mutation<T>, string, Mutation<T>>;
  conflicts: Table<Conflict<T>, string, Conflict<T>>;
  validate: (value: unknown) => T;
  cursorField: "cursor" | "todoCursor";
}

export const expenseStore = (database = db): SyncStore<Entry> => ({
  database, entries: database.entries, outbox: database.outbox, conflicts: database.conflicts,
  validate: validateEntry, cursorField: "cursor"
});

export const todoStore = (database = db): SyncStore<Todo> => ({
  database, entries: database.todos, outbox: database.todoOutbox, conflicts: database.todoConflicts,
  validate: validateTodo, cursorField: "todoCursor"
});

export async function applyStorePage<T extends VersionedRecord>(page: SyncPage<T>, store: SyncStore<T>): Promise<void> {
  const { database } = store;
  if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.entries) || typeof page.more !== "boolean") {
    throw new Error("The server returned an invalid sync response.");
  }
  const latest = new Map<string, T>();
  for (const input of page.entries) {
    const entry = store.validate(input);
    if (entry.revision >= (latest.get(entry.id)?.revision ?? -1)) latest.set(entry.id, entry);
  }
  const entries = [...latest.values()];
  await database.transaction("rw", store.entries, store.outbox, database.preferences, store.conflicts, async () => {
    if (entries.length) {
      const ids = entries.map((entry) => entry.id);
      const pending = new Set(await store.outbox.where("entry.id").anyOf(ids).keys());
      const current = await store.entries.bulkGet(ids);
      const conflicts = pending.size ? await store.conflicts.bulkGet(ids) : [];
      const updates: T[] = [], conflictUpdates: Conflict<T>[] = [];
      for (const [index, entry] of entries.entries()) {
        if (!pending.has(entry.id)) {
          if (!current[index] || entry.revision >= current[index].revision) updates.push(entry);
        } else {
          const conflict = conflicts[index];
          if (conflict && entry.revision > (conflict.remote?.revision ?? 0)) {
            conflictUpdates.push({ entryId: entry.id, remote: entry });
          }
        }
      }
      if (updates.length) await store.entries.bulkPut(updates);
      if (conflictUpdates.length) await store.conflicts.bulkPut(conflictUpdates);
    }
    const preferences = await getPreferences(database);
    if (page.cursor > (preferences[store.cursorField] ?? 0)) {
      await database.preferences.put({ ...preferences, [store.cursorField]: page.cursor });
    }
  });
}

export async function applyStoreResults<T extends VersionedRecord>(results: MutationResult<T>[], store: SyncStore<T>): Promise<void> {
  await store.database.transaction("rw", store.entries, store.outbox, store.conflicts, async () => {
    for (const result of results) {
      const mutation = await store.outbox.get(result.id);
      if (!mutation) continue;
      if (result.status === "conflict") {
        const remote = result.entry ? store.validate(result.entry) : null;
        if (remote && remote.id !== mutation.entry.id) throw new Error("The server returned a different entry's conflict.");
        const existing = await store.conflicts.get(mutation.entry.id);
        if (!existing || (remote?.revision ?? 0) >= (existing.remote?.revision ?? 0)) {
          await store.conflicts.put({ entryId: mutation.entry.id, remote });
        }
        continue;
      }
      const entry = store.validate(result.entry);
      if (entry.id !== mutation.entry.id) throw new Error("The server acknowledged a different entry.");
      await store.outbox.delete(result.id);
      const remaining = await store.outbox.where("entry.id").equals(entry.id).count();
      const current = await store.entries.get(entry.id);
      if (!remaining && (!current || current.revision <= entry.revision)) await store.entries.put(entry);
    }
  });
}

export async function resolveStoreConflict<T extends VersionedRecord>(entryId: string, keepLocal: boolean, store: SyncStore<T>): Promise<void> {
  await store.database.transaction("rw", store.entries, store.outbox, store.conflicts, async () => {
    const conflict = await store.conflicts.get(entryId);
    const local = await store.entries.get(entryId);
    if (!conflict || !local) throw new Error("This conflict is no longer available.");
    await store.outbox.where("entry.id").equals(entryId).delete();
    await store.conflicts.delete(entryId);
    if (!keepLocal) {
      if (conflict.remote) await store.entries.put(conflict.remote);
      else await store.entries.delete(entryId);
    } else {
      const revision = conflict.remote?.revision ?? 0;
      const entry = { ...local, revision: revision + 1, updatedAt: new Date().toISOString() };
      await store.entries.put(entry);
      await store.outbox.add({ id: crypto.randomUUID(), entry, expectedRevision: revision });
    }
  });
}

export const applyPage = (page: SyncPage, database = db) => applyStorePage(page, expenseStore(database));
export const applyResults = (results: MutationResult[], database = db) => applyStoreResults(results, expenseStore(database));
export const resolveConflict = (entryId: string, keepLocal: boolean, database = db) =>
  resolveStoreConflict(entryId, keepLocal, expenseStore(database));
