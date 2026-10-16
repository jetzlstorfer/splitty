import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 393, height: 851 },
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run preview -- --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false
    },
    {
      command: "npm --prefix api run dev",
      url: "http://127.0.0.1:7071/api/me",
      reuseExistingServer: false,
      env: {
        APP_ORIGIN: "http://127.0.0.1:5173",
        LOCAL_DEVELOPMENT: "true",
        TABLE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
        HOUSEHOLD_ID: `browser-test-${randomUUID()}`,
        MEMBER_A_EMAIL: "first@example.com",
        MEMBER_B_EMAIL: "second@example.com",
        MEMBER_A_NAME: "Alex",
        MEMBER_B_NAME: "Sam"
      }
    }
  ]
});
