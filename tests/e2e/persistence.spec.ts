import { expect, test, type Page } from "./fixtures";
import { closeSync, openSync, signIn, storedRecords, synchronize, upToDate, useEnglish } from "./helpers";

async function addExpense(page: Page, description: string, amount = "12.34") {
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill(description);
  await page.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function addTodo(page: Page, title: string) {
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test.describe("shared browser storage", () => {
  test.use({ serviceWorkers: "block" });

  test("two tabs preserve expense and todo writes during an in-flight sync and converge with another device", async ({ page, context, browser, baseURL }) => {
    await useEnglish(page);
    await signIn(page);
    const other = await context.newPage();
    const receiver = await browser.newContext({ baseURL, serviceWorkers: "block" });
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let notify = () => {};
    const started = new Promise<void>((resolve) => { notify = resolve; });
    let releaseTodoPull = () => {};
    const heldTodoPull = new Promise<void>((resolve) => { releaseTodoPull = resolve; });
    let notifyTodoPull = () => {};
    const todoPullStarted = new Promise<void>((resolve) => { notifyTodoPull = resolve; });
    try {
      await other.goto("/");
      await upToDate(other);
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      let pulls = 0;
      await page.route("**/api/sync?*", async (route) => {
        if (++pulls !== 2) return route.continue();
        const response = await route.fetch();
        notify();
        await held;
        await route.fulfill({ response });
      });
      let todoPulls = 0;
      await other.route("**/api/todo-sync?*", async (route) => {
        if (++todoPulls !== 2) return route.continue();
        const response = await route.fetch();
        notifyTodoPull();
        await heldTodoPull;
        await route.fulfill({ response });
      });
      await openSync(page);
      await page.getByRole("button", { name: "Sync now" }).click();
      await started;
      await closeSync(page);
      await addTodo(other, "Shared-tab todo");
      await todoPullStarted;
      await addExpense(page, "Shared-tab expense");
      await expect(page.locator(".expense-row")).toContainText("Shared-tab expense");
      await expect(other.getByRole("checkbox", { name: "Shared-tab todo", exact: true })).not.toBeChecked();
      releaseTodoPull();
      await expect(other.locator(".sync-status")).toHaveText("Saved locally · changes waiting to sync");
      const pending = await storedRecords(other);
      expect(pending.outbox).toHaveLength(1);
      expect(pending.todoOutbox).toHaveLength(0);
      release();
      await expect.poll(async () => {
        const records = await storedRecords(page);
        return [records.outbox.length, records.todoOutbox.length];
      }).toEqual([0, 0]);
      await upToDate(page);
      await upToDate(other);
      await expect(other.locator(".sync-check")).toHaveCount(1);
      await openSync(other);
      await expect(other.locator(".sync-summary")).toHaveText("Up to date");
      await expect(other.getByText("Changes waiting to sync", { exact: true }).locator("..").locator("dd")).toHaveText("0");
      await closeSync(other);
      await page.clock.resume();

      await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
      await other.getByRole("checkbox", { name: "Shared-tab todo", exact: true }).click();
      await expect(other.getByRole("checkbox", { name: "Shared-tab todo", exact: true })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Shared-tab todo", exact: true })).toBeChecked();
      await upToDate(other);
      for (const tab of [page, other]) {
        await tab.reload();
        await upToDate(tab);
        await expect(tab.locator(".expense-row")).toHaveCount(1);
        await expect(tab.locator(".expense-row")).toContainText("12.34");
        await expect(tab.locator(".balance-amount")).toContainText("6.17");
        await tab.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
        await expect(tab.getByRole("checkbox", { name: "Shared-tab todo", exact: true })).toBeChecked();
      }
      const remote = await receiver.newPage();
      await useEnglish(remote);
      await signIn(remote, "B");
      await expect(remote.locator(".expense-row")).toHaveCount(1);
      await expect(remote.locator(".expense-row")).toContainText("Shared-tab expense");
      await expect(remote.locator(".balance-amount")).toContainText("6.17");
      await remote.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
      await expect(remote.getByRole("checkbox", { name: "Shared-tab todo", exact: true })).toBeChecked();
    } finally {
      release();
      releaseTodoPull();
      await receiver.close();
      await other.close();
    }
  });
});

test("accepting a real service-worker update preserves queued expenses and todos until the API recovers", async ({ page, context, browser, baseURL, publishUpdate }) => {
  await useEnglish(page);
  await signIn(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await upToDate(page);
  await context.setOffline(true);
  await addExpense(page, "Queued through deployment", "10");
  await addTodo(page, "Queued deployment todo");
  const before = await storedRecords(page);
  expect(before.outbox).toHaveLength(1);
  expect(before.todoOutbox).toHaveLength(1);
  await context.route(/\/api\/(?:todo-)?sync(?:\?|$)/, (route) =>
    route.fulfill({ status: 503, json: { error: "Sync request failed." } }));
  await context.setOffline(false);
  await expect(page.locator(".sync-status")).toHaveText("Sync request failed.");
  publishUpdate();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting)).toBe(true);
  await expect(page.getByRole("region", { name: "New version available", exact: true })).toContainText("Your saved entries will be kept.");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Update", exact: true }).click()
  ]);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null)).toBe(true);
  await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(page.locator(".expense-row")).toContainText("Queued through deployment");
  await expect(page.locator(".balance-amount")).toContainText("5.00");
  expect(await storedRecords(page)).toEqual(before);
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await expect(page.getByText("Queued deployment todo", { exact: true })).toBeVisible();
  await context.unroute(/\/api\/(?:todo-)?sync(?:\?|$)/);
  await synchronize(page);
  const after = await storedRecords(page);
  expect(after.outbox).toEqual([]);
  expect(after.todoOutbox).toEqual([]);

  const receiver = await browser.newContext({ baseURL, serviceWorkers: "block" });
  try {
    const remote = await receiver.newPage();
    await useEnglish(remote);
    await signIn(remote, "B");
    await expect(remote.locator(".expense-row")).toContainText("Queued through deployment");
    await expect(remote.locator(".balance-amount")).toContainText("5.00");
    await remote.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
    await expect(remote.getByText("Queued deployment todo", { exact: true })).toBeVisible();
  } finally { await receiver.close(); }
});

