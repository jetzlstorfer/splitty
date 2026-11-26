import { expect, test, type Page } from "./fixtures";
import { expectSyncBackdrop, failNextConflictResolution, signIn as signInMember, storedRecords, synchronize as sync, useEnglish as english } from "./helpers";

test.use({ hasTouch: true });

const indicator = (page: Page) => page.getByRole("button", { name: "Sync status", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Synchronization", exact: true });
const detail = (page: Page, label: string) => popover(page).locator(".sync-details > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
const upToDate = (page: Page) => expect(page.locator(".sync-status")).toHaveText("Up to date");

async function signIn(page: Page, member: "A" | "B" = "A") {
  await signInMember(page, member);
  await indicator(page).click();
}

for (const language of ["en", "de"] as const) {
  test(`the healthy cloud indicator shows the localized up-to-date state in ${language}`, async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ json: { member: "a", nameA: "Alex", nameB: "Sam" } }));
    await page.route(/\/api\/(?:todo-)?sync\?/, (route) =>
      route.fulfill({ json: { entries: [], cursor: 0, more: false } }));
    if (language === "en") await english(page);
    else await page.goto("/");
    const cloud = page.getByRole("button", { name: language === "en" ? "Sync status" : "Synchronisierungsstatus", exact: true });
    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await expect(cloud).toHaveText(language === "en" ? "Up-to-date" : "Aktuell");
        await expect(cloud.locator(".sync-icon")).toHaveAttribute("data-sync-state", "current");
        await expect(cloud.locator(".sync-check")).toBeVisible();
        await expect(cloud.locator(".sync-arrows")).toHaveCount(0);
        await expect(cloud).toHaveAttribute("aria-busy", "false");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  });
}

test("the cloud is the only sync entry point across tabs, widths and themes, with keyboard and touch dismissal", async ({ page }, info) => {
  await english(page);
  await expect(page.locator(".sync-status")).toHaveText("Sign in to sync");
  await expect(indicator(page)).toHaveText("Needs attention");
  for (const tab of ["Expenses", "To-dos", "Search", "Statistics", "Settings"]) {
    await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator("main .sync-status, main .sync-summary")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Synchronization", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await expect(page.getByLabel("Member token")).toHaveCount(0);
    await indicator(page).click();
    await expect(popover(page).locator(".sync-summary")).toHaveText("Sign in to sync");
    await expect(detail(page, "Connection")).toHaveText("Online");
    await expect(detail(page, "Changes waiting to sync")).toHaveText("0");
    await expect(detail(page, "Last sync this session")).toHaveText("Not yet synced");
    await indicator(page).click();
  }
  await expect(page.locator(".sync-status")).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
  await indicator(page).focus();
  await page.keyboard.press("Enter");
  await expect(indicator(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(popover(page).getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(popover(page).getByRole("button", { name: "Sync now" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(popover(page).getByRole("button", { name: "Development sign-in as first member" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).not.toBeVisible();
  await expect(indicator(page)).toBeFocused();
  await expect(indicator(page)).toHaveAttribute("aria-expanded", "false");
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const wordmark = await page.locator(".wordmark").screenshot({ animations: "disabled", path: info.outputPath(`header-${theme}-${width}-closed.png`) });
      await indicator(page).tap();
      await expect(popover(page)).toBeVisible();
      await expectSyncBackdrop(page);
      const openWordmark = await page.locator(".wordmark").screenshot({ animations: "disabled", path: info.outputPath(`header-${theme}-${width}-open.png`) });
      expect(openWordmark.equals(wordmark), "The header must stay visually unchanged").toBe(true);
      const bounds = (await popover(page).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`sync-${theme}-${width}.png`) });
      await popover(page).getByRole("button", { name: "Close", exact: true }).tap();
      await expect(popover(page)).not.toBeVisible();
      await expect(indicator(page)).toBeFocused();
      await indicator(page).click();
      await page.mouse.click(4, 70);
      await expect(popover(page)).not.toBeVisible();
    }
  }
  await indicator(page).click();
  await page.locator(".topbar").evaluate((header) => { header.style.paddingTop = "32px"; });
  await expectSyncBackdrop(page);
  await page.locator(".topbar").evaluate((header) => { header.style.removeProperty("padding-top"); });
  await expectSyncBackdrop(page);
  await indicator(page).click();
});

test("provider sign-in is shown only when enabled by the API", async ({ page }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, localSignInEnabled: false } }));
  await english(page);
  await indicator(page).click();
  await expect(popover(page).getByRole("button", {
    name: "Continue with email, Google, or Microsoft", exact: true
  })).toBeVisible();
  await expect(popover(page).getByRole("button", { name: /Development sign-in/ })).toHaveCount(0);
});

