import Dexie, { type EntityTable, type Table } from "dexie";
import { defaultInsuranceTodoSetting, validateEntry, type Entry, type InsuranceTodoSetting, type Member, type Mutation, type MutationResult, type SyncPage, type VersionedRecord } from "../shared/model";
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
  insuranceTodoSetting?: InsuranceTodoSetting;
  pendingInsuranceTodoSetting?: { id: string; enabled: boolean };
}

export function automaticInsuranceTodos(preferences: Preferences): boolean {
  return preferences.pendingInsuranceTodoSetting?.enabled ?? preferences.insuranceTodoSetting?.enabled ?? defaultInsuranceTodoSetting.enabled;
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

export interface LegacyImport {
  id: "legacy-import";
  importedAt: string;
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
  migrations!: EntityTable<LegacyImport, "id">;

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
    this.version(4).stores({ migrations: "id" });
  }
}

class DeviceDatabase extends Dexie {
  session!: EntityTable<DeviceSession, "id">;

  constructor() {
    super("splitty-device");
    this.version(1).stores({ session: "id" });
  }
}

const scopeStorageKey = "splitty-active-database";
const accountDatabaseName = (value: string | null) =>
  value && /^splitty-account-[a-f0-9]{64}$/.test(value) ? value : "splitty";
function rememberedDatabaseName(): string {
  try { return accountDatabaseName(typeof localStorage === "undefined" ? null : localStorage.getItem(scopeStorageKey)); }
  catch { return "splitty"; }
}

const legacyDatabase = new SplittyDatabase();
const deviceDatabase = new DeviceDatabase();
const initialDatabaseName = rememberedDatabaseName();
export let db = initialDatabaseName === legacyDatabase.name ? legacyDatabase : new SplittyDatabase(initialDatabaseName);

export function isActiveDatabase(database: SplittyDatabase): boolean {
  return db === database;
}

async function selectDatabase(name: string, persist = true): Promise<void> {
  if (persist && typeof localStorage !== "undefined") {
    try {
      if (name === legacyDatabase.name) localStorage.removeItem(scopeStorageKey);
      else localStorage.setItem(scopeStorageKey, name);
    } catch { throw new Error("Could not save this device's signed-in account."); }
  }
  if (db.name === name) return;
  const next = name === legacyDatabase.name ? legacyDatabase : new SplittyDatabase(name);
  await next.open();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("splitty-database-changing"));
  db.close();
  db = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("splitty-database-changed"));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== scopeStorageKey) return;
    void selectDatabase(accountDatabaseName(event.newValue), false).catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent("splitty-error", {
        detail: `Local storage failed: ${error instanceof Error ? error.message : String(error)}`
      }));
    });
  });
}

export async function activateAccountDatabase(userId: string, householdId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(householdId)) {
    throw new Error("Invalid sign-in response.");
  }
  if (userId.startsWith("legacy-")) {
    await selectDatabase("splitty");
    return;
  }
  const input = new TextEncoder().encode(`${userId}\0${householdId}`);
  const hash = await crypto.subtle.digest("SHA-256", input);
  const suffix = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await selectDatabase(`splitty-account-${suffix}`);
}

export async function activateAnonymousDatabase(): Promise<void> {
  await selectDatabase("splitty");
}

export async function getDeviceKey(database?: SplittyDatabase): Promise<string | null> {
  if (database) return (await database.session.get("session"))?.key ?? null;
  const current = (await deviceDatabase.session.get("session"))?.key;
  if (current) return current;
  const legacy = (await legacyDatabase.session.get("session"))?.key ?? null;
  if (legacy) {
    await deviceDatabase.session.put({ id: "session", key: legacy });
    await legacyDatabase.session.delete("session");
  }
  return legacy;
}

export async function setDeviceKey(key: string | null, database?: SplittyDatabase): Promise<void> {
  const session = database?.session ?? deviceDatabase.session;
  if (key) await session.put({ id: "session", key });
  else {
    await session.delete("session");
    if (!database) await legacyDatabase.session.delete("session");
  }
}

