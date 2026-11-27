import { expect, test, type Page } from "./fixtures";
import { chooseOption, confirmAction } from "./controls";
import { openSync, closeSync, signIn, upToDate, useEnglish } from "./helpers";

const navigate = (page: Page, name: "Expenses" | "Settings") =>
  page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
const activeHousehold = (page: Page) => page.getByRole("button", { name: "Active household", exact: true });

async function addExpense(page: Page, description: string) {
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill(description);
  await page.getByRole("textbox", { name: "Amount in EUR" }).fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await upToDate(page);
}

async function createHousehold(page: Page) {
  await navigate(page, "Settings");
  await page.getByRole("button", { name: "Create another household", exact: true }).click();
  await confirmAction(page, "Create another household");
  await expect(activeHousehold(page)).toContainText("Alex & Unnamed");
  await upToDate(page);
  await navigate(page, "Expenses");
}

test("creates a second household and switches between separate ledgers", async ({ page }) => {
  await useEnglish(page);
  await signIn(page);
  await addExpense(page, "First household rent");

  await createHousehold(page);
  await expect(page.locator(".expense-row")).toHaveCount(0);
  await expect(page.locator(".balance-amount")).toContainText("0.00");
  await addExpense(page, "Second household groceries");
  await page.reload();
  await upToDate(page);
  await expect(page.locator(".expense-row")).toHaveText([/Second household groceries/]);

  await navigate(page, "Settings");
  await chooseOption(page, activeHousehold(page), "Alex & Sam");
  await expect(activeHousehold(page)).toContainText("Alex & Sam");
  await upToDate(page);
  // The device language follows the account into the other household's local database.
  await navigate(page, "Expenses");
  await expect(page.locator(".expense-row")).toHaveText([/First household rent/]);
  await expect(page.locator(".balance-amount")).toContainText("5.00");
  await page.reload();
  await upToDate(page);
  await expect(page.locator(".expense-row")).toHaveText([/First household rent/]);
  await navigate(page, "Settings");
  await expect(activeHousehold(page)).toContainText("Alex & Sam");
});

test("joins another household while signed in and continues in the first one after leaving it", async ({ page, browser, baseURL }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, localSignInEnabled: true, newHouseholdsEnabled: true } }));
  await useEnglish(page);
  await signIn(page);
  await addExpense(page, "Shared flat rent");
  await createHousehold(page);
  await addExpense(page, "Holiday cabin");
  const setup = page.getByRole("region", { name: "Set up your household", exact: true });
  await expect(setup.getByRole("listitem")).toHaveCount(3);
  await expect(setup.getByRole("listitem").nth(2)).toHaveClass("done");
  await navigate(page, "Settings");
  const invite = page.getByRole("region", { name: "Invite the other person", exact: true });
  await invite.getByRole("button", { name: "Create invitation", exact: true }).click();
  const link = await invite.getByLabel("Invitation link").inputValue();
  await navigate(page, "Expenses");

  const guestContext = await browser.newContext({ baseURL, serviceWorkers: "block" });
  try {
    const guest = await guestContext.newPage();
    await guest.route("**/api/auth/config", (route) =>
      route.fulfill({ json: { entraEnabled: true, localSignInEnabled: true, newHouseholdsEnabled: true } }));
    await useEnglish(guest);
    await signIn(guest, "B");
    await expect(guest.locator(".expense-row")).toHaveText([/Shared flat rent/]);

    await guest.goto(link);
    const invitation = guest.getByRole("region", { name: "Household invitation", exact: true });
    await invitation.getByRole("button", { name: "Join this household", exact: true }).click();
    await expect(invitation).not.toBeVisible();
    await upToDate(guest);
    await expect(guest.locator(".expense-row")).toHaveText([/Holiday cabin/]);
    expect(new URL(guest.url()).hash).toBe("");

    // The owner now sees a confirmed member instead of invitation controls, and setup is complete.
    await page.reload();
    await upToDate(page);
    await expect(page.locator(".expense-row")).toHaveText([/Holiday cabin/]);
    await expect(page.getByRole("region", { name: "Set up your household", exact: true })).toHaveCount(0);
    await navigate(page, "Settings");
    const ownerHousehold = page.getByRole("region", { name: "Household", exact: true });
    await expect(ownerHousehold.locator(".member-status")).toHaveText(["· You", "· Joined"]);
    await expect(ownerHousehold.getByRole("region", { name: "Invite the other person", exact: true })).toHaveCount(0);
    await expect(ownerHousehold.getByRole("button", { name: "Remove the other member", exact: true })).toBeVisible();
    await navigate(page, "Expenses");

    await navigate(guest, "Settings");
    await expect(activeHousehold(guest)).toContainText("Alex & Sam");
    await chooseOption(guest, activeHousehold(guest), 0);
    await upToDate(guest);
    await navigate(guest, "Expenses");
    await expect(guest.locator(".expense-row")).toHaveText([/Shared flat rent/]);
    await navigate(guest, "Settings");
    await chooseOption(guest, activeHousehold(guest), 1);
    await upToDate(guest);

    await guest.getByRole("button", { name: "Leave this household", exact: true }).click();
    await confirmAction(guest, "Leave this household");
    await expect(activeHousehold(guest)).toHaveCount(0);
    await upToDate(guest);
    await navigate(guest, "Expenses");
    await expect(guest.locator(".expense-row")).toHaveText([/Shared flat rent/]);
    await guest.reload();
    await upToDate(guest);
    await expect(guest.locator(".expense-row")).toHaveText([/Shared flat rent/]);
    await openSync(guest);
    await expect(guest.getByText("Signed in as Sam.", { exact: true })).toBeVisible();
    await closeSync(guest);

    // The owner keeps the household the guest left, including its ledger.
    await page.reload();
    await upToDate(page);
    await expect(page.locator(".expense-row")).toHaveText([/Holiday cabin/]);
  } finally { await guestContext.close(); }
});
