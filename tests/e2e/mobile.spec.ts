import { expect, test, type BrowserContext, type Locator, type Page } from "./fixtures";
import { signIn, useEnglish } from "./helpers";

test.beforeEach(async ({ page }) => { await useEnglish(page); });

async function addExpense(page: Page, description: string, amount: string) {
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add an expense" });
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  return dialog;
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function addTodo(page: Page, title: string) {
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await save(page);
}

async function login(page: Page, member: "A" | "B") {
  await signIn(page, member);
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
}

async function offlineReady(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

async function swipe(page: Page, row: Locator, dx: number, dy = 0) {
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  const x = dx < 0 ? box.x + box.width - 16 : Math.max(0, box.x) + 16;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

test("expense description and search match the rounded todo field border and focus ring", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fieldStyle = (field: Locator) => field.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borders: [style.borderTop, style.borderRight, style.borderBottom, style.borderLeft],
      radius: style.borderRadius, outline: style.outlineStyle === "none" ? "none" : style.outline,
      offset: style.outlineOffset, shadow: style.boxShadow
    };
  });
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
      await page.getByRole("button", { name: "Add to-do", exact: true }).click();
      const title = page.getByLabel("Title", { exact: true });
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS("border-radius", "6px");
      await expect(title).toHaveCSS("outline-width", "3px");
      const focused = await fieldStyle(title);
      await page.keyboard.press("Tab");
      const unfocused = await fieldStyle(title);
      await page.keyboard.press("Escape");

      await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
      await page.getByRole("button", { name: "Add expense", exact: true }).click();
      const description = page.getByLabel("Description", { exact: true });
      const field = page.locator(".description-input");
      await expect(description).toBeFocused();
      expect(await fieldStyle(field)).toEqual(focused);
      await expect(description).toHaveCSS("outline-style", "none");
      await expect(description).toHaveCSS("border-width", "0px");
      await description.fill("Coffee");
      await expect(description).toHaveValue("Coffee");
      const icon = field.getByRole("img", { name: "Coffee", exact: true });
      await expect(icon).toBeVisible();
      const fieldBox = (await field.boundingBox())!, iconBox = (await icon.boundingBox())!;
      expect(iconBox.x).toBeGreaterThan(fieldBox.x);
      expect(iconBox.x + iconBox.width).toBeLessThan(fieldBox.x + fieldBox.width);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("textbox", { name: "Amount in EUR" })).toBeFocused();
      expect(await fieldStyle(field)).toEqual(unfocused);
      await page.keyboard.press("Shift+Tab");
      await expect(description).toBeFocused();
      expect(await fieldStyle(field)).toEqual(focused);
      expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (width === 393) await page.screenshot({ path: info.outputPath(`expense-input-${theme}.png`) });
      await page.getByText("Description", { exact: true }).click();
      await expect(description).toBeFocused();
      expect(await fieldStyle(field)).toEqual(focused);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeFocused();

      await page.getByRole("navigation").getByRole("button", { name: "Search", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search expenses" });
      const searchField = page.locator(".search");
      expect(await fieldStyle(searchField)).toEqual(unfocused);
      await page.getByRole("button", { name: "Import", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(search).toBeFocused();
      expect(await fieldStyle(searchField)).toEqual(focused);
      await expect(search).toHaveCSS("outline-style", "none");
      await expect(search).toHaveCSS("border-width", "0px");
      await expect(searchField.locator("svg")).toBeVisible();
      await search.fill("Coffee");
      await expect(page.getByRole("heading", { name: "No matching expenses" })).toBeVisible();
      await page.keyboard.press("Tab");
      expect(await fieldStyle(searchField)).toEqual(unfocused);
      await search.click();
      expect(await fieldStyle(searchField)).toEqual(focused);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 393) await page.screenshot({ path: info.outputPath(`search-input-${theme}.png`) });
      await search.clear();
    }
  }
});

