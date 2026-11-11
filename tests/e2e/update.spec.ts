import { expect, test } from "./fixtures";
import { chooseOption } from "./controls";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["de", "en"] as const) {
    test(`update card keeps the dark accent style in ${theme} mode and ${language}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/");
      const nav = page.getByRole("navigation");
      await expect(nav).toBeVisible();
      if (language === "en") {
        await nav.getByRole("button", { name: "Einstellungen", exact: true }).click();
        await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
      }
      await nav.getByRole("button", { name: language === "de" ? "Statistik" : "Statistics", exact: true }).click();
      const title = language === "de" ? "Neue Version verfügbar" : "New version available";
      const card = page.getByRole("region", { name: title, exact: true });
      await expect(card).toHaveCount(0);

      await page.evaluate(() => {
        document.documentElement.dataset.updateCalls = "0";
        window.dispatchEvent(new CustomEvent("splitty-update", { detail: async () => {
          document.documentElement.dataset.updateCalls = String(Number(document.documentElement.dataset.updateCalls) + 1);
        } }));
      });

      await expect(card.getByRole("status")).toContainText(language === "de"
        ? "Deine gespeicherten Einträge bleiben erhalten." : "Your saved entries will be kept.");
      const heading = card.getByRole("heading", { name: title, level: 2 });
      await expect(heading).toHaveCSS("font-weight", "700");
      await expect(heading).toHaveCSS("font-size", "24px");
      await expect(heading.locator('svg[aria-hidden="true"]')).toBeVisible();
      await expect(card).toHaveCSS("background-color", "rgb(18, 61, 51)");
      await expect(card).toHaveCSS("background-image", /radial-gradient/);
      await expect(card).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(card).toHaveCSS("border-radius", "22px");

      const button = card.getByRole("button", { name: language === "de" ? "Aktualisieren" : "Update", exact: true });
      for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(card).toBeInViewport();
        await expect(button).toBeInViewport();
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(48);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`update-${width}.png`) });
      }
      await expect(page.locator("html")).toHaveAttribute("data-update-calls", "0");
      const sync = page.getByRole("button", { name: language === "de" ? "Synchronisierungsstatus" : "Sync status", exact: true });
      await expect(sync).toBeEnabled();
      await sync.focus();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-width", "3px");
      await expect(button).toHaveCSS("outline-color", "rgb(181, 233, 216)");
      await page.keyboard.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("data-update-calls", "1");
      await button.click();
      await expect(page.locator("html")).toHaveAttribute("data-update-calls", "2");
      await nav.getByRole("button", { name: language === "de" ? "Ausgaben" : "Expenses", exact: true }).click();
      await expect(card).toBeVisible();
    });
  }
}

test("update failures remain visible and allow retrying", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("splitty-update", { detail: async () => {
      throw new Error("Failed to fetch");
    } }));
  });
  const card = page.getByRole("region", { name: "Neue Version verfügbar", exact: true });
  const button = card.getByRole("button", { name: "Aktualisieren", exact: true });
  await button.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Die Netzwerkanfrage");
  await expect(button).toBeEnabled();
  await expect(card).toBeVisible();
});
