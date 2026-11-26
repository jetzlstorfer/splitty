import { TableClient } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { signInLocally } from "./localSignIn";
import type { Config } from "./config";

const table = TableClient.fromConnectionString("UseDevelopmentStorage=true", "SplittyAuth", {
  allowInsecureConnection: true
});

describe("local development sign-in", () => {
  const config: Config = {
    origin: "https://splitty.example",
    storage: { kind: "connectionString", connection: "unused" },
    local: false,
    localSignIn: { household: "synthetic-household", nameA: "Alex", nameB: "Sam" },
    allowNewHouseholds: false
  };

  it("is unavailable outside local development", async () => {
    await expect(signInLocally(config, table, "a")).rejects.toMatchObject({
      status: 404, message: "Endpoint not found."
    });
  });

  it("rejects a member outside the two configured slots", async () => {
    await expect(signInLocally({ ...config, local: true }, table, "c")).rejects.toMatchObject({
      status: 400, message: "Choose a household member."
    });
  });
});
