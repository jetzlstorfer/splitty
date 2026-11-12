import { expect, test, type Page } from "./fixtures";
import { useEnglish } from "./helpers";

type StoredTodo = { id: string; title: string; done: boolean; deleted?: boolean; createdAt: string; position?: number };

async function savedOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const opening = indexedDB.open("splitty");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const request = database.transaction("todos", "readonly").objectStore("todos").getAll();
      request.onerror = () => { database.close(); reject(request.error); };
      request.onsuccess = () => {
        const todos = (request.result as StoredTodo[]).filter((todo) => !todo.deleted && !todo.done);
        todos.sort((a, b) => Number(b.position === undefined) - Number(a.position === undefined)
          || (a.position ?? 0) - (b.position ?? 0)
          || b.createdAt.localeCompare(a.createdAt)
          || a.id.localeCompare(b.id));
        database.close();
        resolve(todos.map((todo) => todo.title));
      };
    };
  }));
}

async function expectSavedOrder(page: Page, expected: string[]) {
  await expect.poll(() => savedOrder(page)).toEqual(expected);
}

test("reordering tracks the finger, slides neighbors and settles without changing completion", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Real touch dragging uses Chromium's input protocol.");
  await useEnglish(page);
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  for (const title of ["Bottom", "Middle", "Top"]) {
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  // Freeze real layout animations so their start, midpoint and destination are measurable.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(".todo-item")) {
      for (const animation of element.getAnimations()) animation.finish();
    }
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches(".todo-item")) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
  });
  const rows = page.locator(".manual-todo");
  const top = rows.filter({ hasText: "Top" });
  const middle = rows.filter({ hasText: "Middle" });
  const handle = top.getByRole("button", { name: "Reorder to-do: Top", exact: true });
  const start = (await handle.boundingBox())!;
  const original = (await top.boundingBox())!;
  const middleStart = (await middle.boundingBox())!;
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  const touch = await context.newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 18 }] });
  await expect(top).toHaveClass(/reordering/);
  expect((await top.boundingBox())!.y - original.y).toBeCloseTo(18, 0);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 78 }] });
  await expect(rows.locator("strong")).toHaveText(["Middle", "Top", "Bottom"]);
  expect((await top.boundingBox())!.y - original.y).toBeCloseTo(78, 0);
  expect((await middle.boundingBox())!.y).toBeCloseTo(middleStart.y, 0);
  expect(await middle.evaluate((element) => element.getAnimations().length)).toBe(1);
  await middle.evaluate((element) => { element.getAnimations()[0].currentTime = 140; });
  const middleHalfway = (await middle.boundingBox())!.y;
  expect(middleHalfway).toBeLessThan(middleStart.y);
  expect(middleHalfway).toBeGreaterThan(original.y);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 18 }] });
  await expect(rows.locator("strong")).toHaveText(["Top", "Middle", "Bottom"]);
  expect((await middle.boundingBox())!.y).toBeCloseTo(middleHalfway, 0);
  expect((await top.boundingBox())!.y).toBeCloseTo(original.y, 0);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 78 }] });
  await expect(rows.locator("strong")).toHaveText(["Middle", "Top", "Bottom"]);
  expect((await middle.boundingBox())!.y).toBeCloseTo(middleHalfway, 0);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(top).not.toHaveClass(/reordering/);
  expect((await top.boundingBox())!.y - original.y).toBeCloseTo(78, 0);
  expect(await top.evaluate((element) => element.getAnimations().length)).toBe(1);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(".todo-item")) {
      for (const animation of element.getAnimations()) animation.finish();
    }
  });
  expect((await top.boundingBox())!.y).toBeCloseTo(middleStart.y, 0);
  await expectSavedOrder(page, ["Middle", "Top", "Bottom"]);
  await expect(rows.locator("input:checked")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  const movedHandle = top.getByRole("button", { name: "Reorder to-do: Top", exact: true });
  const cancelStart = (await movedHandle.boundingBox())!;
  const cancelY = cancelStart.y + cancelStart.height / 2;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: cancelY }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: cancelY - 78 }] });
  await expect(rows.locator("strong")).toHaveText(["Top", "Middle", "Bottom"]);
  await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(rows.locator("strong")).toHaveText(["Middle", "Top", "Bottom"]);
  await expect(top).not.toHaveClass(/reordering/);
  await touch.detach();
});

test("keyboard reorders animate across layouts and themes, but respect reduced motion", async ({ page }) => {
  await useEnglish(page);
  await page.getByRole("navigation").getByRole("button", { name: "To-dos" }).click();
  for (const title of ["First", "Second"]) {
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  const rows = page.locator(".manual-todo");
  await expectSavedOrder(page, ["Second", "First"]);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(".todo-item")) {
      for (const animation of element.getAnimations()) animation.finish();
    }
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches(".todo-item")) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
  });
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 851 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const first = page.locator(".manual-todo").first();
      const title = await first.locator("strong").textContent();
      const currentOrder = await rows.locator("strong").allTextContents();
      const expectedOrder = [...currentOrder.slice(1), title!];
      const handle = page.getByRole("button", { name: `Reorder to-do: ${title}`, exact: true });
      await handle.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(".manual-todo").last().locator("strong")).toHaveText(title!);
      await expectSavedOrder(page, expectedOrder);
      await expect(rows.locator("strong")).toHaveText(expectedOrder);
      await expect(handle).toBeFocused();
      const animations = await page.locator(".manual-todo").evaluateAll((elements) =>
        elements.map((element) => element.getAnimations().length));
      expect(animations).toEqual([1, 1]);
      await page.evaluate(() => {
        for (const element of document.querySelectorAll(".todo-item")) {
          for (const animation of element.getAnimations()) animation.finish();
        }
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const firstTitle = await page.locator(".manual-todo").first().locator("strong").textContent();
  const currentOrder = await page.locator(".manual-todo strong").allTextContents();
  const expectedOrder = [...currentOrder.slice(1), firstTitle!];
  await page.locator(".reorder-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".manual-todo").last().locator("strong")).toHaveText(firstTitle!);
  await expectSavedOrder(page, expectedOrder);
  await expect(page.locator(".manual-todo strong")).toHaveText(expectedOrder);
  expect(await page.locator(".manual-todo").evaluateAll((elements) =>
    elements.reduce((count, element) => count + element.getAnimations().length, 0))).toBe(0);
});
