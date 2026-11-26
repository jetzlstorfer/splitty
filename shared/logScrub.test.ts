import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scrubLog } from "./logScrub";

const token = randomBytes(32).toString("base64url");
const sha256 = createHash("sha256").update(token).digest("hex");

describe("scrubLog", () => {
  it("removes OAuth callback parameters but keeps the path", () => {
    const scrubbed = scrubLog("GET https://splitty.example/api/auth/callback?code=abc.def&state=xyz failed");
    expect(scrubbed).toBe("GET https://splitty.example/api/auth/callback?code=[redacted]&state=[redacted] failed");
  });

  it("keeps only a numeric sync cursor", () => {
    expect(scrubLog("/api/sync?since=42")).toBe("/api/sync?since=42");
    expect(scrubLog("/api/sync?since=abc")).toBe("/api/sync?since=[redacted]");
  });

  it("removes session keys, invitation codes, digests and emails", () => {
    const text = `session ${token} invite household-1.${token} row s-${sha256} user a.person@example.com`;
    const scrubbed = scrubLog(text);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(sha256);
    expect(scrubbed).not.toContain("example.com");
    expect(scrubbed).not.toContain("household-1");
    expect(scrubbed).toContain("[redacted-invitation]");
  });

  it("removes cookies, bearer tokens, JWTs and storage secrets", () => {
    const jwtValue = `eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.${"a".repeat(10)}`;
    const scrubbed = scrubLog(
      `cookie __Host-splitty=${token}; Authorization: Bearer ${jwtValue}; AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net`
    );
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(jwtValue);
    expect(scrubbed).not.toContain("c2VjcmV0");
    expect(scrubbed).toContain("EndpointSuffix=core.windows.net");
  });

  it("leaves ordinary diagnostics untouched", () => {
    const message = "Splitty request failed (TypeError). Retry 3 of 8 after 2000 ms.";
    expect(scrubLog(message)).toBe(message);
  });
});
