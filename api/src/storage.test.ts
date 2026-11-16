import { TableClient } from "@azure/data-tables";
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "./config";
import { tables } from "./storage";

afterEach(() => vi.restoreAllMocks());

for (const local of [true, false]) {
  it(`only permits HTTP table transport in local development: ${local}`, async () => {
    const connection = `DefaultEndpointsProtocol=${local ? "http" : "https"};AccountName=syntheticstorage;AccountKey=${Buffer.from("synthetic-test-key").toString("base64")};TableEndpoint=${local ? "http://127.0.0.1:12345/syntheticstorage" : "https://syntheticstorage.table.core.windows.net"};`;
    const config: Config = {
      origin: local ? "http://127.0.0.1:5173" : "https://splitty.example",
      household: "test-storage", connection, local,
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
