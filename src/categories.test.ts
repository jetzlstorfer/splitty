import { describe, expect, it } from "vitest";
import { detectCategory, expenseCategory, normalizeText } from "./categories";

describe("bilingual expense category detection", () => {
  it.each([
    ["BILLA PLUS Einkauf", "groceries"], ["beim Hofer", "groceries"], ["SPAR", "groceries"],
    ["Uni", "groceries"], ["Unimarkt am Freitag", "groceries"], ["INTERSPAR", "groceries"],
    ["Tanken", "fuel"], ["Tanken OMV", "fuel"], ["gas station", "fuel"], ["petrol", "fuel"],
    ["Putzfrau", "cleaning"], ["cleaning lady", "cleaning"], ["Reinigung", "cleaning"],
    ["Friseur", "hairdresser"], ["Frisör", "hairdresser"], ["Frisoer", "hairdresser"], ["haircut", "hairdresser"],
    ["Apotheke", "pharmacy"], ["pharmacy", "pharmacy"], ["Medikamente", "pharmacy"],
    ["ÖBB Ticket", "transport"], ["OeBB", "transport"], ["train ticket", "transport"],
    ["Parkgebühren", "parking"], ["parking", "parking"], ["Pizza", "restaurant"], ["Gasthaus", "restaurant"], ["Essen", "restaurant"],
    ["Café", "coffee"], ["coffee", "coffee"], ["Tierarzt", "pets"], ["vet", "pets"],
    ["Zahnarzt", "health"], ["dentist", "health"], ["IKEA", "home"], ["rent", "home"],
    ["Strom", "utilities"], ["electricity", "utilities"], ["gas bill", "utilities"], ["Gasrechnung", "utilities"],
    ["Internet", "internet"], ["mobile plan", "internet"], ["Kleidung", "shopping"], ["clothes", "shopping"],
    ["Urlaub", "travel"], ["flight", "travel"], ["Geschenk", "gifts"], ["birthday gift", "gifts"],
    ["Versicherung", "insurance"], ["insurance", "insurance"], ["Kino", "entertainment"],
    ["Netflix", "entertainment"], ["Schule", "education"], ["university", "education"],
    ["Kindergarten", "education"], ["kiga", "education"], ["KiGa Beitrag", "education"]
  ])("recognizes %s as %s", (description, category) => {
    expect(detectCategory(description)).toBe(category);
  });
  it.each(["spare parts", "unicorn", "uniform", "gastronomy", "shellfish", "jetlag", "blue sky", "vergessen", "ikigai", "Unknown purchase"])("does not use substring matches for %s", (description) => {
    expect(detectCategory(description)).toBe("general");
  });
  it("preserves meaningful imported categories and payment semantics", () => {
    expect(expenseCategory("Tanken", "Lebensmittel", "imported")).toBe("groceries");
    expect(expenseCategory("Hofer", "Allgemein", "imported")).toBe("groceries");
    expect(expenseCategory("Billa", "Zahlung", "imported")).toBe("payment");
    expect(expenseCategory("Billa", "", "settlement")).toBe("payment");
    expect(expenseCategory("Anything", "Nebenkosten - Sonstiges", "imported")).toBe("utilities");
    expect(expenseCategory("Anything", "Unterhaltung - Sonstiges", "imported")).toBe("entertainment");
    expect(expenseCategory("Monthly fee", "KiGa", "imported")).toBe("education");
  });
  it("supports manual overrides including general and automatic recategorization", () => {
    expect(expenseCategory("Billa", "fuel", "expense", "manual")).toBe("fuel");
    expect(expenseCategory("Billa", "general", "expense", "manual")).toBe("general");
    expect(expenseCategory("Billa", "fuel", "expense", "auto")).toBe("groceries");
    expect(expenseCategory("Payment", "General", "expense")).toBe("general");
  });
  it("normalizes umlauts, transliteration, punctuation and case", () => {
    expect(normalizeText("ÖBB / CAFÉ")).toBe(normalizeText("OeBB cafe"));
    expect(normalizeText("Straße")).toBe(normalizeText("STRASSE"));
  });
});