test("expense swipe actions edit, close, and ignore short or vertical gestures", async ({ page }) => {
  await addExpense(page, "Swipe groceries", "20");
  await save(page);
  const row = page.locator(".swipe-row").filter({ hasText: "Swipe groceries" });
  const toggle = row.getByRole("button", { name: "Entry actions: Swipe groceries" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row.locator(".swipe-actions")).toHaveAttribute("inert", "");
  await swipe(page, row.locator(".expense-row"), -25);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await swipe(page, row.locator(".expense-row"), -10, 50);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await swipe(page, row.locator(".expense-row"), -140);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row.getByRole("button", { name: "Edit entry: Swipe groceries" })).toBeInViewport();
  await swipe(page, row.locator(".expense-row"), 140);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await swipe(page, row.locator(".expense-row"), -140);
  await row.getByRole("button", { name: "Edit entry: Swipe groceries" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit entry" });
  await dialog.getByLabel("Description", { exact: true }).fill("Edited groceries");
  await save(page);
  await expect(page.getByText("Edited groceries", { exact: true })).toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("10.00");
});

test("keyboard actions delete with confirmation offline and in search", async ({ page, context }) => {
  await addExpense(page, "Keep this expense", "20");
  await save(page);
  await addExpense(page, "Delete this expense", "8");
  await save(page);
  const keepToggle = page.getByRole("button", { name: "Entry actions: Keep this expense" });
  const deleteToggle = page.getByRole("button", { name: "Entry actions: Delete this expense" });
  await keepToggle.click();
  await deleteToggle.click();
  await expect(keepToggle).toHaveAttribute("aria-expanded", "false");
  await expect(deleteToggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(deleteToggle).toBeFocused();
  await expect(deleteToggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Edit entry: Delete this expense" })).toBeFocused();
  await page.getByRole("heading", { name: /^Expenses/, level: 1 }).click();
  await expect(deleteToggle).toHaveAttribute("aria-expanded", "false");

  await offlineReady(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search expenses" }).fill("Delete this expense");
  await deleteToggle.click();
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await page.getByRole("button", { name: "Delete entry: Delete this expense" }).click();
  await expect(page.getByText("Delete this expense", { exact: true })).toBeVisible();
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.getByRole("button", { name: "Delete entry: Delete this expense" }).click();
  await expect(page.getByText("Delete this expense", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Delete this expense", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Keep this expense", { exact: true })).toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("10.00");
  await context.setOffline(false);
});

test("manual todo swipes preserve checkboxes and support editing and offline deletion", async ({ page, context }) => {
  await addTodo(page, "Swipe task");
  await addTodo(page, "Keep task");
  const row = page.getByRole("listitem").filter({ has: page.getByText("Swipe task", { exact: true }) });
  const toggle = row.getByRole("button", { name: "To-do actions: Swipe task" });
  await expect(row.locator(".swipe-actions")).toHaveAttribute("inert", "");
  for (const [dx, dy] of [[-25, 0], [-10, 50]]) {
    await swipe(page, row.locator(".swipe-content"), dx, dy);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByRole("checkbox")).not.toBeChecked();
  }
  await swipe(page, row.locator(".swipe-content"), -140);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await swipe(page, row.locator(".swipe-content"), 140);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await row.getByRole("button", { name: "Edit to-do: Swipe task" }).click();
  await page.getByLabel("Description (optional)").fill("Edited from swipe actions");
  await save(page);
  await expect(row).toContainText("Edited from swipe actions");
  await row.getByRole("checkbox").click();
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(done.getByRole("checkbox")).toBeChecked();

  await offlineReady(page);
  await context.setOffline(true);
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  await swipe(page, row.locator(".swipe-content"), -140);
  page.once("dialog", (dialog) => dialog.dismiss());
  await row.getByRole("button", { name: "Delete to-do: Swipe task" }).click();
  await expect(done.getByRole("checkbox")).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete to-do: Swipe task" }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Keep task", { exact: true })).toBeVisible();
  await context.setOffline(false);
});

test("todo action menus close on Escape, outside clicks, and another row opening", async ({ page }) => {
  await addTodo(page, "First task");
  await addTodo(page, "Second task");
  const first = page.getByRole("button", { name: "To-do actions: First task" });
  const second = page.getByRole("button", { name: "To-do actions: Second task" });
  await first.click();
  await second.click();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Edit to-do: Second task" })).toBeFocused();
  await page.getByRole("heading", { name: /^To-dos/, level: 1 }).click();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.click();
  await page.getByRole("listitem").filter({ hasText: "Second task" }).getByText("Second task", { exact: true }).click();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("checkbox", { name: "Second task" })).not.toBeChecked();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByText("Second task", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit to-do" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("checkbox", { name: "Second task" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Second task" }).click();
  await expect(page.getByRole("checkbox", { name: "Second task" })).toBeChecked();
});

