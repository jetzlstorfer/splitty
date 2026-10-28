import { expect, test } from "./fixtures";
import { closeSync, expectSyncBackdrop, openSync, signIn, synchronize, upToDate, useEnglish } from "./helpers";

test("WebKit supports native sync popovers, touch dismissal, keyboard focus and the mobile expense sheet", async ({ page }) => {
  await useEnglish(page);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 851 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const wordmark = await page.locator(".wordmark").screenshot();
      await page.getByRole("button", { name: "Sync status", exact: true }).tap();
      const popover = page.getByRole("dialog", { name: "Synchronization", exact: true });
      await expect(popover).toBeVisible();
      await expectSyncBackdrop(page);
      expect((await page.locator(".wordmark").screenshot()).equals(wordmark), "The header must stay visually unchanged").toBe(true);
      const bounds = (await popover.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.touchscreen.tap(4, 70);
      await expect(popover).not.toBeVisible();
    }
  }
  const trigger = page.getByRole("button", { name: "Sync status", exact: true });
  await trigger.focus();
  await page.keyboard.press("Space");
  await page.getByRole("dialog", { name: "Synchronization", exact: true }).getByLabel("Member token").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Synchronization", exact: true })).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await openSync(page);
  const popover = page.getByRole("dialog", { name: "Synchronization", exact: true });
  await expect(popover.locator("form")).toHaveAttribute("novalidate", "");
  await popover.getByRole("button", { name: "Sign in", exact: true }).tap();
  await expect(popover.getByRole("alert")).toHaveText("Please fill out this field.");
  await expect(popover.getByLabel("Member token", { exact: true })).toBeFocused();
  await closeSync(page);
  await page.getByRole("button", { name: "Add expense", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Add an expense", exact: true });
  await expect(sheet.getByLabel("Description", { exact: true })).toBeFocused();
  await sheet.getByLabel("Description", { exact: true }).fill("WebKit mobile expense");
  await sheet.getByRole("textbox", { name: "Amount in EUR" }).fill("12.34");
  await sheet.getByRole("button", { name: "Save", exact: true }).tap();
  await expect(sheet).not.toBeVisible();
  await expect(page.locator(".expense-row")).toContainText("WebKit mobile expense");
  await expect(page.locator(".balance-amount")).toContainText("6.17");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("WebKit reloads the production PWA offline and delivers its queued write after reconnect", async ({ page, context }) => {
  await useEnglish(page);
  await signIn(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await upToDate(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Add expense", exact: true }).tap();
  await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill("WebKit offline expense");
  await page.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).tap();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".expense-row")).toContainText("WebKit offline expense");
  await page.reload();
  await expect(page.locator(".expense-row")).toContainText("WebKit offline expense");
  await openSync(page);
  await expect(page.locator(".sync-summary")).toHaveText("Offline · changes stay on this device");
  await expect(page.getByText("Changes waiting to sync", { exact: true }).locator("..").locator("dd")).toHaveText("1");
  await closeSync(page);
  await context.setOffline(false);
  await synchronize(page);
  const response = await page.request.get("/api/sync?since=0");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ entries: [{ description: "WebKit offline expense", amountCents: 1000 }], more: false });
  await page.reload();
  await upToDate(page);
  await expect(page.locator(".expense-row")).toHaveCount(1);
  await expect(page.locator(".balance-amount")).toContainText("5.00");
});
