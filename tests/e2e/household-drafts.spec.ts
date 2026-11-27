import { expect, test } from "./fixtures";
import { confirmAction } from "./controls";
import { signIn, storedRecords, upToDate } from "./helpers";
import { example, exampleTodo } from "../fixtures";

test.use({ serviceWorkers: "block" });

const backup = (description: string, title: string) => ({
  name: "synthetic.json", mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({
    format: "splitty-v2", entries: [example({ id: crypto.randomUUID(), description })], todos: [exampleTodo({ id: crypto.randomUUID(), title })]
  }))
});

for (const draft of ["expense", "to-do", "CSV import", "backup restore"] as const) {
  test(`switching households in another tab cancels the open ${draft} without moving queued records`, async ({ page, context }) => {
    await page.goto("/");
    await signIn(page);
    const source = await page.evaluate(() => localStorage.getItem("splitty-active-database"));
    expect(source).toMatch(/^splitty-account-/);
    await context.route(/\/api\/(?:todo-)?sync$/, (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Offline" } }) : route.continue());

    const navigate = (name: string) => page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
    const file = page.getByLabel("Restore missing entries from a backup");
    await navigate("Settings");
    await file.setInputFiles(backup("Original expense", "Original task"));
    await confirmAction(page, "Restore backup");
    await expect.poll(async () => (await storedRecords(page)).todoOutbox.length).toBe(1);
    const original = await storedRecords(page);
    expect(original.outbox).toHaveLength(1);

    if (draft === "expense") {
      await navigate("Expenses");
      await page.getByRole("button", { name: /Original expense.*paid/ }).click();
      await page.getByRole("dialog").getByLabel("Description", { exact: true }).fill("Unsubmitted expense edit");
    } else if (draft === "to-do") {
      await navigate("To-dos");
      await page.getByRole("button", { name: "Original task", exact: true }).click();
      await page.getByLabel("Title", { exact: true }).fill("Unsubmitted to-do edit");
    } else if (draft === "CSV import") {
      await navigate("Search");
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.getByLabel("Splitwise CSV").setInputFiles({
        name: "synthetic.csv", mimeType: "text/csv",
        buffer: Buffer.from("Date,Description,Category,Cost,Currency,Alex,Sam\n2024-03-01,Unsubmitted import,General,10.00,EUR,5.00,-5.00")
      });
      await page.getByRole("button", { name: "Preview import" }).click();
      await expect(page.getByRole("button", { name: "Confirm import" })).toBeEnabled();
    } else {
      await file.setInputFiles(backup("Unsubmitted restore expense", "Unsubmitted restore task"));
      await expect(page.getByRole("dialog", { name: "Restore backup" })).toContainText("1 missing entries and 1 missing to-dos");
    }

    const switcher = await context.newPage();
    try {
      await switcher.goto("/");
      await switcher.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
      await switcher.getByRole("button", { name: "Create another household" }).click();
      await confirmAction(switcher, "Create another household");
      await expect(switcher.getByRole("button", { name: "Active household" })).toContainText("Alex & Unnamed");
      await upToDate(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await navigate("Expenses");
      await expect(page.locator(".expense-row")).toHaveCount(0);
      await page.reload();
      await upToDate(page);
      expect(await storedRecords(page)).toEqual({ entries: [], todos: [], outbox: [], todoOutbox: [] });
      expect(await storedRecords(page, source!)).toEqual(original);
    } finally { await switcher.close(); }
  });
}
