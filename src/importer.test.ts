import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previewImport, readCsv } from "./importer";

const header = "Datum,Beschreibung,Kategorie,Kosten,Währung,Alex,Sam\n";
const fixture = header
  + '2024-01-01,"Dinner, together",Restaurant,83.07,EUR,-41.54,41.54\n'
  + "2024-01-02,Payment,Zahlung,10.00,EUR,10.00,-10.00\n"
  + "2024-01-03,Refund,General,-2.00,EUR,1.00,-1.00\n"
  + "2024-01-04,Gesamtbilanz,,,EUR,-30.54,30.54\n";

describe("Splitwise import", () => {
  it("preserves signed cents, settlements and refunds and verifies the summary", async () => {
    const result = await previewImport(fixture, "Alex", new Set());
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(3);
    expect(result.balanceA).toBe(-3054);
    expect(result.expectedBalanceA).toBe(-3054);
    expect(result.entries[0]).toMatchObject({ paidBy: null, shareA: null, balanceA: -4154, description: "Dinner, together" });
  });
  it("re-imports without duplicates while preserving genuine identical rows", async () => {
    const text = header + "2024-01-01,Coffee,General,4.00,EUR,2.00,-2.00\n".repeat(2);
    const first = await previewImport(text, "Alex", new Set());
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].id).not.toBe(first.entries[1].id);
    const second = await previewImport(text, "Alex", new Set(first.entries.map((entry) => entry.id)));
    expect(second.entries).toHaveLength(0);
    expect(second.duplicates).toBe(2);
    expect(second.balanceA).toBe(400);
  });
  it("maps the other person without changing deterministic source identifiers", async () => {
    const a = await previewImport(fixture, "Alex", new Set());
    const b = await previewImport(fixture, "Sam", new Set());
    expect(a.entries[0].id).toBe(b.entries[0].id);
    expect(a.balanceA).toBe(-b.balanceA);
  });
  it.each([
    ["EUR,-41.54,41.54", "USD,-41.54,41.54"],
    ["EUR,-41.54,41.54", "EUR,-41.54,41.53"],
    ["EUR,-30.54,30.54", "EUR,-30.55,30.55"],
    ["2024-01-01", "2024-02-30"],
    ["83.07", "83.071"]
  ])("rejects invalid input rather than silently dropping rows (%s)", async (from, to) => {
    expect((await previewImport(fixture.replace(from, to), "Alex", new Set())).errors.length).toBeGreaterThan(0);
  });
  it("supports English exports and a BOM", async () => {
    const english = "\uFEFFDate,Description,Category,Cost,Currency,Alex,Sam\n2024-01-01,Food,General,10.00,EUR,5.00,-5.00";
    expect(readCsv(english).members).toEqual(["Alex", "Sam"]);
    expect((await previewImport(english, "Alex", new Set())).entries).toHaveLength(1);
  });
  it("rejects more than two people", () => {
    expect(() => readCsv(header.trim() + ",Third\n")).toThrow("exactly two");
  });
  it.skipIf(!process.env.SPLITWISE_EXPORT)("reconciles the supplied private export locally", async () => {
    const text = readFileSync(process.env.SPLITWISE_EXPORT!, "utf8");
    const { members } = readCsv(text);
    const result = await previewImport(text, members[0], new Set());
    expect(result.errors.length).toBe(0);
    expect(result.entries).toHaveLength(3001);
    expect(result.entries.filter((entry) => entry.category === "Zahlung")).toHaveLength(15);
    expect(result.balanceA).toBe(result.expectedBalanceA);
    const repeated = await previewImport(text, members[0], new Set(result.entries.map((entry) => entry.id)));
    expect(repeated.entries).toHaveLength(0);
    expect(repeated.duplicates).toBe(3001);
  });
});
