import { expect, test, type Page } from "@playwright/test";

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
  await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(20, 27, 25)" : "rgb(242, 244, 243)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", theme === "dark" ? "#1c2524" : "#ffffff");
}

for (const initial of ["light", "dark"] as const) {
  const opposite = initial === "light" ? "dark" : "light";

  test(`system theme follows live changes starting in ${initial} without losing form input`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: initial });
    await page.goto("/");
    await expectTheme(page, initial);
    await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
    const description = page.getByRole("textbox", { name: "Beschreibung", exact: true });
    await description.fill("Theme change regression");

    for (const theme of [opposite, initial]) {
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, theme);
      await expect(description).toHaveValue("Theme change regression");
      await expect(description).toBeFocused();
    }
  });

  test(`explicit ${initial} override ignores system theme changes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: opposite });
    await page.goto(`/?scoutTheme=${initial}`);
    await expectTheme(page, initial);
    for (const theme of [initial, opposite]) {
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, initial);
    }
  });
}

test("invalid theme override still follows system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?scoutTheme=invalid");
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
});

test("system theme follows changes after an offline PWA reload", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.getByRole("heading", { name: /^Ausgaben/, level: 1 })).toBeVisible();
    await expectTheme(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, "dark");
  } finally {
    await context.setOffline(false);
  }
});
