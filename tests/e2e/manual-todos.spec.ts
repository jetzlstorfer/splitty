import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "./fixtures";
import { failNextConflictResolution, signIn as signInMember, synchronize as sync, upToDate } from "./helpers";
import { chooseOption, confirmAction } from "./controls";

const row = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
const todos = (page: Page) => page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();

async function signIn(page: Page, member: "A" | "B") {
  await page.goto("/");
  await signInMember(page, member);
  await todos(page);
}

async function add(page: Page, title: string, description = "") {
  await page.getByRole("button", { name: "To-do hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "To-do hinzufügen" });
  await dialog.getByLabel("Titel", { exact: true }).fill(title);
  await dialog.getByLabel("Beschreibung (optional)").fill(description);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function addInsuranceExpense(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Ausgaben", exact: true }).click();
  await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Apotheke");
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("20");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await todos(page);
}

async function edit(page: Page, title: string, next: string, description: string) {
  await page.getByRole("button", { name: `To-do-Aktionen: ${title}`, exact: true }).click();
  await page.getByRole("button", { name: `To-do bearbeiten: ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "To-do bearbeiten" });
  await dialog.getByLabel("Titel", { exact: true }).fill(next);
  await dialog.getByLabel("Beschreibung (optional)").fill(description);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function toggle(page: Page, title: string, done: boolean) {
  await row(page, title).getByRole("checkbox").click();
  await expect(row(page, title).getByRole("checkbox")).toBeChecked({ checked: done });
}

async function remove(page: Page, title: string) {
  await page.getByRole("button", { name: `To-do-Aktionen: ${title}`, exact: true }).click();
  await page.getByRole("button", { name: `To-do bearbeiten: ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "To-do löschen", exact: true }).click();
  await confirmAction(page, "To-do löschen");
  await expect(row(page, title)).toHaveCount(0);
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`no open todos invites you to enjoy your day with motion: ${reducedMotion}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    await todos(page);
    const clear = page.locator(".todo-clear-state");
    await expect(clear.getByRole("heading", { level: 2 })).toHaveText("Alles erledigt!");
    await expect(clear).toContainText("Nichts mehr zu erledigen. Genieß deinen Tag.");
    await expect(clear.locator(".todo-clear-hint")).toBeVisible();
    await expect(clear).toHaveCSS("animation-name", reducedMotion === "reduce" ? "none" : "fade-in");

    await add(page, "Call dentist");
    await expect(clear).toHaveCount(0);
    await page.getByRole("navigation").getByRole("button", { name: "Ausgaben", exact: true }).click();
    await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Beschreibung", { exact: true }).fill("Apotheke");
    await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("20");
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await todos(page);
    await expect(page.locator(".entry-count")).toHaveText("2");
    await row(page, "Call dentist").getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(row(page, "Call dentist").getByRole("checkbox")).toBeChecked();
    await expect(page.locator(".entry-count")).toHaveText("1");
    await expect(clear).toHaveCount(0);
    await page.getByRole("listitem").filter({ hasText: "Apotheke" }).getByRole("checkbox").click();
    await expect(page.getByRole("listitem").filter({ hasText: "Apotheke" }).getByRole("checkbox")).toBeChecked();
    await expect(clear).toBeVisible();
    await expect(clear.locator(".todo-clear-hint")).toHaveCount(0);
    await expect(page.locator(".entry-count")).toHaveText("0");
    await expect(page.getByRole("region", { name: "Erledigt", exact: true }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Offene To-dos", exact: true })).toHaveCount(0);
    await expect(clear.locator("..")).toHaveAttribute("aria-live", "polite");

    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await expect(clear).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const message = (await clear.boundingBox())!;
        const done = (await page.getByRole("region", { name: "Erledigt", exact: true }).boundingBox())!;
        expect(done.y).toBeGreaterThanOrEqual(message.y + message.height);
        if (width === 393) await page.screenshot({ path: info.outputPath(`todos-clear-${theme}.png`) });
      }
    }

    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
    await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
    await todos(page);
    await expect(clear.getByRole("heading", { level: 2 })).toHaveText("All caught up!");
    await expect(clear).toContainText("Nothing left to chase. Enjoy your day.");
    await row(page, "Call dentist").getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(clear).toHaveCount(0);
    await toggle(page, "Call dentist", true);
    await expect(clear).toBeVisible();
    await page.reload();
    await todos(page);
    await expect(clear).toContainText("Nothing left to chase. Enjoy your day.");
    await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("checkbox")).toHaveCount(2);
  });
}

test("todo and expense add buttons share their floating position, styling, and keyboard behavior", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const nav = page.getByRole("navigation");
  const action = page.locator(".add-button");
  const geometry = () => action.evaluate((element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { right: rect.right, bottom: rect.bottom, height: rect.height, background: style.backgroundColor, radius: style.borderRadius };
  });
  for (const [width, height] of [[320, 740], [393, 851], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await nav.getByRole("button", { name: "Ausgaben", exact: true }).click();
      await expect(action).toHaveAccessibleName("Ausgabe hinzufügen");
      const expense = await geometry();
      await todos(page);
      await expect(action).toHaveAccessibleName("To-do hinzufügen");
      expect(await geometry()).toEqual(expense);
      await expect(page.locator(".todos-page .page-heading button")).toHaveCount(0);
      expect(await page.locator("main").evaluate((element) => getComputedStyle(element).paddingBottom)).toBe("152px");
      const navTop = await nav.evaluate((element) => element.getBoundingClientRect().top);
      expect(expense.bottom).toBeLessThanOrEqual(navTop);
    }
  }
  await action.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "To-do hinzufügen" });
  await expect(dialog.getByLabel("Titel", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(action).toBeFocused();
  for (const tab of ["Suche", "Statistik", "Einstellungen"]) {
    await nav.getByRole("button", { name: tab, exact: true }).click();
    await expect(action).toHaveCount(0);
  }
});

test("todo rows match expense text and column alignment in both themes", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await todos(page);
  await add(page, "Call dentist", "Shared household details");
  await addInsuranceExpense(page);
  const geometry = (item: Locator) => item.evaluate((element) => {
    const icon = element.querySelector(".entry-icon")!.getBoundingClientRect();
    const title = element.querySelector(".entry-description strong")!;
    const titleStyle = getComputedStyle(title);
    const subtitleStyle = getComputedStyle(element.querySelector(".entry-description small")!);
    return {
      height: element.getBoundingClientRect().height, iconX: icon.x, iconWidth: icon.width, iconHeight: icon.height,
      textX: title.getBoundingClientRect().x, color: titleStyle.color, fontSize: titleStyle.fontSize,
      fontWeight: titleStyle.fontWeight, lineHeight: titleStyle.lineHeight,
      subtitleColor: subtitleStyle.color, subtitleSize: subtitleStyle.fontSize
    };
  });
  const manual = row(page, "Call dentist");
  const insurance = page.getByRole("listitem").filter({ hasText: "Ausgabe: Apotheke" });

  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole("navigation").getByRole("button", { name: "Ausgaben", exact: true }).click();
      const expense = page.locator(".expense-row");
      const expected = await geometry(expense);
      const date = (await expense.locator(".date-block").boundingBox())!;
      expect(expected.color).toBe(await page.locator("body").evaluate((element) => getComputedStyle(element).color));
      await todos(page);

      for (const item of [manual, insurance]) {
        expect(await geometry(item.locator(".todo-row"))).toEqual(expected);
        const checkbox = (await item.getByRole("checkbox").boundingBox())!;
        expect(checkbox.x + checkbox.width / 2).toBeCloseTo(date.x + date.width / 2, 1);
        expect(checkbox.height).toBe(22);
        await expect(item.getByRole("checkbox")).not.toBeChecked();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 393) await page.screenshot({ path: info.outputPath(`todo-rows-${theme}.png`) });
    }
  }
});

test("todo content opens details while only the checkbox completes or reopens it", async ({ page }) => {
  await page.goto("/");
  await todos(page);
  await add(page, "Call dentist", "Shared household details");
  await addInsuranceExpense(page);
  const items = [
    { item: row(page, "Call dentist"), dialogName: "To-do bearbeiten", field: "Titel", value: "Call dentist" },
    { item: page.getByRole("listitem").filter({ hasText: "Ausgabe: Apotheke" }), dialogName: "Eintrag bearbeiten", field: "Beschreibung", value: "Apotheke" }
  ];
  for (const { item, dialogName, field, value } of items) {
    const details = item.locator(".todo-details");
    const checkbox = item.getByRole("checkbox");
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(checkbox).toHaveAccessibleName(value === "Apotheke" ? "Bei Versicherung einreichen: Apotheke" : value);
    for (const done of [false, true]) {
      for (const target of [item.locator(".entry-icon"), item.locator(".entry-description strong"), item.locator(".entry-description small")]) {
        await target.click();
        await expect(dialog.getByLabel(field, { exact: true })).toHaveValue(value);
        await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
        await expect(details).toBeFocused();
        await expect(checkbox).toBeChecked({ checked: done });
      }
      for (const key of ["Enter", "Space"]) {
        await details.focus();
        await page.keyboard.press(key);
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(details).toBeFocused();
        await expect(checkbox).toBeChecked({ checked: done });
      }
      await details.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(checkbox).toBeFocused();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked({ checked: !done });
      await expect(dialog).not.toBeVisible();
    }
    const label = item.locator(".todo-check");
    await label.click({ position: { x: 1, y: 1 } });
    await expect(checkbox).toBeChecked();
    await label.click({ position: { x: 1, y: 1 } });
    await expect(checkbox).not.toBeChecked();
    await expect(dialog).not.toBeVisible();
  }
  await page.reload();
  await todos(page);
  await expect(page.getByRole("region", { name: "Offene To-dos" }).getByRole("checkbox")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Erledigt", exact: true })).toHaveCount(0);
});

test("the floating todo button stays above navigation without covering the last item", async ({ page }) => {
  await page.goto("/");
  await todos(page);
  for (let i = 0; i < 8; i++) await add(page, `Task ${i}`, "Shared household details");
  for (const [width, height] of [[320, 740], [393, 851], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator(".add-button")).toBeInViewport();
    const lastRow = page.getByRole("listitem").last();
    const rowBottom = await lastRow.evaluate((element) => element.getBoundingClientRect().bottom);
    const actionTop = await page.locator(".expense-action").evaluate((element) => element.getBoundingClientRect().top);
    expect(rowBottom).toBeLessThanOrEqual(actionTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("manual todos persist with optional descriptions and leave expenses unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await todos(page);
  await add(page, "Call dentist");
  await add(page, "Buy supplies", "Milk\nCoffee");
  await expect(row(page, "Buy supplies")).toContainText("Milk\nCoffee");
  await expect(page.getByRole("heading", { name: /^To-dos/, level: 1 })).toContainText("2");
  await toggle(page, "Call dentist", true);
  await page.reload();
  await todos(page);
  await expect(row(page, "Call dentist").getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("heading", { name: /^To-dos/, level: 1 })).toContainText("1");
  await edit(page, "Buy supplies", "Buy supplies", "");
  await expect(row(page, "Buy supplies").locator("small")).toHaveCount(0);

  await page.getByRole("button", { name: "To-do hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "To-do hinzufügen" });
  await dialog.getByLabel("Titel", { exact: true }).fill(" ");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("höchstens 200 Zeichen");
  await expect(dialog.getByLabel("Titel", { exact: true })).toHaveAttribute("maxlength", "200");
  await expect(dialog.getByLabel("Beschreibung (optional)")).toHaveAttribute("maxlength", "2000");
  await dialog.getByLabel("Titel", { exact: true }).fill("a".repeat(200));
  await dialog.getByLabel("Beschreibung (optional)").fill("b".repeat(2000));
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row(page, "a".repeat(200))).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Ausgaben", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gemeinsam. Fair geteilt.", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Haushaltssaldo" })).toContainText("Alles ausgeglichen");
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache"), "English");
  await todos(page);
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add to-do" }).getByLabel("Description (optional)")).toBeVisible();
});

test("both household members share offline creation, edits, completion, reopening, and deletion", async ({ browser }) => {
  const aContext = await browser.newContext({ serviceWorkers: "block" });
  const bContext = await browser.newContext({ serviceWorkers: "block" });
  const a = await aContext.newPage(), b = await bContext.newPage();
  const title = `Household ${crypto.randomUUID()}`, edited = `${title} edited`;
  try {
    await signIn(a, "A");
    await signIn(b, "B");
    await aContext.setOffline(true);
    await add(a, title, "Created offline");
    await expect(row(a, title)).toContainText("Created offline");
    await aContext.setOffline(false);
    await upToDate(a);
    await sync(b);
    await expect(row(b, title)).toContainText("Created offline");
    await edit(b, title, edited, "Updated by the other member");
    await upToDate(b);
    await sync(a);
    await expect(row(a, edited)).toContainText("Updated by the other member");
    await toggle(b, edited, true);
    await upToDate(b);
    await sync(a);
    await expect(row(a, edited).getByRole("checkbox")).toBeChecked();
    await aContext.setOffline(true);
    await toggle(a, edited, false);
    await aContext.setOffline(false);
    await upToDate(a);
    await sync(b);
    await expect(row(b, edited).getByRole("checkbox")).not.toBeChecked();
    await remove(b, edited);
    await upToDate(b);
    await sync(a);
    await expect(row(a, edited)).toHaveCount(0);
    await a.reload();
    await todos(a);
    await expect(row(a, edited)).toHaveCount(0);
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("todo conflicts show both versions and allow keeping local edits or remote deletions", async ({ browser }) => {
  const aContext = await browser.newContext({ serviceWorkers: "block" });
  const bContext = await browser.newContext({ serviceWorkers: "block" });
  const a = await aContext.newPage(), b = await bContext.newPage();
  const title = `Conflict ${crypto.randomUUID()}`;
  try {
    await signIn(a, "A");
    await add(a, title, "Original");
    await upToDate(a);
    await signIn(b, "B");
    await aContext.setOffline(true);
    await edit(a, title, title, "Local details");
    await edit(b, title, title, "Remote details");
    await upToDate(b);
    await aContext.setOffline(false);
    await a.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    const conflict = a.getByRole("region", { name: "Widersprüchliche To-do-Änderungen" });
    await expect(conflict).toContainText("Local details");
    await expect(conflict).toContainText("Remote details");
    await expect(row(a, title).getByRole("checkbox")).toBeDisabled();
    await expect(row(a, title).locator(".todo-details")).toBeDisabled();
    await expect(row(a, title).getByRole("button", { name: `To-do-Aktionen: ${title}` })).toBeDisabled();
    await failNextConflictResolution(a, "todoConflicts");
    await conflict.getByRole("button", { name: "Diese Version behalten" }).click();
    await expect(a.locator(".sync-popover").getByRole("alert")).toHaveText("Ein unerwarteter Fehler ist aufgetreten. Deine gespeicherten Einträge bleiben auf diesem Gerät.");
    await expect(conflict).toBeVisible();
    await conflict.getByRole("button", { name: "Diese Version behalten" }).click();
    await upToDate(a);
    await expect(a.locator(".sync-popover").getByRole("alert")).toHaveCount(0);
    await expect(a.getByRole("button", { name: "Synchronisierungsstatus" })).not.toHaveClass(/needs-attention/);
    await a.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await sync(b);
    await expect(row(b, title)).toContainText("Local details");

    await aContext.setOffline(true);
    await edit(a, title, title, "Another local edit");
    await remove(b, title);
    await upToDate(b);
    await aContext.setOffline(false);
    await a.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await expect(conflict).toContainText("Another local edit");
    await expect(conflict).toContainText("Gelöscht");
    await failNextConflictResolution(a, "todoConflicts");
    await conflict.getByRole("button", { name: "Andere Version behalten" }).click();
    await expect(a.locator(".sync-popover").getByRole("alert")).toHaveText("Ein unerwarteter Fehler ist aufgetreten. Deine gespeicherten Einträge bleiben auf diesem Gerät.");
    await expect(conflict).toBeVisible();
    await conflict.getByRole("button", { name: "Andere Version behalten" }).click();
    await upToDate(a);
    await expect(a.locator(".sync-popover").getByRole("alert")).toHaveCount(0);
    await expect(a.getByRole("button", { name: "Synchronisierungsstatus" })).not.toHaveClass(/needs-attention/);
    await expect(row(a, title)).toHaveCount(0);
    await expect(conflict).not.toBeVisible();
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("manual completions saved during a slow sync are sent in the next pass", async ({ browser }) => {
  const aContext = await browser.newContext({ serviceWorkers: "block" });
  const bContext = await browser.newContext({ serviceWorkers: "block" });
  const a = await aContext.newPage(), b = await bContext.newPage();
  const titles = [`Slow ${crypto.randomUUID()}`, `Slow ${crypto.randomUUID()}`];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = () => {};
  const pullStarted = new Promise<void>((resolve) => { started = resolve; });
  try {
    await signIn(a, "A");
    for (const title of titles) { await add(a, title); await upToDate(a); }
    await signIn(b, "B");
    await a.clock.install();
    let pulls = 0;
    await a.route("**/api/todo-sync?*", async (route) => {
      if (++pulls !== 2) return route.continue();
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await a.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await a.getByRole("button", { name: "Jetzt synchronisieren" }).click();
    await a.getByRole("button", { name: "Synchronisierungsstatus" }).click();
    await pullStarted;
    for (const title of titles) await toggle(a, title, true);
    await a.clock.runFor(1_000);
    release();
    await upToDate(a);
    await sync(b);
    for (const title of titles) await expect(row(b, title).getByRole("checkbox")).toBeChecked();
  } finally {
    release();
    await aContext.close();
    await bContext.close();
  }
});

test("backups round-trip manual todos including descriptions and completion", async ({ page, browser }) => {
  await page.goto("/");
  await todos(page);
  await add(page, "Backup task", "Details to preserve");
  await toggle(page, "Backup task", true);
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Sicherung herunterladen" }).click();
  const download = await downloaded;
  const contents = await readFile((await download.path())!, "utf8");
  expect(JSON.parse(contents)).toMatchObject({
    format: "splitty-v2", todos: [{ title: "Backup task", description: "Details to preserve", done: true }]
  });
  const context = await browser.newContext();
  try {
    const restored = await context.newPage();
    await restored.goto("/");
    await restored.getByRole("button", { name: "Einstellungen", exact: true }).click();
    await restored.getByLabel("Fehlende Einträge aus einer Sicherung wiederherstellen").setInputFiles({
      name: "backup.json", mimeType: "application/json", buffer: Buffer.from(contents)
    });
    await confirmAction(restored, "Backup wiederherstellen");
    await todos(restored);
    await expect(row(restored, "Backup task")).toContainText("Details to preserve");
    await expect(row(restored, "Backup task").getByRole("checkbox")).toBeChecked();
  } finally { await context.close(); }
});