for (const kind of ["expense", "todo"] as const) {
  test(`a failed local ${kind} transaction shows an error, rolls back and never reports a successful save`, async ({ page, context }) => {
    await context.addInitScript(() => {
      let fail = true;
      window.addEventListener("splitty-test-storage-recovered", () => { fail = false; });
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value, key) {
        if (fail && (this.name === "outbox" || this.name === "todoOutbox")) {
          throw new DOMException("Test storage quota exceeded.", "QuotaExceededError");
        }
        return key === undefined ? add.call(this, value) : add.call(this, value, key);
      };
    });
    await useEnglish(page);
    if (kind === "todo") await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
    await page.getByRole("button", { name: kind === "expense" ? "Add expense" : "Add to-do", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel(kind === "expense" ? "Description" : "Title", { exact: true });
    await field.fill("Recoverable local write");
    if (kind === "expense") await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("An unexpected error occurred. Your saved entries remain on this device.");
    await expect(field).toHaveValue("Recoverable local write");
    await expect(page.locator(".save-feedback, .saved-row-glow")).toHaveCount(0);
    await expect(page.locator(".brand-mark")).not.toHaveClass(/is-saving/);
    expect(await storedRecords(page)).toEqual({ entries: [], todos: [], outbox: [], todoOutbox: [] });
    await page.evaluate(() => window.dispatchEvent(new Event("splitty-test-storage-recovered")));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const records = await storedRecords(page);
    expect(kind === "expense" ? records.entries : records.todos).toHaveLength(1);
    expect(kind === "expense" ? records.outbox : records.todoOutbox).toHaveLength(1);
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: kind === "expense" ? "Expenses" : "To-dos", exact: true }).click();
    await expect(page.getByText("Recoverable local write", { exact: true })).toBeVisible();
  });
}
