import type { Entry } from "../shared/model";
import { expenseCategory, type Category } from "./categories";

export interface StatisticsSummary {
  total: number;
  count: number;
  average: number;
  largest: Entry | null;
  categories: { category: Category; total: number }[];
  paid: { a: number; b: number; unknown: number };
  months: { month: string; total: number }[];
}

export function summarizeStatistics(entries: Entry[], month: string | null, anchorMonth: string): StatisticsSummary {
  const [year, monthNumber] = anchorMonth.split("-").map(Number);
  const anchor = year * 12 + monthNumber - 1;
  const months = Array.from({ length: 6 }, (_, index) => {
    const value = anchor - 5 + index;
    return {
      month: `${String(Math.floor(value / 12)).padStart(4, "0")}-${String(value % 12 + 1).padStart(2, "0")}`,
      total: 0
    };
  });
  const monthlyTotals = new Map(months.map((item) => [item.month, item]));
  const categories = new Map<Category, number>();
  const paid = { a: 0, b: 0, unknown: 0 };
  let total = 0;
  let count = 0;
  let largest: Entry | null = null;

  for (const entry of entries) {
    if (entry.deleted || entry.kind === "settlement") continue;
    const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
    if (entry.kind === "imported" && category === "payment") continue;

    const entryMonth = entry.date.slice(0, 7);
    const monthlyTotal = monthlyTotals.get(entryMonth);
    if (monthlyTotal) monthlyTotal.total += entry.amountCents;
    if (month !== null && entryMonth !== month) continue;

    total += entry.amountCents;
    count++;
    if (largest === null || entry.amountCents > largest.amountCents) largest = entry;
    categories.set(category, (categories.get(category) ?? 0) + entry.amountCents);
    paid[entry.paidBy ?? "unknown"] += entry.amountCents;
  }

  return {
    total,
    count,
    average: count === 0 ? 0 : Math.round(total / count),
    largest,
    categories: Array.from(categories, ([category, categoryTotal]) => ({ category, total: categoryTotal }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    paid,
    months
  };
}
