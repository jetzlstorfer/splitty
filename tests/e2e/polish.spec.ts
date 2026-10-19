import { expect, test, type Locator, type Page } from "@playwright/test";

async function useEnglish(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await page.getByLabel("App-Sprache", { exact: true }).selectOption("en");
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
}

async function save(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function addExpense(page: Page, description: string, amount = "12") {
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  await save(page);
}

async function pay(page: Page, amount: string) {
  await page.getByRole("button", { name: "Settle up", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  await dialog.getByLabel("Paid by", { exact: true }).selectOption("b");
  await save(page);
}

async function iconStyle(icon: Locator) {
  return icon.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/\d+/g)!.slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return r * .2126 + g * .7152 + b * .0722;
  };
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`local saves and genuine settlements get feedback with motion: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await useEnglish(page);
    const motion = reducedMotion === "no-preference";
    const feedback = page.locator(".save-feedback");
    const mark = page.locator(".settled-mark");
    await expect(page.locator(".settled-note")).toHaveText("All square. Nicely done.");
    await expect(mark).not.toHaveClass(/celebrate/);

    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Description", { exact: true }).fill("Coffee together");
    await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12.345");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(feedback).toHaveCount(0);
    await expect(page.locator(".saved-row-glow")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12");
    await save(page);

    await expect(feedback).toHaveText("Expense saved on this device");
    await expect(feedback.locator("..")).toHaveAttribute("aria-live", "polite");
    await expect(feedback).toHaveCSS("animation-name", motion ? "fade-in" : "none");
    await expect(page.locator(".saved-row-glow")).toHaveCSS("animation-name", motion ? "saved-row-in" : "none");
    await expect(page.locator(".balance-amount")).toContainText("6.00");
    await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeFocused();
    await expect(feedback).toHaveCount(0, { timeout: 6500 });
    await expect(page.locator(".saved-row-glow")).toHaveCount(0);

    await page.getByText("Coffee together", { exact: true }).click();
    await dialog.getByLabel("Description", { exact: true }).fill("Coffee with you");
    await save(page);
    await expect(page.locator(".expense-row").filter({ hasText: "Coffee with you" }).locator(".saved-row-glow")).toHaveCount(1);
    await expect(feedback).toHaveText("Expense saved on this device");
    await pay(page, "2");
    await expect(page.locator(".balance-amount")).toContainText("4.00");
    await expect(mark).toHaveCount(0);
    await expect(feedback).toHaveText("Payment saved on this device");

    await pay(page, "4");
    await expect(page.locator(".balance-amount")).toContainText("0.00");
    await expect(mark).toHaveClass(/celebrate/);
    await expect(mark).toHaveCSS("animation-name", motion ? "settled-pop" : "none");
    await expect(page.locator(".settled-sparkles")).toHaveCSS("animation-name", motion ? "settled-sparkle" : "none");
    await expect(feedback).toHaveText("Payment saved on this device");
    await expect(page.getByRole("button", { name: "Settle up", exact: true })).toBeFocused();
    await expect(feedback).toHaveCount(0, { timeout: 6500 });
    await expect(mark).not.toHaveClass(/celebrate/);
    await expect(page.locator(".settled-sparkles")).toHaveCount(0);

    await page.locator(".expense-row").filter({ hasText: "Payment" }).first().click();
    await dialog.getByLabel("Description", { exact: true }).fill("Settled together");
    await save(page);
    await expect(page.locator(".balance-amount")).toContainText("0.00");
    await expect(mark).not.toHaveClass(/celebrate/);

    await page.getByRole("navigation").getByRole("button", { name: "Statistics", exact: true }).click();
    await expect(feedback).toHaveCount(0);
    await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
    await expect(mark).not.toHaveClass(/celebrate/);
    await page.reload();
    await expect(page.locator(".balance-amount")).toContainText("0.00");
    await expect(mark).not.toHaveClass(/celebrate/);
    await expect(feedback).toHaveCount(0);
  });
}

test("category colors are consistent, accessible and responsive across both themes", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useEnglish(page);
  const nav = page.getByRole("navigation");
  const categories = [
    ["Coffee date", "coffee"], ["Shopping together", "shopping"], ["Travel", "travel"],
    ["Pharmacy", "pharmacy"], ["Groceries", "groceries"]
  ];
  for (const [description] of categories) await addExpense(page, description);

  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await nav.getByRole("button", { name: "Expenses", exact: true }).click();
      const colors = new Map<string, { color: string; background: string }>();
      for (const [description, category] of categories) {
        const row = page.locator(".expense-row").filter({ hasText: description });
        const icon = row.locator(".entry-icon");
        await expect(icon).toHaveAttribute("data-category", category);
        const style = await iconStyle(icon);
        expect(contrast(style.color, style.background)).toBeGreaterThanOrEqual(4.5);
        colors.set(category, style);
        await row.locator(".entry-description").hover();
        expect(await iconStyle(icon)).toEqual(style);
        await row.click();
        await expect(page.locator(".description-input > .expense-icon")).toHaveCSS("color", style.color);
        await page.keyboard.press("Escape");
      }
      expect(new Set([...colors.values()].map((style) => style.background)).size).toBe(categories.length);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 393) await page.screenshot({ path: info.outputPath(`polish-expenses-${theme}.png`) });

      await nav.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("searchbox").fill("Coffee date");
      expect(await iconStyle(page.locator(".entry-icon"))).toEqual(colors.get("coffee"));
      await nav.getByRole("button", { name: "To-dos", exact: true }).click();
      expect(await iconStyle(page.locator(".entry-icon"))).toEqual(colors.get("pharmacy"));
      await nav.getByRole("button", { name: "Statistics", exact: true }).click();
      for (const [, category] of categories) {
        const icon = page.locator(`.statistics-category-icon[data-category="${category}"]`);
        expect(await iconStyle(icon)).toEqual(colors.get(category));
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }

  await nav.getByRole("button", { name: "Expenses", exact: true }).click();
  await pay(page, "30");
  await expect(page.locator(".balance-amount")).toContainText("0.00");
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await expect(page.locator(".settled-note")).toBeVisible();
      const card = await page.locator(".balance-card").boundingBox();
      const button = await page.getByRole("button", { name: "Settle up", exact: true }).boundingBox();
      expect(button!.x + button!.width).toBeLessThanOrEqual(card!.x + card!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 393) await page.screenshot({ path: info.outputPath(`polish-settled-${theme}.png`) });
    }
  }
});

test("German local-save and settled copy follows the device language", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".settled-note")).toHaveText("Gut gemacht, ihr zwei.");
  await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Kaffee");
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("12");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".save-feedback")).toHaveText("Ausgabe auf diesem Gerät gespeichert");
  await page.getByRole("button", { name: "Ausgleichen", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("6");
  await dialog.getByLabel("Bezahlt von", { exact: true }).selectOption("b");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".save-feedback")).toHaveText("Zahlung auf diesem Gerät gespeichert");
  await expect(page.locator(".settled-mark")).toHaveClass(/celebrate/);
});
