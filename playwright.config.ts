import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 2,
  maxFailures: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    viewport: { width: 393, height: 851 },
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/webkit.spec.ts",
      use: { browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL }
    },
    {
      name: "webkit",
      testMatch: ["**/webkit.spec.ts", "**/controls.spec.ts", "**/sync-popover-layout.spec.ts", "**/todo-motion.spec.ts"],
      use: { browserName: "webkit", isMobile: true, hasTouch: true }
    }
  ]
});
