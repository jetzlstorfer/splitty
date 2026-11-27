import { expect, type Page } from "./fixtures";
import { chooseOption } from "./controls";

export async function useEnglish(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
}

export const syncIndicator = (page: Page) =>
  page.getByRole("button", { name: /^(Sync status|Synchronisierungsstatus)$/ });

export async function expectSyncBackdrop(page: Page) {
  const backdrop = await page.locator(".sync-popover").evaluate((popover) => {
    const style = getComputedStyle(popover, "::backdrop");
    const overlay = document.createElement("span");
    overlay.style.backgroundColor = "var(--cp-overlay)";
    popover.append(overlay);
    const expectedTint = getComputedStyle(overlay).backgroundColor;
    overlay.remove();
    return {
      tint: style.backgroundColor,
      expectedTint,
      blur: style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter"),
      pointerEvents: style.pointerEvents
    };
  });
  expect(backdrop.tint).toBe(backdrop.expectedTint);
  expect(backdrop.blur).toBe("blur(4px)");
  expect(backdrop.pointerEvents).toBe("none");
  await expect.poll(() => page.locator(".sync-popover").evaluate((popover) => {
    const headerBottom = popover.closest("header")!.getBoundingClientRect().bottom;
    return parseFloat(getComputedStyle(popover, "::backdrop").top) - headerBottom;
  })).toBeCloseTo(0, 1);
  const gap = await page.locator(".sync-popover").evaluate((popover) =>
    popover.getBoundingClientRect().top - popover.closest("header")!.getBoundingClientRect().bottom);
  expect(gap).toBeCloseTo(8, 1);
}

export async function openSync(page: Page) {
  const popover = page.locator(".sync-popover");
  // Native visibility changes before React receives the asynchronous toggle event.
  if (!await popover.isVisible()) await syncIndicator(page).click();
  await expect(popover).toBeVisible();
  await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "true");
}

export async function closeSync(page: Page) {
  const popover = page.locator(".sync-popover");
  if (await popover.isVisible()) await syncIndicator(page).click();
  await expect(popover).not.toBeVisible();
  await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");
}

export const upToDate = (page: Page) =>
  expect(page.locator(".sync-status")).toHaveText(/^(Up to date|Auf dem neuesten Stand)$/);

export async function signIn(page: Page, member: "A" | "B" = "A", language: "en" | "de" = "en") {
  await openSync(page);
  await page.getByRole("button", {
    name: member === "A" ? /^(Development sign-in as first member|Als erstes Mitglied zur Entwicklung anmelden)$/
      : /^(Development sign-in as second member|Als zweites Mitglied zur Entwicklung anmelden)$/
  }).click();
  await upToDate(page);
  if (language === "en") await useEnglish(page);
  else await page.goto("/");
  await openSync(page);
  await expect(page.getByText(new RegExp(`^(Signed in as|Angemeldet als) ${member === "A" ? "Alex" : "Sam"}\\.$`))).toBeVisible();
  await closeSync(page);
}

export async function synchronize(page: Page) {
  await openSync(page);
  await page.getByRole("button", { name: /^(Sync now|Jetzt synchronisieren)$/ }).click();
  await upToDate(page);
  await closeSync(page);
}

export async function failNextConflictResolution(page: Page, store: "conflicts" | "todoConflicts") {
  await page.evaluate((store) => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === store) {
        IDBObjectStore.prototype.delete = remove;
        throw new DOMException("Test storage quota exceeded.", "QuotaExceededError");
      }
      return remove.call(this, key);
    };
  }, store);
}

export async function storedRecords(page: Page, databaseName?: string) {
  return page.evaluate(async (storedDatabaseName) => {
    const name = storedDatabaseName ?? localStorage.getItem("splitty-active-database") ?? "splitty";
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = ["entries", "todos", "outbox", "todoOutbox"] as const;
      const transaction = database.transaction(stores, "readonly");
      const records = await Promise.all(stores.map((name) => new Promise<unknown[]>((resolve, reject) => {
        const request = transaction.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      return { entries: records[0], todos: records[1], outbox: records[2], todoOutbox: records[3] };
    } finally { database.close(); }
  }, databaseName);
}