test("insurance todo swipes open and delete their linked expense with explicit confirmation", async ({ page }) => {
  await addExpense(page, "Doctor swipe", "30");
  await save(page);
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Doctor swipe" });
  await swipe(page, row.locator(".swipe-content"), -140);
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await row.getByRole("button", { name: "Open expense: Doctor swipe" }).click();
  await expect(page.getByRole("dialog", { name: "Edit entry" })).toBeVisible();
  await page.getByLabel("Description", { exact: true }).fill("Doctor edited");
  await save(page);
  const edited = page.getByRole("listitem").filter({ hasText: "Doctor edited" });
  await edited.getByRole("checkbox").click();
  await expect(edited.getByRole("checkbox")).toBeChecked();
  await swipe(page, edited.locator(".swipe-content"), -140);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Delete this entry for both of you? This will sync when you are online.");
    await dialog.dismiss();
  });
  await edited.getByRole("button", { name: "Delete entry: Doctor edited" }).click();
  await expect(edited.getByRole("checkbox")).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await edited.getByRole("button", { name: "Delete entry: Doctor edited" }).click();
  await expect(edited).toHaveCount(0);
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No expenses yet" })).toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("0.00");
});

test("expense and todo rows align and highlight their full width including the three-dot menu", async ({ page }) => {
  await addExpense(page, "Doctor hover", "12");
  await save(page);
  await addTodo(page, "Hover task");
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole("button", { name: "Expenses", exact: true }).click();
      const expense = await page.locator(".swipe-row").boundingBox();
      await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
      for (const row of await page.locator(".swipe-row").all()) {
        const todo = await row.boundingBox();
        expect(todo?.x).toBe(expense?.x);
        expect(todo?.width).toBe(expense?.width);
      }
      for (const tab of ["Expenses", "To-dos"]) {
        await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
        for (const row of await page.locator(".swipe-row").all()) {
          const front = row.locator(".swipe-front");
          const background = await front.evaluate((element) => getComputedStyle(element).backgroundColor);
          for (const target of [row.locator(".entry-description"), row.locator(".row-actions-toggle")]) {
            await target.hover();
            await expect(front).not.toHaveCSS("background-color", background);
            for (const child of [row.locator(".swipe-content"), row.locator(".row-actions-toggle")]) {
              const childColor = await child.evaluate((element) => getComputedStyle(element).backgroundColor);
              expect(["rgba(0, 0, 0, 0)", await front.evaluate((element) => getComputedStyle(element).backgroundColor)]).toContain(childColor);
            }
          }
          await page.getByRole("heading", { level: 1 }).hover();
          await expect(front).toHaveCSS("background-color", background);
          if (tab === "To-dos") await expect(row.getByRole("checkbox")).not.toBeChecked();
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

for (const kind of ["expense", "manual todo", "insurance todo"]) {
test(`touch swipes on ${kind} reveal actions without activating the row and cancel safely`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 851 });
  const title = kind === "insurance todo" ? "Doctor touch" : "Touch item";
  if (kind === "manual todo") await addTodo(page, title);
  else {
    await addExpense(page, title, "12");
    await save(page);
    if (kind === "insurance todo") await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  }
  const row = page.locator(".swipe-content");
  await expect(row).toHaveCSS("touch-action", "pan-y pinch-zoom");
  const box = (await row.boundingBox())!;
  const x = box.x + box.width - 16, y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let offset = 20; offset <= 140; offset += 20) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - offset, y }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    const toggle = page.getByRole("button", { name: `${kind === "expense" ? "Entry actions" : "To-do actions"}: ${title}` });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".swipe-front")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let offset = 20; offset <= 140; offset += 20) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - offset, y }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("button", { name: `${kind === "manual todo" ? "Delete to-do" : "Delete entry"}: ${title}` })).toBeInViewport();
    if (kind !== "expense") await expect(page.getByRole("checkbox")).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await session.detach(); }
});
}

