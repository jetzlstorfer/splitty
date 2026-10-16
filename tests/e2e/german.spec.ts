import { expect, test, type Page } from "@playwright/test";

async function addGerman(page: Page, description: string, amount = "12,34") {
  await page.locator(".add-button").click();
  const dialog = page.getByRole("dialog", { name: "Ausgabe hinzufügen" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill(amount);
  return dialog;
}

async function saveGerman(page: Page) {
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("German is the default and category icons update while typing, saving and editing", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 851 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: /^Ausgaben/, level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Zum Synchronisieren anmelden");
  const dialog = await addGerman(page, "Billa");
  for (const [term, category] of [
    ["Billa", "Lebensmittel"], ["Hofer", "Lebensmittel"], ["Spar", "Lebensmittel"],
    ["Uni", "Lebensmittel"], ["Unimarkt", "Lebensmittel"], ["Tanken", "Tanken"],
    ["Putzfrau", "Reinigung"], ["Friseur", "Friseur"], ["Apotheke", "Apotheke"],
    ["groceries", "Lebensmittel"], ["gas", "Tanken"], ["cleaning lady", "Reinigung"],
    ["hairdresser", "Friseur"], ["pharmacy", "Apotheke"], ["Essen", "Essen"]
  ]) {
    await dialog.getByLabel("Beschreibung", { exact: true }).fill(term);
    await expect(dialog.getByRole("img", { name: category, exact: true })).toBeVisible();
    await expect(dialog.locator(".category-detected")).toHaveText(`Erkannt: ${category}`);
  }
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Hofer");
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("12,345");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Gib einen Betrag mit höchstens zwei Nachkommastellen ein.");
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("12,34");
  await dialog.getByLabel("Datum", { exact: true }).fill("2026-10-01");
  await saveGerman(page);
  await expect(page.locator(".month-heading")).toHaveText("Oktober 2026");
  await expect(page.locator(".balance-amount")).toContainText("6,17");
  let row = page.locator(".expense-row").filter({ hasText: "Hofer" });
  await expect(row.getByRole("img", { name: "Lebensmittel", exact: true })).toBeVisible();
  await row.click();
  await page.getByLabel("Beschreibung", { exact: true }).fill("Tanken");
  await expect(page.getByRole("dialog").getByRole("img", { name: "Tanken", exact: true })).toBeVisible();
  await saveGerman(page);
  row = page.locator(".expense-row").filter({ hasText: "Tanken" });
  await expect(row.getByRole("img", { name: "Tanken", exact: true })).toBeVisible();
  await row.click();
  await page.getByLabel("Kategorie", { exact: true }).selectOption("groceries");
  await expect(page.getByRole("dialog").getByRole("img", { name: "Lebensmittel", exact: true })).toBeVisible();
  await saveGerman(page);
  await row.click();
  await expect(page.getByLabel("Kategorie", { exact: true })).toHaveValue("groceries");
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByRole("button", { name: "Suche", exact: true }).click();
  await page.getByLabel("Ausgaben suchen", { exact: true }).fill("Lebensmittel");
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("german-expense-icons.png") });
});

test("language persists offline and does not change expenses or manual categories", async ({ page, context }, info) => {
  await page.goto("/");
  const dialog = await addGerman(page, "Apotheke", "20,00");
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("general");
  await saveGerman(page);
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await expect(page.getByLabel("App-Sprache", { exact: true })).toHaveValue("de");
  await page.getByLabel("Erste Person", { exact: true }).fill("Alex");
  await page.getByLabel("Zweite Person", { exact: true }).fill("Sam");
  await page.getByRole("heading", { name: "Sprache", exact: true }).click();
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Sign in to sync");
  await expect(page.getByLabel("First person", { exact: true })).toHaveValue("Alex");
  await expect(page.getByLabel("Second person", { exact: true })).toHaveValue("Sam");
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.getByText("Apotheke", { exact: true })).toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("10.00");
  await expect(page.locator(".expense-row").getByRole("img", { name: "General", exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByText("Apotheke", { exact: true }).click();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue("general");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("App language", { exact: true }).selectOption("de");
  await expect(page.getByLabel("Erste Person", { exact: true })).toHaveValue("Alex");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator(".balance-amount")).toContainText("10,00");
  await expect(page.locator(".expense-row").getByRole("img", { name: "Allgemein", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await page.screenshot({ path: info.outputPath("german-settings.png"), fullPage: true });
  await context.setOffline(false);
});

test("German import feedback, existing category icons, and translations preserve source descriptions", async ({ page }) => {
  await page.goto("/");
  const csv = "Datum,Beschreibung,Kategorie,Kosten,Währung,Alex,Sam\n"
    + "2024-01-01,Billa,Allgemein,10.00,EUR,5.00,-5.00\n"
    + "2024-01-02,Tanken,Allgemein,20.00,EUR,10.00,-10.00\n"
    + "2024-01-03,Putzfrau,Reinigung,10.00,EUR,5.00,-5.00\n"
    + "2024-01-04,Friseur,Allgemein,10.00,EUR,5.00,-5.00\n"
    + "2024-01-05,Apotheke,Medikamente,10.00,EUR,5.00,-5.00\n"
    + "2024-01-06,Payment,Zahlung,10.00,EUR,-10.00,10.00\n"
    + "2024-01-07,Gesamtbilanz,,,EUR,20.00,-20.00\n";
  await page.getByRole("button", { name: "Suche", exact: true }).click();
  await page.getByRole("button", { name: "Importieren", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const file = dialog.getByLabel("Splitwise-CSV", { exact: true });
  await file.setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv.replace("10.00,EUR", "10.00,USD")) });
  await dialog.getByRole("button", { name: "Importvorschau", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Zeile 2: Es wird nur EUR unterstützt");
  await expect(dialog.getByRole("button", { name: "Import bestätigen", exact: true })).toBeDisabled();
  await file.setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await dialog.getByRole("button", { name: "Importvorschau", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "6 neue Einträge", exact: true })).toBeVisible();
  await expect(dialog.getByText("Stimmt mit dem Endsaldo deines Exports überein.")).toBeVisible();
  await dialog.getByRole("button", { name: "Import bestätigen", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  for (const [description, category] of [
    ["Billa", "Lebensmittel"], ["Tanken", "Tanken"], ["Putzfrau", "Reinigung"],
    ["Friseur", "Friseur"], ["Apotheke", "Apotheke"], ["Payment", "Zahlung"]
  ]) {
    const row = page.locator(".expense-row").filter({ has: page.getByText(description, { exact: true }) });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole("img", { name: category, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.locator(".balance-amount")).toContainText("20.00");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Search expenses", { exact: true }).fill("Groceries");
  await expect(page.getByText("Billa", { exact: true })).toBeVisible();
  await expect(page.locator(".expense-row").getByRole("img", { name: "Groceries", exact: true })).toBeVisible();
});
