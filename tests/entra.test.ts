import { createHash } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { beginEntraSignIn, getAccountDetails, identityClaims } from "../api/src/entra";
import { directoryProvider } from "../api/src/signInProvider";
import { profilePictureUrl } from "../shared/profile";
import type { Config } from "../api/src/config";

describe("sign-in profile claims", () => {
  const issuer = "https://splittytest.ciamlogin.com/tenant/v2.0";
  const claims = { iss: issuer, sub: "synthetic-subject", email: "alex@example.invalid" };

  it.each([
    ["google.com", "google"],
    ["https://accounts.google.com/", "google"],
    ["live.com", "microsoft"],
    ["MicrosoftAccount", "microsoft"],
    ["https://login.microsoftonline.com/consumers/v2.0/tenant", "microsoft"],
    ["https://login.microsoftonline.com/tenant/v2.0", "microsoft"],
    ["https://sts.windows.net/9188040d-6c67-4c5b-b112-36a304b66dad/", "microsoft"],
    [issuer, "email"],
    ["email", "email"],
    ["mail", "email"],
    [undefined, "unknown"],
    ["https://login.microsoftonline.com.example.invalid/tenant/v2.0", "unknown"],
    ["https://accounts.google.com.example.invalid", "unknown"]
  ])("recognizes %s without guessing from the email domain", (idp, provider) => {
    expect(identityClaims({ ...claims, email: "alex@gmail.com", idp }).signInProvider).toBe(provider);
  });

  it("uses mapped provider claims without overriding the session's idp", () => {
    expect(identityClaims({ ...claims, identityprovider: "MicrosoftAccount" }).signInProvider).toBe("microsoft");
    expect(identityClaims({ ...claims, idp: "mail", identityprovider: "MicrosoftAccount" }).signInProvider).toBe("email");
  });

  it("does not mistake a directory UPN, an unrecognized issuer, or linked methods for the active sign-in", () => {
    const upn = { signInType: "userPrincipalName", issuer: "example.onmicrosoft.com" };
    const local = { signInType: "emailAddress", issuer: "example.onmicrosoft.com" };
    const google = { signInType: "federated", issuer: "google.com" };
    expect(directoryProvider([upn, google])).toBe("google");
    expect(directoryProvider([upn])).toBe("unknown");
    expect(directoryProvider([upn, local, google])).toBe("unknown");
    expect(directoryProvider([local, { signInType: "federated", issuer: "other.example.invalid" }])).toBe("unknown");
    expect(directoryProvider(null)).toBe("unknown");
  });

  it("recognizes External ID's stored formats for Microsoft-account federation and email passcodes", () => {
    const upn = { signInType: "userPrincipalName", issuer: "example.onmicrosoft.com" };
    const tenant = "<00000000-0000-4000-8000-000000000000>";
    expect(directoryProvider([{ signInType: "federated", issuer: `https://login.live.com${tenant}` }, upn])).toBe("microsoft");
    expect(directoryProvider([{ signInType: "federated", issuer: "mail" }, upn])).toBe("email");
    expect(directoryProvider([{ signInType: "federated", issuer: `https://login.live.com.example.invalid${tenant}` }, upn]))
      .toBe("unknown");
  });

  it("keeps supplied profile details separate from the household name fallback", () => {
    expect(identityClaims({
      ...claims, name: "  Alex Sample  ", picture: "https://profiles.example.invalid/alex.png"
    })).toMatchObject({
      displayName: "Alex Sample", email: claims.email, pictureUrl: "https://profiles.example.invalid/alex.png"
    });
    const profile = identityClaims({ ...claims, name: " ", picture: "javascript:alert(1)" });
    expect(profile.displayName).toBeUndefined();
    expect(profile.pictureUrl).toBeUndefined();
    expect(profile.name).toBe("alex");
    expect(identityClaims({ ...claims, email: undefined, emails: [claims.email] }).email).toBe(claims.email);
  });

  it("treats External ID's placeholder display name as missing", async () => {
    const profile = identityClaims({ ...claims, name: "unknown" });
    expect(profile.displayName).toBeUndefined();
    expect(profile.name).toBe("alex");
    const user = { userId: "user-synthetic", householdId: "household-synthetic", email: claims.email, name: "Unknown" };
    const table = { getEntity: async () => user } as unknown as TableClient;
    const identity = { ...user, member: "a" as const, signInProvider: "microsoft" as const, displayName: "unknown" };
    expect((await getAccountDetails(table, identity)).displayName).toBeUndefined();
    expect((await getAccountDetails(table, { ...identity, displayName: undefined })).displayName).toBeUndefined();
    expect((await getAccountDetails({ getEntity: async () => ({ ...user, name: "Alex Sample" }) } as unknown as TableClient,
      identity)).displayName).toBe("Alex Sample");
  });

  it.each([
    undefined, 123, "", "not a URL", "http://profiles.example.invalid/alex.png",
    "data:image/svg+xml,test", "https://user:password@profiles.example.invalid/alex.png",
    `https://profiles.example.invalid/${"a".repeat(2048)}`
  ])("rejects unusable profile picture %s", (picture) => {
    expect(profilePictureUrl(picture)).toBeUndefined();
  });
});

describe("Entra authorization request", () => {
  it("persists one-time state and PKCE material before redirecting", async () => {
    const config: Config = {
      origin: "http://127.0.0.1:5173",
      storage: { kind: "connectionString", connection: "unused" },
      local: true,
      allowNewHouseholds: true,
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
      claims?: string;
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
          claims: request.claims,
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
      claims: JSON.stringify({ id_token: { idp: { essential: false } } }),
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
