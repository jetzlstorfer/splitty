import { expect, test, type Page } from "./fixtures";
import { signIn as signInMember } from "./helpers";
import { chooseOption, confirmAction } from "./controls";

async function signIn(page: Page, member: "A" | "B" = "A") {
  await page.goto("/");
  await signInMember(page, member);
  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
}

async function add(page: Page, description: string) {
  await addOn(page, description, "2026-10-01");
}

async function addOn(page: Page, description: string, date: string) {
  await page.locator(".add-button").click();
  const dialog = page.getByRole("dialog", { name: "Ausgabe hinzufügen" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("20,00");
  await dialog.getByLabel("Datum", { exact: true }).fill(date);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function addTodo(page: Page, title: string) {
  await page.getByRole("button", { name: "To-do hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "To-do hinzufügen" });
  await dialog.getByLabel("Titel", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("to-dos default to newest first and can switch to a saved manual order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "To-dos" }).click();
  await addTodo(page, "Eigene Aufgabe");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "To-dos" }).click();
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "Ausgaben" }).click();
  await addOn(page, "Apotheke", "2099-12-31");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "To-dos" }).click();

  const open = page.getByRole("region", { name: "Offene To-dos" });
  await expect(open.getByRole("listitem").nth(0)).toContainText("Apotheke");
  await expect(open.getByRole("listitem").nth(1)).toContainText("Eigene Aufgabe");
  await chooseOption(page, page.getByRole("button", { name: "To-do-Sortierung" }), "Manuell");
  await expect(open.getByRole("listitem").nth(0)).toContainText("Eigene Aufgabe");
  await expect(open.getByRole("listitem").nth(1)).toContainText("Apotheke");

  await page.reload();
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "To-dos" }).click();
  await expect(page.getByRole("button", { name: "To-do-Sortierung" })).toContainText("Manuell");
  await expect(page.getByRole("region", { name: "Offene To-dos" }).getByRole("listitem").nth(0)).toContainText("Eigene Aufgabe");
});

test("doctor and pharmacy expenses create insurance to-dos that can be checked off", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("button")).toHaveText([/Ausgaben/, /To-dos/, /Suche/, /Statistik/, /Einstellungen/]);
  await add(page, "Apotheke");
  await add(page, "Arzt Dr. Huber");
  await add(page, "Billa");

  await nav.getByRole("button", { name: "To-dos" }).click();
  await expect(page.locator(".todos-page .page-heading p")).toHaveText("2 offen");
  const open = page.getByRole("region", { name: "Offene To-dos" });
  await expect(open.getByRole("heading")).toHaveCount(0);
  await expect(open.locator(".section-label")).toHaveCount(0);
  await expect(open.getByRole("listitem")).toHaveCount(2);
  await expect(open.getByRole("listitem").first()).toContainText("Bei Versicherung einreichen");
  await expect(open).toContainText("Apotheke");
  await expect(open).toContainText("Arzt Dr. Huber");
  await expect(page.getByText("Billa")).toHaveCount(0);

  await open.getByRole("listitem").filter({ hasText: "Apotheke" }).getByRole("checkbox").click();
  const done = page.getByRole("region", { name: "Erledigt" });
  await expect(done.getByRole("heading", { level: 2 })).toHaveText("Erledigt");
  await expect(page.locator(".todos-page .page-heading p")).toHaveText("1 offen");
  await expect(done.getByRole("checkbox")).toBeChecked();
  await expect(done).toContainText("Apotheke");
  await expect(open.getByRole("listitem")).toHaveCount(1);

  await page.reload();
  await nav.getByRole("button", { name: "To-dos" }).click();
  await expect(page.getByRole("region", { name: "Erledigt" })).toContainText("Apotheke");

  await page.getByRole("button", { name: "To-do-Aktionen: Apotheke" }).click();
  await page.getByRole("button", { name: "Ausgabe öffnen: Apotheke" }).click();
  const dialog = page.getByRole("dialog", { name: "Eintrag bearbeiten" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Apotheke Rezept");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("region", { name: "Erledigt" })).toContainText("Apotheke Rezept");
});

