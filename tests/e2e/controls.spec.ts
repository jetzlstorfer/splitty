import { expect, test, type Page } from "./fixtures";
import { chooseOption, confirmAction } from "./controls";
import { useEnglish } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "Sign in to sync" } }));
});

async function english(page: Page, theme = "light") {
  await page.goto(`/?scoutTheme=${theme}`);
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
}

async function expense(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  return page.getByRole("dialog", { name: "Add an expense", exact: true });
}

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const dialog of await page.locator("dialog[open]").all()) {
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
}

test.describe("touch controls", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const section of [
    { kind: "expense", row: ".expense-row", dialog: "Edit entry", text: "Row focus expense", actions: "Entry actions: Row focus expense" },
    { kind: "manual to-do", row: ".todo-details", dialog: "Edit to-do", text: "Row focus todo", actions: "To-do actions: Row focus todo", checkbox: "Row focus todo" },
    { kind: "insurance to-do", row: ".todo-details", dialog: "Edit entry", text: "Doctor focus", actions: "To-do actions: Doctor focus", checkbox: "Submit to insurance: Doctor focus" }
  ]) {
    test(`closing ${section.kind} sheets leaves no native row outline and preserves keyboard focus`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await useEnglish(page);
      if (section.kind !== "manual to-do") {
        await page.getByRole("button", { name: "Add expense", exact: true }).tap();
        const form = page.getByRole("dialog", { name: "Add an expense", exact: true });
        await form.getByLabel("Description", { exact: true }).fill(section.text);
        await form.getByLabel("Amount in EUR", { exact: true }).fill("20");
      } else {
        await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).tap();
        await page.getByRole("button", { name: "Add to-do", exact: true }).tap();
        await page.getByLabel("Title", { exact: true }).fill(section.text);
      }
      await page.getByRole("button", { name: "Save", exact: true }).tap();
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 15_000 });
      if (section.kind === "insurance to-do") await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).tap();

      const row = page.locator(section.row);
      const content = page.locator(".swipe-content");
      const edit = page.getByRole("dialog", { name: section.dialog, exact: true });
      const actions = page.getByRole("button", { name: section.actions, exact: true });
      for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await row.tap();
          await expect(edit).toBeVisible();
          await edit.getByRole("button", { name: "Close", exact: true }).tap();
          await expect(edit).not.toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-input-mode", "pointer");
          await expect(content).toHaveCSS("outline-style", "none");
          await expect(row).toHaveCSS("outline-style", "none");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

          await row.focus();
          await page.keyboard.press("Tab");
          await expect(actions).toBeFocused();
          await content.focus();
          await expect(content).toBeFocused();
          await expect.poll(() => content.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          await expect(content).toHaveCSS("outline-style", "none");

          await row.focus();
          await page.keyboard.press("Enter");
          await expect(page.locator("html")).toHaveAttribute("data-input-mode", "keyboard");
          await expect(edit).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(edit).not.toBeVisible();
          await expect(row).toBeFocused();
          await expect(row).toHaveCSS("outline-style", "solid");
          await expect(row).toHaveCSS("outline-width", "3px");
          await page.keyboard.press("Tab");
          await expect(actions).toBeFocused();
          if (section.checkbox) await expect(page.getByRole("checkbox", { name: section.checkbox, exact: true })).not.toBeChecked();
        }
      }
    });
  }

  for (const theme of ["light", "dark"]) for (const width of [320, 393, 1280]) {
    test(`${theme} app controls at ${width}px never open native pickers or confirmations`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const nativeDialogs: string[] = [];
      page.on("dialog", async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
      await english(page, theme);
      const background = theme === "light" ? "rgb(255, 255, 255)" : "rgb(28, 37, 36)";
      await page.getByLabel("This device belongs to").tap();
      await expect(page.locator(".control-dialog")).toHaveCSS("background-color", background);
      await fits(page);
      await page.getByRole("option").nth(1).tap();
      await expect(page.getByLabel("This device belongs to")).toHaveText("Your spouse");

      const form = await expense(page);
      await form.getByLabel("Description", { exact: true }).fill("Themed groceries");
      await form.getByLabel("Amount in EUR", { exact: true }).fill("12");
      const payers = form.getByRole("group", { name: "Paid by", exact: true });
      const first = payers.getByRole("radio").nth(0);
      const second = payers.getByRole("radio").nth(1);
      await expect(second).toBeChecked();
      await first.tap();
      await expect(first).toBeChecked();
      await expect(second).not.toBeChecked();
      await second.tap();
      await expect(second).toBeChecked();
      await expect(page.locator(".control-dialog")).toHaveCount(0);
      const left = await payers.locator("label").nth(0).boundingBox();
      const right = await payers.locator("label").nth(1).boundingBox();
      expect(left!.y).toBe(right!.y);
      expect(left!.width).toBeCloseTo(right!.width, 0);
      expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
      expect(left!.height).toBeGreaterThanOrEqual(48);
      await second.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(first).toBeFocused();
      await expect(first).toBeChecked();
      await page.keyboard.press("ArrowRight");
      await expect(second).toBeFocused();
      await expect(second).toBeChecked();
      await fits(page);
      await page.screenshot({ path: info.outputPath(`expense-${theme}-${width}.png`) });
      await form.getByLabel("Date", { exact: true }).fill("2026-03-31");
      await form.getByRole("button", { name: "Choose date", exact: true }).tap();
      const calendar = page.getByRole("dialog", { name: "Choose date", exact: true });
      await expect(calendar).toHaveCSS("background-color", background);
      await expect(calendar.getByRole("gridcell", { name: "Tuesday 31 March 2026" })).toHaveAttribute("aria-selected", "true");
      await calendar.getByRole("button", { name: "Next month", exact: true }).tap();
      await expect(calendar.getByRole("heading", { name: "April 2026" })).toBeVisible();
      await fits(page);
      await page.screenshot({ path: info.outputPath(`calendar-${theme}-${width}.png`) });
      await calendar.getByRole("gridcell", { name: "Thursday 30 April 2026" }).tap();
      await expect(form.getByLabel("Date", { exact: true })).toHaveValue("2026-04-30");
      await form.getByLabel("Category", { exact: true }).tap();
      await expect(page.getByRole("option", { name: "Automatic", exact: true })).toHaveAttribute("aria-selected", "true");
      await fits(page);
      await page.getByRole("option", { name: "Groceries", exact: true }).tap();
      await expect(form.getByLabel("Category", { exact: true })).toHaveText("Groceries");
      await form.getByRole("button", { name: /Split equally/ }).tap();
      await expect(form.getByRole("radio", { name: "Equally · 50/50" })).toHaveCSS("appearance", "none");
      await form.getByRole("radio", { name: "I owe the full amount" }).check();
      await form.getByRole("button", { name: "Save", exact: true }).tap();
      await expect(form).not.toBeVisible();

      await page.getByText("Themed groceries", { exact: true }).tap();
      const edit = page.getByRole("dialog", { name: "Edit entry", exact: true });
      await expect(edit.getByLabel("Date", { exact: true })).toHaveValue("2026-04-30");
      await expect(edit.getByLabel("Category", { exact: true })).toHaveText("Groceries");
      await edit.getByRole("button", { name: "Delete entry", exact: true }).tap();
      const confirmation = page.locator(".control-dialog");
      await expect(confirmation).toContainText("Delete this entry for both of you?");
      await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await expect(confirmation).toHaveCSS("background-color", background);
      await fits(page);
      await confirmAction(page, "Cancel");
      await expect(edit.getByRole("button", { name: "Delete entry", exact: true })).toBeFocused();
      await edit.getByRole("button", { name: "Close", exact: true }).tap();
      await expect(page.getByText("Themed groceries", { exact: true })).toBeVisible();

      await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).tap();
      await page.getByRole("button", { name: "Add to-do", exact: true }).tap();
      await page.getByLabel("Title", { exact: true }).fill("Themed task");
      await page.getByRole("button", { name: "Save", exact: true }).tap();
      const checkbox = page.getByRole("checkbox", { name: "Themed task", exact: true });
      await expect(checkbox).toHaveCSS("appearance", "none");
      await checkbox.tap();
      await expect(checkbox).toBeChecked();
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).not.toBeChecked();
      await fits(page);
      await expect(page.locator('select, input[type="date"]')).toHaveCount(0);
      expect(nativeDialogs).toEqual([]);
    });
  }
});

