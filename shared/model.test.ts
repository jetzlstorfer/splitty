import { describe, expect, it } from "vitest";
import { calculateShareA, expenseBalance, parseMoney, validateEntry, validateMutation } from "./model";
import { example } from "../tests/fixtures";

describe("money and accounting", () => {
  it("parses decimal inputs exactly, including comma input", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney("12,3")).toBe(1230);
    expect(parseMoney("-1.01", true)).toBe(-101);
  });
  it.each(["", "1.234", "1,234.56", "NaN", "1e3", "-1", "Infinity", "1.0.0"])("rejects invalid amount %s", (input) => {
    expect(() => parseMoney(input)).toThrow();
  });
  it("computes both payer directions and 100% on-behalf splits", () => {
    expect(expenseBalance(2000, "a", 1000)).toBe(1000);
    expect(expenseBalance(2000, "b", 1000)).toBe(-1000);
    expect(expenseBalance(2000, "a", 0)).toBe(2000);
    expect(expenseBalance(2000, "b", 2000)).toBe(-2000);
  });
  it("validates settlements as payments rather than additional expenses", () => {
    expect(validateEntry(example({ kind: "settlement", shareA: null, balanceA: 1001 }))).toMatchObject({ balanceA: 1001 });
    expect(() => validateEntry(example({ kind: "settlement", shareA: null }))).toThrow("settlement");
  });
  it("rejects mismatched balance, invalid dates, unsafe identifiers and versions", () => {
    for (const patch of [{ balanceA: 400 }, { date: "2024-02-30" }, { id: "../foo" }, { shareA: 1002 }]) {
      expect(() => validateEntry(example(patch))).toThrow();
    }
    expect(() => validateMutation({ id: "mutation", expectedRevision: 1, entry: example() })).toThrow("version");
  });
  it("retains exact split semantics and rounds percentages in integer basis points", () => {
    expect(calculateShareA(1001, "a", "equal")).toBe(501);
    expect(calculateShareA(1001, "b", "equal")).toBe(500);
    expect(calculateShareA(800, "a", "percent", 25)).toBe(200);
    expect(calculateShareA(10000, "a", "percent", 33.33)).toBe(3333);
    expect(validateEntry(example({ splitType: "equal" })).splitType).toBe("equal");
    expect(() => validateEntry(example({ splitType: "percent", percentageA: 25 }))).toThrow("split method");
    expect(() => validateEntry(example({ splitType: "percent" }))).toThrow("split method");
  });
});
