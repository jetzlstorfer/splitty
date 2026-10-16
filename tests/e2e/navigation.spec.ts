import { expect, test, type Page } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`visual feedback preserves expense entry with motion preference: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    const nav = page.getByRole("navigation");
    await nav.getByRole("button", { name: "Einstellungen", exact: true }).click();
    await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
    await nav.getByRole("button", { name: "Expenses", exact: true }).click();
    const motion = reducedMotion === "no-preference";
    await expect(page.locator(".balance-card")).toHaveCSS("animation-name", motion ? "rise-in" : "none");
    await expect(page.locator(".add-button")).toHaveCSS("transition-duration", motion ? /0\.18s/ : "0s");

    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCSS("animation-name", motion ? "sheet-in" : "none");
    expect(await dialog.evaluate((element) => getComputedStyle(element, "::backdrop").animationName))
      .toBe(motion ? "fade-in" : "none");
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await dialog.getByLabel("Description", { exact: true }).fill("Coffee together");
    await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12");
    const split = dialog.getByRole("button", { name: /Split equally/ });
    await split.click();
    await expect(split).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.locator(".split-options")).toBeVisible();
    await expect(split.locator("svg")).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
    await split.click();
    await expect(dialog.locator(".split-options")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".expense-row")).toContainText("Coffee together");
    await expect(page.locator(".balance-amount")).toContainText("6.00");

    await nav.getByRole("button", { name: "Statistics", exact: true }).click();
    await expect(page.locator(".statistics-total")).toContainText("12.00");
    await expect(page.locator(".statistics-bar").last()).toHaveCSS("animation-name", motion ? "bar-in" : "none");
    await expect(page.locator(".statistics-meter > span").first()).toHaveCSS("animation-name", motion ? "meter-in" : "none");
    await expect(page.locator(".statistics-meter > span").first()).toHaveCSS("transition-duration", motion ? "0.35s" : "0s");

    await nav.getByRole("button", { name: "Expenses", exact: true }).click();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeFocused();
  });
}

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

test("header and footer stay visible with themed blur while scrolling", async ({ page }) => {
  await page.goto("/");
  await importExpenses(page, 40);
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(page.locator(".expense-row")).toHaveCount(40);

  for (const [width, height] of [[320, 740], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      for (const position of [0, 0.5, 1]) {
        await page.evaluate((position) => {
          window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * position);
        }, position);
        await expect.poll(() => page.locator(".topbar").evaluate((element) =>
          element.getBoundingClientRect().top)).toBe(0);
        const layout = await page.locator(".topbar, .bottom-nav").evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              left: rect.left, right: rect.right, bottom: rect.bottom,
              blur: style.backdropFilter, background: style.backgroundColor
            };
          }));
        expect(layout[1].bottom).toBe(height);
        for (const bar of layout) {
          expect(bar.left).toBeGreaterThanOrEqual(0);
          expect(bar.right).toBeLessThanOrEqual(width);
          expect(bar.blur).toContain("blur(16px)");
          expect(bar.background).toMatch(/(?:0?\.82|82%)/);
        }
        if (position > 0) expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      }
      const lastRow = page.locator(".expense-row").last();
      const rowBottom = await lastRow.evaluate((element) => element.getBoundingClientRect().bottom);
      const actionTop = await page.locator(".expense-action").evaluate((element) => element.getBoundingClientRect().top);
      expect(rowBottom).toBeLessThanOrEqual(actionTop);
      await lastRow.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
    }
  }
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