test("mobile expense entry, custom splits, settlements and offline reload", async ({ page, context }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^Expenses/, level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-empty.png"), fullPage: true });
  let dialog = await addExpense(page, "Offline groceries", "20.01");
  await expect(dialog.getByRole("button", { name: /Split equally/ })).toBeVisible();
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("10.00");
  await offlineReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Offline groceries", { exact: true })).toBeVisible();
  dialog = await addExpense(page, "On behalf of partner", "12,34");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "Your wife owes the full amount" }).check();
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("22.34");
  dialog = await addExpense(page, "Percentage expense", "8");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "By percentage" }).check();
  await dialog.getByLabel("Your share (%)").fill("25");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("28.34");
  dialog = await addExpense(page, "Partner paid", "10");
  await dialog.getByLabel("Paid by").selectOption("b");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("23.34");
  await page.getByRole("button", { name: /Settle up/ }).click();
  dialog = page.getByRole("dialog", { name: "Settle up" });
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("3");
  await dialog.getByLabel("Paid by").selectOption("b");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("20.34");
  await page.reload();
  await expect(page.locator(".balance-amount")).toContainText("20.34");
  await expect(page.getByText("On behalf of partner", { exact: true })).toBeVisible();
  await page.getByText("Offline groceries", { exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit entry" });
  await expect(dialog.getByRole("button", { name: /Split equally/ })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill("22.01");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("21.34");
  dialog = await addExpense(page, "Exact shares", "5");
  await dialog.getByRole("button", { name: /Split equally/ }).click();
  await dialog.getByRole("radio", { name: "By exact amount" }).check();
  await dialog.getByLabel("Your share (EUR)").fill("1");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("25.34");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-offline.png"), fullPage: true });
  await context.setOffline(false);
});

test("member-token sign-in and two devices converge after an offline change", async ({ page, browser }) => {
  const second: BrowserContext = await browser.newContext({ viewport: { width: 393, height: 851 } });
  const partner = await second.newPage();
  try {
    await page.goto("/"); await partner.goto("/");
    await useEnglish(partner);
    await login(page, "A");
    await login(partner, "B");
    await offlineReady(page);
    await page.context().setOffline(true);
    await addExpense(page, "Shared across devices", "18");
    await save(page);
    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Sync status" }).click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByRole("status")).toHaveText("Up to date");
    await page.getByRole("button", { name: "Sync status" }).click();
    await partner.getByRole("button", { name: "Sync status" }).click();
    await partner.getByRole("button", { name: "Sync now" }).click();
    await expect(partner.getByRole("status")).toHaveText("Up to date");
    await partner.getByRole("button", { name: "Sync status" }).click();
    await expect(partner.getByText("Shared across devices", { exact: true })).toBeVisible();
    await expect(partner.locator(".balance-amount")).toContainText("9.00");
    await expect(partner.getByText("You owe Alex", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Shared across devices", { exact: true })).toBeVisible();
  } finally { await second.close(); }
});

test("previews, reconciles and deduplicates a Splitwise import", async ({ page }) => {
  await page.goto("/");
  const csv = "Datum,Beschreibung,Kategorie,Kosten,Währung,Alex,Sam\n"
    + '2024-01-01,"Dinner, together",Restaurant,83.07,EUR,-41.54,41.54\n'
    + "2024-01-02,Payment,Zahlung,10.00,EUR,10.00,-10.00\n"
    + "2024-01-03,Gesamtbilanz,,,EUR,-31.54,31.54\n";
  async function preview() {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import from Splitwise" });
    await dialog.getByLabel("Splitwise CSV").setInputFiles({
      name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
    });
    await dialog.getByRole("button", { name: "Preview import" }).click();
    return dialog;
  }
  let dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "2 new entries" })).toBeVisible();
  await expect(dialog.getByText("Matches the final balance in your export.")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await expect(page.locator(".balance-amount")).toContainText("31.54");
  dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "0 new entries" })).toBeVisible();
  await expect(dialog.getByText("2 already imported · skipped")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByText("Dinner, together", { exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit entry" });
  await expect(dialog.getByRole("textbox", { name: "Amount in EUR" })).toHaveAttribute("readonly");
  await dialog.getByLabel("Description", { exact: true }).fill("Updated dinner");
  await save(page);
  await expect(page.locator(".balance-amount")).toContainText("31.54");
  await page.getByText("Updated dinner", { exact: true }).click();
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".balance-amount")).toContainText("10.00");
  dialog = await preview();
  await expect(dialog.getByRole("heading", { name: "0 new entries" })).toBeVisible();
});

