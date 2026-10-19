import { validateEntry, type Entry } from "../shared/model";
import { validateTodo, type Todo } from "../shared/todo";
import { db, queueEntries, queueTodos } from "./db";

export interface BackupRecords { entries: Entry[]; todos: Todo[] }

export function readBackup(value: unknown): BackupRecords {
  if (!value || typeof value !== "object") throw new Error("Choose a Splitty JSON backup.");
  const data = value as Record<string, unknown>;
  if ((data.format !== "splitty-v1" && data.format !== "splitty-v2") || !Array.isArray(data.entries)) {
    throw new Error("Choose a Splitty JSON backup.");
  }
  const todos = data.format === "splitty-v2" ? data.todos : [];
  if (!Array.isArray(todos)) throw new Error("Choose a Splitty JSON backup.");
  return { entries: data.entries.map(validateEntry), todos: todos.map(validateTodo) };
}

export async function missingBackupRecords(backup: BackupRecords, database = db): Promise<BackupRecords> {
  const entries = new Set(await database.entries.toCollection().primaryKeys());
  const todos = new Set(await database.todos.toCollection().primaryKeys());
  return { entries: backup.entries.filter((entry) => !entries.has(entry.id)), todos: backup.todos.filter((todo) => !todos.has(todo.id)) };
}

export async function restoreBackup(backup: BackupRecords, database = db): Promise<void> {
  await database.transaction("rw", [
    database.entries, database.outbox, database.conflicts, database.todos, database.todoOutbox, database.todoConflicts
  ], async () => {
    const missing = await missingBackupRecords(backup, database);
    await queueEntries(missing.entries, database);
    await queueTodos(missing.todos, database);
  });
}
