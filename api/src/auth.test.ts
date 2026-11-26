import { describe, expect, it } from "vitest";
import { sessionCookie } from "./auth";
import type { Config } from "./config";

const connection = "UseDevelopmentStorage=true";
const config: Config = {
  origin: "https://splitty.example",
  storage: { kind: "connectionString", connection },
  local: false,
  allowNewHouseholds: false
};

describe("device session cookies", () => {
  it("sets a local-only cookie without Secure", () => {
    const cookie = sessionCookie({ ...config, local: true }, "K".repeat(43), 400 * 24 * 60 * 60);
    expect(cookie).toBe(`splitty-local=${"K".repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
  });

  it("still expires the cookie immediately on logout", () => {
    expect(sessionCookie(config, "", 0)).toBe(
      "__Host-splitty=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"
    );
  });
});
