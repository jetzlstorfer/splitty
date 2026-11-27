import { expect, test } from "./fixtures";
import { confirmAction } from "./controls";
import { signIn, useEnglish } from "./helpers";

test("keeps new household registration closed and sends existing members to invitations", async ({ page, baseURL }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, localSignInEnabled: false, newHouseholdsEnabled: false } }));
  await page.route("**/api/auth/start", async (route) => {
    await route.fulfill({ status: 302, headers: { location: `${baseURL}/authorize` } });
  });
  await useEnglish(page);
  const indicator = page.getByRole("button", { name: "Sync status", exact: true });
  await indicator.click();
  const popover = page.getByRole("dialog", { name: "Synchronization", exact: true });
  await expect(popover).toContainText("New household registration is currently closed. Ask a household member for an invitation.");
  await expect(popover.getByRole("button", { name: /member token/i })).toHaveCount(0);
  await popover.getByRole("button", { name: "Continue with email, Google, or Microsoft", exact: true }).click();
  await page.waitForURL(`${baseURL}/authorize`);
});

test("creates, copies, revokes and replaces invitations in Settings and carries one through provider sign-in", async ({ page, browser, baseURL }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, localSignInEnabled: true, newHouseholdsEnabled: true } }));
  await useEnglish(page);
  await signIn(page);
  const settings = async () => {
    await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
    return page.getByRole("region", { name: "Household", exact: true });
  };
  let household = await settings();
  let panel = household.getByRole("region", { name: "Invite the other person", exact: true });
  await expect(panel).toContainText("takes over the invited member slot's existing balance");
  await expect(panel).toContainText("exactly two members");
  await expect(household.locator(".member-status")).toHaveText(["· You", "· Not joined yet"]);
  await expect(household.getByRole("button", { name: "Remove the other member", exact: true })).toHaveCount(0);

  const guestContext = await browser.newContext({ baseURL, serviceWorkers: "block" });
  try {
    await panel.getByRole("button", { name: "Create invitation", exact: true }).click();
    const linkInput = panel.getByLabel("Invitation link");
    await expect(linkInput).toBeVisible();
    await expect(panel.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Create invitation", exact: true })).toHaveCount(0);
    await expect(household.locator(".member-status").nth(1)).toHaveText("· Invitation pending");
    const [inputBox, qrBox, copyBox] = await Promise.all([
      linkInput.boundingBox(),
      panel.getByRole("img", { name: "Invitation QR code" }).boundingBox(),
      panel.getByRole("button", { name: "Copy invite link", exact: true }).boundingBox()
    ]);
    if (!inputBox || !qrBox || !copyBox) throw new Error("Invitation layout is not rendered");
    // Leave room for the 3px focus outline at a 3px offset so the QR code does not cover it.
    expect(qrBox.y - (inputBox.y + inputBox.height)).toBeGreaterThanOrEqual(6);
    expect(copyBox.y - (qrBox.y + qrBox.height)).toBeGreaterThanOrEqual(6);
    expect(Math.abs((qrBox.x + qrBox.width / 2) - (inputBox.x + inputBox.width / 2))).toBeLessThanOrEqual(1);
    expect(copyBox.x).toBeCloseTo(inputBox.x, 0);
    expect(copyBox.width).toBeCloseTo(inputBox.width, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const link = await linkInput.inputValue();
    const code = new URLSearchParams(new URL(link).hash.slice(1)).get("invite");
    expect(code).toMatch(/^browser-test-[a-zA-Z0-9-]+\.[a-zA-Z0-9_-]{43}$/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await panel.getByRole("button", { name: "Copy invite link", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Invite was copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    await panel.getByRole("button", { name: "Revoke invitation", exact: true }).click();
    await expect(panel).not.toContainText("Pending invitation to Sam");
    await expect(household.locator(".member-status").nth(1)).toHaveText("· Not joined yet");
    await panel.getByRole("button", { name: "Create invitation", exact: true }).click();
    const secondLink = await panel.getByLabel("Invitation link").inputValue();

    // Only a hash is stored, so after a reload the pending link can be replaced but not shown again.
    await page.reload();
    household = await settings();
    panel = household.getByRole("region", { name: "Invite the other person", exact: true });
    await expect(panel).toContainText("Pending invitation to Sam");
    await expect(panel.getByLabel("Invitation link")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Create invitation", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Replace invitation", exact: true }).click();
    await confirmAction(page, "Replace invitation");
    const replacedLink = await panel.getByLabel("Invitation link").inputValue();
    expect(replacedLink).not.toBe(secondLink);
    const invitedCode = new URLSearchParams(new URL(replacedLink).hash.slice(1)).get("invite") ?? "";

    const guest = await guestContext.newPage();
    await guest.route("**/api/auth/config", (route) =>
      route.fulfill({ json: { entraEnabled: true, localSignInEnabled: false, newHouseholdsEnabled: true } }));
    await guest.goto(replacedLink);
    const landing = guest.getByRole("region", { name: "Du wurdest zu einem gemeinsamen Haushalt eingeladen", exact: true });
    await expect(landing).toBeVisible();
    await expect(landing).toContainText("werden nicht automatisch hinzugefügt");
    await landing.getByRole("button", { name: "Nicht jetzt", exact: true }).click();
    await expect(landing).not.toBeVisible();
    expect(new URL(guest.url()).hash).toBe("");
    await guest.goto(replacedLink);
    await expect(landing).toBeVisible();
    // The ordinary welcome card does not compete with the invitation's sign-in.
    await expect(guest.getByRole("button", { name: "Anmelden und teilen", exact: true })).toHaveCount(0);
    let signInCode: unknown;
    await guest.route("**/api/auth/start", async (route) => {
      signInCode = route.request().postDataJSON().inviteCode;
      await route.fulfill({ json: { authorizationUrl: `${baseURL}/authorize` } });
    });
    await landing.getByRole("button", { name: "Anmelden und beitreten", exact: true }).click();
    await expect.poll(() => signInCode).toBe(invitedCode);
    await guest.waitForURL(`${baseURL}/authorize`);
    await guest.close();
  } finally { await guestContext.close(); }
});
