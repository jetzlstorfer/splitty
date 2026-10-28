import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "./fixtures";
import { signIn as signInMember, useEnglish } from "./helpers";

async function syncDetails(page: Page) {
  await page.getByRole("button", { name: "Sync status", exact: true }).click();
}

async function signIn(page: Page) {
  await useEnglish(page);
  await signInMember(page);
}

const sessionCookie = async (context: BrowserContext, baseURL?: string) =>
  (await context.cookies(baseURL)).find((item) => item.name === "splitty-local");

test("recovers when the browser drops the session cookie but keeps offline data", async ({ browser, baseURL }, info) => {
  test.setTimeout(120_000);
  // Chromium's nested CacheStorage paths exceed Windows limits under test-results.
  const profile = await mkdtemp(join(tmpdir(), "splitty-session-"));
  const launch = () => browser.browserType().launchPersistentContext(profile, {
    baseURL, channel: info.project.use.channel, viewport: { width: 393, height: 851 },
    isMobile: true, hasTouch: true
  });
  const expense = `Session expense ${crypto.randomUUID()}`;
  const todo = `Session todo ${crypto.randomUUID()}`;
  let context: BrowserContext | undefined;
  let receiver: BrowserContext | undefined;
  try {
    context = await launch();
    let page = await context.newPage();
    await signIn(page);
    const cookie = await sessionCookie(context, baseURL);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 399 * 24 * 60 * 60);
    expect(await page.evaluate(() => document.cookie)).not.toContain("splitty-local");

    // Android Chrome has been observed dropping only the cookie; IndexedDB survives.
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        active: registration?.active?.state ?? null,
        installing: registration?.installing?.state ?? null,
        waiting: registration?.waiting?.state ?? null
      };
    }), { timeout: 15_000 }).toMatchObject({ active: "activated" });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.clearCookies();
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await syncDetails(page);
    await expect(page.getByText("Signed in as Alex.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Up to date");
    expect((await sessionCookie(context, baseURL))?.value).toBe(cookie!.value);

    await context.setOffline(true);
    await expect(page.getByRole("status")).toHaveText("Offline · changes stay on this device");
    await syncDetails(page);
    await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill(expense);
    await page.getByRole("textbox", { name: "Amount in EUR" }).fill("12.34");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill(todo);
    await page.getByLabel("Description (optional)").fill("Saved before the cookie was lost");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await context.close();

    // Reopen the disk profile without its cookie; queued offline saves must still sync.
    context = await launch();
    await context.clearCookies();
    page = await context.newPage();
    await page.goto("/");
    await syncDetails(page);
    await expect(page.getByText("Signed in as Alex.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Up to date");
    await syncDetails(page);
    await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
    const balance = await page.locator(".balance-amount").innerText();

    receiver = await browser.newContext({ baseURL, serviceWorkers: "block" });
    const other = await receiver.newPage();
    await signIn(other);
    for (const device of [page, other]) {
      await device.reload();
      await expect(device.getByRole("status")).toHaveText("Up to date");
      await expect(device.locator(".expense-row").filter({ hasText: expense })).toContainText("12.34");
      await expect(device.locator(".balance-amount")).toHaveText(balance);
      await device.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
      const todoRow = device.getByRole("listitem").filter({ has: device.getByText(todo, { exact: true }) });
      await expect(todoRow).toContainText("Saved before the cookie was lost");
    }

    // Signing out without a cookie still revokes this device and forgets its key.
    await context.clearCookies();
    await syncDetails(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await context.addCookies([cookie!]);
    await page.reload();
    await syncDetails(page);
    await expect(page.getByRole("status")).toHaveText("Sign in to sync");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await other.reload();
    await syncDetails(other);
    await expect(other.getByText("Signed in as Alex.", { exact: true })).toBeVisible();
  } finally {
    await receiver?.close();
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
