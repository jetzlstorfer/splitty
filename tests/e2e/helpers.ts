import { expect, type Page } from "./fixtures";

export async function useEnglish(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
}

export const syncIndicator = (page: Page) =>
  page.getByRole("button", { name: /^(Sync status|Synchronisierungsstatus)$/ });

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
