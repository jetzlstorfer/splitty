import { expect, test, type Page } from "./fixtures";
import { chooseOption, confirmAction } from "./controls";
import { useEnglish } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "Sign in to sync" } }));
});

async function english(page: Page) {
  await page.goto("/?scoutTheme=light");
  await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
}

async function mockHouseholdSync(page: Page) {
  await page.route("**/api/household/insurance-todos", (route) =>
    route.fulfill({ json: { enabled: true, revision: 0 } }));
  await page.route(/\/api\/(?:todo-)?sync\?/, (route) =>
    route.fulfill({ json: { entries: [], cursor: 0, more: false } }));
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

async function inEachTheme(page: Page, check: (theme: string, background: string) => Promise<void>) {
  for (const [theme, background] of [["light", "rgb(255, 255, 255)"], ["dark", "rgb(28, 37, 36)"]] as const) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await check(theme, background);
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

  for (const width of [320, 393, 1280]) {
    test(`app controls at ${width}px never open native pickers or confirmations in light and dark mode`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const nativeDialogs: string[] = [];
      page.on("dialog", async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
      await english(page);
      await page.getByLabel("This device belongs to").tap();
      await inEachTheme(page, async (_, background) => {
        await expect(page.locator(".control-dialog")).toHaveCSS("background-color", background);
        await fits(page);
      });
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
      await inEachTheme(page, async () => {
        const left = await payers.locator("label").nth(0).boundingBox();
        const right = await payers.locator("label").nth(1).boundingBox();
        expect(left!.y).toBe(right!.y);
        expect(left!.width).toBeCloseTo(right!.width, 0);
        expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
        expect(left!.height).toBeGreaterThanOrEqual(48);
      });
      await second.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(first).toBeFocused();
      await expect(first).toBeChecked();
      await page.keyboard.press("ArrowRight");
      await expect(second).toBeFocused();
      await expect(second).toBeChecked();
      await inEachTheme(page, async (theme) => {
        await fits(page);
        await page.screenshot({ path: info.outputPath(`expense-${theme}-${width}.png`) });
      });
      await form.getByLabel("Date", { exact: true }).fill("2026-03-31");
      await form.getByRole("button", { name: "Choose date", exact: true }).tap();
      const calendar = page.getByRole("dialog", { name: "Choose date", exact: true });
      await expect(calendar.getByRole("gridcell", { name: "Tuesday 31 March 2026" })).toHaveAttribute("aria-selected", "true");
      await calendar.getByRole("button", { name: "Next month", exact: true }).tap();
      await expect(calendar.getByRole("heading", { name: "April 2026" })).toBeVisible();
      await inEachTheme(page, async (theme, background) => {
        await expect(calendar).toHaveCSS("background-color", background);
        await fits(page);
        await page.screenshot({ path: info.outputPath(`calendar-${theme}-${width}.png`) });
      });
      await calendar.getByRole("gridcell", { name: "Thursday 30 April 2026" }).tap();
      await expect(form.getByLabel("Date", { exact: true })).toHaveValue("2026-04-30");
      await form.getByLabel("Category", { exact: true }).tap();
      await expect(page.getByRole("option", { name: "Automatic", exact: true })).toHaveAttribute("aria-selected", "true");
      await inEachTheme(page, () => fits(page));
      await page.getByRole("option", { name: "Groceries", exact: true }).tap();
      await expect(form.getByLabel("Category", { exact: true })).toHaveText("Groceries");
      await form.getByRole("button", { name: /Split equally/ }).tap();
      await inEachTheme(page, () => expect(form.getByRole("radio", { name: "Equally · 50/50" })).toHaveCSS("appearance", "none"));
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
      await inEachTheme(page, async (_, background) => {
        await expect(confirmation).toHaveCSS("background-color", background);
        await fits(page);
      });
      await confirmAction(page, "Cancel");
      await expect(edit.getByRole("button", { name: "Delete entry", exact: true })).toBeFocused();
      await edit.getByRole("button", { name: "Close", exact: true }).tap();
      await expect(page.getByText("Themed groceries", { exact: true })).toBeVisible();

      await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).tap();
      await page.getByRole("button", { name: "Add to-do", exact: true }).tap();
      await page.getByLabel("Title", { exact: true }).fill("Themed task");
      await page.getByRole("button", { name: "Save", exact: true }).tap();
      const checkbox = page.getByRole("checkbox", { name: "Themed task", exact: true });
      await inEachTheme(page, () => expect(checkbox).toHaveCSS("appearance", "none"));
      await checkbox.tap();
      await expect(checkbox).toBeChecked();
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).not.toBeChecked();
      await inEachTheme(page, () => fits(page));
      await expect(page.locator('select, input[type="date"]')).toHaveCount(0);
      expect(nativeDialogs).toEqual([]);
    });
  }

  test("signed-out household names show an edit cue and accept touch input", async ({ page }) => {
    await english(page);
    await expect(page.getByRole("region", { name: "Account", exact: true })).toContainText("Not signed in");
    const first = page.getByLabel("First person", { exact: true });
    const cues = page.locator(".settings-name-edit");
    await expect(cues).toHaveCount(2);
    await expect(page.locator(".settings-name-lock")).toHaveCount(0);
    await expect(first).toBeEditable();
    await expect(first).not.toBeFocused();

    const cue = (await cues.first().boundingBox())!;
    await page.touchscreen.tap(cue.x + cue.width / 2, cue.y + cue.height / 2);
    await expect(first).toBeFocused();

    await first.fill("Jordan");
    await first.press("Tab");
    await expect(page.locator(".settings-page .page-heading p")).toHaveText("Jordan & Your spouse");
    await expect(first).toHaveValue("Jordan");
  });

  test("signed-in household names are visibly locked, explained and ringed only for keyboard focus", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ json: {
      member: "a", nameA: "Alex", nameB: "Sam", signInProvider: "local"
    } }));
    await page.route(/\/api\/(?:todo-)?sync\?/, (route) =>
      route.fulfill({ json: { entries: [], cursor: 0, more: false } }));
    await english(page);
    await expect(page.getByRole("region", { name: "Account", exact: true })).toContainText("Signed in for local development");
    const first = page.getByLabel("First person", { exact: true });
    const second = page.getByLabel("Second person", { exact: true });
    await expect(first).toHaveValue("Alex");
    await expect(second).toHaveValue("Sam");
    await expect(first).not.toBeEditable();
    await expect(page.locator(".settings-name-lock")).toHaveCount(2);
    await expect(page.locator(".settings-name-edit")).toHaveCount(0);
    await expect(first).toHaveAccessibleDescription(/household configuration/);

    await first.tap();
    await expect(first).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-input-mode", "pointer");
    await expect(first).toHaveCSS("outline-style", "none");

    await first.press("Tab");
    await expect(second).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-input-mode", "keyboard");
    await expect(second).toHaveCSS("outline-style", "solid");
    await expect(second).toHaveCSS("outline-width", "3px");
  });

  test("provider-account household names are editable and saved to the household", async ({ page }) => {
    const names = { nameA: "Alex", nameB: "Sam" };
    let renamed: unknown;
    await page.route("**/api/me", (route) =>
      route.fulfill({ json: { userId: "user-names", householdId: "household-names", member: "a", ...names } }));
    await mockHouseholdSync(page);
    await page.route("**/api/household/member-name", async (route) => {
      renamed = route.request().postDataJSON();
      names.nameB = (renamed as { name: string }).name;
      await route.fulfill({ json: { renamed: true } });
    });
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).click();
    await expect(page.getByLabel("Erste Person", { exact: true })).toHaveValue("Alex");
    await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");

    const second = page.getByLabel("Second person", { exact: true });
    await expect(second).toBeEditable();
    await expect(page.locator(".settings-name-lock")).toHaveCount(0);
    await expect(page.locator(".settings-name-edit")).toHaveCount(2);
    await expect(second).toHaveAccessibleDescription(/shared with your household/);
    await second.fill("Jamie");
    await second.press("Tab");
    await expect.poll(() => renamed).toEqual({ slot: "b", name: "Jamie" });
    await expect(page.locator(".settings-page .page-heading p")).toHaveText("Alex & Jamie");
    await expect(second).toHaveValue("Jamie");
  });

  test("settings account buttons share a consistent shape and distinguish destructive actions", async ({ page }, info) => {
    await page.route("**/api/me", (route) => route.fulfill({ json: {
      userId: "user-buttons", householdId: "household-buttons", member: "a",
      nameA: "Alex", nameB: "Sam", signInProvider: "email", otherMemberJoined: true
    } }));
    await mockHouseholdSync(page);
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).tap();
    const settings = page.locator(".settings-page");
    const accountButtons = settings.locator(".button-row > button");
    // Sign out, then account deletion, member removal, leaving, household deletion and local data removal.
    await expect(accountButtons).toHaveCount(6);
    for (const language of ["de", "en"] as const) {
      if (language === "en") await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
      for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await inEachTheme(page, async (theme, background) => {
          await expect(accountButtons.first()).toHaveCSS("background-color", background);
          const buttons = await accountButtons.evaluateAll((elements) => elements.map((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return {
              shape: [style.borderRadius, style.borderWidth, style.borderStyle, style.padding, style.fontSize, style.fontWeight],
              color: style.color, background: style.backgroundColor,
              x: box.x, y: box.y, width: box.width, height: box.height,
              fits: element.scrollWidth <= element.clientWidth
            };
          }));
          const [signOut, ...destructive] = buttons;
          for (const button of buttons) {
            expect(button.shape).toEqual(signOut.shape);
            expect(button.background).toBe(signOut.background);
            expect(button.height).toBeGreaterThanOrEqual(48);
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.x + button.width).toBeLessThanOrEqual(width);
            expect(button.fits).toBe(true);
          }
          for (const button of destructive) {
            expect(button.color).toBe(destructive[0].color);
            expect(button.color).not.toBe(signOut.color);
            for (const neighbor of destructive.filter((other) => Math.abs(other.y - button.y) < 1)) {
              expect(button.height).toBeCloseTo(neighbor.height, 0);
            }
          }
          await fits(page);
          if (width === 393) await page.screenshot({ path: info.outputPath(`settings-buttons-${language}-${theme}.png`), fullPage: true });
        });
      }
    }
    await settings.getByRole("button", { name: "Delete your account", exact: true }).tap();
    const confirmation = page.getByRole("dialog", { name: "Delete your account", exact: true });
    await expect(confirmation).toContainText("Your sessions will be revoked immediately");
    await confirmAction(page, "Cancel");
    await expect(accountButtons).toHaveCount(6);
  });

  test("account settings show each sign-in provider and the available profile in both languages and themes", async ({ page }, info) => {
    const providers = ["email", "google", "microsoft"] as const;
    const label = { email: "E-Mail", google: "Google", microsoft: "Microsoft" } as const;
    const email = `${"alex".repeat(35)}@example.invalid`;
    let provider: (typeof providers)[number] = providers[0];
    await page.route("**/api/me", (route) => route.fulfill({ json: {
      userId: "user-profile", householdId: "household-profile", member: "a", nameA: "Alex", nameB: "Sam",
      signInProvider: provider, displayName: "Alex Profile", email,
      pictureUrl: "https://profiles.example.invalid/avatar.png"
    } }));
    await mockHouseholdSync(page);
    await page.route("https://profiles.example.invalid/avatar.png", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=", "base64")
    }));
    // Window focus refreshes the identity in place; a reload would be service-worker controlled,
    // which bypasses WebKit route mocks.
    const signInWith = async (next: typeof provider) => {
      provider = next;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    };
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen", exact: true }).tap();
    const german = page.getByRole("region", { name: "Konto", exact: true });
    for (const next of providers) {
      await signInWith(next);
      await expect(german).toContainText(`Mit ${label[next]} angemeldet`);
      await expect(german.getByText("Alex Profile", { exact: true })).toBeVisible();
    }
    await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
    const account = page.getByRole("region", { name: "Account", exact: true });
    for (const next of providers) {
      await signInWith(next);
      await expect(account).toContainText(`Signed in with ${next === "email" ? "email" : label[next]}`);
      await expect(account.getByText(email, { exact: true })).toBeVisible();
      await expect(account.locator("img")).toHaveAttribute("referrerpolicy", "no-referrer");
      await expect.poll(() => account.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
      for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await fits(page);
          await expect(account.getByText(email, { exact: true })).toBeVisible();
        }
      }
      if (next === "google") await page.screenshot({ path: info.outputPath("account-settings.png"), fullPage: true });
    }
  });

  test("account settings handle older sessions and unavailable profile photos", async ({ page }) => {
    const identity = {
      userId: "user-profile", householdId: "household-profile", member: "a", nameA: "Alex", nameB: "Sam",
      displayName: "Alex Profile", pictureUrl: "https://profiles.example.invalid/missing.png"
    };
    await page.route("**/api/me", (route) => route.fulfill({ json: identity }));
    await mockHouseholdSync(page);
    await page.route("https://profiles.example.invalid/missing.png", (route) => route.fulfill({ status: 404, body: "" }));
    await english(page);
    const account = page.getByRole("region", { name: "Account", exact: true });
    await expect(account).toContainText("Sign-in provider unavailable");
    await expect(account).toContainText("Sign in again");
    await expect(account.locator("img")).toHaveCount(0);
    await expect(account.locator(".avatar")).toHaveText("A");
  });

  test("account settings show an account icon when no name or photo is supplied", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ json: {
      userId: "user-profile", householdId: "household-profile", member: "a", nameA: "Alex", nameB: "Sam",
      signInProvider: "email"
    } }));
    await mockHouseholdSync(page);
    await english(page);
    const account = page.getByRole("region", { name: "Account", exact: true });
    await expect(account).toContainText("Signed in with email");
    await expect(account.locator(".avatar svg")).toBeVisible();
  });

  test("account settings do not ask for another login after an inconclusive fresh sign-in", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ json: {
      userId: "user-profile", householdId: "household-profile", member: "a", nameA: "Alex", nameB: "Sam",
      signInProvider: "unknown"
    } }));
    await mockHouseholdSync(page);
    await english(page);
    const account = page.getByRole("region", { name: "Account", exact: true });
    await expect(account).toContainText("Entra did not identify a single sign-in method for this session.");
    await expect(account).not.toContainText("Sign in again");
  });
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
