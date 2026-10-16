import { expect, test, type Page } from "@playwright/test";

async function importExpenses(page: Page, count: number) {
  await page.getByRole("button", { name: "Suche", exact: true }).click();
  await page.getByRole("button", { name: "Importieren", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Aus Splitwise importieren" });
  const rows = Array.from({ length: count }, (_, index) =>
    `2026-10-${String(index % 16 + 1).padStart(2, "0")},Einkauf ${index + 1},Lebensmittel,2.00,EUR,1.00,-1.00`);
  const csv = ["Datum,Beschreibung,Kategorie,Kosten,Währung,Alex,Sam", ...rows,
    `2026-10-17,Gesamtbilanz,,,EUR,${count}.00,-${count}.00`].join("\n");
  await dialog.getByLabel("Splitwise-CSV", { exact: true }).setInputFiles({
    name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await dialog.getByRole("button", { name: "Importvorschau", exact: true }).click();
  await dialog.getByRole("button", { name: "Import bestätigen", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("search owns import, filtering, pagination and editing without filtering Expenses", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("button")).toHaveText(["Ausgaben", "Suche", "Statistik", "Einstellungen"]);
  await expect(page.getByRole("heading", { name: "Noch keine Ausgaben" })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Import/ })).toHaveCount(0);
  await expect(page.locator(".add-button")).toBeVisible();
  await nav.getByRole("button", { name: "Suche", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Suche", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".add-button")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Noch keine Ausgaben" })).toBeVisible();

  await importExpenses(page, 105);
  await expect(page.getByRole("status")).toContainText("Zum Synchronisieren anmelden");
  const rows = page.locator(".expense-row");
  await expect(rows).toHaveCount(100);
  await page.getByRole("button", { name: "Mehr anzeigen (5)", exact: true }).click();
  await expect(rows).toHaveCount(105);
  const search = page.getByRole("searchbox", { name: "Ausgaben suchen", exact: true });
  await search.fill("Einkauf 105");
  await expect(rows).toHaveCount(1);
  await rows.click();
  await page.getByLabel("Beschreibung", { exact: true }).fill("Einkauf 105 korrigiert");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(rows).toContainText("Einkauf 105 korrigiert");

  await nav.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(rows).toHaveCount(100);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ausgaben105");
  await expect(page.locator(".balance-amount")).toContainText("105,00");
  await nav.getByRole("button", { name: "Suche", exact: true }).click();
  await expect(search).toHaveValue("Einkauf 105");
  await expect(rows).toHaveCount(1);
  await search.fill("does not exist");
  await expect(page.getByRole("heading", { name: "Keine passenden Ausgaben" })).toBeVisible();
  await search.fill("2026-10-16");
  await expect(rows).toHaveCount(6);
  await search.fill("Lebensmittel");
  await expect(rows).toHaveCount(100);
  await search.fill("   ");
  await expect(rows).toHaveCount(100);

  await nav.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await expect(page.locator(".add-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Import/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sicherung herunterladen", exact: true })).toBeVisible();
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText(["Expenses", "Search", "Statistics", "Settings"]);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
});

test("compact mobile layout shows six expenses and keeps all four tabs usable at 320px", async ({ page }) => {
  await page.goto("/");
  await importExpenses(page, 8);
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Zum Synchronisieren anmelden");
  const layout = await page.locator(".expense-row").evaluateAll((rows) => {
    const actionTop = document.querySelector(".expense-action")!.getBoundingClientRect().top;
    return {
      firstRowTop: rows[0].getBoundingClientRect().top,
      visibleRows: rows.filter((row) => row.getBoundingClientRect().bottom <= actionTop).length,
      rowHeights: rows.map((row) => row.getBoundingClientRect().height)
    };
  });
  expect(layout.firstRowTop).toBeLessThan(320);
  expect(layout.visibleRows).toBeGreaterThanOrEqual(6);
  expect(Math.min(...layout.rowHeights)).toBeGreaterThanOrEqual(44);

  for (const [width, height] of [[320, 740], [393, 851], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const tab of ["Ausgaben", "Suche", "Statistik", "Einstellungen"]) {
      await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const targets = await page.getByRole("navigation").getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }));
      for (const target of targets) {
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.x).toBeGreaterThanOrEqual(0);
        expect(target.x + target.width).toBeLessThanOrEqual(width);
        expect(target.y + target.height).toBeLessThanOrEqual(height);
      }
    }
  }
});
