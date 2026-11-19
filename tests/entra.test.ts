import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginEntraSignIn } from "../api/src/entra";
import type { Config } from "../api/src/config";

describe("Entra authorization request", () => {
  it("persists one-time state and PKCE material before redirecting", async () => {
    const config: Config = {
      origin: "http://127.0.0.1:5173",
      storage: { kind: "connectionString", connection: "unused" },
      nameA: "Alex",
      nameB: "Sam",
      local: true,
      entra: {
        authority: "https://splittytest.ciamlogin.com",
        clientId: "00000000-0000-4000-8000-000000000001",
        clientSecret: "test-secret"
      }
    };
    const entities: Record<string, unknown>[] = [];
    const table: Parameters<typeof beginEntraSignIn>[1] = {
      getEntity: async () => { throw new Error("Invitation lookup was not expected."); },
      createEntity: async (entity) => {
        entities.push(entity);
        return { etag: "", lastModified: new Date() };
      }
    };
    let authorizationRequest: {
      scopes?: string[];
      redirectUri?: string;
      responseMode?: string;
      state?: string;
      nonce?: string;
      codeChallengeMethod?: string;
      codeChallenge?: string;
      prompt?: string;
    } | undefined;
    const authorizationClient: NonNullable<Parameters<typeof beginEntraSignIn>[2]> = {
      getAuthCodeUrl: async (request) => {
        authorizationRequest = {
          scopes: request.scopes,
          redirectUri: request.redirectUri,
          responseMode: request.responseMode,
          state: request.state,
          nonce: request.nonce,
          codeChallengeMethod: request.codeChallengeMethod,
          codeChallenge: request.codeChallenge,
          prompt: request.prompt
        };
        return "https://splittytest.ciamlogin.com/authorize";
      }
    };

    const response = await beginEntraSignIn(config, table, authorizationClient);
    const transaction = entities[0];
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://splittytest.ciamlogin.com/authorize");
    expect(response.headers.get("set-cookie")).toContain("splitty-entra-state=");
    expect(entities).toHaveLength(1);
    expect(transaction.partitionKey).toBe("entra-transactions");
    expect(transaction.rowKey).not.toBe(`t-${transaction.state}`);
    expect(transaction.expiresAt).toBeGreaterThan(Date.now());
    expect(authorizationRequest).toMatchObject({
      scopes: ["openid", "profile", "email"],
      redirectUri: "http://127.0.0.1:5173/api/auth/callback",
      responseMode: "query",
      state: transaction.state,
      nonce: transaction.nonce,
      codeChallengeMethod: "S256",
      prompt: "select_account"
    });
    expect(authorizationRequest?.codeChallenge).toBe(
      createHash("sha256").update(String(transaction.verifier)).digest("base64url")
    );
  });
});
