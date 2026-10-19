import type { Entry } from "../shared/model";
import type { Todo } from "../shared/todo";

export const example = (overrides: Partial<Entry> = {}): Entry => ({
  id: "test-entry", kind: "expense", description: "Groceries", category: "General",
  date: "2024-03-01", currency: "EUR", amountCents: 1001, paidBy: "a", shareA: 501,
  balanceA: 500, revision: 1, updatedAt: "2024-03-01T12:00:00.000Z", deleted: false, ...overrides
});

export const exampleTodo = (overrides: Partial<Todo> = {}): Todo => ({
  id: "test-todo", title: "Book an appointment", done: false,
  revision: 1, createdAt: "2024-03-01T12:00:00.000Z", updatedAt: "2024-03-01T12:00:00.000Z", deleted: false, ...overrides
});