test("doctor specialties map to Gesundheit and create insurance to-dos", async ({ page }) => {
  await page.goto("/");
  for (const description of ["Augenarzt", "Zahnarzt", "Zahnärztin"]) {
    await add(page, description);
  }
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("button", { name: "To-dos" }).click();
  const open = page.getByRole("region", { name: "Offene To-dos" });
  await expect(open.getByRole("listitem")).toHaveCount(3);
  for (const description of ["Augenarzt", "Zahnarzt", "Zahnärztin"]) {
    await expect(open.getByRole("listitem").filter({ hasText: description }).first()).toContainText("Bei Versicherung einreichen");
    await page.getByRole("button", { name: `To-do-Aktionen: ${description}`, exact: true }).click();
    await page.getByRole("button", { name: `Ausgabe öffnen: ${description}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Eintrag bearbeiten" });
    await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveText("Automatisch");
    await expect(dialog.getByRole("status")).toContainText("Gesundheit");
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  }
});

test("the same member's devices sync completions saved during a slow sync and reopened to-dos", async ({ browser }) => {
  const mobileContext = await browser.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const mobile = await mobileContext.newPage(), desktop = await desktopContext.newPage();
  const descriptions = [`Apotheke ${crypto.randomUUID()}`, `Arzt ${crypto.randomUUID()}`];
  let releasePull = () => {};
  const heldPull = new Promise<void>((resolve) => { releasePull = resolve; });
  let notifyPull = () => {};
  const pullStarted = new Promise<void>((resolve) => { notifyPull = resolve; });
  const todo = (page: Page, description: string) => page.getByRole("listitem").filter({ hasText: description }).getByRole("checkbox");
  try {
    await signIn(mobile);
    for (const description of descriptions) {
      await add(mobile, description);
      await expect(mobile.getByRole("status")).toHaveText("Auf dem neuesten Stand");
    }
    await signIn(desktop);
    for (const page of [mobile, desktop]) {
      await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
      for (const description of descriptions) await expect(todo(page, description)).not.toBeChecked();
    }

    await mobile.clock.install();
    let pulls = 0;
    await mobile.route("**/api/sync?*", async (route) => {
      if (++pulls !== 2) return route.continue();
      const response = await route.fetch();
      notifyPull();
      await heldPull;
      await route.fulfill({ response });
    });

    await mobile.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await mobile.getByRole("button", { name: "Jetzt synchronisieren" }).click();
    await mobile.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await pullStarted;
    for (const description of descriptions) {
      await todo(mobile, description).click();
      await expect(todo(mobile, description)).toBeChecked();
    }
    // Let the save debounce fire while the final pull is still in flight.
    await mobile.clock.runFor(1_000);
    releasePull();
    await expect(mobile.getByRole("status")).toHaveText("Auf dem neuesten Stand");

    await desktop.evaluate(() => window.dispatchEvent(new Event("focus")));
    for (const description of descriptions) await expect(todo(desktop, description)).toBeChecked();
    await desktop.reload();
    await desktop.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
    for (const description of descriptions) await expect(todo(desktop, description)).toBeChecked();

    await desktopContext.setOffline(true);
    await todo(desktop, descriptions[0]).click();
    await expect(todo(desktop, descriptions[0])).not.toBeChecked();
    await desktopContext.setOffline(false);
    await expect(desktop.getByRole("status")).toHaveText("Auf dem neuesten Stand");
    await mobile.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(todo(mobile, descriptions[0])).not.toBeChecked();
    await expect(todo(mobile, descriptions[1])).toBeChecked();
  } finally {
    releasePull();
    await mobileContext.close();
    await desktopContext.close();
  }
});

for (const change of ["insurance completion", "deletion"]) {
  test(`a stale expense form cannot overwrite another member's ${change}`, async ({ browser }) => {
    const aContext = await browser.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" });
    const bContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const a = await aContext.newPage(), b = await bContext.newPage();
    const description = `Apotheke ${crypto.randomUUID()}`;
    const expense = (page: Page) => page.locator(".expense-row").filter({ hasText: description });
    const todo = (page: Page) => page.getByRole("listitem").filter({ hasText: description });
    try {
      await signIn(a);
      await add(a, description);
      await expect(a.getByRole("status")).toHaveText("Auf dem neuesten Stand");
      await signIn(b, "B");
      await expense(a).click();
      const stale = a.getByRole("dialog", { name: "Eintrag bearbeiten" });
      await stale.getByLabel("Beschreibung", { exact: true }).fill(`Stale ${description}`);

      if (change === "insurance completion") {
        await b.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
        await todo(b).getByRole("checkbox").click();
        await expect(todo(b).getByRole("checkbox")).toBeChecked();
      } else {
        await expense(b).click();
        await b.getByRole("button", { name: "Eintrag löschen", exact: true }).click();
        await confirmAction(b, "Eintrag löschen");
        await expect(expense(b)).toHaveCount(0);
      }
      await expect(b.getByRole("status")).toHaveText("Auf dem neuesten Stand");
      const pulled = a.waitForResponse((response) => response.url().includes("/api/sync?") && response.request().method() === "GET");
      await a.evaluate(() => window.dispatchEvent(new Event("focus")));
      await pulled;
      await expect(a.locator(".sync-status")).toHaveText("Auf dem neuesten Stand");
      await stale.getByRole("button", { name: "Speichern", exact: true }).click();
      await expect(stale.getByRole("alert")).toHaveText("Diese Ausgabe wurde geändert. Öffne sie erneut, bevor du speicherst.");
      await stale.getByRole("button", { name: "Schließen", exact: true }).click();

      for (const page of [a, b]) {
        await page.reload();
        await expect(page.getByRole("status")).toHaveText("Auf dem neuesten Stand");
        if (change === "deletion") await expect(expense(page)).toHaveCount(0);
        else await expect(expense(page)).toBeVisible();
        await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
        if (change === "deletion") await expect(todo(page)).toHaveCount(0);
        else await expect(todo(page).getByRole("checkbox")).toBeChecked();
        await expect(page.getByText(`Stale ${description}`, { exact: true })).toHaveCount(0);
      }
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });
}
