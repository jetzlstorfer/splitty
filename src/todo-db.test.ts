import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { example, exampleTodo } from "../tests/fixtures";
import { SplittyDatabase, applyPage, applyStorePage, applyStoreResults, getPreferences, queueTodos, resolveStoreConflict, todoStore } from "./db";

let database: SplittyDatabase;
beforeEach(() => { database = new SplittyDatabase(crypto.randomUUID()); });
afterEach(async () => { await database.delete(); });

describe("offline manual to-dos", () => {
  it("upgrades an existing database without losing expenses, pending writes, or its cursor", async () => {
    const old = new Dexie(database.name);
    old.version(1).stores({ entries: "id, date", outbox: "id, entry.id", preferences: "id", conflicts: "entryId" });
    await old.table("entries").put(example());
    await old.table("outbox").put({ id: "pending-expense", entry: example(), expectedRevision: 0 });
    await old.table("preferences").put({ id: "preferences", cursor: 42, member: "a", nameA: "Alex", nameB: "Sam" });
    old.close();
    await database.open();
    expect(await database.entries.get("test-entry")).toEqual(example());
    expect(await database.outbox.count()).toBe(1);
    expect(await getPreferences(database)).toMatchObject({ cursor: 42, todoCursor: 0 });
    await queueTodos([exampleTodo()], database);
    expect(await database.todos.count()).toBe(1);
  });
  it("persists sequential edits atomically without mixing expense records or cursors", async () => {
    const store = todoStore(database);
    await queueTodos([exampleTodo({ revision: 0 })], database);
    const original = (await database.todoOutbox.toArray())[0];
    await queueTodos([exampleTodo({ title: "Updated", description: "Details", done: true })], database);
    await applyStoreResults([{ id: original.id, status: "ok", entry: original.entry }], store);
    expect(await database.todos.get("test-todo")).toMatchObject({ title: "Updated", description: "Details", done: true, revision: 2 });
    expect(await database.todoOutbox.count()).toBe(1);
    expect(await database.entries.count()).toBe(0);
    expect(await database.outbox.count()).toBe(0);
    await applyPage({ entries: [], cursor: 7, more: false }, database);
    await applyStorePage({ entries: [], cursor: 3, more: false }, store);
    expect(await getPreferences(database)).toMatchObject({ cursor: 7, todoCursor: 3 });
  });
  it("rejects stale forms and rolls back invalid batches", async () => {
    await expect(queueTodos([exampleTodo(), exampleTodo({ id: "invalid", title: "" })], database)).rejects.toThrow();
    expect(await database.todos.count()).toBe(0);
    expect(await database.todoOutbox.count()).toBe(0);
    await queueTodos([exampleTodo({ revision: 0 })], database);
    await expect(queueTodos([exampleTodo({ revision: 0, title: "Stale" })], database)).rejects.toThrow("Reopen");
    expect((await database.todos.get("test-todo"))?.title).toBe(exampleTodo().title);
  });
  it("preserves unsynced work, refreshes remote conflicts, and rebases keep-local decisions", async () => {
    const store = todoStore(database);
    await queueTodos([exampleTodo({ title: "Local" })], database);
    const pending = (await database.todoOutbox.toArray())[0];
    await applyStorePage({ entries: [exampleTodo({ title: "Remote", revision: 2 })], cursor: 2, more: false }, store);
    expect((await database.todos.get("test-todo"))?.title).toBe("Local");
    await applyStoreResults([{ id: pending.id, status: "conflict", entry: exampleTodo({ title: "Remote", revision: 2 }) }], store);
    await expect(queueTodos([exampleTodo()], database)).rejects.toThrow("conflict");
    await applyStorePage({ entries: [exampleTodo({ title: "Newest remote", revision: 3 })], cursor: 3, more: false }, store);
    await applyStoreResults([{ id: pending.id, status: "conflict", entry: exampleTodo({ revision: 2 }) }], store);
    expect((await database.todoConflicts.get("test-todo"))?.remote?.title).toBe("Newest remote");
    await resolveStoreConflict("test-todo", true, store);
    expect(await database.todos.get("test-todo")).toMatchObject({ title: "Local", revision: 4 });
    expect((await database.todoOutbox.toArray())[0].expectedRevision).toBe(3);
    expect(await database.todoConflicts.count()).toBe(0);
  });
  it.each([null, exampleTodo({ deleted: true, revision: 3 })])("honors keep-remote, including missing/deleted todos", async (remote) => {
    const store = todoStore(database);
    await queueTodos([exampleTodo()], database);
    const pending = (await database.todoOutbox.toArray())[0];
    await applyStoreResults([{ id: pending.id, status: "conflict", entry: remote }], store);
    await resolveStoreConflict("test-todo", false, store);
    expect(await database.todos.get("test-todo")).toEqual(remote ?? undefined);
    expect(await database.todoOutbox.count()).toBe(0);
  });
  it("does not let old responses rewind records or todo cursors", async () => {
    const store = todoStore(database);
    await queueTodos([exampleTodo()], database);
    const pending = (await database.todoOutbox.toArray())[0];
    await database.todos.put(exampleTodo({ title: "Newer tab state", revision: 4 }));
    await applyStoreResults([{ id: pending.id, status: "ok", entry: pending.entry }], store);
    await applyStorePage({ entries: [exampleTodo()], cursor: 10, more: false }, store);
    await applyStorePage({ entries: [], cursor: 4, more: false }, store);
    expect((await database.todos.get("test-todo"))?.title).toBe("Newer tab state");
    expect((await getPreferences(database)).todoCursor).toBe(10);
  });
  it("rejects acknowledgements for another todo without removing pending work", async () => {
    await queueTodos([exampleTodo()], database);
    const pending = (await database.todoOutbox.toArray())[0];
    await expect(applyStoreResults([{ id: pending.id, status: "ok", entry: exampleTodo({ id: "other" }) }], todoStore(database))).rejects.toThrow("different entry");
    expect(await database.todoOutbox.count()).toBe(1);
  });
});