test("busy sync stays inspectable and a failed sync can be retried from the popover", async ({ page }) => {
  await page.route("**/api/me", (route) => route.fulfill({ json: { member: "a", nameA: "Alex", nameB: "Sam" } }));
  await page.route(/\/api\/(?:todo-)?sync\?/, (route) =>
    route.fulfill({ json: { entries: [], cursor: 0, more: false } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let notify = () => {};
  const started = new Promise<void>((resolve) => { notify = resolve; });
  await page.route("**/api/sync?*", async (route) => {
    notify();
    await held;
    await route.fulfill({ status: 503, json: { error: "Sync request failed." } });
  }, { times: 1 });
  try {
    await english(page);
    await started;
    await expect(indicator(page)).toBeEnabled();
    await expect(indicator(page)).toHaveAttribute("aria-busy", "true");
    await expect(indicator(page)).toHaveText("Syncing…");
    await expect(indicator(page).locator(".sync-icon")).toHaveAttribute("data-sync-state", "syncing");
    const arrows = indicator(page).locator(".sync-arrows");
    await expect(arrows).toBeVisible();
    await expect(indicator(page).locator(".sync-check")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(arrows).toHaveCSS("animation-name", "sync-spin");
    const initialTransform = await arrows.evaluate((icon) => getComputedStyle(icon).transform);
    await expect.poll(() => arrows.evaluate((icon) => getComputedStyle(icon).transform)).not.toBe(initialTransform);
    await expect(indicator(page).locator(".sync-cloud")).toHaveCSS("transform", "none");
    const cloudBounds = (await indicator(page).locator(".sync-cloud").boundingBox())!;
    const arrowBounds = (await arrows.boundingBox())!;
    expect(arrowBounds.x).toBeGreaterThan(cloudBounds.x);
    expect(arrowBounds.y).toBeGreaterThan(cloudBounds.y);
    expect(arrowBounds.x + arrowBounds.width).toBeLessThan(cloudBounds.x + cloudBounds.width);
    expect(arrowBounds.y + arrowBounds.height).toBeLessThan(cloudBounds.y + cloudBounds.height);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(arrows).toHaveCSS("animation-name", "none");
    await expect(arrows).toBeVisible();
    await indicator(page).click();
    await expect(popover(page).locator(".sync-summary")).toHaveText("Syncing…");
    await expect(popover(page).getByRole("button", { name: "Sync now" })).toBeDisabled();
    release();
    await expect(popover(page).locator(".sync-summary")).toHaveText("Sync request failed.");
    await expect(indicator(page)).toHaveClass(/needs-attention/);
    await expect(indicator(page)).toHaveText("Needs attention");
    await expect(indicator(page).locator(".sync-icon")).toHaveAttribute("data-sync-state", "attention");
    await expect(arrows).toHaveCount(0);
    await expect(detail(page, "Last sync this session")).toHaveText("Not yet synced");
    await expect(page.locator("main")).not.toContainText("Sync request failed.");
    await popover(page).getByRole("button", { name: "Sync now" }).click();
    await expect(popover(page).locator(".sync-summary")).toHaveText("Up to date");
    await expect(detail(page, "Last sync this session").locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
    await expect(indicator(page)).not.toHaveClass(/needs-attention/);
    await expect(indicator(page)).toHaveText("Up-to-date");
    await expect(indicator(page).locator(".sync-check")).toBeVisible();
  } finally { release(); }
});

test("development sign-in and sync stay in the popover while sign-out is in Settings", async ({ page, context }) => {
  let signInRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/auth/local") signInRequests++; });
  await page.goto("/");
  await page.getByRole("button", { name: "Synchronisierungsstatus", exact: true }).click();
  const germanPopover = page.locator(".sync-popover");
  await expect(germanPopover.locator("form")).toHaveCount(0);
  await expect(germanPopover.getByLabel("Mitglieds-Token", { exact: true })).toHaveCount(0);
  expect(signInRequests).toBe(0);
  await english(page);
  await signIn(page);
  const accountDatabaseName = await page.evaluate(() => localStorage.getItem("splitty-active-database"));
  if (!accountDatabaseName) throw new Error("The signed-in account database was not selected.");
  expect(signInRequests).toBe(1);
  await expect(page.getByRole("heading", { name: /^Expenses/, level: 1 })).toBeVisible();
  await expect(popover(page).getByRole("alert")).toHaveCount(0);
  await indicator(page).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await upToDate(page);
  await context.setOffline(true);
  await expect(indicator(page)).toHaveText("Offline");
  await expect(indicator(page).locator(".sync-icon")).toHaveAttribute("data-sync-state", "offline");
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const expense = `Popover expense ${crypto.randomUUID()}`;
  await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill(expense);
  await page.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".expense-row").filter({ hasText: expense })).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  const todo = `Popover todo ${crypto.randomUUID()}`;
  await page.getByLabel("Title", { exact: true }).fill(todo);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText(todo, { exact: true })).toBeVisible();
  const pending = await storedRecords(page);
  expect(pending.outbox).toHaveLength(1);
  expect(pending.todoOutbox).toHaveLength(1);
  await page.reload();
  expect(await storedRecords(page)).toEqual(pending);
  await indicator(page).tap();
  await expect(popover(page).locator(".sync-summary")).toHaveText("Offline · changes stay on this device");
  await expect(detail(page, "Connection")).toHaveText("Offline");
  await expect(detail(page, "Changes waiting to sync")).toHaveText("2");
  await expect(popover(page).getByRole("button", { name: "Sync now" })).toBeDisabled();
  await expect(popover(page).getByRole("button", { name: "Development sign-in as first member", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(popover(page).locator(".sync-summary")).toHaveText("Up to date");
  await expect(detail(page, "Changes waiting to sync")).toHaveText("0");
  await expect(popover(page).getByText("Signed in as Alex.", { exact: true })).toBeVisible();
  await expect(popover(page).getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(account.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await account.getByRole("button", { name: "Sign out", exact: true }).click();
  await indicator(page).click();
  await expect(popover(page).locator(".sync-summary")).toHaveText("Signed out · local history remains on this device");
  await expect(popover(page).getByRole("button", { name: "Development sign-in as first member", exact: true })).toBeVisible();
  expect(await storedRecords(page)).toEqual({ entries: [], todos: [], outbox: [], todoOutbox: [] });
  const retained = await storedRecords(page, accountDatabaseName);
  expect(retained.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ description: expense, amountCents: 1000 })
  ]));
  expect(retained.todos).toEqual(expect.arrayContaining([expect.objectContaining({ title: todo })]));
});

test("expense conflicts are resolved in the popover without changing the pending balance rules", async ({ browser, baseURL }) => {
  const aContext = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const bContext = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const a = await aContext.newPage(), b = await bContext.newPage();
  const description = `Popover conflict ${crypto.randomUUID()}`;
  const expense = (page: Page) => page.locator(".expense-row").filter({ hasText: description });
  async function edit(page: Page, amount: string) {
    await expense(page).click();
    await page.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  try {
    await english(a);
    await signIn(a);
    await indicator(a).click();
    await a.getByRole("button", { name: "Add expense", exact: true }).click();
    await a.getByRole("dialog").getByLabel("Description", { exact: true }).fill(description);
    await a.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
    await a.getByRole("button", { name: "Save", exact: true }).click();
    await upToDate(a);
    await english(b);
    await signIn(b, "B");
    await indicator(b).click();
    for (const keepLocal of [true, false]) {
      await aContext.setOffline(true);
      await edit(a, keepLocal ? "20" : "40");
      await edit(b, keepLocal ? "30" : "50");
      await upToDate(b);
      await aContext.setOffline(false);
      await expect(a.locator(".sync-status")).toHaveText("Some edits need your attention");
      await expect(expense(a)).toBeDisabled();
      await indicator(a).click();
      await expect(detail(a, "Edits needing attention")).toHaveText("1");
      const conflict = popover(a).getByRole("region", { name: "Conflicting edits", exact: true });
      await expect(conflict).toContainText(description);
      await expect(conflict).toContainText(keepLocal ? "10.00" : "20.00");
      await expect(conflict).toContainText(keepLocal ? "15.00" : "25.00");
      await expect(a.locator("main .conflict-panel")).toHaveCount(0);
      const resolve = conflict.getByRole("button", { name: keepLocal ? "Keep this device" : "Keep other device" });
      await failNextConflictResolution(a, "conflicts");
      await resolve.click();
      await expect(popover(a).getByRole("alert")).toHaveText("An unexpected error occurred. Your saved entries remain on this device.");
      await expect(conflict).toBeVisible();
      await expect(detail(a, "Edits needing attention")).toHaveText("1");
      await resolve.click();
      await expect(conflict).not.toBeVisible();
      await upToDate(a);
      await expect(popover(a).getByRole("alert")).toHaveCount(0);
      await expect(indicator(a)).not.toHaveClass(/needs-attention/);
      await indicator(a).click();
      await sync(b);
      for (const page of [a, b]) {
        await page.reload();
        await upToDate(page);
        await expect(expense(page)).toBeEnabled();
        await expect(expense(page)).toContainText(keepLocal ? "20.00" : "50.00");
      }
      await expect(a.locator(".balance-amount")).toHaveText(await b.locator(".balance-amount").innerText());
    }
  } finally {
    await aContext.close();
    await bContext.close();
  }
});
