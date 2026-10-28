import { expect, test, type Page } from "./fixtures";

async function holdSyncPull(page: Page, path: "sync" | "todo-sync", status: 200 | 503 = 200) {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let notify = () => {};
  const started = new Promise<void>((resolve) => { notify = resolve; });
  await page.route(`**/api/${path}?*`, async (route) => {
    notify();
    await held;
    await route.fulfill({
      status,
      json: status === 200 ? { entries: [], cursor: 0, more: false } : { error: "Sync request failed." }
    });
  }, { times: 1 });
  return { started, release };
}

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
    await expect(dialog.getByLabel("Description", { exact: true })).toBeFocused();
    await page.keyboard.type("Coffee together");
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
    await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeFocused();
    await expect(page.locator(".expense-row")).toContainText("Coffee together");
    await expect(page.locator(".balance-amount")).toContainText("6.00");

    await page.getByText("Coffee together", { exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await expect(dialog.getByLabel("Description", { exact: true })).not.toBeFocused();
    await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue("Coffee together");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

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
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Description", { exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeFocused();
  });

  test(`heart logo follows sync activity with motion preference: ${reducedMotion}`, async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion });
    await page.route("**/api/me", (route) => route.fulfill({ json: { member: "a", nameA: "Alex", nameB: "Sam" } }));
    await page.route(/\/api\/(?:todo-)?sync\?/, (route) =>
      route.fulfill({ json: { entries: [], cursor: 0, more: false } }));
    const expenses = await holdSyncPull(page, "sync");
    const todos = await holdSyncPull(page, "todo-sync");
    const releases = [expenses.release, todos.release];
    const icon = page.locator(".topbar .brand-mark");
    const button = page.locator(".sync-pill");
    const status = page.locator(".sync-status");
    const motion = reducedMotion === "no-preference";
    try {
      await page.goto("/");
      await expenses.started;
      await expect(icon).toHaveClass(/is-syncing/);
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button).toBeEnabled();
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await expect(icon).toHaveCSS("animation-name", motion ? "sync-heartbeat" : "none");
        await expect(icon).toHaveCSS("width", "32px");
        await expect(icon).toHaveCSS("height", "32px");
        if (motion) {
          await expect(icon).toHaveCSS("animation-duration", "1.8s");
          await expect(icon).toHaveCSS("animation-iteration-count", "infinite");
          await expect.poll(() => icon.evaluate((element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).a), { intervals: [50] }).toBeGreaterThan(1.03);
        } else {
          await expect(icon).toHaveCSS("transform", "none");
          await expect(icon).not.toHaveCSS("box-shadow", "none");
        }
      }
      expenses.release();
      await todos.started;
      await expect(icon).toHaveClass(/is-syncing/);
      await expect(button).toHaveAttribute("aria-busy", "true");
      todos.release();
      await expect(status).toHaveText("Auf dem neuesten Stand");
      await expect(icon).not.toHaveClass(/is-syncing/);
      await expect(icon).toHaveCSS("animation-name", "none");
      await expect(icon).toHaveCSS("transform", "none");
      await expect(icon).toHaveCSS("box-shadow", "none");
      await expect(button).toHaveAttribute("aria-busy", "false");
      await expect(button).toBeEnabled();

      const failed = await holdSyncPull(page, "sync", 503);
      releases.push(failed.release);
      await button.click();
      await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
      await button.click();
      await failed.started;
      await expect(icon).toHaveClass(/is-syncing/);
      failed.release();
      await expect(icon).not.toHaveClass(/is-syncing/);
      await expect(icon).toHaveCSS("animation-name", "none");
      await expect(button).toHaveAttribute("aria-busy", "false");

      const offline = await holdSyncPull(page, "sync");
      releases.push(offline.release);
      await button.click();
      await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
      await button.click();
      await offline.started;
      await expect(icon).toHaveClass(/is-syncing/);
      await context.setOffline(true);
      await expect(icon).not.toHaveClass(/is-syncing/);
      await expect(icon).toHaveCSS("animation-name", "none");
      await expect(icon).toHaveCSS("box-shadow", "none");
      await expect(button).toHaveAttribute("aria-busy", "false");
      await expect(button).toContainText("Offline");
    } finally {
      for (const release of releases) release();
    }
  });
}

