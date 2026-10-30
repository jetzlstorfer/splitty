import type { VersionedRecord } from "./model";

export interface Todo extends VersionedRecord {
  title: string;
  description?: string;
  done: boolean;
  createdAt: string;
  /** Household-wide manual order; to-dos without a position are listed first, newest first. */
  position?: number;
}

export const MAX_TODO_TITLE = 200;
export const MAX_TODO_DESCRIPTION = 2000;

export function validateTodo(value: unknown): Todo {
  if (!value || typeof value !== "object") throw new Error("Invalid to-do.");
  const todo = value as Record<string, unknown>;
  if (typeof todo.title !== "string" || !todo.title.trim() || todo.title.length > MAX_TODO_TITLE) {
    throw new Error("Enter a title of at most 200 characters.");
  }
  if (todo.description !== undefined && (typeof todo.description !== "string" || todo.description.length > MAX_TODO_DESCRIPTION)) {
    throw new Error("Enter a description of at most 2000 characters.");
  }
  if (typeof todo.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(todo.id)
    || typeof todo.done !== "boolean" || typeof todo.deleted !== "boolean"
    || typeof todo.revision !== "number" || !Number.isSafeInteger(todo.revision) || todo.revision < 0
    || typeof todo.createdAt !== "string" || todo.createdAt.length > 40 || !Number.isFinite(Date.parse(todo.createdAt))
    || typeof todo.updatedAt !== "string" || todo.updatedAt.length > 40 || !Number.isFinite(Date.parse(todo.updatedAt))
    || (todo.position !== undefined && (typeof todo.position !== "number" || !Number.isFinite(todo.position) || Math.abs(todo.position) > 1e12))) {
    throw new Error("Invalid to-do fields.");
  }
  return {
    id: todo.id, title: todo.title.trim(),
    ...(typeof todo.description === "string" && todo.description.trim() ? { description: todo.description.trim() } : {}),
    done: todo.done, ...(typeof todo.position === "number" ? { position: todo.position } : {}),
    createdAt: todo.createdAt, updatedAt: todo.updatedAt, revision: todo.revision, deleted: todo.deleted
  };
}
