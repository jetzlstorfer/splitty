import { TableClient } from "@azure/data-tables";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCookie, signInWithToken } from "./auth";
import type { Config } from "./config";

const config: Config = {
  origin: "https://splitty.example",
  household: "test-auth",
  connection: "UseDevelopmentStorage=true",
  memberAToken: "A".repeat(43),
  memberBToken: "B".repeat(43),
  nameA: "Alex",
  nameB: "Sam",
  local: false
};

afterEach(() => vi.restoreAllMocks());

describe("device session cookies", () => {
  it.each([false, true])("persists sign-in across browser sessions (local=%s)", async (local) => {
    const table = TableClient.fromConnectionString(config.connection, "SplittyAuth");
    const create = vi.spyOn(table, "createEntity").mockResolvedValue({});
    const cookie = await signInWithToken(config.memberAToken, { ...config, local }, table);

    expect(cookie).toMatch(new RegExp(`^${local ? "splitty-local" : "__Host-splitty"}=[a-zA-Z0-9_-]{43};`));
    expect(cookie).toContain("; Max-Age=34560000");
    expect(cookie).toContain("; Path=/; HttpOnly; SameSite=Lax");
    expect(cookie.includes("; Secure")).toBe(!local);
    expect(cookie).not.toContain(config.memberAToken);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      partitionKey: "auth-test-auth",
      member: "a",
      rowKey: expect.stringMatching(/^s-[a-f0-9]{64}$/),
      credentialDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
  });

  it("still expires the cookie immediately on logout", () => {
    expect(sessionCookie(config, "", 0)).toBe(
      "__Host-splitty=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"
    );
  });
});