test.describe("touch navigation", () => {
  test.use({ hasTouch: true });

  test("bottom tabs suppress native tap flashes and retain active and keyboard feedback", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      for (const name of ["To-dos", "Suche", "Statistik", "Einstellungen", "Ausgaben", "Ausgaben"]) {
        const button = nav.getByRole("button", { name, exact: true });
        for (const target of [button, button.locator("svg"), button.locator("span")]) {
          await expect(target).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
        }
        await button.locator("svg").tap();
        await expect(button).toHaveAttribute("aria-current", "page");
        await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
        await expect(button).toHaveCSS("font-weight", "600");
        await expect.poll(() => button.evaluate((element) =>
          getComputedStyle(element.querySelector("svg")!).color === getComputedStyle(element).color)).toBe(true);
      }
    }
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const expenses = nav.getByRole("button", { name: "Ausgaben", exact: true });
    await expect(expenses).toBeFocused();
    await expect(expenses).toHaveCSS("outline-style", "solid");
    await expect(expenses).toHaveCSS("outline-width", "3px");
  });
});

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
  await expect(nav.getByRole("button")).toHaveText(["Ausgaben", "To-dos", "Suche", "Statistik", "Einstellungen"]);
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
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText(["Expenses", "To-dos", "Search", "Statistics", "Settings"]);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
});

test("header and footer fade into safe areas and retain themed blur while scrolling", async ({ page }) => {
  await page.goto("/");
  await importExpenses(page, 40);
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(page.locator(".expense-row")).toHaveCount(40);

  for (const [width, height] of [[320, 740], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const surface = await page.locator(".app-shell").evaluate((element) => getComputedStyle(element).backgroundColor);
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
              blur: style.backdropFilter, background: style.backgroundColor,
              fade: style.backgroundImage
            };
          }));
        expect(layout[1].bottom).toBe(height);
        for (const bar of layout) {
          expect(bar.left).toBeGreaterThanOrEqual(0);
          expect(bar.right).toBeLessThanOrEqual(width);
          expect(bar.blur).toContain("blur(16px)");
          expect(bar.background).toMatch(/(?:0?\.35|35%)/);
        }
        expect(layout[0].fade).toBe(`linear-gradient(${surface} 0px, rgba(0, 0, 0, 0))`);
        expect(layout[1].fade).toBe(`linear-gradient(to top, ${surface} 0px, rgba(0, 0, 0, 0))`);
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

test("compact mobile layout measures density at 320px and 393px and keeps all five tabs usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await importExpenses(page, 8);
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Zum Synchronisieren anmelden");
  for (const [width, height, minimumRows] of [[320, 740, 5], [393, 851, 6]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.locator(".expense-row").evaluateAll((rows) => {
      const actionTop = document.querySelector(".expense-action")!.getBoundingClientRect().top;
      return {
        firstRowTop: rows[0].getBoundingClientRect().top,
        visibleRows: rows.filter((row) => row.getBoundingClientRect().bottom <= actionTop).length,
        rowHeights: rows.map((row) => row.getBoundingClientRect().height)
      };
    });
    expect(layout.firstRowTop).toBeLessThan(320);
    expect(layout.visibleRows, `${width}x${height} density`).toBeGreaterThanOrEqual(minimumRows);
    expect(Math.min(...layout.rowHeights)).toBeGreaterThanOrEqual(44);
  }

  for (const [width, height] of [[320, 740], [393, 851], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const tab of ["Ausgaben", "To-dos", "Suche", "Statistik", "Einstellungen"]) {
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
