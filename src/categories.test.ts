import { describe, expect, it } from "vitest";
import { categoryLabels, detectCategory, expenseCategory, normalizeText, storedCategory, type Category } from "./categories";
import { translate } from "../shared/i18n";

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
  const everydayDescriptions: Array<[Category, string[]]> = [
    ["sports", [
      "Hallenbad", "Freibad", "Hallenbad-Eintritt", "Eintritt ins Freibad", "Schwimmbad mit Kindern",
      "Hallenbäder", "Freibaeder", "Schwimmbäder", "Hallenbadbesuch", "Freibadbesuch", "Schwimmunterricht",
      "Schwimmkurs", "Schwimmhalle", "Strandbad", "Erlebnisbad", "Freibadkarten", "Fitnessstudio",
      "Fitnessabo", "Fitinn", "McFit", "Clever Fit", "Yoga", "Pilates", "Turnverein", "Sportverein",
      "Tennisplatz", "Fußball", "Fussball", "Kletterhalle", "Bouldern", "Skipass", "Schipass",
      "Schikurs", "Eislaufen", "Fahrradservice", "Radservice", "Decathlon", "Intersport",
      "swimming pool", "indoor pool", "outdoor pool", "swimming lessons", "gym membership", "bike repair"
    ]],
    ["groceries", [
      "Lebensmitteleinkauf", "Gemüse", "Bäckerei", "Baeckerei", "Metzgerei", "Bauernmarkt",
      "MPreis", "ADEG", "Sutterlüty", "Nah & Frisch", "Denn's Biomarkt", "Kaufland", "bakery"
    ]],
    ["fuel", ["Tankrechnung", "Ladesäule", "Ladestrom", "E-Auto laden", "EV charging"]],
    ["cleaning", ["Endreinigung", "Textilreinigung", "Wäscherei", "Putzmittel", "Waschmittel", "dry cleaning"]],
    ["hairdresser", ["Friseursalon", "Haare schneiden"]],
    ["pharmacy", ["Rezeptgebühr", "Rezeptgebühren", "Hustensaft", "Nasenspray", "prescription"]],
    ["coffee", ["Kaffeehaus", "Latte Macchiato"]],
    ["restaurant", [
      "Frühstück", "Fruehstueck", "Jause", "Heuriger", "Buschenschank", "Döner", "Doener",
      "Würstelstand", "Mensa", "Eissalon", "McDonald's", "Burger King", "L'Osteria", "food delivery"
    ]],
    ["parking", ["Parkschein", "Parkticket", "Parkpickerl", "Handyparken", "EasyPark"]],
    ["transport", ["Klimaticket", "Vorteilscard", "Bahnticket", "Fahrkarten", "Straßenbahn", "U-Bahn", "Deutschlandticket"]],
    ["utilities", ["Stromrechnung", "Stromnachzahlung", "Heizkosten", "Fernwärme", "Müllabfuhr", "Betriebskosten", "ORF-Beitrag"]],
    ["internet", ["Handyrechnung", "Telefonrechnung", "Spusu", "Drei Tarif", "SIM-Karte", "Glasfaser", "phone bill"]],
    ["pets", ["Tierärztin", "Tieraerztin", "Tierarztrechnung", "Tierklinik", "Katzenstreu", "Hundeschule", "pet sitter"]],
    ["health", ["Wahlarzt", "Arztkosten", "Arztrechnung", "Zahnarztrechnung", "Orthopäde", "Gynäkologin", "Mundhygiene", "Impfung", "Kontaktlinsen", "Psychotherapie"]],
    ["car", ["Pickerl", "Ölwechsel", "Oelwechsel", "Reifenwechsel", "Autowäsche", "ÖAMTC", "ASFINAG", "car wash"]],
    ["home", ["Wohnungsmiete", "Möbelix", "Moebelix", "Mömax", "XXXLutz", "JYSK", "Bettwäsche", "Geschirrspüler", "Installateur"]],
    ["shopping", ["Rossmann", "Windeln", "Feuchttücher", "Deichmann", "MediaMarkt", "Amazon", "H&M", "C&A"]],
    ["travel", ["Flugticket", "Ferienwohnung", "Übernachtung", "Naechtigung", "Campingplatz", "Mietwagen", "car rental"]],
    ["gifts", ["Weihnachtsgeschenke", "Hochzeitsgeschenk", "Mitbringsel", "Blumenstrauß", "birthday gift"]],
    ["insurance", ["Haushaltsversicherung", "Kfz-Versicherung", "Autoversicherung", "Krankenversicherung", "Rechtsschutz", "Vollkasko"]],
    ["education", ["Kindergartenbeitrag", "Kinderkrippe", "Hort", "Schulbedarf", "ÖH-Beitrag", "Nachhilfe", "Musikschule", "daycare"]],
    ["entertainment", ["Kinokarten", "Konzerttickets", "Tiergarten", "Freizeitpark", "Therme", "Brettspiele", "Bücher", "Disney+", "Amazon Prime"]]
  ];
  it.each(everydayDescriptions.flatMap(([category, descriptions]) =>
    descriptions.map((description) => [description, category])))("categorizes everyday German/English expenses: %s → %s", (description, category) => {
    expect(detectCategory(description)).toBe(category);
    expect(detectCategory(description.toLocaleUpperCase("de"))).toBe(category);
  });
  it.each([
    "Hallenbadstraße", "Freibadweg", "Sportplatzstraße", "Baden", "Bad", "Eintritt", "Ticket",
    "Mitgliedsbeitrag", "Drei Personen", "Amazonas", "Kurswechsel", "Buchhaltung", "Parkett", "Reis",
    "BILLAplusartig", "Gartenstraße", "Arztroman", "Schulden", "Gymnastikstraße", ""
  ])("leaves ambiguous descriptions and unrelated substrings in General: %s", (description) => {
    expect(detectCategory(description)).toBe("general");
  });
  it.each([
    ["Handy kaufen", "shopping"], ["Neues Handy", "shopping"], ["Auto Versicherung", "insurance"],
    ["car insurance", "insurance"], ["health insurance", "insurance"], ["car rental", "travel"],
    ["Amazon Prime", "entertainment"], ["Eis essen", "restaurant"],
    ["H&M / birthday gift", "gifts"], ["C&A / christmas gift", "gifts"], ["OMV gas bill", "utilities"]
  ])("prefers a specific phrase over a generic keyword: %s", (description, category) => {
    expect(detectCategory(description)).toBe(category);
  });
  it("recognizes every displayed category name in either language as a stored category", () => {
    for (const [category, label] of Object.entries(categoryLabels)) {
      expect(storedCategory(category)).toBe(category);
      expect(storedCategory(label)).toBe(category);
      expect(storedCategory(translate("de", label))).toBe(category);
    }
  });
  it.each(["Sport", "sports", "Unterhaltung - Sport", "Entertainment - Sports"])("recognizes imported sports categories: %s", (category) => {
    expect(expenseCategory("Eintritt", category, "imported")).toBe("sports");
  });
  it("improves existing automatic and general imports without rewriting explicit choices or payments", () => {
    expect(expenseCategory("Hallenbad", "general", "expense", "auto")).toBe("sports");
    expect(expenseCategory("Freibad", "entertainment", "expense", "auto")).toBe("sports");
    expect(expenseCategory("Hallenbad", "general", "expense", "manual")).toBe("general");
    expect(expenseCategory("Freibad", "entertainment", "expense", "manual")).toBe("entertainment");
    expect(expenseCategory("Hallenbad", "Allgemein", "imported")).toBe("sports");
    expect(expenseCategory("Freibad", "Unknown category", "imported")).toBe("sports");
    expect(expenseCategory("Freibad", "Freizeit", "imported")).toBe("entertainment");
    expect(expenseCategory("Hallenbad", "Zahlung", "imported")).toBe("payment");
    expect(expenseCategory("Freibad", "", "settlement")).toBe("payment");
    expect(expenseCategory("Dinner", "sports", "expense", "manual")).toBe("sports");
  });
  it.each([
    "Augenarzt", "Augenärztin Dr. Huber", "Zahnarzt Kontrolle", "Zahnärztin", "Zahnaerztin",
    "Hausarzt", "Hausärztin", "Hautarzt", "Hautärztin", "Kinderarzt", "Kinderärztin",
    "Frauenarzt", "Frauenärztin", "HNO-Arzt", "HNO-Ärztin", "HNOarzt", "HNOärztin",
    "Facharzt", "Fachärztin"
  ])("recognizes doctor expenses as health: %s", (description) => {
    expect(detectCategory(description)).toBe("health");
  });
  it("recognizes the German health category without overriding explicit categories", () => {
    expect(storedCategory("Gesundheit")).toBe("health");
    expect(expenseCategory("Kontrolle", "Gesundheit", "imported")).toBe("health");
    expect(expenseCategory("Augenarzt", "general", "expense", "manual")).toBe("general");
    expect(expenseCategory("Augenarzt", "pets", "imported")).toBe("pets");
    expect(detectCategory("Tierarzt Kontrolle")).toBe("pets");
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
