import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedRecord } from "../shared/model";
import { example, exampleTodo } from "../tests/fixtures";
import { SplittyDatabase, applyPage, applyResults, applyStorePage, expenseStore, getPreferences, queueEntries, resolveConflict, todoStore, updatePreferences, type SyncStore } from "./db";

let database: SplittyDatabase;
beforeEach(() => { database = new SplittyDatabase(crypto.randomUUID()); });
afterEach(async () => { vi.restoreAllMocks(); await database.delete(); });

describe("offline ledger", () => {
  it("defaults existing devices to German without changing names or ledger data", async () => {
    expect((await getPreferences(database)).language).toBe("de");
    await database.preferences.put({ id: "preferences", member: "b", nameA: "Alex", nameB: "Sam", cursor: 4 });
    expect(await getPreferences(database)).toMatchObject({ language: "de", nameA: "Alex", member: "b", cursor: 4 });
  });
  it("persists device language without losing concurrent profile updates or sync cursors", async () => {
    await Promise.all([
      updatePreferences({ language: "en" }, database),
      updatePreferences({ nameA: "Alex", nameB: "Sam", member: "b" }, database)
    ]);
    await applyPage({ entries: [], cursor: 5, more: false }, database);
    expect(await getPreferences(database)).toMatchObject({ language: "en", nameA: "Alex", nameB: "Sam", member: "b", cursor: 5 });
    expect(await database.outbox.count()).toBe(0);
  });
  it("atomically stores changes and a retryable outbox, including sequential edits", async () => {
    await queueEntries([example({ revision: 0 })], database);
    const original = (await database.outbox.toArray())[0];
    expect(original.expectedRevision).toBe(0);
    await queueEntries([example({ description: "Changed" })], database);
    expect((await database.outbox.toArray()).map((mutation) => mutation.expectedRevision).sort()).toEqual([0, 1]);
    expect((await database.entries.get("test-entry"))?.revision).toBe(2);
    await applyResults([{ id: original.id, status: "ok", entry: original.entry }], database);
    expect((await database.entries.get("test-entry"))?.description).toBe("Changed");
    expect(await database.outbox.count()).toBe(1);
  });
  it("keeps unsynced edits when receiving remote data", async () => {
    await queueEntries([example({ description: "Local edit" })], database);
    await applyPage({ entries: [example({ description: "Remote edit", revision: 2 })], cursor: 7, more: false }, database);
    expect((await database.entries.get("test-entry"))?.description).toBe("Local edit");
    expect((await database.preferences.get("preferences"))?.cursor).toBe(7);
  });
  it("rejects stale saves without overwriting pending insurance completion", async () => {
    await queueEntries([example({ revision: 0 })], database);
    const submitted = { ...example(), insuranceSubmittedAt: "2026-10-01T12:00:00.000Z" };
    await queueEntries([submitted], database);
    const current = await database.entries.get("test-entry");
    const pending = await database.outbox.toArray();
    await expect(queueEntries([
      example({ id: "new-entry", revision: 0 }),
      example({ description: "Stale form" })
    ], database)).rejects.toThrow("This expense changed. Reopen it before saving.");
    expect(await database.entries.get("test-entry")).toEqual(current);
    expect(await database.entries.get("new-entry")).toBeUndefined();
    expect(await database.outbox.toArray()).toEqual(pending);
  });
  it("does not resurrect a remote tombstone from a stale expense form", async () => {
    await applyPage({ entries: [example({ deleted: true, revision: 2 })], cursor: 2, more: false }, database);
    await expect(queueEntries([example({ description: "Stale form" })], database))
      .rejects.toThrow("Reopen");
    expect(await database.entries.get("test-entry")).toMatchObject({ deleted: true, revision: 2 });
    expect(await database.outbox.count()).toBe(0);
    database.close();
    await database.open();
    expect(await database.entries.get("test-entry")).toMatchObject({ deleted: true, revision: 2 });
  });
  it("records conflicts and rebases an explicit keep-local decision", async () => {
    await queueEntries([example({ description: "Local" })], database);
    const pending = (await database.outbox.toArray())[0];
    await applyResults([{ id: pending.id, status: "conflict", entry: example({ description: "Remote", revision: 3 }) }], database);
    expect(await database.conflicts.count()).toBe(1);
    await resolveConflict("test-entry", true, database);
    expect((await database.entries.get("test-entry"))?.revision).toBe(4);
    expect((await database.outbox.toArray())[0].expectedRevision).toBe(3);
    expect(await database.conflicts.count()).toBe(0);
  });

  function pageTests<T extends VersionedRecord>(
    name: string, createStore: (database: SplittyDatabase) => SyncStore<T>, record: (overrides?: Partial<T>) => T
  ) {
    describe(`${name} sync page application`, () => {
      it("applies a 500-change history in one bulk write without scanning the outbox", async () => {
        const store = createStore(database);
        const put = vi.spyOn(store.entries, "put");
        const get = vi.spyOn(store.entries, "get");
        const bulkPut = vi.spyOn(store.entries, "bulkPut");
        const scan = vi.spyOn(store.outbox, "toArray");
        const entries = Array.from({ length: 500 }, (_, i) => ({
          ...record(), revision: i + 1, deleted: i === 499
        }));
        await applyStorePage({ entries, cursor: 500, more: false }, store);
        expect(await store.entries.toArray()).toEqual([entries[499]]);
        expect(get).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        expect(bulkPut).toHaveBeenCalledExactlyOnceWith([entries[499]]);
        expect(scan).not.toHaveBeenCalled();
        expect((await getPreferences(database))[store.cursorField]).toBe(500);
      });
      it("preserves pending work and the newest conflict when a page repeats a record", async () => {
        const store = createStore(database);
        const local = record();
        await store.entries.put(local);
        const mutation = { id: "pending", entry: local, expectedRevision: 0 };
        await store.outbox.add(mutation);
        await store.conflicts.put({ entryId: local.id, remote: null });
        const remote = { ...local, revision: 5, deleted: true };
        await applyStorePage({
          entries: [{ ...local, revision: 2 }, remote, { ...local, revision: 3 }],
          cursor: 10, more: false
        }, store);
        expect(await store.entries.get(local.id)).toEqual(local);
        expect(await store.outbox.toArray()).toEqual([mutation]);
        expect(await store.conflicts.get(local.id)).toEqual({ entryId: local.id, remote });
        database.close();
        await database.open();
        expect(await store.entries.get(local.id)).toEqual(local);
        expect(await store.conflicts.get(local.id)).toEqual({ entryId: local.id, remote });
        expect((await getPreferences(database))[store.cursorField]).toBe(10);
      });
      it("does not write preferences or scan pending payloads on an unchanged poll", async () => {
        const store = createStore(database);
        await applyStorePage({ entries: [], cursor: 9, more: false }, store);
        const put = vi.spyOn(database.preferences, "put");
        const scan = vi.spyOn(store.outbox, "toArray");
        await applyStorePage({ entries: [], cursor: 9, more: false }, store);
        expect(put).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
      });
    });
  }

  pageTests("expense", expenseStore, example);
  pageTests("manual to-do", todoStore, exampleTodo);
  it("honors an explicit keep-remote decision including deletion", async () => {
    await queueEntries([example()], database);
    const pending = (await database.outbox.toArray())[0];
    await applyResults([{ id: pending.id, status: "conflict", entry: example({ revision: 2, deleted: true }) }], database);
    await resolveConflict("test-entry", false, database);
    expect((await database.entries.get("test-entry"))?.deleted).toBe(true);
    expect(await database.outbox.count()).toBe(0);
  });
  it("deduplicates imports but still permits editing and deleting imported entries", async () => {
    const imported = example({ kind: "imported", paidBy: null, shareA: null, importKey: "hash-1", revision: 0 });
    await queueEntries([imported, imported], database);
    expect(await database.entries.count()).toBe(1);
    expect(await database.outbox.count()).toBe(1);
    const entry = (await database.entries.get(imported.id))!;
    await queueEntries([{ ...entry, deleted: true }], database);
    expect((await database.entries.get(imported.id))?.deleted).toBe(true);
    expect(await database.outbox.count()).toBe(2);
  });
  it("rolls back a whole import if any entry fails validation", async () => {
    await expect(queueEntries([example(), example({ id: "bad", balanceA: 33 })], database)).rejects.toThrow();
    expect(await database.entries.count()).toBe(0);
    expect(await database.outbox.count()).toBe(0);
  });
  it("does not let delayed acknowledgements or pulls revert newer data from another tab", async () => {
    await queueEntries([example()], database);
    const mutation = (await database.outbox.toArray())[0];
    await database.entries.put(example({ revision: 4, description: "Newer tab state" }));
    await applyResults([{ id: mutation.id, status: "ok", entry: mutation.entry }], database);
    expect((await database.entries.get("test-entry"))?.description).toBe("Newer tab state");
    await applyPage({ entries: [], cursor: 10, more: false }, database);
    await applyPage({ entries: [], cursor: 4, more: false }, database);
    expect((await database.preferences.get("preferences"))?.cursor).toBe(10);
  });
  it("refreshes a conflict's remote version before advancing past newer changes", async () => {
    await queueEntries([example()], database);
    const mutation = (await database.outbox.toArray())[0];
    await applyResults([{ id: mutation.id, status: "conflict", entry: example({ revision: 2 }) }], database);
    await applyPage({ entries: [example({ revision: 3, description: "Latest remote" })], cursor: 3, more: false }, database);
    await applyResults([{ id: mutation.id, status: "conflict", entry: example({ revision: 2 }) }], database);
    await resolveConflict("test-entry", false, database);
    expect((await database.entries.get("test-entry"))?.description).toBe("Latest remote");
    expect((await database.entries.get("test-entry"))?.revision).toBe(3);
  });
});
