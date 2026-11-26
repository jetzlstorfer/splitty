import { expect, type Locator, type Page } from "./fixtures";

export async function chooseOption(page: Page, trigger: Locator, option: string | number) {
  await trigger.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await (typeof option === "number" ? list.getByRole("option").nth(option) : list.getByRole("option", { name: option, exact: true })).click();
  await expect(list).not.toBeVisible();
}

export async function confirmAction(page: Page, action: string) {
  await page.locator(".control-dialog").getByRole("button", { name: action, exact: true }).click();
  await expect(page.locator(".control-dialog")).not.toBeVisible();
}
