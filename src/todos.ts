import type { Entry } from "../shared/model";
import { expenseCategory } from "./categories";

export interface InsuranceTodo { entry: Entry; done: boolean }

export function needsInsuranceSubmission(entry: Entry): boolean {
  if (entry.deleted || entry.kind === "settlement") return false;
  const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
  return category === "health" || category === "pharmacy";
}

export function insuranceTodos(entries: Entry[]): InsuranceTodo[] {
  return entries.filter(needsInsuranceSubmission)
    .map((entry) => ({ entry, done: !!entry.insuranceSubmittedAt }))
    .sort((a, b) => Number(a.done) - Number(b.done) || b.entry.date.localeCompare(a.entry.date) || a.entry.id.localeCompare(b.entry.id));
}
