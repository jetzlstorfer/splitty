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
  if (await syncIndicator(page).getAttribute("aria-expanded") !== "true") await syncIndicator(page).click();
}

export async function closeSync(page: Page) {
  if (await syncIndicator(page).getAttribute("aria-expanded") === "true") await syncIndicator(page).click();
}

export const upToDate = (page: Page) =>
  expect(page.locator(".sync-status")).toHaveText(/^(Up to date|Auf dem neuesten Stand)$/);

export async function signIn(page: Page, member: "A" | "B" = "A") {
  await openSync(page);
  await page.getByLabel(/^(Member token|Mitglieds-Token)$/).fill(member.repeat(43));
  await page.getByRole("button", { name: /^(Sign in|Anmelden)$/ }).click();
  await upToDate(page);
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

export async function storedRecords(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("splitty");
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
  });
}
