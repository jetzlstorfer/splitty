import { describe, expect, it } from "vitest";
import { exampleTodo } from "../tests/fixtures";
import { validateChange } from "./model";
import { MAX_TODO_TITLE, MAX_TODO_DESCRIPTION, validateTodo } from "./todo";

describe("manual to-dos", () => {
  it("requires only a title and normalizes optional descriptions", () => {
    expect(validateTodo(exampleTodo({ title: "  Call dentist  " }))).toMatchObject({ title: "Call dentist" });
    expect(validateTodo(exampleTodo({ description: " \n " }))).not.toHaveProperty("description");
    expect(validateTodo(exampleTodo({ description: "  Call after lunch\nAsk about dates  " })).description).toBe("Call after lunch\nAsk about dates");
    expect(validateTodo({ ...exampleTodo(), balanceA: 100 })).not.toHaveProperty("balanceA");
  });
  it("enforces the exact title and description limits", () => {
    expect(validateTodo(exampleTodo({ title: "a".repeat(MAX_TODO_TITLE), description: "b".repeat(MAX_TODO_DESCRIPTION) })).title).toHaveLength(MAX_TODO_TITLE);
    expect(() => validateTodo(exampleTodo({ title: "a".repeat(MAX_TODO_TITLE + 1) }))).toThrow("title");
    expect(() => validateTodo(exampleTodo({ description: "b".repeat(MAX_TODO_DESCRIPTION + 1) }))).toThrow("description");
  });
  it.each([
    { title: "" }, { title: " \n " }, { title: null }, { description: 123 }, { description: null },
    { id: "../invalid" }, { done: 1 }, { deleted: null }, { revision: -1 }, { revision: 0.5 },
    { createdAt: "never" }, { updatedAt: "never" }
  ])("rejects invalid fields: %j", (fields) => {
    expect(() => validateTodo({ ...exampleTodo(), ...fields })).toThrow();
  });
  it("validates versioned todo mutations using the same revision contract as expenses", () => {
    const change = { id: "change-1", entry: exampleTodo(), expectedRevision: 0 };
    expect(validateChange(change, validateTodo)).toEqual(change);
    expect(() => validateChange({ ...change, expectedRevision: 1 }, validateTodo)).toThrow("version");
  });
});
