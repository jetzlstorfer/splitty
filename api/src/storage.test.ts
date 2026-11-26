import { TableClient } from "@azure/data-tables";
import { ClientSecretCredential } from "@azure/identity";
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config";
import { tables } from "./storage";

vi.mock("@azure/identity", () => ({
  ClientSecretCredential: vi.fn(class {
    getToken = vi.fn();
  })
}));

afterEach(() => vi.restoreAllMocks());

for (const local of [true, false]) {
  it(`only permits HTTP table transport in local development: ${local}`, async () => {
    const connection = `DefaultEndpointsProtocol=${local ? "http" : "https"};AccountName=syntheticstorage;AccountKey=${Buffer.from("synthetic-test-key").toString("base64")};TableEndpoint=${local ? "http://127.0.0.1:12345/syntheticstorage" : "https://syntheticstorage.table.core.windows.net"};`;
    const config: Config = {
      origin: local ? "http://127.0.0.1:5173" : "https://splitty.example",
      household: "test-storage", storage: { kind: "connectionString", connection }, local,
      allowNewHouseholds: local,
      memberAToken: "A".repeat(43), memberBToken: "B".repeat(43),
      nameA: "Alex", nameB: "Sam"
    };
    const fromConnectionString = vi.spyOn(TableClient, "fromConnectionString");
    const createTable = vi.spyOn(TableClient.prototype, "createTable").mockResolvedValue();
    await tables(config);
    expect(fromConnectionString.mock.calls).toEqual([
      [connection, "SplittyLedger", { allowInsecureConnection: local }],
      [connection, "SplittyAuth", { allowInsecureConnection: local }]
    ]);
    expect(createTable).toHaveBeenCalledTimes(2);
  });
}

it("uses the configured service principal for HTTPS table clients", async () => {
  const config: Config = {
    origin: "https://splitty.example",
    storage: {
      kind: "rbac",
      accountName: "splittytest",
      tenantId: "00000000-0000-4000-8000-000000000001",
      clientId: "00000000-0000-4000-8000-000000000002",
      clientSecret: "test-secret"
    },
    local: false,
    allowNewHouseholds: false,
    nameA: "Alex",
    nameB: "Sam"
  };
  const fromConnectionString = vi.spyOn(TableClient, "fromConnectionString");
  const createTable = vi.spyOn(TableClient.prototype, "createTable").mockResolvedValue();

  await tables(config);

  expect(ClientSecretCredential).toHaveBeenCalledWith(
    config.storage.kind === "rbac" ? config.storage.tenantId : "",
    config.storage.kind === "rbac" ? config.storage.clientId : "",
    config.storage.kind === "rbac" ? config.storage.clientSecret : ""
  );
  expect(fromConnectionString).not.toHaveBeenCalled();
  expect(createTable).toHaveBeenCalledTimes(2);
});
