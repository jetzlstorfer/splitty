import { expect, test } from "./fixtures";
import { useEnglish } from "./helpers";

const copy = {
  de: {
    members: "Du & Deine bessere Hälfte", heading: "Gemeinsam. Fair geteilt.",
    intro: "Behalte eure gemeinsamen Ausgaben im Blick, teile sie nach euren Wünschen auf und sieh, wer wem etwas schuldet. Füge eure erste Ausgabe hinzu, um loszulegen.",
    hint: "Auch offline auf diesem Gerät gespeichert. Melde dich über Sync an, um eure Geräte zu synchronisieren.",
    add: "Ausgabe hinzufügen", description: "Beschreibung", amount: "Betrag in EUR",
    payer: "Bezahlt von", second: "Zweite Person", save: "Speichern",
    debt: "Du schuldest deiner besseren Hälfte", settle: "Ausgleichen",
    recipient: "an deine bessere Hälfte", close: "Schließen", search: "Suche",
    searchInput: "Ausgaben suchen", noMatches: "Keine passenden Ausgaben"
  },
  en: {
    members: "You & Your spouse", heading: "Together, fairly split",
    intro: "Track shared expenses, split them your way and see who owes whom. Add your first expense to get started.",
    hint: "Saved on this device, even offline. Sign in via Sync to share across devices.",
    add: "Add expense", description: "Description", amount: "Amount in EUR",
    payer: "Paid by", second: "Second person", save: "Save",
    debt: "You owe your spouse", settle: "Settle up",
    recipient: "to your spouse", close: "Close", search: "Search",
    searchInput: "Search expenses", noMatches: "No matching expenses"
  }
};

test.describe("public legal pages", () => {
  test("home legal links preserve language and offline records through a round trip", async ({ page, context }) => {
    await useEnglish(page);
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Description", { exact: true }).fill("Shared groceries");
    await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("8");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    try {
      const privacy = page.getByRole("link", { name: "Privacy policy", exact: true });
      await expect(privacy).toHaveAttribute("href", "/privacy?lang=en");
      await privacy.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");
      await page.getByRole("link", { name: "Terms of service", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms of service");
      await page.getByRole("link", { name: "Splitty home", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Expenses");
      await expect(page.locator(".expense-row")).toHaveCount(1);
      await expect(page.locator(".expense-row")).toContainText("Shared groceries");
      await expect(page.locator(".balance-amount")).toContainText("4.00");
    } finally { await context.setOffline(false); }
  });
});

for (const language of ["de", "en"] as const) {
  test(`empty expenses onboarding in ${language} fits 320, 393 and 1280px in light and dark mode`, async ({ page }, info) => {
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    const text = copy[language];
    const welcome = page.locator(".expense-welcome");
    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 851 });
      for (const theme of ["light", "dark"] as const) {
        await test.step(`${width}px ${theme}`, async () => {
          await page.emulateMedia({ colorScheme: theme });
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator(".household-members")).toHaveText(text.members);
          await expect(welcome.getByRole("heading", { name: text.heading, exact: true })).toBeVisible();
          await expect(welcome.getByText(text.intro, { exact: true })).toBeVisible();
          await expect(welcome.getByText(text.hint, { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: text.add, exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const bounds = await welcome.boundingBox();
          const action = await page.locator(".expense-action").boundingBox();
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(action!.y);
          await page.screenshot({ path: info.outputPath(`onboarding-${language}-${theme}-${width}.png`), fullPage: true });
        });
      }
    }
  });

  test(`first expense replaces onboarding and uses neutral spouse labels in ${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    const text = copy[language];
    await page.getByRole("button", { name: text.add, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(text.description, { exact: true }).fill("Shared groceries");
    await dialog.getByRole("textbox", { name: text.amount }).fill("20");
    await dialog.getByRole("group", { name: text.payer }).getByRole("radio", { name: text.second, exact: true }).check();
    await dialog.getByRole("button", { name: text.save, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".expense-welcome")).toHaveCount(0);
    await expect(page.locator(".expense-row")).toContainText("Shared groceries");
    await expect(page.getByText(text.debt, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const balance = page.getByRole("region", { name: language === "de" ? "Haushaltssaldo" : "Household balance" });
    const labelBounds = await balance.getByText(text.debt, { exact: true }).boundingBox();
    const settleBounds = await balance.getByRole("button", { name: text.settle, exact: true }).boundingBox();
    expect(labelBounds!.y + labelBounds!.height).toBeLessThanOrEqual(settleBounds!.y);
    expect(settleBounds!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: text.settle, exact: true }).click();
    await expect(dialog.getByText(text.recipient, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: text.close, exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: text.search, exact: true }).click();
    await page.getByLabel(text.searchInput, { exact: true }).fill("No such expense");
    await expect(page.getByRole("heading", { name: text.noMatches, exact: true })).toBeVisible();
    await expect(page.locator(".expense-welcome")).toHaveCount(0);
  });
}
