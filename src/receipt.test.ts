import { describe, expect, it } from "vitest";
import { extractReceipt } from "./receipt";

const scan = (text: string, confidence = 95) => extractReceipt(text, confidence);

describe("local receipt extraction", () => {
  it("extracts a German receipt without confusing tax, subtotal or cash with the total", () => {
    expect(scan("HOFER\n19.10.2026\nZwischensumme 30,00\nMWST 2,26\nSUMME EUR 24,90\nBAR 50,00\nRUECKGELD 25,10")).toMatchObject({
      merchant: "HOFER", date: "2026-10-19", amountCents: 2490, currency: "EUR", warnings: []
    });
  });

  it.each([
    ["Grand total EUR 1,234.56", 123456],
    ["Gesamtbetrag EUR 1.234,56", 123456],
    ["Zu zahlen 1 234,56 EUR", 123456],
    ["SUMME\nEUR 24,90", 2490],
    ["TOTAL EUR 24.90\nTOTAL EUR 24.90", 2490]
  ])("recognizes totals and thousands separators: %s", (text, amountCents) => {
    expect(scan(text).amountCents).toBe(amountCents);
  });

  it.each([
    "SUBTOTAL 12.00\nTAX 2.00\nCASH 20.00",
    "Total savings EUR 4.00\nTotal tax EUR 1.00",
    "TOTAL EUR 10.00\nTOTAL EUR 12.00",
    "TOTAL EUR 10.00 12.00",
    "TOTAL\nCASH EUR 50.00",
    "TOTAL EUR -10.00",
    "TOTAL EUR - 10.00",
    "TOTAL - EUR 10.00",
    "TOTAL EUR 10.00-",
    "TOTAL EUR (10.00)",
    "TOTAL EUR -10.00\nTOTAL EUR 12.00",
    "TOTAL EUR 0.00\nTOTAL EUR 12.00",
    "TOTAL EUR 0.00",
    "TOTAL EUR 1000000001.00",
    "Milk 2,00\nBread 3,00",
    "TOTAL 19.10.2026"
  ])("leaves ambiguous, non-expense or unlabeled amounts empty: %s", (text) => {
    const draft = scan(text);
    expect(draft.amountCents).toBeUndefined();
    expect(draft.warnings).toContain("total");
  });

  it.each([
    ["19.10.2026", "2026-10-19"],
    ["1.2.26", "2026-02-01"],
    ["2024-02-29", "2024-02-29"],
    ["19/10/2026", "2026-10-19"],
    ["19.10.2026\n19.10.2026", "2026-10-19"]
  ])("extracts unambiguous calendar dates: %s", (text, date) => {
    expect(scan(text).date).toBe(date);
  });

  it.each(["31.02.2026", "29.02.2025", "19.13.2026", "03/04/2026", "10/19/2026", "19.10.2026\n20.10.2026", "2026-10-00", ""])(
    "does not guess ambiguous or invalid dates: %s", (text) => {
      expect(scan(text).date).toBeUndefined();
      expect(scan(text).warnings).toContain("date");
    }
  );

  it("skips generic headers and addresses when suggesting a merchant", () => {
    expect(scan("Willkommen\nKassenbon\nHauptstr. 12\nBILLA PLUS\n19.10.2026").merchant).toBe("BILLA PLUS");
    expect(scan("19.10.2026\nEUR 24,90\nTOTAL 24,90").merchant).toBeUndefined();
  });

  it.each(["USD", "CHF", "GBP", "PLN", "$", "¥"])("flags a non-EUR currency: %s", (currency) => {
    const draft = scan(`MARKET\nTOTAL ${currency} 24.90`);
    expect(draft.currency).toBe(currency);
    expect(draft.amountCents).toBe(2490);
    expect(draft.warnings).toContain("foreign");
  });

  it("does not treat mixed currencies or missing currency as EUR", () => {
    expect(scan("TOTAL EUR 24.90\nUSD 26.50").warnings).toContain("foreign");
    const draft = scan("TOTAL 24.90");
    expect(draft.currency).toBeUndefined();
    expect(draft.warnings).toContain("currency");
  });

  it("withholds all field suggestions when OCR confidence is low", () => {
    for (const confidence of [0, 69, Number.NaN]) {
      const draft = scan("HOFER\n19.10.2026\nSUMME EUR 24,90", confidence);
      expect(draft.merchant).toBeUndefined();
      expect(draft.date).toBeUndefined();
      expect(draft.amountCents).toBeUndefined();
      expect(draft.warnings).toContain("confidence");
    }
  });
});