for (const [theme, width] of [["light", 393], ["dark", 393], ["light", 320]] as const) {
  test(`Splitwise-style ${theme} presentation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 851 });
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.goto(`/?scoutTheme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", theme === "light" ? "#ffffff" : "#1c2524");
    await expect(page.locator(".add-button")).toHaveCSS("background-color", "rgb(28, 194, 159)");
    await expect(page.getByRole("button", { name: "Expenses", exact: true })).toHaveAttribute("aria-current", "page");

    await addExpense(page, "Groceries", "40");
    await save(page);
    const dialog = await addExpense(page, "Dinner together", "60");
    await dialog.getByLabel("Paid by").selectOption("b");
    await save(page);

    const credit = theme === "light" ? "rgb(8, 127, 105)" : "rgb(84, 214, 183)";
    const debt = theme === "light" ? "rgb(196, 71, 32)" : "rgb(255, 148, 108)";
    await expect(page.locator(".entry-balance.lent")).toHaveCSS("color", credit);
    await expect(page.locator(".entry-balance.owed")).toHaveCSS("color", debt);
    await expect(page.locator(".balance-amount")).toHaveCSS("color", debt);
    await expect(page.locator(".balance-amount")).toContainText("10.00");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = await page.locator(".expense-row").first().boundingBox();
    const action = await page.locator(".add-button").boundingBox();
    expect(row!.y + row!.height).toBeLessThan(action!.y);
    expect(action!.height).toBeGreaterThanOrEqual(48);
    const contrast = await page.locator(".entry-balance.owed").evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color.match(/\d+/g)!.slice(0, 3).map(Number).map((c) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(document.querySelector(".app-shell")!).backgroundColor);
      return [element, document.querySelector(".entry-balance.lent")!].map((item) => {
        const foreground = luminance(getComputedStyle(item).color);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: info.outputPath(`splitty-${theme}-${width}.png`) });

    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCSS("border-radius", "0px");
    await page.getByLabel("Description", { exact: true }).fill("Weekend groceries");
    await page.getByRole("textbox", { name: "Amount in EUR" }).fill("24.50");
    await page.screenshot({ path: info.outputPath(`splitty-form-${theme}-${width}.png`) });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.locator(".app-shell").evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(760);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  });
}
