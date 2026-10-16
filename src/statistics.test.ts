import { describe, expect, it } from "vitest";
import type { Entry } from "../shared/model";
import { previewImport } from "./importer";
import { summarizeStatistics } from "./statistics";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "expense", kind: "expense", description: "Purchase", date: "2025-01-15",
    category: "general", currency: "EUR", amountCents: 100, paidBy: "a",
    shareA: 50, balanceA: 50, revision: 1, updatedAt: "2025-01-15T00:00:00Z",
    deleted: false, ...overrides
  };
}

function imported(overrides: Partial<Entry> = {}): Entry {
  return entry({ kind: "imported", paidBy: null, shareA: null, importKey: "import", ...overrides });
}

describe("expense statistics", () => {
  it("returns empty totals and six zero-filled months across a year boundary", () => {
    expect(summarizeStatistics([], null, "2025-02")).toEqual({
      total: 0, count: 0, average: 0, largest: null, categories: [],
      paid: { a: 0, b: 0, unknown: 0 },
      months: [
        { month: "2024-09", total: 0 }, { month: "2024-10", total: 0 },
        { month: "2024-11", total: 0 }, { month: "2024-12", total: 0 },
        { month: "2025-01", total: 0 }, { month: "2025-02", total: 0 }
      ]
    });
  });

  it("pads early years to four digits across the minimum selectable year's boundary", () => {
    const result = summarizeStatistics([
      entry({ date: "0001-01-01", amountCents: 125 })
    ], "0001-01", "0001-01");
    expect(result.months).toEqual([
      { month: "0000-08", total: 0 }, { month: "0000-09", total: 0 },
      { month: "0000-10", total: 0 }, { month: "0000-11", total: 0 },
      { month: "0000-12", total: 0 }, { month: "0001-01", total: 125 }
    ]);
    expect(result).toMatchObject({ total: 125, count: 1 });
  });

  it("filters the summary at month boundaries without filtering the six-month chart", () => {
    const januaryLast = entry({ id: "last", date: "2025-01-31", amountCents: 300, paidBy: "b" });
    const result = summarizeStatistics([
      entry({ date: "2024-07-31", amountCents: 10 }),
      entry({ date: "2024-08-01", amountCents: 20 }),
      entry({ date: "2024-12-31", amountCents: 30 }),
      entry({ date: "2025-01-01", amountCents: 100 }),
      januaryLast,
      entry({ date: "2025-02-01", amountCents: 40 })
    ], "2025-01", "2025-01");
    expect(result).toMatchObject({
      total: 400, count: 2, average: 200, largest: januaryLast,
      categories: [{ category: "general", total: 400 }],
      paid: { a: 100, b: 300, unknown: 0 }
    });
    expect(result.months).toEqual([
      { month: "2024-08", total: 20 }, { month: "2024-09", total: 0 },
      { month: "2024-10", total: 0 }, { month: "2024-11", total: 0 },
      { month: "2024-12", total: 30 }, { month: "2025-01", total: 400 }
    ]);
  });

  it("includes all-time entries outside the chart and handles leap days", () => {
    const entries = [
      entry({ date: "2023-12-31", amountCents: 100 }),
      entry({ date: "2024-02-29", amountCents: 200 }),
      entry({ date: "2024-03-01", amountCents: 300 }),
      entry({ date: "2024-09-01", amountCents: 400 })
    ];
    const allTime = summarizeStatistics(entries, null, "2024-07");
    expect(allTime).toMatchObject({ total: 1000, count: 4, average: 250 });
    expect(allTime.months).toEqual([
      { month: "2024-02", total: 200 }, { month: "2024-03", total: 300 },
      { month: "2024-04", total: 0 }, { month: "2024-05", total: 0 },
      { month: "2024-06", total: 0 }, { month: "2024-07", total: 0 }
    ]);
    expect(summarizeStatistics(entries, "2024-02", "2024-07")).toMatchObject({ total: 200, count: 1 });
    const emptyPeriod = summarizeStatistics(entries, "2024-01", "2024-07");
    expect(emptyPeriod).toMatchObject({
      total: 0, count: 0, average: 0, largest: null, categories: [],
      paid: { a: 0, b: 0, unknown: 0 }, months: allTime.months
    });
  });

  it("excludes deleted entries, settlements and imported payment aliases from every total", () => {
    const entries = [
      entry({ deleted: true, amountCents: 10000 }),
      imported({ deleted: true, amountCents: 10000 }),
      entry({ kind: "settlement", category: "groceries", amountCents: 10000 }),
      ...["payment", "Zahlung", "Ausgleich", "settlement"].map((category) =>
        imported({ category, categoryMode: "manual", description: "Billa", amountCents: 10000 })),
      entry({ description: "Payment", category: "payment" })
    ];
    const result = summarizeStatistics(entries, null, "2025-01");
    expect(result).toMatchObject({
      total: 100, count: 1, average: 100, largest: entries.at(-1),
      categories: [{ category: "general", total: 100 }],
      paid: { a: 100, b: 0, unknown: 0 }
    });
    expect(result.months.at(-1)?.total).toBe(100);
    expect(summarizeStatistics(entries.slice(0, -1), null, "2025-01").largest).toBeNull();
  });

  it("preserves imported refunds and unknown payers without inferring a payer from balances", async () => {
    const preview = await previewImport(
      "Date,Description,Category,Cost,Currency,Alex,Sam\n"
      + "2025-01-01,Dinner,Restaurant,10.01,EUR,-5.01,5.01\n"
      + "2025-01-02,Refund,Shopping,-20.00,EUR,10.00,-10.00\n"
      + "2025-01-03,Payment,Payment,30.00,EUR,30.00,-30.00\n",
      "Alex", new Set()
    );
    expect(preview.errors).toEqual([]);
    const result = summarizeStatistics([...preview.entries, entry({ amountCents: 100, paidBy: "b" })], null, "2025-01");
    expect(result).toMatchObject({
      total: -899, count: 3, average: -300, largest: preview.entries[0],
      categories: [
        { category: "shopping", total: -2000 },
        { category: "restaurant", total: 1001 },
        { category: "general", total: 100 }
      ],
      paid: { a: 0, b: 100, unknown: -999 }
    });
    expect(result.months.at(-1)?.total).toBe(-899);
  });

  it("honors automatic and manual categories, including imported legacy categories", () => {
    const result = summarizeStatistics([
      entry({ description: "Billa", category: "fuel", categoryMode: "auto", amountCents: 600 }),
      entry({ description: "Billa", category: "fuel", categoryMode: "manual", amountCents: 300 }),
      entry({ description: "Billa", category: "general", categoryMode: "manual", amountCents: 200 }),
      imported({ description: "Tanken", category: "Lebensmittel", categoryMode: "auto", amountCents: 400 }),
      imported({ description: "Hofer", category: "Allgemein", amountCents: 100 })
    ], null, "2025-01");
    expect(result.categories).toEqual([
      { category: "groceries", total: 1100 },
      { category: "fuel", total: 300 },
      { category: "general", total: 200 }
    ]);
  });

  it("rounds an average to the nearest cent and leaves entries unchanged", () => {
    const first = Object.freeze(entry({ id: "first", amountCents: 100 }));
    const second = Object.freeze(entry({ id: "second", amountCents: 101 }));
    const entries = [second, first];
    const result = summarizeStatistics(entries, null, "2025-01");
    expect(result.average).toBe(101);
    expect(result.largest).toBe(second);
    expect(entries).toEqual([second, first]);
  });

  it("selects the greatest signed amount for refund-only data", () => {
    const smallerRefund = imported({ id: "smaller", amountCents: -100 });
    const result = summarizeStatistics([
      imported({ amountCents: -501 }), smallerRefund
    ], null, "2025-01");
    expect(result).toMatchObject({ total: -601, count: 2, average: -300, largest: smallerRefund });
  });
});