for (const language of ["en", "de"] as const) {
  test(`description Next and amount Done save without visiting the date in ${language}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 10, 1, 12));
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    const de = language === "de";
    await page.getByRole("button", { name: de ? "Ausgabe hinzufügen" : "Add expense", exact: true }).click();
    const form = page.getByRole("dialog", { name: de ? "Ausgabe hinzufügen" : "Add an expense", exact: true });
    const description = form.getByLabel(de ? "Beschreibung" : "Description", { exact: true });
    const amount = form.getByLabel(de ? "Betrag in EUR" : "Amount in EUR", { exact: true });
    await expect(description).toHaveAttribute("enterkeyhint", "next");
    await expect(amount).toHaveAttribute("enterkeyhint", "done");
    await description.fill("Quick groceries");
    await description.press("Enter");
    await expect(amount).toBeFocused();
    await expect(form).toBeVisible();
    await amount.fill("0");
    await amount.press("Enter");
    await expect(form.getByRole("alert")).toContainText(de ? "größer als null" : "greater than zero");
    await amount.fill(de ? "24,50" : "24.50");
    await amount.press("Enter");
    await expect(form).not.toBeVisible();
    await expect(page.getByText("Quick groceries", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByText("Quick groceries", { exact: true }).click();
    const edit = page.getByRole("dialog", { name: de ? "Eintrag bearbeiten" : "Edit entry", exact: true });
    await expect(edit.getByLabel(de ? "Datum" : "Date", { exact: true })).toHaveValue("2026-11-01");
    await expect(edit.getByLabel(de ? "Betrag in EUR" : "Amount in EUR", { exact: true })).toHaveValue(de ? "24,50" : "24.50");
    await expect(edit.getByRole("group", { name: de ? "Bezahlt von" : "Paid by" }).getByRole("radio").nth(0)).toBeChecked();
  });
}

test("amount Done still validates custom shares and preserves an edited date and payer", async ({ page }) => {
  await english(page);
  const form = await expense(page);
  await form.getByLabel("Description", { exact: true }).fill("Custom groceries");
  const amount = form.getByLabel("Amount in EUR", { exact: true });
  await amount.fill("20");
  await form.getByRole("group", { name: "Paid by" }).getByRole("radio").nth(1).check();
  await form.getByLabel("Date", { exact: true }).fill("2026-10-12");
  await form.getByRole("button", { name: /Split equally/ }).click();
  await form.getByRole("radio", { name: "By exact amount" }).check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Please fill out this field.");
  await expect(form.getByLabel("Your share (EUR)")).toBeFocused();
  await amount.press("Enter");
  await expect(form.getByRole("alert")).toHaveText("Please fill out this field.");
  await expect(form.getByLabel("Your share (EUR)")).toBeFocused();
  await form.getByLabel("Your share (EUR)").fill("5");
  await amount.press("Enter");
  await expect(form).not.toBeVisible();
  await page.getByText("Custom groceries", { exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit entry", exact: true });
  await expect(edit.getByLabel("Date", { exact: true })).toHaveValue("2026-10-12");
  await expect(edit.getByRole("group", { name: "Paid by" }).getByRole("radio").nth(1)).toBeChecked();
  await edit.getByRole("button", { name: /Custom split/ }).click();
  await expect(edit.getByLabel("Your share (EUR)")).toHaveValue("5.00");
});

test("keyboard selection, calendar arithmetic, validation and nested dismissal preserve the form", async ({ page }) => {
  await english(page);
  const form = await expense(page);
  await expect(form.locator("form")).toHaveAttribute("novalidate", "");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Please fill out this field.");
  await expect(form.getByLabel("Description", { exact: true })).toBeFocused();
  await form.getByLabel("Description", { exact: true }).fill("Keyboard groceries");
  await form.getByLabel("Amount in EUR", { exact: true }).fill("10");
  const date = form.getByLabel("Date", { exact: true });
  await date.fill("2026-02-30");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter a valid date.");
  await expect(date).toBeFocused();
  await date.fill("2024-02-29");
  const opener = form.getByRole("button", { name: "Choose date", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  let cell = page.getByRole("gridcell", { name: "Thursday 29 February 2024" });
  await expect(cell).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(page.getByRole("gridcell", { name: "Friday 29 March 2024" })).toBeFocused();
  await page.keyboard.press("PageUp");
  await expect(cell).toBeFocused();
  await page.keyboard.press("ArrowRight");
  cell = page.getByRole("gridcell", { name: "Friday 1 March 2024" });
  await expect(cell).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(date).toHaveValue("2024-03-01");
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await expect(opener).toBeFocused();

  const category = form.getByLabel("Category", { exact: true });
  await category.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Automatic", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("option").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "Automatic", exact: true })).toBeFocused();
  await page.keyboard.type("gro");
  await expect(page.getByRole("option", { name: "Groceries", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(category).toHaveText("Groceries");
  await expect(category).toBeFocused();
  await category.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(category).toHaveText("Groceries");
  await expect(category).toBeFocused();
  await category.click();
  await page.mouse.click(2, 2);
  await expect(page.locator(".control-dialog")).not.toBeVisible();
  await expect(form.getByLabel("Description", { exact: true })).toHaveValue("Keyboard groceries");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).not.toBeVisible();

  await page.getByRole("button", { name: "Entry actions: Keyboard groceries", exact: true }).click();
  const remove = page.getByRole("button", { name: "Delete entry: Keyboard groceries", exact: true });
  await remove.click();
  await page.keyboard.press("Escape");
  await expect(remove).toBeFocused();
  await remove.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(".control-dialog").getByRole("button", { name: "Delete entry", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Keyboard groceries", { exact: true })).toHaveCount(0);
});

test("German calendar and validation are localized and Today selects the local date", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 28, 12));
  await page.goto("/");
  await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Ausgabe hinzufügen", exact: true });
  await form.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Bitte fülle dieses Feld aus.");
  await form.getByLabel("Datum", { exact: true }).fill("2026-02-01");
  await form.getByRole("button", { name: "Datum auswählen", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "Datum auswählen", exact: true });
  await expect(calendar.getByRole("columnheader").first()).toHaveAttribute("aria-label", "Montag");
  await expect(calendar.getByRole("heading", { name: "Februar 2026" })).toBeVisible();
  await calendar.getByRole("button", { name: "Heute", exact: true }).click();
  await expect(form.getByLabel("Datum", { exact: true })).toHaveValue("2026-10-28");
  await expect(form.getByRole("button", { name: "Datum auswählen", exact: true })).toBeFocused();
});

test("import mapping and cancellable restore use app controls without changing source text", async ({ page }) => {
  await english(page);
  await page.getByRole("navigation").getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const csv = "Date,Description,Category,Cost,Currency,Alex,Sam\n2026-10-01,Original description,General,10.00,EUR,5.00,-5.00";
  await page.getByLabel("Splitwise CSV", { exact: true }).setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const mapping = page.getByLabel("Export column for You", { exact: true });
  await chooseOption(page, mapping, "Sam");
  await expect(mapping).toHaveText("Sam");
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 new entry", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm import", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.getByText("Original description", { exact: true })).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search expenses", exact: true });
  await search.fill("Original");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();

  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  const backup = {
    format: "splitty-v2", entries: [], todos: [{
      id: "synthetic-restore-task", title: "Restored task", description: "", done: false,
      revision: 0, deleted: false, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z"
    }]
  };
  const file = { name: "synthetic-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) };
  const restore = page.getByLabel("Restore missing entries from a backup");
  await restore.setInputFiles(file);
  await expect(page.locator(".control-dialog")).toContainText("Restore 0 missing entries and 1 missing to-dos?");
  await confirmAction(page, "Cancel");
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await expect(page.getByText("Restored task", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await restore.setInputFiles(file);
  await confirmAction(page, "Restore backup");
  await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
  await expect(page.getByText("Restored task", { exact: true })).toBeVisible();
});
