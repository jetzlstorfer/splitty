import { expect, test, type Page } from "./fixtures";

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
  await expect(page.locator("html")).toHaveCSS("background-color", theme === "dark" ? "rgb(28, 37, 36)" : "rgb(255, 255, 255)");
  await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(20, 27, 25)" : "rgb(242, 244, 243)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", theme === "dark" ? "#1c2524" : "#ffffff");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", theme === "dark" ? "black-translucent" : "default");
}

for (const initial of ["light", "dark"] as const) {
  const opposite = initial === "light" ? "dark" : "light";

  test(`system theme follows live changes starting in ${initial} without losing form input`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: initial });
    await page.goto("/");
    await expectTheme(page, initial);
    await page.getByRole("button", { name: "Ausgabe hinzufügen", exact: true }).click();
    const description = page.getByRole("textbox", { name: "Beschreibung", exact: true });
    await description.fill("Theme change regression");

    for (const theme of [opposite, initial] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, theme);
      await expect(description).toHaveValue("Theme change regression");
      await expect(description).toBeFocused();
    }
  });

  test(`explicit ${initial} override ignores system theme changes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: opposite });
    await page.goto(`/?scoutTheme=${initial}`);
    await expectTheme(page, initial);
    for (const theme of [initial, opposite] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, initial);
    }
  });
}

test("invalid theme override still follows system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?scoutTheme=invalid");
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
});

test("installed app shell uses the dark surface behind Android system navigation", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expectTheme(page, "dark");
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestUrl).toBeTruthy();
  const response = await page.request.get(manifestUrl!);
  expect(response.ok()).toBe(true);
  const surface = await page.locator("html").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--cp-surface").trim()
  );
  expect(await response.json()).toMatchObject({
    display: "standalone",
    background_color: surface,
    theme_color: surface
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
});

test("installed-app manifest checks receive new colors without activating a new service worker", async ({ page, publishManifestUpdate }) => {
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
  const fetchManifest = () => page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
    return response.json();
  });
  expect(await fetchManifest()).toMatchObject({ background_color: "#1c2524", theme_color: "#1c2524" });
  publishManifestUpdate();
  expect(await fetchManifest()).toMatchObject({ background_color: "#102030", theme_color: "#102030" });
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(controller);
});

test("system theme follows changes after an offline PWA reload", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.getByRole("heading", { name: /^Ausgaben/, level: 1 })).toBeVisible();
    await expectTheme(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, "dark");
  } finally {
    await context.setOffline(false);
  }
});
