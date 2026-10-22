import { describe, expect, it } from "vitest";
import { sessionCookie } from "../api/src/auth";
import type { Config } from "../api/src/config";

const config: Config = {
  origin: "https://splitty.example", household: "test-cookie", connection: "UseDevelopmentStorage=true",
  memberAToken: "A".repeat(43), memberBToken: "B".repeat(43), nameA: "Alex", nameB: "Sam", local: false
};

describe("persistent device cookies", () => {
  it("keeps production cookies host-only, secure and inaccessible to JavaScript", () => {
    expect(sessionCookie(config, "test-session")).toBe(
      "__Host-splitty=test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure"
    );
  });

  it("uses the same persistent lifetime for local development", () => {
    expect(sessionCookie({ ...config, local: true }, "test-session")).toBe(
      "splitty-local=test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
    );
  });

  it.each([false, true])("expires the matching cookie immediately on logout (local: %s)", (local) => {
    const cookie = sessionCookie({ ...config, local }, "", 0);
    expect(cookie).toBe(`${local ? "splitty-local" : "__Host-splitty"}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${local ? "" : "; Secure"}`);
  });
});
