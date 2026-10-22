import { rm } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function settings(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: /^(Settings|Einstellungen)$/ }).click();
}

async function signIn(page: Page, member: "A" | "B") {
  await page.goto("/");
  await settings(page);
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await page.getByLabel("Member token").fill(member.repeat(43));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as ${member === "A" ? "Alex" : "Sam"}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Up to date");
}

for (const legacy of [false, true]) {
  test(`remembers ${legacy ? "an upgraded legacy" : "a new"} session across a browser restart and delivers offline saves`, async ({ browser, baseURL }, info) => {
    const profile = info.outputPath("browser-profile");
    const launch = () => browser.browserType().launchPersistentContext(profile, {
      baseURL, channel: info.project.use.channel, viewport: { width: 393, height: 851 },
      isMobile: true, hasTouch: true
    });
    const member = legacy ? "B" : "A";
    const expense = `Session expense ${crypto.randomUUID()}`;
    const todo = `Session todo ${crypto.randomUUID()}`;
    let context: BrowserContext | undefined;
    let receiver: BrowserContext | undefined;
    try {
      context = await launch();
      let page = await context.newPage();
      await signIn(page, member);
      if (legacy) {
        // Recreate the old session-only cookie, then let the app upgrade it.
        await page.goto("about:blank");
        const cookie = (await context.cookies(baseURL)).find((item) => item.name === "splitty-local")!;
        await context.addCookies([{ ...cookie, expires: -1 }]);
        expect((await context.cookies(baseURL)).find((item) => item.name === "splitty-local")?.expires).toBe(-1);
        await page.goto("/");
        await expect(page.getByRole("status")).toHaveText("Up to date");
      }
      const cookie = (await context.cookies(baseURL)).find((item) => item.name === "splitty-local");
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
      expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 364 * 24 * 60 * 60);
      expect(await page.evaluate(() => document.cookie)).not.toContain("splitty-local");
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await expect(page.getByRole("status")).toHaveText("Up to date");
      await context.setOffline(true);
      await expect(page.getByRole("status")).toHaveText("Offline · changes stay on this device");
      await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
      await page.getByRole("button", { name: "Add expense", exact: true }).click();
      await page.getByLabel("Description", { exact: true }).fill(expense);
      await page.getByRole("textbox", { name: "Amount in EUR" }).fill("12.34");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
      await page.getByRole("button", { name: "Add to-do", exact: true }).click();
      await page.getByLabel("Title", { exact: true }).fill(todo);
      await page.getByLabel("Description (optional)").fill("Saved before the browser closed");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.reload();
      await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
      await expect(page.getByText(todo, { exact: true })).toBeVisible();
      await context.close();

      // Reopen the actual disk profile; restoring storageState would also restore session-only cookies.
      context = await launch();
      page = await context.newPage();
      await page.goto("/");
      await settings(page);
      await expect(page.getByText(`Signed in as ${member === "A" ? "Alex" : "Sam"}.`, { exact: true })).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Up to date");
      await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
      await expect(page.getByText(expense, { exact: true })).toBeVisible();
      const balance = await page.locator(".balance-amount").innerText();

      receiver = await browser.newContext({ baseURL, serviceWorkers: "block" });
      const other = await receiver.newPage();
      await signIn(other, member);
      for (const device of [page, other]) {
        await device.reload();
        await expect(device.getByRole("status")).toHaveText("Up to date");
        const expenseRow = device.locator(".expense-row").filter({ hasText: expense });
        await expect(expenseRow).toContainText("12.34");
        await expect(device.locator(".balance-amount")).toHaveText(balance);
        await device.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
        const todoRow = device.getByRole("listitem").filter({ has: device.getByText(todo, { exact: true }) });
        await expect(todoRow).toContainText("Saved before the browser closed");
        await expect(todoRow.getByRole("checkbox")).not.toBeChecked();
      }

      await settings(page);
      await expect(page.getByRole("status")).toHaveText("Up to date");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      expect((await context.cookies(baseURL)).some((item) => item.name === "splitty-local")).toBe(false);
      await page.reload();
      await settings(page);
      await expect(page.getByRole("status")).toHaveText("Sign in to sync");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await other.reload();
      await settings(other);
      await expect(other.getByText(`Signed in as ${member === "A" ? "Alex" : "Sam"}.`, { exact: true })).toBeVisible();
    } finally {
      await receiver?.close();
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
