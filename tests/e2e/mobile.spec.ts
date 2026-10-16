import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function addExpense(page: Page, description: string, amount: string) {
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add an expense" });
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  return dialog;
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function login(page: Page, email: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Local development sign-in link" }).click();
  await page.getByRole("button", { name: "Sign in on this device" }).click();
  await expect(page.getByText("Signed in as", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
}

async function offlineReady(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("mobile expense entry, custom splits, settlements and offline reload", async ({ page, context }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Just the two of us." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-empty.png"), fullPage: true });
  let dialog = await addExpense(page, "Offline groceries", "20.01");
  await expect(dialog.getByRole("button", { name: /Split equally/ })).toBeVisible();
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("10,00");
  await offlineReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Offline groceries", { exact: true })).toBeVisible();
  dialog = await addExpense(page, "On behalf of partner", "12,34");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "Your wife owes the full amount" }).check();
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("22,34");
  dialog = await addExpense(page, "Percentage expense", "8");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "By percentage" }).check();
  await dialog.getByLabel("Your share (%)").fill("25");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("28,34");
  dialog = await addExpense(page, "Partner paid", "10");
  await dialog.getByLabel("Paid by").selectOption("b");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("23,34");
  await page.getByRole("button", { name: /Settle up/ }).click();
  dialog = page.getByRole("dialog", { name: "Settle up" });
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("3");
  await dialog.getByLabel("Paid by").selectOption("b");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("20,34");
  await page.reload();
  await expect(page.locator(".balance-amount")).toContainText("20,34");
  await expect(page.getByText("On behalf of partner", { exact: true })).toBeVisible();
  await page.getByText("Offline groceries", { exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit entry" });
  await expect(dialog.getByRole("button", { name: /Split equally/ })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("22.01");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("21,34");
  dialog = await addExpense(page, "Exact shares", "5");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "By exact amount" }).check();
  await dialog.getByLabel("Your share (EUR)").fill("1");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("25,34");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-offline.png"), fullPage: true });
  await context.setOffline(false);
});

test("email sign-in and two devices converge after an offline change", async ({ page, browser }) => {
  const second: BrowserContext = await browser.newContext({ viewport: { width: 393, height: 851 } });
  const partner = await second.newPage();
  try {
    await page.goto("/"); await partner.goto("/");
    await login(page, "first@example.com");
    await login(partner, "second@example.com");
    await offlineReady(page);
    await page.context().setOffline(true);
    await addExpense(page, "Shared across devices", "18");
    await save(page);
    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Synchronize devices" }).click();
    await expect(page.getByRole("status")).toHaveText("Up to date");
    await partner.getByRole("button", { name: "Synchronize devices" }).click();
    await expect(partner.getByText("Shared across devices", { exact: true })).toBeVisible();
    await expect(partner.locator(".balance-amount")).toContainText("9,00");
    await expect(partner.getByText("You owe Alex", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Shared across devices", { exact: true })).toBeVisible();
  } finally { await second.close(); }
});

test("previews, reconciles and deduplicates a Splitwise import", async ({ page }) => {
  await page.goto("/");
  const csv = "Datum,Beschreibung,Kategorie,Kosten,Währung,Alex,Sam\n"
    + '2024-01-01,"Dinner, together",Restaurant,83.07,EUR,-41.54,41.54\n'
    + "2024-01-02,Payment,Zahlung,10.00,EUR,10.00,-10.00\n"
    + "2024-01-03,Gesamtbilanz,,,EUR,-31.54,31.54\n";
  async function preview() {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Bring your history" });
    await dialog.getByLabel("Splitwise CSV").setInputFiles({
      name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
    });
    await dialog.getByRole("button", { name: "Preview import" }).click();
    return dialog;
  }
  let dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "2 new entries" })).toBeVisible();
  await expect(dialog.getByText("Matches the final balance in your export.")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("31,54");
  dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "0 new entries" })).toBeVisible();
  await expect(dialog.getByText("2 already imported · skipped")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText("Dinner, together", { exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit entry" });
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveAttribute("readonly");
  await dialog.getByLabel("Description", { exact: true }).fill("Updated dinner");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("31,54");
  await page.getByText("Updated dinner", { exact: true }).click();
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.getByRole("button", { name: "Delete entry" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("10,00");
  dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "0 new entries" })).toBeVisible();
});
