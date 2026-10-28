import { randomUUID } from "node:crypto";
import { test as base } from "@playwright/test";
import { removeHousehold, startApp, startStorage } from "./server";

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page } from "@playwright/test";

export const test = base.extend<{
  household: string;
  publishUpdate: () => void;
}, {
  storage: Awaited<ReturnType<typeof startStorage>>;
  app: Awaited<ReturnType<typeof startApp>>;
}>({
  storage: [async ({ browserName: _browserName }, use) => {
    const storage = await startStorage();
    const previous = process.env.TABLE_STORAGE_CONNECTION_STRING;
    process.env.TABLE_STORAGE_CONNECTION_STRING = storage.connection;
    try { await use(storage); }
    finally {
      await storage.close();
      if (previous === undefined) delete process.env.TABLE_STORAGE_CONNECTION_STRING;
      else process.env.TABLE_STORAGE_CONNECTION_STRING = previous;
    }
  }, { scope: "worker", timeout: 90_000 }],
  app: [async ({ storage: _storage }, use) => {
    const values = {
      NODE_ENV: "test", APP_ORIGIN: "", LOCAL_DEVELOPMENT: "true",
      MEMBER_A_TOKEN: "A".repeat(43), MEMBER_B_TOKEN: "B".repeat(43),
      MEMBER_A_NAME: "Alex", MEMBER_B_NAME: "Sam"
    };
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try {
      const app = await startApp();
      process.env.APP_ORIGIN = app.origin;
      try { await use(app); }
      finally { await app.close(); }
    }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, { scope: "worker" }],
  baseURL: async ({ app }, use) => { await use(app.origin); },
  publishUpdate: async ({ app }, use) => { await use(app.publishUpdate); },
  household: [async ({ app: _app }, use) => {
    const previous = process.env.HOUSEHOLD_ID;
    const household = `browser-test-${randomUUID()}`;
    process.env.HOUSEHOLD_ID = household;
    try { await use(household); }
    finally {
      await removeHousehold(household);
      if (previous === undefined) delete process.env.HOUSEHOLD_ID;
      else process.env.HOUSEHOLD_ID = previous;
    }
  }, { auto: true }]
});
