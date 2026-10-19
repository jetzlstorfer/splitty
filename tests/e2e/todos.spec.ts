import { expect, test, type Page } from "@playwright/test";

async function add(page: Page, description: string) {
  await page.locator(".add-button").click();
  const dialog = page.getByRole("dialog", { name: "Ausgabe hinzufügen" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("20,00");
  await dialog.getByLabel("Datum", { exact: true }).fill("2026-10-01");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("doctor and pharmacy expenses create insurance to-dos that can be checked off", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("button")).toHaveText([/Ausgaben/, /To-dos/, /Suche/, /Statistik/, /Einstellungen/]);
  await add(page, "Apotheke");
  await add(page, "Arzt Dr. Huber");
  await add(page, "Billa");

  await nav.getByRole("button", { name: "To-dos" }).click();
  await expect(page.getByRole("heading", { name: /^To-dos/, level: 1 })).toContainText("2");
  const open = page.getByRole("region", { name: "Offene To-dos" });
  await expect(open.getByRole("heading")).toHaveCount(0);
  await expect(open.locator(".section-title")).toHaveCount(0);
  await expect(open.getByRole("listitem")).toHaveCount(2);
  await expect(open.getByRole("listitem").first()).toContainText("Bei Versicherung einreichen");
  await expect(open).toContainText("Ausgabe: Apotheke");
  await expect(open).toContainText("Ausgabe: Arzt Dr. Huber");
  await expect(page.getByText("Billa")).toHaveCount(0);

  await open.getByRole("listitem").filter({ hasText: "Apotheke" }).getByRole("checkbox").click();
  const done = page.getByRole("region", { name: "Erledigt" });
  await expect(done.getByRole("heading", { level: 2 })).toHaveText("Erledigt1");
  await expect(page.getByRole("heading", { name: /^To-dos/, level: 1 })).toContainText("1");
  await expect(done.getByRole("checkbox")).toBeChecked();
  await expect(done).toContainText("Ausgabe: Apotheke");
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
    await expect(open).toContainText(`Ausgabe: ${description}`);
    await page.getByRole("button", { name: `To-do-Aktionen: ${description}`, exact: true }).click();
    await page.getByRole("button", { name: `Ausgabe öffnen: ${description}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Eintrag bearbeiten" });
    await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("auto");
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
  async function signIn(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
    await page.getByLabel("Mitglieds-Token").fill("A".repeat(43));
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Auf dem neuesten Stand");
    await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  }
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
    await mobile.getByRole("button", { name: "Geräte synchronisieren" }).click();
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
