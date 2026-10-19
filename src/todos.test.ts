import { describe, expect, it } from "vitest";
import { example, exampleTodo } from "../tests/fixtures";
import { validateEntry } from "../shared/model";
import { householdTodos, insuranceTodos, needsInsuranceSubmission } from "./todos";

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
