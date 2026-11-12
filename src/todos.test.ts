import { describe, expect, it } from "vitest";
import { example, exampleTodo } from "../tests/fixtures";
import { validateEntry } from "../shared/model";
import { householdTodos, insuranceTodos, needsInsuranceSubmission, reorderTodos } from "./todos";

describe("manual todo order", () => {
  const todo = (id: string, createdAt: string, position?: number) =>
    exampleTodo({ id, title: id, createdAt: `2024-03-0${createdAt}T12:00:00.000Z`, ...(position === undefined ? {} : { position }) });
  const ids = (entries: Parameters<typeof householdTodos>[0], manual: Parameters<typeof householdTodos>[1]) =>
    householdTodos(entries, manual).map((item) => item.kind === "manual" ? item.todo.id : `insurance:${item.entry.id}`);

  it("interleaves reminders by date with unsorted manual to-dos", () => {
    const expenses = [
      example({ id: "new", description: "Arzt", date: "2024-03-05" }),
      example({ id: "middle", description: "Apotheke", date: "2024-03-03" }),
      example({ id: "old", description: "Arzt", date: "2024-02-28" })
    ];
    expect(ids(expenses, [todo("first", "4"), todo("second", "2"), { ...todo("done", "5"), done: true }]))
      .toEqual(["insurance:new", "first", "insurance:middle", "second", "insurance:old", "done"]);
  });
  it("keeps reminders in their date-based slots when manual to-dos are reordered or added", () => {
    const expenses = [example({ id: "middle", description: "Apotheke", date: "2024-03-03" })];
    expect(ids(expenses, [todo("first", "4", 1), todo("second", "2", 0)]))
      .toEqual(["second", "insurance:middle", "first"]);
    expect(ids(expenses, [todo("first", "4", 1), todo("second", "2", 0), todo("new", "5")]))
      .toEqual(["new", "second", "insurance:middle", "first"]);
  });
  it("recomputes slots for completed or deleted items and orders equal dates deterministically", () => {
    const expenses = [
      example({ id: "b", description: "Arzt", date: "2024-03-03" }),
      example({ id: "a", description: "Apotheke", date: "2024-03-03" })
    ];
    expect(ids(expenses, [todo("first", "4", 1), todo("second", "2", 0)]))
      .toEqual(["second", "insurance:a", "insurance:b", "first"]);
    expect(ids([{ ...expenses[0], insuranceSubmittedAt: "2024-03-04T00:00:00.000Z" }, expenses[1]],
      [{ ...todo("first", "4", 1), deleted: true }, todo("second", "2", 0)]))
      .toEqual(["insurance:a", "second", "insurance:b"]);
  });
  it("moves one todo between positioned neighbours without touching the others", () => {
    const list = [todo("a", "1", 0), todo("b", "1", 1), todo("c", "1", 2)];
    expect(reorderTodos(list, 2, 0)).toEqual([{ ...list[2], position: -1 }]);
    expect(reorderTodos(list, 0, 2)).toEqual([{ ...list[0], position: 3 }]);
    expect(reorderTodos(list, 0, 1)).toEqual([{ ...list[0], position: 1.5 }]);
    expect(reorderTodos(list, 1, 1)).toEqual([]);
  });
  it("renumbers changed todos when neighbours are unpositioned or out of precision", () => {
    const list = [todo("new", "2"), todo("a", "1", 0), todo("b", "1", 1)];
    expect(reorderTodos(list, 0, 2)).toEqual([{ ...list[0], position: 2 }]);
    expect(reorderTodos(list, 1, 0).map(({ id, position }) => [id, position])).toEqual([["new", 1], ["b", 2]]);
    const tied = [todo("a", "1", 1), todo("b", "1", 1), todo("c", "1", 1)];
    expect(reorderTodos(tied, 2, 1).map(({ id, position }) => [id, position])).toEqual([["a", 0], ["b", 2]]);
  });
});

describe("insurance todos", () => {
  it("combines manual and automatic todos without changing or duplicating expenses", () => {
    const expenses = [example({ description: "Apotheke", id: "shared-id" })];
    const manual = [
      exampleTodo({ id: "shared-id", title: "My todo" }),
      exampleTodo({ id: "done", done: true }),
      exampleTodo({ id: "deleted", deleted: true })
    ];
    const combined = householdTodos(expenses, manual);
    expect(combined.map((todo) => [todo.kind, todo.done])).toEqual([["manual", false], ["insurance", false], ["manual", true]]);
    expect(expenses).toEqual([example({ description: "Apotheke", id: "shared-id" })]);
    expect(insuranceTodos(expenses)).toHaveLength(1);
  });
  it("creates todos only for doctor and pharmacy expenses", () => {
    expect(needsInsuranceSubmission(example({ description: "Apotheke" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Arzt Dr. Huber" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Billa" }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Apotheke", deleted: true }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Something", category: "Pharmacy", categoryMode: "manual" }))).toBe(true);
  });
  it.each(["Augenarzt", "Zahnarzt", "Zahnärztin", "Hautarzt", "Kinderärztin", "HNO-Arzt"])("creates an open insurance todo for %s", (description) => {
    const entry = example({ description, categoryMode: "auto" });
    expect(insuranceTodos([entry])).toEqual([{ entry, done: false }]);
  });
  it.each(["Impfung", "MMR Impfung", "Kontaktlinsen"])("includes historical health expenses recognized as %s without creating manual todos", (description) => {
    const entry = example({ description, date: "2023-06-18", categoryMode: "auto" });
    expect(householdTodos([entry], [])).toEqual([{ kind: "insurance", entry, done: false }]);
    const submitted = { ...entry, insuranceSubmittedAt: "2024-05-02T10:00:00.000Z" };
    expect(householdTodos([submitted], [])).toEqual([{ kind: "insurance", entry: submitted, done: true }]);
  });
  it("respects stored health categories, overrides, and excluded expenses", () => {
    expect(needsInsuranceSubmission(example({ description: "Kontrolle", category: "Gesundheit", kind: "imported" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Augenarzt" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Augenarzt", category: "general", categoryMode: "manual" }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Augenarzt", deleted: true }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Zahnarzt", kind: "settlement" }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Tierarzt" }))).toBe(false);
  });
  it("lists open todos before submitted ones, newest first", () => {
    const todos = insuranceTodos([
      example({ id: "old", description: "Arzt", date: "2024-01-01" }),
      example({ id: "done", description: "Apotheke", date: "2024-05-01", insuranceSubmittedAt: "2024-05-02T10:00:00.000Z" }),
      example({ id: "new", description: "Apotheke", date: "2024-03-01" }),
      example({ id: "food", description: "Billa" })
    ]);
    expect(todos.map((todo) => [todo.entry.id, todo.done])).toEqual([["new", false], ["old", false], ["done", true]]);
  });
  it("syncs the submission state as part of the validated expense", () => {
    expect(validateEntry(example({ insuranceSubmittedAt: "2024-05-02T10:00:00.000Z" })).insuranceSubmittedAt).toBe("2024-05-02T10:00:00.000Z");
    expect(validateEntry(example())).not.toHaveProperty("insuranceSubmittedAt");
    expect(() => validateEntry(example({ insuranceSubmittedAt: "never" }))).toThrow();
  });
});
