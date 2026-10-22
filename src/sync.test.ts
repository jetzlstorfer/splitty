import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "../shared/model";
import type { Todo } from "../shared/todo";
import { example, exampleTodo } from "../tests/fixtures";
import { db, getDeviceKey, getPreferences, queueTodos, setDeviceKey } from "./db";
import { ApiError, identify, signInDevice, signOutDevice, synchronize } from "./sync";

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); });

const deviceKey = "K".repeat(43);
const identity = { member: "a", nameA: "Alex", nameB: "Sam" };

describe("device session recovery", () => {
  it("stores the device key on sign-in and sends it when signing out", async () => {
    const requests: [string, unknown][] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      requests.push([path, JSON.parse(String(init.body))]);
      return Response.json(path === "/api/auth/token" ? { signedIn: true, deviceKey } : { signedOut: true });
    }));
    await signInDevice("A".repeat(43));
    expect(await getDeviceKey()).toBe(deviceKey);
    await signOutDevice();
    expect(await getDeviceKey()).toBeNull();
    expect(requests).toEqual([["/api/auth/token", { token: "A".repeat(43) }], ["/api/auth/logout", { deviceKey }]]);
  });

  it("restores a lost session cookie without asking for the member token", async () => {
    await setDeviceKey(deviceKey);
    let cookie = false;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      requests.push(path);
      if (path === "/api/auth/resume") {
        expect(JSON.parse(String(init.body))).toEqual({ deviceKey });
        cookie = true;
        return Response.json({ resumed: true });
      }
      return cookie ? Response.json(identity) : Response.json({ error: "Sign in to sync this device." }, { status: 401 });
    }));
    await expect(identify()).resolves.toEqual(identity);
    expect(requests).toEqual(["/api/me", "/api/auth/resume", "/api/me"]);
    expect(await getDeviceKey()).toBe(deviceKey);
  });

  it("forgets revoked keys but keeps them when the network fails", async () => {
    await setDeviceKey(deviceKey);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/auth/resume") throw new TypeError("Failed to fetch");
      return Response.json({ error: "Sign in to sync this device." }, { status: 401 });
    }));
    await expect(identify()).rejects.toThrow("Failed to fetch");
    expect(await getDeviceKey()).toBe(deviceKey);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Your member token was rotated. Sign in again." }, { status: 401 })));
    await expect(identify()).rejects.toBeInstanceOf(ApiError);
    expect(await getDeviceKey()).toBeNull();
  });

  it("does not try to recover without a stored key or after non-auth errors", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "Sign in to sync this device." }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(identify()).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();

    await setDeviceKey(deviceKey);
    const failing = vi.fn(async () => Response.json({ error: "Retry shortly." }, { status: 500 }));
    vi.stubGlobal("fetch", failing);
    await expect(identify()).rejects.toMatchObject({ status: 500 });
    expect(failing).toHaveBeenCalledOnce();
    expect(await getDeviceKey()).toBe(deviceKey);
  });
});

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

describe("paginated synchronization", () => {
  it.each(["sync", "todo-sync"] as const)("persists the final tombstone across pages of %s", async (path) => {
    const entry = path === "sync" ? example() : exampleTodo();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      if (!url.startsWith(`/api/${path}?`)) return Response.json({ entries: [], cursor: 0, more: false });
      requests.push(url);
      const since = new URL(url, "http://localhost").searchParams.get("since");
      if (since === "0") return Response.json({
        entries: [entry, { ...entry, revision: 2 }], cursor: 2, more: true
      });
      if (since === "2") return Response.json({
        entries: [{ ...entry, revision: 3, deleted: true }], cursor: 3, more: false
      });
      return Response.json({ entries: [], cursor: 3, more: false });
    }));
    await synchronize();
    expect(requests).toEqual([`/api/${path}?since=0`, `/api/${path}?since=2`, `/api/${path}?since=3`]);
    const records = path === "sync" ? db.entries : db.todos;
    const tombstone = { ...entry, revision: 3, deleted: true };
    expect(await records.get(entry.id)).toEqual(tombstone);
    expect(await getPreferences()).toMatchObject(path === "sync" ? { cursor: 3, todoCursor: 0 } : { cursor: 0, todoCursor: 3 });
    db.close();
    await db.open();
    expect(await records.get(entry.id)).toEqual(tombstone);
    expect(await db.outbox.count() + await db.todoOutbox.count()).toBe(0);
  });
});
