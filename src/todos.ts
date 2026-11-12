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

export function compareManualTodos(a: Todo, b: Todo): number {
  const unordered = Number(b.position === undefined) - Number(a.position === undefined);
  if (unordered) return unordered;
  return (a.position ?? 0) - (b.position ?? 0) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** Moves one manual to-do and returns only the to-dos whose position must change. */
export function reorderTodos(ordered: Todo[], from: number, to: number): Todo[] {
  if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) return [];
  const next = [...ordered];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const lower = next[to - 1]?.position, upper = next[to + 1]?.position;
  const first = to === 0, last = to === next.length - 1;
  if ((first || lower !== undefined) && (last || upper !== undefined)) {
    const position = first ? upper! - 1 : last ? lower! + 1 : (lower! + upper!) / 2;
    // Midpoints run out of float precision eventually; renumber the list when that happens.
    if ((first || lower! < position) && (last || position < upper!)) return [{ ...moved, position }];
  }
  return next.flatMap((todo, index) => todo.position === index ? [] : [{ ...todo, position: index }]);
}

export function householdTodos(entries: Entry[], manual: Todo[], manualOrder = false): HouseholdTodo[] {
  const visible = manual.filter((todo) => !todo.deleted);
  const insurance = insuranceTodos(entries).map((todo) => ({ ...todo, kind: "insurance" as const }));
  const date = (item: HouseholdTodo) => item.kind === "manual" ? item.todo.createdAt : item.entry.date;
  const id = (item: HouseholdTodo) => item.kind === "manual" ? item.todo.id : item.entry.id;
  const openManual = visible.filter((todo) => !todo.done).map((todo) => ({ kind: "manual" as const, todo, done: false }));
  const openInsurance = insurance.filter((todo) => !todo.done);
  const open = manualOrder
    ? [...openManual.sort((a, b) => compareManualTodos(a.todo, b.todo)), ...openInsurance]
    : [...openManual, ...openInsurance]
      .sort((a, b) => date(b).localeCompare(date(a)) || id(a).localeCompare(id(b)));
  const done: HouseholdTodo[] = [
    ...insurance.filter((todo) => todo.done),
    ...visible.filter((todo) => todo.done).map((todo) => ({ kind: "manual" as const, todo, done: true }))
  ].sort((a, b) => date(b).localeCompare(date(a)) || id(a).localeCompare(id(b)));
  return [
    ...open,
    ...done
  ];
}
