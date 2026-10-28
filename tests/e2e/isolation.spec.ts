import { expect, test } from "./fixtures";
import { signIn, upToDate, useEnglish } from "./helpers";

for (const run of [1, 2]) {
  test(`backend isolation starts empty even when another test uses the same descriptions (${run})`, async ({ page }) => {
    await useEnglish(page);
    await signIn(page);
    await expect(page.locator(".expense-row")).toHaveCount(0);
    await expect(page.locator(".balance-amount")).toContainText("0.00");
    await page.getByRole("navigation").getByRole("button", { name: "To-dos", exact: true }).click();
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Repeated isolation todo");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await upToDate(page);
    await page.getByRole("navigation").getByRole("button", { name: "Expenses", exact: true }).click();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill("Repeated isolation expense");
    await page.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await upToDate(page);
    await page.reload();
    await upToDate(page);
    await expect(page.locator(".expense-row")).toHaveCount(1);
    await expect(page.locator(".balance-amount")).toContainText("5.00");
  });
}
