import { expect, test } from "./fixtures";
import { chooseOption, confirmAction } from "./controls";
import { signIn, storedRecords, upToDate, useEnglish } from "./helpers";

const copy = {
  de: {
    members: "Du & Deine bessere Hälfte", heading: "Gemeinsam. Fair geteilt.",
    intro: "Behalte eure gemeinsamen Ausgaben im Blick, teile sie nach euren Wünschen auf und sieh, wer wem etwas schuldet. Füge eure erste Ausgabe hinzu, um loszulegen.",
    hint: "Splitty ist für zwei Personen gedacht. Melde dich an, um Ausgaben und To-dos mit der anderen Person zu teilen, oder nutze Splitty nur auf diesem Gerät.",
    share: "Anmelden und teilen", empty: "Noch keine gemeinsamen Ausgaben", cloud: "Nur lokal",
    add: "Ausgabe hinzufügen", description: "Beschreibung", amount: "Betrag in EUR",
    payer: "Bezahlt von", second: "Zweite Person", save: "Speichern",
    debt: "Du schuldest deiner besseren Hälfte", settle: "Ausgleichen",
    recipient: "an deine bessere Hälfte", close: "Schließen", search: "Suche",
    searchInput: "Ausgaben suchen", noMatches: "Keine passenden Ausgaben"
  },
  en: {
    members: "You & Your spouse", heading: "Together, fairly split",
    intro: "Track shared expenses, split them your way and see who owes whom. Add your first expense to get started.",
    hint: "Splitty is for two people. Sign in to share expenses and to-dos with the other person, or keep using it on this device only.",
    share: "Sign in to share", empty: "No shared expenses yet", cloud: "Local only",
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
          await expect(welcome.getByRole("button", { name: text.share, exact: true })).toBeVisible();
          // An empty ledger is not celebrated as settled, and there is nothing to settle yet.
          await expect(page.locator(".balance-card")).toContainText(text.empty);
          await expect(page.locator(".settled-note, .settle-button")).toHaveCount(0);
          // Local-only use is a supported mode, so the cloud stays calm.
          await expect(page.locator(".sync-pill")).toHaveText(text.cloud);
          await expect(page.locator(".sync-pill")).not.toHaveClass(/needs-attention/);
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

test("the welcome card's sharing action opens sign-in in Settings when no provider is configured", async ({ page }) => {
  await useEnglish(page);
  await page.locator(".expense-welcome").getByRole("button", { name: "Sign in to share", exact: true }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(page.locator("#settings-account")).toBeFocused();
  await expect(page.locator(".sync-popover")).not.toBeVisible();
  await expect(account).toContainText("Without an account, entries stay on this device.");
  await account.getByRole("button", { name: "Development sign-in as first member", exact: true }).click();
  await upToDate(page);
  await expect(account.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  // The chosen device language survives signing in.
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".sync-pill")).not.toHaveText("Local only");
});

test("a new household shows order-free setup steps that open the matching Settings sections", async ({ page }, info) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, localSignInEnabled: true, newHouseholdsEnabled: true } }));
  await useEnglish(page);
  await signIn(page);
  const nav = page.getByRole("navigation");
  const setup = page.getByRole("region", { name: "Set up your household", exact: true });
  const steps = setup.getByRole("listitem");
  await expect(setup).toBeVisible();
  // A signed-in member is not asked to sign in again just because the ledger is empty.
  await expect(page.locator(".expense-welcome")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Sign in");
  await expect(page.locator(".balance-card")).toContainText("No shared expenses yet");
  await expect(steps).toHaveText([
    /Check both names\s*Done/, /Invite the other person\s*Share a link or QR code/, /Add your first expense\s*You can start/
  ]);
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 851 });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const button of await setup.getByRole("button").all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      if (width === 393) await page.screenshot({ path: info.outputPath(`setup-${theme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 393, height: 851 });

  await steps.nth(1).getByRole("button").click();
  await expect(nav.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#settings-invite")).toBeFocused();
  await expect(page.getByRole("region", { name: "Invite the other person", exact: true })
    .getByRole("button", { name: "Create invitation", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Invite the other person", exact: true })
    .getByRole("button", { name: "Create invitation", exact: true }).click();
  await nav.getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(steps.nth(1)).toContainText("Invitation pending");

  await steps.nth(2).getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: "Add an expense", exact: true });
  await dialog.getByLabel("Description", { exact: true }).fill("Setup groceries");
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(steps.nth(2)).toHaveClass("done");
  await expect(setup).toBeVisible();

  await setup.getByRole("button", { name: "Hide setup", exact: true }).click();
  await expect(setup).toHaveCount(0);
  await upToDate(page);
  await page.reload();
  await upToDate(page);
  await expect(page.locator(".expense-row")).toHaveCount(1);
  await expect(setup).toHaveCount(0);
});

test("entries saved before sign-in stay on the device until they are explicitly added", async ({ page }) => {
  await useEnglish(page);
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill("Local groceries");
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("12");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await dialog.getByLabel("Title", { exact: true }).fill("Local errand");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const local = await storedRecords(page, "splitty");

  await signIn(page);
  await expect(page.locator(".expense-row")).toHaveCount(0);
  const banner = page.getByRole("region", { name: "Entries from before you signed in", exact: true });
  await expect(banner).toContainText("1 expense and 1 to-do are saved only on this device.");
  await banner.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("#settings-device")).toBeFocused();
  const notice = page.getByRole("region", { name: "This device", exact: true })
    .getByRole("region", { name: "Entries from before you signed in", exact: true });
  await notice.getByRole("button", { name: "Add to this household", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add entries to this household", exact: true }))
    .toContainText("Add 1 expense and 1 to-do from this device to this household?");
  await confirmAction(page, "Add to this household");
  await expect(notice).toHaveCount(0);
  await upToDate(page);

  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.locator(".expense-row")).toContainText("Local groceries");
  await expect(page.locator(".balance-amount")).toContainText("6.00");
  await expect(banner).toHaveCount(0);
  // Adding copies the records into the household; the device's local copy is left as it was.
  expect((await storedRecords(page, "splitty")).entries).toEqual(local.entries);
  await page.reload();
  await upToDate(page);
  await expect(page.locator(".expense-row")).toHaveCount(1);
  await expect(banner).toHaveCount(0);
});

test("entries recorded with the other person order are offered only as a download", async ({ page }) => {
  await useEnglish(page);
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await chooseOption(page, page.getByRole("button", { name: "This device belongs to", exact: true }), 1);
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill("Mirrored groceries");
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await signIn(page);
  await page.getByRole("region", { name: "Entries from before you signed in", exact: true })
    .getByRole("button", { name: "Review", exact: true }).click();
  const notice = page.getByRole("region", { name: "This device", exact: true })
    .getByRole("region", { name: "Entries from before you signed in", exact: true });
  await expect(notice).toContainText("recorded with you as the other person");
  await expect(notice.getByRole("button", { name: "Add to this household", exact: true })).toHaveCount(0);
  const download = page.waitForEvent("download");
  await notice.getByRole("button", { name: "Download these entries", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^splitty-local-entries-\d{4}-\d{2}-\d{2}\.json$/);
});
