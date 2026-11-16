import { expect, test } from "./fixtures";
import { useEnglish } from "./helpers";

test("native install prompt is offered and appinstalled hides the button", async ({ page }) => {
  await useEnglish(page);
  await page.evaluate(() => {
    const createPrompt = () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, {
        prompt: async () => { document.body.dataset.installPromptCalled = "true"; },
        userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" })
      });
      window.dispatchEvent(event);
    };
    createPrompt();
  });

  const install = page.getByRole("button", { name: "Install", exact: true });
  await expect(install).toBeVisible();
  await install.click();
  await expect.poll(() => page.locator("body").getAttribute("data-install-prompt-called")).toBe("true");
  await expect(install).toBeHidden();

  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" })
    });
    window.dispatchEvent(event);
  });
  await expect(install).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(install).toBeHidden();
});

test("install button is hidden in standalone mode", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });
  await useEnglish(page);
  await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
});
