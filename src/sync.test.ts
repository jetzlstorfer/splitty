import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "../shared/model";
import type { Todo } from "../shared/todo";
import { exampleTodo } from "../tests/fixtures";
import { db, getPreferences, queueTodos } from "./db";
import { synchronize } from "./sync";

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); });

describe("todo synchronization", () => {
  it("bounds escaped payloads, clears acknowledged writes, and keeps stream cursors separate", async () => {
    const posted: Mutation<Todo>[][] = [];
    const history: Todo[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === "POST") {
        const { mutations } = JSON.parse(String(init.body)) as { mutations: Mutation<Todo>[] };
        expect(path).toBe("/api/todo-sync");
        expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(128_000);
        posted.push(mutations);
        history.push(...mutations.map((mutation) => mutation.entry));
        return Response.json(mutations.map((mutation) => ({ id: mutation.id, status: "ok", entry: mutation.entry })));
      }
      if (path.startsWith("/api/sync?")) return Response.json({ entries: [], cursor: 42, more: false });
      return Response.json({ entries: history, cursor: history.length, more: false });
    }));
    await queueTodos(Array.from({ length: 6 }, (_, i) => exampleTodo({
      id: `todo-${i}`, title: "\u0000".repeat(200), description: "\u0000".repeat(2000)
    })));
    await synchronize();
    expect(posted.map((batch) => batch.length)).toEqual([5, 1]);
    expect(await db.todoOutbox.count()).toBe(0);
    expect(await db.todos.count()).toBe(6);
    expect(await db.entries.count()).toBe(0);
    expect(await getPreferences()).toMatchObject({ cursor: 42, todoCursor: 6 });
  });
  it("retains pending todos when the API is unavailable and retries with the same operation ID", async () => {
    await queueTodos([exampleTodo()]);
    const pending = (await db.todoOutbox.toArray())[0];
    const response = vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === "POST") return Response.json([{ id: pending.id, status: "ok", entry: pending.entry }]);
      if (path.startsWith("/api/todo-sync")) return Response.json({ error: "Endpoint not found." }, { status: 404 });
      return Response.json({ entries: [], cursor: 0, more: false });
    });
    vi.stubGlobal("fetch", response);
    await expect(synchronize()).rejects.toThrow("Endpoint not found");
    expect(await db.todoOutbox.toArray()).toEqual([pending]);
    response.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") {
        expect(JSON.parse(String(init.body)).mutations[0].id).toBe(pending.id);
        return Response.json([{ id: pending.id, status: "ok", entry: pending.entry }]);
      }
      return Response.json({ entries: [], cursor: 0, more: false });
    });
    await synchronize();
    expect(await db.todoOutbox.count()).toBe(0);
  });
  it("rejects invalid acknowledgements without dropping a manual todo", async () => {
    await queueTodos([exampleTodo()]);
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? [] : { entries: [], cursor: 0, more: false })));
    await expect(synchronize()).rejects.toThrow("invalid acknowledgement");
    expect(await db.todoOutbox.count()).toBe(1);
  });
});
