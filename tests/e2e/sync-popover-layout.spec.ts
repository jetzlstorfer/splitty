import { expect, test, type Locator, type Page } from "./fixtures";
import { confirmAction } from "./controls";
import { openSync, signIn, syncIndicator, upToDate, useEnglish } from "./helpers";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

const themes = ["light", "dark"] as const;

async function useTheme(page: Page, theme: (typeof themes)[number]) {
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
}

const viewports = [
  { width: 402, height: 874 },
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 667 },
  { width: 384, height: 854 },
  { width: 390, height: 844 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
  { width: 414, height: 896 },
  { width: 430, height: 932 },
  { width: 440, height: 956 },
  { width: 874, height: 402 },
  { width: 768, height: 1024 },
  { width: 1280, height: 900 }
];

async function expectActionFits(button: Locator) {
  await button.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await expect(button).toBeInViewport({ ratio: 1 });
  const layout = await button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!text) throw new Error("Expected an action label.");
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = ({ left, right, top, bottom, width }: DOMRect) => ({ left, right, top, bottom, width });
    const icon = element.querySelector("svg");
    return {
      height: box.height,
      contentLeft: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      contentRight: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
      contentTop: box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
      contentBottom: box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom),
      text: [...range.getClientRects()].map(rect),
      icon: icon ? rect(icon.getBoundingClientRect()) : null,
      gap: parseFloat(style.columnGap)
    };
  });
  expect(layout.height).toBeGreaterThanOrEqual(44);
  expect(layout.text, "The complete action label should fit on one line").toHaveLength(1);
  const text = layout.text[0];
  expect(text.left).toBeGreaterThanOrEqual(layout.contentLeft - 1);
  expect(text.right).toBeLessThanOrEqual(layout.contentRight + 1);
  expect(text.top).toBeGreaterThanOrEqual(layout.contentTop - 1);
  expect(text.bottom).toBeLessThanOrEqual(layout.contentBottom + 1);
  if (layout.icon) {
    expect(layout.icon.width, "The sync icon must not shrink to make room for text").toBeCloseTo(16, 1);
    expect(layout.icon.left).toBeGreaterThanOrEqual(layout.contentLeft - 1);
    expect(layout.icon.right + layout.gap).toBeLessThanOrEqual(text.left + 1);
  }
}

for (const language of ["de", "en"] as const) {
  test(`${language} sync and account actions fit mobile viewports in light and dark mode`, async ({ page }, info) => {
    test.setTimeout(120_000);
    let logoutRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/logout") logoutRequests++;
    });
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    await signIn(page, "A", language);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const popover = page.locator(".sync-popover");
    const sync = popover.getByRole("button", { name: language === "de" ? "Jetzt synchronisieren" : "Sync now", exact: true });
    const signOut = page.getByRole("button", { name: language === "de" ? "Abmelden" : "Sign out", exact: true });
    const close = popover.getByRole("button", { name: language === "de" ? "Schließen" : "Close", exact: true });
    await syncIndicator(page).tap();
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: language === "de" ? "Abmelden" : "Sign out", exact: true })).toHaveCount(0);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const theme of themes) {
        await test.step(`${viewport.width}x${viewport.height} ${theme}`, async () => {
          await useTheme(page, theme);
          await popover.evaluate((element) => { element.scrollTop = 0; });
          if (viewport.width === 402 || viewport.width === 320) {
            await page.screenshot({ path: info.outputPath(`sync-${language}-${theme}-${viewport.width}.png`) });
          }
          await expectActionFits(sync);
          const bounds = (await popover.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(12);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
          expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
      }
    }
    await close.tap();
    await expect(popover).not.toBeVisible();
    await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");

    await page.setViewportSize(viewports[0]);
    await openSync(page);
    await sync.tap();
    await upToDate(page);
    await expect(popover).toBeVisible();
    await page.getByRole("navigation").getByRole("button", { name: language === "de" ? "Einstellungen" : "Settings", exact: true }).tap();
    await expect(popover).not.toBeVisible();
    await expect(signOut).toBeVisible();
    const confirmation = page.getByRole("dialog", { name: language === "de" ? "Abmelden" : "Sign out", exact: true });
    const cancel = confirmation.getByRole("button", { name: language === "de" ? "Abbrechen" : "Cancel", exact: true });
    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of themes) {
        await useTheme(page, theme);
        await expectActionFits(signOut);
        await signOut.tap();
        await expect(confirmation).toBeVisible();
        await expect(confirmation).toContainText(language === "de"
          ? "Auf diesem Gerät abmelden? Dein Offline-Verlauf bleibt auf diesem Gerät erhalten."
          : "Sign out on this device? Your offline history will remain on this device.");
        await expect(cancel).toBeFocused();
        await expectActionFits(cancel);
        await expectActionFits(confirmation.getByRole("button", { name: language === "de" ? "Abmelden" : "Sign out", exact: true }));
        await cancel.tap();
        await expect(confirmation).not.toBeVisible();
        await expect(signOut).toBeEnabled();
        expect(logoutRequests).toBe(0);
      }
    }
    await signOut.focus();
    await page.keyboard.press("Enter");
    await expect(confirmation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirmation).not.toBeVisible();
    await expect(signOut).toBeFocused();
    expect(logoutRequests).toBe(0);
    await signOut.tap();
    await confirmAction(page, language === "de" ? "Abmelden" : "Sign out");
    await openSync(page);
    await expect(popover.getByRole("button", {
      name: language === "de" ? "Als erstes Mitglied zur Entwicklung anmelden" : "Development sign-in as first member",
      exact: true
    })).toBeVisible();
    expect(logoutRequests).toBe(1);
    await close.tap();
    await page.getByRole("navigation").getByRole("button", { name: language === "de" ? "Einstellungen" : "Settings", exact: true }).tap();
    const accountSignIn = page.getByRole("region", { name: language === "de" ? "Konto" : "Account", exact: true })
      .getByRole("button", { name: language === "de" ? "Anmelden" : "Sign in", exact: true });
    await expect(popover).not.toBeVisible();
    await accountSignIn.tap();
    await expect(popover).toBeVisible();
    await expect(page.getByRole("dialog", { name: language === "de" ? "Synchronisierung" : "Synchronization", exact: true })
      .getByRole("button", {
        name: language === "de" ? "Als erstes Mitglied zur Entwicklung anmelden" : "Development sign-in as first member",
        exact: true
      })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible();
    await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");
    await openSync(page);
    for (const viewport of viewports.slice(0, 2)) {
      await page.setViewportSize(viewport);
      for (const theme of themes) {
        await useTheme(page, theme);
        await expectActionFits(sync);
      }
    }
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible();
    await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");
  });
}
