import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { example } from "../tests/fixtures";
import { SplittyDatabase, applyPage, applyResults, getPreferences, queueEntries, resolveConflict, updatePreferences } from "./db";

let database: SplittyDatabase;
beforeEach(() => { database = new SplittyDatabase(crypto.randomUUID()); });
afterEach(async () => { await database.delete(); });

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
