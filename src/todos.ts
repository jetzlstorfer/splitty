import type { Entry } from "../shared/model";
import type { Todo } from "../shared/todo";
import { expenseCategory } from "./categories";

export interface InsuranceTodo { entry: Entry; done: boolean }
export type HouseholdTodo = (InsuranceTodo & { kind: "insurance" }) | { kind: "manual"; todo: Todo; done: boolean };

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

export function householdTodos(entries: Entry[], manual: Todo[]): HouseholdTodo[] {
  const todos: HouseholdTodo[] = [
    ...insuranceTodos(entries).map((todo) => ({ ...todo, kind: "insurance" as const })),
    ...manual.filter((todo) => !todo.deleted).map((todo) => ({ kind: "manual" as const, todo, done: todo.done }))
  ];
  const date = (item: HouseholdTodo) => item.kind === "manual" ? item.todo.createdAt : item.entry.date;
  const id = (item: HouseholdTodo) => item.kind === "manual" ? item.todo.id : item.entry.id;
  return todos.sort((a, b) => Number(a.done) - Number(b.done) || date(b).localeCompare(date(a)) || id(a).localeCompare(id(b)));
}
