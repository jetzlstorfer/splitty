import { expect, test, type Locator } from "./fixtures";
import { openSync, signIn, syncIndicator, upToDate, useEnglish } from "./helpers";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

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

for (const language of ["de", "en"] as const) for (const theme of ["light", "dark"] as const) {
  test(`${language} sync action labels fit mobile viewports in ${theme} mode`, async ({ page }, info) => {
    if (language === "en") await useEnglish(page);
    else await page.goto("/");
    await signIn(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const popover = page.locator(".sync-popover");
    const sync = popover.getByRole("button", { name: language === "de" ? "Jetzt synchronisieren" : "Sync now", exact: true });
    const signOut = popover.getByRole("button", { name: language === "de" ? "Abmelden" : "Sign out", exact: true });
    const close = popover.getByRole("button", { name: language === "de" ? "Schließen" : "Close", exact: true });
    await syncIndicator(page).tap();
    await expect(popover).toBeVisible();

    for (const viewport of viewports) {
      await test.step(`${viewport.width}x${viewport.height}`, async () => {
        await page.setViewportSize(viewport);
        await popover.evaluate((element) => { element.scrollTop = 0; });
        if (viewport.width === 402 || viewport.width === 320) {
          await page.screenshot({ path: info.outputPath(`sync-${language}-${theme}-${viewport.width}.png`) });
        }
        await expectActionFits(sync);
        await expectActionFits(signOut);
        const bounds = (await popover.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(12);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
    await close.tap();
    await expect(popover).not.toBeVisible();
    await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");

    await page.setViewportSize(viewports[0]);
    await openSync(page);
    await sync.tap();
    await upToDate(page);
    await expect(popover).toBeVisible();
    await signOut.tap();
    await expect(popover.getByRole("button", { name: language === "de" ? "Anmelden" : "Sign in", exact: true })).toBeVisible();
    for (const viewport of viewports.slice(0, 2)) {
      await page.setViewportSize(viewport);
      await expectActionFits(sync);
    }
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible();
    await expect(syncIndicator(page)).toHaveAttribute("aria-expanded", "false");
  });
}