export async function clearAccountDatabase(database: SplittyDatabase): Promise<void> {
  if (!/^splitty-account-[a-f0-9]{64}$/.test(database.name)) {
    throw new Error("Cannot clear the shared local database.");
  }
  const cleanupDatabase = new SplittyDatabase(database.name);
  try {
    await cleanupDatabase.open();
    for (let attempt = 0; attempt < 3; attempt++) {
      await cleanupDatabase.transaction("rw", [
        cleanupDatabase.entries, cleanupDatabase.outbox, cleanupDatabase.preferences, cleanupDatabase.conflicts,
        cleanupDatabase.todos, cleanupDatabase.todoOutbox, cleanupDatabase.todoConflicts,
        cleanupDatabase.session, cleanupDatabase.migrations
      ], async () => {
        await cleanupDatabase.entries.clear();
        await cleanupDatabase.outbox.clear();
        await cleanupDatabase.preferences.clear();
        await cleanupDatabase.conflicts.clear();
        await cleanupDatabase.todos.clear();
        await cleanupDatabase.todoOutbox.clear();
        await cleanupDatabase.todoConflicts.clear();
        await cleanupDatabase.session.clear();
        await cleanupDatabase.migrations.clear();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const remaining = await Promise.all(cleanupDatabase.tables.map((table) => table.count()));
      if (remaining.every((count) => count === 0)) return;
    }
    throw new Error("Could not remove local account data.");
  } finally {
    cleanupDatabase.close();
  }
}

export async function assertLegacyMigrationTarget(database = db): Promise<void> {
  if (!/^splitty-account-[a-f0-9]{64}$/.test(database.name)) {
    throw new Error("Sign in to an account before importing household history.");
  }
  const marker = await database.migrations.get("legacy-import");
  if (marker) return;
  const [entries, outbox, conflicts, todos, todoOutbox, todoConflicts, preferences] = await Promise.all([
    database.entries.count(), database.outbox.count(), database.conflicts.count(),
    database.todos.count(), database.todoOutbox.count(), database.todoConflicts.count(),
    database.preferences.get("preferences")
  ]);
  if (entries || outbox || conflicts || todos || todoOutbox || todoConflicts
    || (preferences && (preferences.cursor !== 0 || (preferences.todoCursor ?? 0) !== 0))) {
    throw new Error("This account already has household data. Its history cannot be moved safely.");
  }
}

export async function importLegacyDatabase(
  identity: { member: Member; nameA: string; nameB: string },
  target = db,
  source = legacyDatabase
): Promise<void> {
  if (target === source || !/^splitty-account-[a-f0-9]{64}$/.test(target.name)) {
    throw new Error("Cannot import household history into this database.");
  }
  await source.open();
  const legacy = await source.transaction("r", [
    source.entries, source.outbox, source.conflicts, source.todos, source.todoOutbox,
    source.todoConflicts, source.preferences
  ], async () => ({
    entries: await source.entries.toArray(),
    outbox: await source.outbox.toArray(),
    conflicts: await source.conflicts.toArray(),
    todos: await source.todos.toArray(),
    todoOutbox: await source.todoOutbox.toArray(),
    todoConflicts: await source.todoConflicts.toArray(),
    preferences: await source.preferences.get("preferences")
  }));
  await target.transaction("rw", [
    target.entries, target.outbox, target.conflicts, target.todos, target.todoOutbox,
    target.todoConflicts, target.preferences, target.migrations
  ], async () => {
    if (await target.migrations.get("legacy-import")) return;
    const [entries, outbox, conflicts, todos, todoOutbox, todoConflicts, preferences] = await Promise.all([
      target.entries.count(), target.outbox.count(), target.conflicts.count(),
      target.todos.count(), target.todoOutbox.count(), target.todoConflicts.count(),
      target.preferences.get("preferences")
    ]);
    if (entries || outbox || conflicts || todos || todoOutbox || todoConflicts
      || (preferences && (preferences.cursor !== 0 || (preferences.todoCursor ?? 0) !== 0))) {
      throw new Error("This account already has household data. Its history cannot be moved safely.");
    }
    await target.entries.bulkAdd(legacy.entries);
    await target.outbox.bulkAdd(legacy.outbox);
    await target.conflicts.bulkAdd(legacy.conflicts);
    await target.todos.bulkAdd(legacy.todos);
    await target.todoOutbox.bulkAdd(legacy.todoOutbox);
    await target.todoConflicts.bulkAdd(legacy.todoConflicts);
    await target.preferences.put({
      ...(legacy.preferences ?? await getPreferences(source)),
      id: "preferences",
      member: identity.member,
      nameA: identity.nameA,
      nameB: identity.nameB,
      cursor: legacy.preferences?.cursor ?? 0,
      todoCursor: legacy.preferences?.todoCursor ?? 0
    });
    await target.migrations.put({ id: "legacy-import", importedAt: new Date().toISOString() });
  });
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

export async function localQueueState(database = db) {
  const [expenses, todos, preferences] = await Promise.all([
    database.outbox.count(), database.todoOutbox.count(), getPreferences(database)
  ]);
  return { pending: expenses + todos + Number(!!preferences.pendingInsuranceTodoSetting), preferences };
}

export function queueInsuranceTodoSetting(enabled: boolean, database = db): Promise<void> {
  return updatePreferences({ pendingInsuranceTodoSetting: { id: crypto.randomUUID(), enabled } }, database);
}

/** Apply only to newly entered or imported receipts, never to edits, sync pulls or backup restores. */
export async function queueNewReceipts(entries: Entry[], database = db): Promise<void> {
  await database.transaction("rw", [database.preferences, database.entries, database.outbox, database.conflicts], async () => {
    const enabled = automaticInsuranceTodos(await getPreferences(database));
    await queueEntries(enabled ? entries : entries.map((entry) => ({ ...entry, skipInsuranceTodo: true })), database);
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
