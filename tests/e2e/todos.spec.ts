import { expect, test, type Page } from "@playwright/test";

async function add(page: Page, description: string) {
  await page.locator(".add-button").click();
  const dialog = page.getByRole("dialog", { name: "Ausgabe hinzufügen" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill(description);
  await dialog.getByRole("textbox", { name: "Betrag in EUR" }).fill("20,00");
  await dialog.getByLabel("Datum", { exact: true }).fill("2026-10-01");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("doctor and pharmacy expenses create insurance to-dos that can be checked off", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("button")).toHaveText([/Ausgaben/, /To-dos/, /Suche/, /Statistik/, /Einstellungen/]);
  await add(page, "Apotheke");
  await add(page, "Arzt Dr. Huber");
  await add(page, "Billa");

  await nav.getByRole("button", { name: "To-dos" }).click();
  await expect(page.getByRole("heading", { name: /^To-dos/, level: 1 })).toContainText("2");
  const open = page.getByRole("region", { name: "Offene To-dos" });
  await expect(open.getByRole("listitem")).toHaveCount(2);
  await expect(open.getByRole("listitem").first()).toContainText("Bei Versicherung einreichen");
  await expect(open).toContainText("Ausgabe: Apotheke");
  await expect(open).toContainText("Ausgabe: Arzt Dr. Huber");
  await expect(page.getByText("Billa")).toHaveCount(0);

  await open.getByRole("listitem").filter({ hasText: "Apotheke" }).getByRole("checkbox").click();
  const done = page.getByRole("region", { name: "Erledigt" });
  await expect(done.getByRole("checkbox")).toBeChecked();
  await expect(done).toContainText("Ausgabe: Apotheke");
  await expect(open.getByRole("listitem")).toHaveCount(1);

  await page.reload();
  await nav.getByRole("button", { name: "To-dos" }).click();
  await expect(page.getByRole("region", { name: "Erledigt" })).toContainText("Apotheke");

  await page.getByRole("button", { name: "Ausgabe öffnen: Apotheke" }).click();
  const dialog = page.getByRole("dialog", { name: "Eintrag bearbeiten" });
  await dialog.getByLabel("Beschreibung", { exact: true }).fill("Apotheke Rezept");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("region", { name: "Erledigt" })).toContainText("Apotheke Rezept");
});
