import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "../shared/model";
import type { Todo } from "../shared/todo";
import { example, exampleTodo } from "../tests/fixtures";
import { activateAnonymousDatabase, automaticInsuranceTodos, db, getDeviceKey, getPreparedDeviceKey, getPreferences, prepareDeviceKey, queueInsuranceTodoSetting, queueTodos, setDeviceKey } from "./db";
import { ApiError, identify, signInLocally, signOutDevice, syncPollingInterval, synchronize } from "./sync";

beforeEach(async () => {
  await activateAnonymousDatabase();
  await db.delete();
  await db.open();
  await setDeviceKey(null);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setDeviceKey(null);
  await activateAnonymousDatabase();
  await db.delete();
});

const deviceKey = "K".repeat(43);
const identity = { member: "a", nameA: "Alex", nameB: "Sam" };

describe("adaptive sync polling", () => {
  it("uses one-minute polling until five idle minutes, then polls every five minutes", () => {
    const now = 1_000_000;
    expect(syncPollingInterval(now, now)).toBe(60_000);
    expect(syncPollingInterval(now, now - 5 * 60_000 + 1)).toBe(60_000);
    expect(syncPollingInterval(now, now - 5 * 60_000)).toBe(5 * 60_000);
    expect(syncPollingInterval(now, now - 30 * 60_000)).toBe(5 * 60_000);
  });
});

describe("device session recovery", () => {
  it("stores the device key on sign-in and sends it when signing out", async () => {
    const requests: [string, unknown][] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      requests.push([path, JSON.parse(String(init.body))]);
      return Response.json(path === "/api/auth/local" ? { signedIn: true, deviceKey } : { signedOut: true });
    }));
    await signInLocally("a");
    expect(await getDeviceKey()).toBe(deviceKey);
    await signOutDevice();
    expect(await getDeviceKey()).toBeNull();
    expect(requests).toEqual([["/api/auth/local", { member: "a" }], ["/api/auth/logout", { deviceKey }]]);
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

  it("redeems the one-time device key after provider sign-in and removes it from the URL", async () => {
    const code = "C".repeat(43);
    const replaceState = vi.fn();
    vi.stubGlobal("location", { hash: "#auth=" + code, pathname: "/", search: "" });
    vi.stubGlobal("history", { replaceState });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      requests.push(path);
      return path === "/api/auth/device-key"
        ? Response.json({ deviceKey })
        : Response.json(identity);
    }));

    await expect(identify()).resolves.toEqual(identity);
    expect(requests).toEqual(["/api/me", "/api/auth/device-key"]);
    expect(await getDeviceKey()).toBe(deviceKey);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it.each([true, false])("recovers after a lost household-change response (committed: %s)", async (committed) => {
    const prepared = "H".repeat(43), valid = committed ? prepared : deviceKey;
    await setDeviceKey(deviceKey);
    await prepareDeviceKey(prepared);
    let resumed = false;
    const attempts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      if (path === "/api/auth/resume") {
        const { deviceKey: tried } = JSON.parse(String(init.body));
        attempts.push(tried);
        resumed = tried === valid;
      }
      return resumed ? Response.json(identity) : Response.json({ error: "Sign in to sync this device." }, { status: 401 });
    }));
    await expect(identify()).resolves.toEqual(identity);
    expect(attempts).toEqual(committed ? [prepared] : [prepared, deviceKey]);
    expect(await getDeviceKey()).toBe(valid);
    if (committed) expect(await getPreparedDeviceKey()).toBeNull();
  });

  it("forgets revoked keys but keeps them when the network fails", async () => {
    await setDeviceKey(deviceKey);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/auth/resume") throw new TypeError("Failed to fetch");
      return Response.json({ error: "Sign in to sync this device." }, { status: 401 });
    }));
    await expect(identify()).rejects.toThrow("Failed to fetch");
    expect(await getDeviceKey()).toBe(deviceKey);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Your household access has been revoked. Sign in again." }, { status: 401 })));
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
  it("retains a newer insurance setting saved while a previous change is being acknowledged", async () => {
    const context = { userId: "local-member", householdId: "test-household" };
    const changes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      if (path !== "/api/household/insurance-todos") return Response.json({ entries: [], cursor: 0, more: false });
      const { enabled, revision } = JSON.parse(String(init.body));
      changes.push({ enabled, revision });
      if (!enabled) await queueInsuranceTodoSetting(true);
      return Response.json({ enabled, revision: revision + 1 });
    }));
    await queueInsuranceTodoSetting(false);
    await synchronize(db, context);
    expect(automaticInsuranceTodos(await getPreferences())).toBe(true);
    expect((await getPreferences()).pendingInsuranceTodoSetting?.enabled).toBe(true);
    await synchronize(db, context);
    expect(changes).toEqual([{ enabled: false, revision: 0 }, { enabled: true, revision: 1 }]);
    expect((await getPreferences()).pendingInsuranceTodoSetting).toBeUndefined();
  });
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
