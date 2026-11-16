import { expect, test, type Page } from "./fixtures";
import { chooseOption } from "./controls";

async function addExpense(page: Page, description: string, amount: string, date: string, paidBy = "a") {
  await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Amount in EUR" }).fill(amount);
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await dialog.getByRole("group", { name: "Paid by" }).getByRole("radio").nth(paidBy === "a" ? 0 : 1).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("statistics filters real spending, stays independent of search, and works on mobile offline", async ({ page, context }, info) => {
  await page.clock.setFixedTime(new Date("2026-10-16T12:00:00"));
  await page.goto("/");
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Statistik", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Statistik", exact: true })).toBeVisible();
  await expect(page.getByText("Platz für neue Erlebnisse", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("statistics-empty-de.png"), fullPage: true });
  await nav.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await chooseOption(page, page.getByLabel("App-Sprache", { exact: true }), "English");
  await addExpense(page, "Weekly groceries", "128.40", "2026-10-14");
  await addExpense(page, "Dinner together", "76", "2026-10-12", "b");
  await addExpense(page, "Train tickets", "42.60", "2026-10-08");
  await addExpense(page, "Coffee date", "13", "2026-10-06", "b");
  await addExpense(page, "September groceries", "190", "2026-09-20");
  await addExpense(page, "Summer holiday", "480", "2026-08-10", "b");
  await addExpense(page, "Home supplies", "215", "2026-07-08");
  await addExpense(page, "Concert tickets", "120", "2026-06-15", "b");
  await addExpense(page, "Restaurant", "85", "2026-05-12");
  await page.getByRole("button", { name: "Settle up", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Amount in EUR" }).fill("50");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await nav.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox").fill("no match");
  await nav.getByRole("button", { name: "Statistics", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Statistics", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".add-button")).toHaveCount(0);
  await expect(page.locator(".statistics-total")).toContainText("260.00");
  await expect(page.locator(".statistics-hero small")).toHaveText("4 expenses · Ø €65.00 per expense");
  await expect(page.getByRole("region", { name: "Who paid", exact: true })).toContainText("171.00");
  await expect(page.getByRole("region", { name: "Who paid", exact: true })).toContainText("89.00");
  await expect(page.getByRole("region", { name: "Largest expense", exact: true })).toContainText("Weekly groceries");
  await page.screenshot({ path: info.outputPath("statistics-mobile-en.png"), fullPage: true });
  await page.getByRole("button", { name: "September 2026: €190.00", exact: true }).click();
  await expect(page.locator(".statistics-total")).toContainText("190.00");
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await expect(page.locator(".statistics-total")).toContainText("260.00");
  await page.getByRole("button", { name: "All time", exact: true }).click();
  await expect(page.locator(".statistics-total")).toContainText("1,350.00");

  for (const [width, height] of [[320, 740], [393, 851], [851, 393], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const targets = await page.locator(".statistics-period button, .statistics-bar-column").evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().height));
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath("statistics-desktop-en.png"), fullPage: true });
  await page.setViewportSize({ width: 393, height: 851 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await nav.getByRole("button", { name: "Statistics", exact: true }).click();
  await expect(page.locator(".statistics-total")).toContainText("260.00");
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseOption(page, page.getByLabel("App language", { exact: true }), "Deutsch");
  await nav.getByRole("button", { name: "Statistik", exact: true }).click();
  await expect(page.locator(".statistics-total")).toContainText("260,00");
  await page.screenshot({ path: info.outputPath("statistics-mobile-de.png"), fullPage: true });
});
