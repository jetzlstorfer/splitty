import { expect, test } from "./fixtures";
import { useEnglish } from "./helpers";

test("claims an existing household before provider sign-in while new household registration is closed", async ({ page, baseURL }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, legacyEnabled: true, newHouseholdsEnabled: false } }));
  await page.route("**/api/auth/start", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ legacyToken: "A".repeat(43) });
    await route.fulfill({ json: { authorizationUrl: `${baseURL}/authorize` } });
  });
  await useEnglish(page);
  const indicator = page.getByRole("button", { name: "Sync status", exact: true });
  await indicator.click();
  const popover = page.getByRole("dialog", { name: "Synchronization", exact: true });
  await expect(popover).toContainText("New household registration is closed.");
  await popover.getByLabel("Existing household member token").fill("A".repeat(43));
  await popover.getByRole("button", { name: "Continue and claim existing household", exact: true }).click();
  await page.waitForURL(`${baseURL}/authorize`);
});

test("creates, copies, revokes, and carries an invitation through provider sign-in", async ({ page, browser, baseURL }) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({ json: { entraEnabled: true, legacyEnabled: true, newHouseholdsEnabled: true } }));
  await useEnglish(page);
  const indicator = page.getByRole("button", { name: "Sync status", exact: true });
  await indicator.click();
  const popover = page.getByRole("dialog", { name: "Synchronization", exact: true });
  await popover.getByLabel("Member token", { exact: true }).fill("A".repeat(43));
  await popover.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(popover.getByText("Signed in as Alex.", { exact: true })).toBeVisible();
  await expect(popover.getByRole("region", { name: "Household invitations" })).toBeVisible();
  await expect(popover).toContainText("takes over the invited member slot's existing balance");

  const guestContext = await browser.newContext({ baseURL, serviceWorkers: "block" });
  try {
    let invitedCode = "";
    await popover.getByRole("button", { name: "Create invitation", exact: true }).click();
    const linkInput = popover.getByLabel("Invitation link");
    await expect(linkInput).toBeVisible();
    await expect(popover.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
    const [inputBox, qrBox, copyBox] = await Promise.all([
      linkInput.boundingBox(),
      popover.getByRole("img", { name: "Invitation QR code" }).boundingBox(),
      popover.getByRole("button", { name: "Copy invite link", exact: true }).boundingBox()
    ]);
    if (!inputBox || !qrBox || !copyBox) throw new Error("Invitation layout is not rendered");
    // Leave room for the 3px focus outline at a 3px offset so the QR code does not cover it.
    expect(qrBox.y - (inputBox.y + inputBox.height)).toBeGreaterThanOrEqual(6);
    expect(copyBox.y - (qrBox.y + qrBox.height)).toBeGreaterThanOrEqual(6);
    expect(Math.abs((qrBox.x + qrBox.width / 2) - (inputBox.x + inputBox.width / 2))).toBeLessThanOrEqual(1);
    expect(copyBox.x).toBeCloseTo(inputBox.x, 0);
    expect(copyBox.width).toBeCloseTo(inputBox.width, 0);
    const link = await linkInput.inputValue();
    const code = new URLSearchParams(new URL(link).hash.slice(1)).get("invite");
    expect(code).toMatch(/^browser-test-[a-zA-Z0-9-]+\.[a-zA-Z0-9_-]{43}$/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await popover.getByRole("button", { name: "Copy invite link", exact: true }).click();
    await expect(popover.getByRole("status")).toHaveText("Invite was copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    await popover.getByRole("button", { name: "Revoke invitation", exact: true }).click();
    await expect(popover).not.toContainText("Pending invitation to Sam");
    await popover.getByRole("button", { name: "Create invitation", exact: true }).click();
    const secondLink = await popover.getByLabel("Invitation link").inputValue();
    invitedCode = new URLSearchParams(new URL(secondLink).hash.slice(1)).get("invite") ?? "";

    const guest = await guestContext.newPage();
    await guest.route("**/api/auth/config", (route) =>
      route.fulfill({ json: { entraEnabled: true, legacyEnabled: false, newHouseholdsEnabled: true } }));
    await guest.goto(secondLink);
    await guest.getByRole("button", { name: "Synchronisierungsstatus", exact: true }).click();
    const providerButton = guest.getByRole("button", { name: "Mit E-Mail, Google oder Microsoft fortfahren", exact: true });
    await expect(providerButton).toBeVisible();
    let signInCode: unknown;
    await guest.route("**/api/auth/start", async (route) => {
      signInCode = route.request().postDataJSON().inviteCode;
      await route.fulfill({ json: { authorizationUrl: `${baseURL}/authorize` } });
    });
    await providerButton.click();
    await expect.poll(() => signInCode).toBe(invitedCode);
    await guest.waitForURL(`${baseURL}/authorize`);
    await guest.close();
  } finally { await guestContext.close(); }
});
