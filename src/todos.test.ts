import { describe, expect, it } from "vitest";
import { example } from "../tests/fixtures";
import { validateEntry } from "../shared/model";
import { insuranceTodos, needsInsuranceSubmission } from "./todos";

describe("insurance todos", () => {
  it("creates todos only for doctor and pharmacy expenses", () => {
    expect(needsInsuranceSubmission(example({ description: "Apotheke" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Arzt Dr. Huber" }))).toBe(true);
    expect(needsInsuranceSubmission(example({ description: "Billa" }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Apotheke", deleted: true }))).toBe(false);
    expect(needsInsuranceSubmission(example({ description: "Something", category: "Pharmacy", categoryMode: "manual" }))).toBe(true);
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
