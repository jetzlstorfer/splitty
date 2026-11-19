import { describe, expect, it } from "vitest";
import { signInRateLimitKey } from "./rateLimit";

describe("sign-in rate-limit key", () => {
  it("uses a shared bucket when the platform omits the client IP", () => {
    expect(signInRateLimitKey(null)).toBe("sign-in:shared");
  });

  it("uses a valid forwarded client IP", () => {
    expect(signInRateLimitKey("198.51.100.42")).toBe("sign-in:198.51.100.42");
  });

  it("uses the shared bucket for an invalid forwarded value", () => {
    expect(signInRateLimitKey("not-an-ip")).toBe("sign-in:shared");
  });
});
