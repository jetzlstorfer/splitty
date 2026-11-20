import { expect, test } from "./fixtures";
import { chooseOption } from "./controls";

for (const pageName of ["privacy", "terms"] as const) {
  for (const language of ["de", "en"] as const) {
    test(`${pageName} is public and localized in ${language}`, async ({ page }) => {
      const apiRequests: string[] = [];
      const pageErrors: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        indexedDB.open = (...args) => {
          throw new Error(`Unexpected ledger initialization: ${args[0]}`);
        };
      });
      await page.goto(`/${pageName}${language === "en" ? "?lang=en" : ""}`);
      const title = pageName === "privacy"
        ? language === "de" ? "Datenschutzerklärung" : "Privacy policy"
        : language === "de" ? "Nutzungsbedingungen" : "Terms of service";
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
      await expect(page).toHaveTitle(`${title} | Splitty`);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.getByText("Jürgen Etzlstorfer, Hagenberg im Mühlkreis")).toBeVisible();
      await expect(page.locator('meta[name="robots"][content*="noindex" i], meta[name="robots"][content*="nofollow" i]')).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/draft|entwurf|review required/i);
      if (pageName === "privacy") {
        await expect(page.locator("main")).toContainText(language === "de" ? "Microsoft-Azure-Cloudregion innerhalb der EU" : "Microsoft Azure cloud region within the EU");
        await expect(page.locator("main")).toContainText(language === "de" ? "beim Betreiber eine Kopie oder ein Backup" : "request a copy or backup of your data");
        await expect(page.locator("main")).toContainText(language === "de" ? "Löschung anfordern" : "request deletion");
        await expect(page.locator("main")).toContainText(language === "de" ? "Wenn aktiviert" : "When enabled");
        await expect(page.locator('a[href="https://privacy.microsoft.com/privacystatement"]')).toBeVisible();
        await expect(page.locator('a[href="https://policies.google.com/privacy"]')).toBeVisible();
      }
      for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 851 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      await expect(page.locator(`.legal-language a[lang="${language}"]`)).toHaveAttribute("aria-current", "true");
      await page.getByRole("link", { name: language === "de" ? "English" : "Deutsch", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", language === "de" ? "en" : "de");
      expect(apiRequests).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    });
  }
}

test("app footer links retain the selected language", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator('footer[aria-label="Rechtliche Informationen"]');
  await expect(footer.getByRole("link", { name: "Datenschutzerklärung" })).toHaveAttribute("href", "/privacy?lang=de");
  await expect(footer.getByRole("link", { name: "Nutzungsbedingungen" })).toHaveAttribute("href", "/terms?lang=de");
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
  const englishFooter = page.locator('footer[aria-label="Legal information"]');
  await expect(englishFooter.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", "/privacy?lang=en");
  await expect(englishFooter.getByRole("link", { name: "Terms of service" })).toHaveAttribute("href", "/terms?lang=en");
  await englishFooter.getByRole("link", { name: "Privacy policy" }).click();
  await expect(page.getByRole("heading", { name: "Privacy policy", level: 1 })).toBeVisible();
});
