import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { example, exampleTodo } from "../tests/fixtures";
import { queueInsuranceTodoSetting, queueNewReceipts, SplittyDatabase } from "./db";
import { insuranceTodos } from "./todos";
import { missingBackupRecords, readBackup, restoreBackup } from "./backup";

let database: SplittyDatabase;
beforeEach(() => { database = new SplittyDatabase(crypto.randomUUID()); });
afterEach(async () => { await database.delete(); });

describe("backups with manual to-dos", () => {
  it("accepts old expense-only backups and new backups with todos", () => {
    expect(readBackup({ format: "splitty-v1", entries: [example()] })).toEqual({ entries: [example()], todos: [] });
    const todo = exampleTodo({ description: "Details", done: true, position: 2.5 });
    expect(readBackup({ format: "splitty-v2", entries: [example()], todos: [todo] })).toEqual({ entries: [example()], todos: [todo] });
  });
  it("rejects malformed backups rather than silently losing todos", () => {
    expect(() => readBackup({ format: "splitty-v2", entries: [] })).toThrow();
    expect(() => readBackup({ format: "splitty-v2", entries: [], todos: [exampleTodo({ title: "" })] })).toThrow();
    expect(() => readBackup({ format: "splitty-v3", entries: [] })).toThrow();
  });
  it("restores missing records and queues them, without overwriting existing data or resurrecting deletions", async () => {
    await database.entries.put(example({ description: "Local expense" }));
    await database.todos.put(exampleTodo({ deleted: true }));
    const backup = readBackup({
      format: "splitty-v2", entries: [example(), example({ id: "missing-expense" })],
      todos: [exampleTodo(), exampleTodo({ id: "missing-todo", description: "Restored", done: true, revision: 12 })]
    });
    expect((await missingBackupRecords(backup, database)).todos).toHaveLength(1);
    await restoreBackup(backup, database);
    await restoreBackup(backup, database);
    expect((await database.entries.get("test-entry"))?.description).toBe("Local expense");
    expect((await database.todos.get("test-todo"))?.deleted).toBe(true);
    expect(await database.todos.get("missing-todo")).toMatchObject({ description: "Restored", done: true, revision: 1 });
    expect(await database.outbox.count()).toBe(1);
    expect(await database.todoOutbox.count()).toBe(1);
  });
  it("rolls back expenses too if a todo cannot be restored", async () => {
    await expect(restoreBackup({ entries: [example()], todos: [exampleTodo({ title: "" })] }, database)).rejects.toThrow();
    expect(await database.entries.count()).toBe(0);
    expect(await database.outbox.count()).toBe(0);
  });
  it("preserves reminder eligibility on restore instead of applying the current CSV import setting", async () => {
    const imported = example({ id: "imported", importKey: "csv-key", kind: "imported", description: "Apotheke", paidBy: null, shareA: null });
    await queueInsuranceTodoSetting(false, database);
    await queueNewReceipts([imported], database);
    const skipped = example({ id: "restored-skip", description: "Apotheke", skipInsuranceTodo: true });
    const submitted = example({ description: "Arzt", insuranceSubmittedAt: "2024-06-02T00:00:00Z" });
    const backup = readBackup({ format: "splitty-v2", entries: [submitted, skipped], todos: [] });
    await restoreBackup(backup, database);
    await queueInsuranceTodoSetting(true, database);
    const entries = await database.entries.toArray();
    expect(entries).toHaveLength(3);
    expect(insuranceTodos(entries).map(({ entry, done }) => [entry.id, done])).toEqual([[submitted.id, true]]);
    expect(entries.find((entry) => entry.id === imported.id)).toMatchObject({ balanceA: imported.balanceA, paidBy: null, shareA: null });
  });
});
