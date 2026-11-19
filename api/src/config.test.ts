import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, HttpError } from "./config";

const storageAccount = "splittytest";
const tenantId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";

function setBaseEnvironment() {
  for (const key of [
    "HOUSEHOLD_ID", "MEMBER_A_TOKEN", "MEMBER_B_TOKEN",
    "TABLE_STORAGE_CONNECTION_STRING", "TABLE_STORAGE_ACCOUNT_NAME",
    "TABLE_STORAGE_TENANT_ID", "TABLE_STORAGE_CLIENT_ID", "TABLE_STORAGE_CLIENT_SECRET"
  ]) vi.stubEnv(key, "");
  vi.stubEnv("APP_ORIGIN", "https://splitty.example");
  vi.stubEnv("LOCAL_DEVELOPMENT", "false");
  vi.stubEnv("ENTRA_AUTHORITY", "https://splittyauth.ciamlogin.com/00000000-0000-4000-8000-000000000003");
  vi.stubEnv("ENTRA_CLIENT_ID", clientId);
  vi.stubEnv("ENTRA_CLIENT_SECRET", "test-entra-secret");
}

describe("storage configuration", () => {
  beforeEach(setBaseEnvironment);
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the connection-string configuration mode", () => {
    vi.stubEnv("TABLE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true");

    expect(getConfig().storage).toEqual({
      kind: "connectionString",
      connection: "UseDevelopmentStorage=true"
    });
  });

  it("accepts a complete table-storage service-principal configuration", () => {
    vi.stubEnv("TABLE_STORAGE_ACCOUNT_NAME", storageAccount);
    vi.stubEnv("TABLE_STORAGE_TENANT_ID", tenantId);
    vi.stubEnv("TABLE_STORAGE_CLIENT_ID", clientId);
    vi.stubEnv("TABLE_STORAGE_CLIENT_SECRET", "test-storage-secret");

    expect(getConfig().storage).toEqual({
      kind: "rbac",
      accountName: storageAccount,
      tenantId,
      clientId,
      clientSecret: "test-storage-secret"
    });
  });

  it("rejects an External ID authority without its tenant path", () => {
    vi.stubEnv("ENTRA_AUTHORITY", "https://splittyauth.ciamlogin.com");

    expect(() => getConfig()).toThrow(HttpError);
  });

  it.each([
    ["neither storage mode", {}],
    ["partial service-principal settings", { TABLE_STORAGE_ACCOUNT_NAME: storageAccount }],
    ["both storage modes", {
      TABLE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      TABLE_STORAGE_ACCOUNT_NAME: storageAccount,
      TABLE_STORAGE_TENANT_ID: tenantId,
      TABLE_STORAGE_CLIENT_ID: clientId,
      TABLE_STORAGE_CLIENT_SECRET: "test-storage-secret"
    }],
    ["invalid account name", {
      TABLE_STORAGE_ACCOUNT_NAME: "Invalid_Name",
      TABLE_STORAGE_TENANT_ID: tenantId,
      TABLE_STORAGE_CLIENT_ID: clientId,
      TABLE_STORAGE_CLIENT_SECRET: "test-storage-secret"
    }],
    ["invalid tenant ID", {
      TABLE_STORAGE_ACCOUNT_NAME: storageAccount,
      TABLE_STORAGE_TENANT_ID: "not-a-guid",
      TABLE_STORAGE_CLIENT_ID: clientId,
      TABLE_STORAGE_CLIENT_SECRET: "test-storage-secret"
    }]
  ])("rejects %s", (_description, environment) => {
    for (const key of [
      "TABLE_STORAGE_CONNECTION_STRING",
      "TABLE_STORAGE_ACCOUNT_NAME",
      "TABLE_STORAGE_TENANT_ID",
      "TABLE_STORAGE_CLIENT_ID",
      "TABLE_STORAGE_CLIENT_SECRET"
    ]) vi.stubEnv(key, "");
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, String(value));

    expect(() => getConfig()).toThrow(HttpError);
  });
});
