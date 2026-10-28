import { expect, test, type Page } from "@playwright/test";

async function openExpense(page: Page, english = true) {
  await page.goto("/");
  if (english) {
    await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
    await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
    await page.getByRole("button", { name: "Expenses", exact: true }).click();
  }
  await page.getByRole("button", { name: english ? "Add expense" : "Ausgabe hinzufügen", exact: true }).click();
  return page.getByRole("dialog");
}

async function receiptImage(page: Page, lines: string[]) {
  const base64 = await page.evaluate((text) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1100; canvas.height = 100 + text.length * 75;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black"; context.font = "36px monospace";
    text.forEach((line, index) => context.fillText(line, 50, 70 + index * 75));
    return canvas.toDataURL("image/png").split(",")[1];
  }, lines);
  return { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

async function prepareScanner(page: Page) {
  await page.getByRole("button", { name: "Scan receipt (optional)", exact: true }).click();
  await page.getByRole("button", { name: "Download scanner", exact: true }).click();
  await expect(page.getByText("Scanner downloaded. You can scan offline on this device.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("real local OCR creates only a reviewed expense and works after an offline reload", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const requests: { url: string; method: string }[] = [];
  context.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  let dialog = await openExpense(page);
  expect(requests.some((request) => request.url.includes("/receipt-ocr-"))).toBe(false);
  const image = await receiptImage(page, ["HOFER", "19.10.2026", "BROT 2,00", "SUMME EUR 24,90", "BAR 30,00", "RUECKGELD 5,10"]);
  await prepareScanner(page);
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(image);
  await expect(dialog.getByText("Nothing has been saved.", { exact: false })).toBeVisible({ timeout: 45_000 });
  await expect(dialog.locator(".receipt-result dd").nth(2)).toHaveText("24.90");
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("");
  await expect(page.locator(".expense-row")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("receipt-review.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Use suggestions" }).click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue("HOFER");
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("24.90");
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-10-19");
  await expect(dialog.getByText("Detected: Groceries", { exact: true })).toBeVisible();
  await expect(page.locator(".expense-row")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("25.00");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".expense-row")).toHaveCount(1);
  await expect(page.locator(".balance-amount")).toContainText("12.50");

  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Scan receipt (optional)", exact: true }).click();
  await expect(dialog.getByLabel("Choose receipt image", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(image);
  await expect(dialog.getByRole("button", { name: "Use suggestions" })).toBeEnabled({ timeout: 45_000 });
  await dialog.getByRole("button", { name: "Use suggestions" }).click();
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("24.90");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".expense-row")).toHaveCount(1);
  expect(requests.filter((request) => !request.url.startsWith("http://127.0.0.1:5173/"))).toEqual([]);
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("foreign and unidentified currencies cannot silently autofill EUR", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await openExpense(page);
  await prepareScanner(page);
  const foreign = await receiptImage(page, ["MARKET", "19.10.2026", "TOTAL USD 24.90"]);
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(foreign);
  await expect(dialog.getByText("This receipt uses USD.", { exact: false })).toBeVisible({ timeout: 45_000 });
  await dialog.getByRole("button", { name: "Use suggestions" }).click();
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("");
  const unknown = await receiptImage(page, ["MARKET", "19.10.2026", "TOTAL 24.90"]);
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(unknown);
  await expect(dialog.getByLabel("I confirm this receipt is in EUR.")).toBeVisible({ timeout: 45_000 });
  await dialog.getByRole("button", { name: "Use suggestions" }).click();
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("");
  await dialog.getByLabel("I confirm this receipt is in EUR.").check();
  await dialog.getByRole("button", { name: "Use suggestions" }).click();
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("24.90");
  await expect(page.locator(".expense-row")).toHaveCount(0);
});

test("cancellation, bad photos, and retries leave manual entry intact", async ({ page }) => {
  const dialog = await openExpense(page);
  await prepareScanner(page);
  await dialog.getByLabel("Description", { exact: true }).fill("Keep my draft");
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12.00");
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles({
    name: "receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a photo")
  });
  await expect(dialog.getByRole("alert")).toHaveText("Choose a JPEG, PNG or WebP receipt photo.");
  const image = await receiptImage(page, ["HOFER", "19.10.2026", "SUMME EUR 24,90"]);
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(image);
  await expect.poll(() => page.workers().length).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Cancel scan", exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(dialog.getByRole("alert")).toHaveText("Receipt scanning cancelled. Retry or enter the expense manually.");
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue("Keep my draft");
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveValue("12.00");
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(image);
  await expect(dialog.getByRole("button", { name: "Use suggestions" })).toBeEnabled({ timeout: 45_000 });
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue("Keep my draft");
  const blank = await receiptImage(page, []);
  await dialog.getByLabel("Choose receipt image", { exact: true }).setInputFiles(blank);
  await expect(dialog.getByText("The text is unclear.", { exact: false })).toBeVisible({ timeout: 45_000 });
  await expect(dialog.getByRole("button", { name: "Use suggestions" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".expense-row")).toHaveCount(1);
  await expect(page.getByText("Keep my draft", { exact: true })).toBeVisible();
});

test("German scanner controls stay optional and usable on narrow screens", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 851 });
  const dialog = await openExpense(page, false);
  await dialog.getByRole("button", { name: "Beleg scannen (optional)", exact: true }).click();
  await expect(dialog.getByLabel("Beleg fotografieren", { exact: true })).toHaveAttribute("capture", "environment");
  await expect(dialog.getByLabel("Belegfoto auswählen", { exact: true })).toBeDisabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await context.setOffline(true);
  await dialog.getByRole("button", { name: "Scanner herunterladen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Manuell");
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("10");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Manuell", { exact: true })).toBeVisible();
});
