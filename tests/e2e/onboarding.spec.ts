import { expect, test } from "./fixtures";
import { chooseOption } from "./controls";
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

for (const language of ["de", "en"] as const) {
  for (const width of [320, 393, 1280]) {
    for (const theme of ["light", "dark"] as const) {
      test(`empty expenses onboarding in ${language}, ${theme}, ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 851 });
        await page.emulateMedia({ colorScheme: theme });
        if (language === "en") await useEnglish(page);
        else await page.goto("/");
        const text = copy[language];
        await expect(page.locator(".household-members")).toHaveText(text.members);
        const welcome = page.locator(".expense-welcome");
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

  test(`first expense replaces onboarding and uses neutral spouse labels in ${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    const text = copy[language];
    await page.getByRole("button", { name: text.add, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(text.description, { exact: true }).fill("Shared groceries");
    await dialog.getByRole("textbox", { name: text.amount }).fill("20");
    await chooseOption(page, dialog.getByLabel(text.payer, { exact: true }), text.second);
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
