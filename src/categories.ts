import type { EntryKind } from "../shared/model";
import type { MessageKey } from "../shared/i18n";

export const categoryLabels = {
  general: "General", groceries: "Groceries", fuel: "Fuel", cleaning: "Cleaning",
  hairdresser: "Hairdresser", pharmacy: "Pharmacy", restaurant: "Restaurant",
  coffee: "Coffee", transport: "Transport", parking: "Parking", car: "Car",
  home: "Home", utilities: "Utilities", internet: "Phone & internet",
  shopping: "Shopping", health: "Health", pets: "Pets", entertainment: "Entertainment",
  travel: "Travel", gifts: "Gifts", insurance: "Insurance", education: "Education",
  payment: "Payment"
} as const satisfies Record<string, MessageKey>;
export type Category = keyof typeof categoryLabels;

export function normalizeText(value: string): string {
  return value.toLocaleLowerCase("de").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const rules: Array<[Category, string[]]> = [
  ["pharmacy", ["apotheke", "apotheken", "pharmacy", "pharmacies", "medikamente", "medikament", "medicine", "medication"]],
  ["hairdresser", ["friseur", "frisör", "friseurin", "friseurbesuch", "haarschnitt", "hairdresser", "haircut", "barber", "hair salon"]],
  ["cleaning", ["putzfrau", "putzhilfe", "reinigung", "reinigungskraft", "cleaning", "cleaner", "cleaning lady", "housekeeping"]],
  ["fuel", ["tanken", "tankstelle", "tankstellen", "benzin", "diesel", "treibstoff", "kraftstoff", "fuel", "petrol", "gas", "gas station", "omv", "bp", "eni", "shell", "avanti", "jet"]],
  ["groceries", ["billa", "hofer", "spar", "interspar", "eurospar", "uni", "unimarkt", "lidl", "aldi", "penny", "rewe", "edeka", "supermarkt", "lebensmittel", "wocheneinkauf", "groceries", "grocery", "supermarket"]],
  ["coffee", ["kaffee", "café", "cafe", "coffee", "starbucks", "cappuccino", "espresso"]],
  ["restaurant", ["restaurant", "restaurants", "gasthaus", "gasthof", "wirtshaus", "abendessen", "mittagessen", "essen", "essen gehen", "pizza", "pizzeria", "dinner", "lunch", "takeaway", "takeout", "lieferando", "foodora", "mcdonalds", "burger", "sushi", "wolt"]],
  ["parking", ["parken", "parkhaus", "parkgarage", "parkgebühr", "parkgebühren", "parking", "garage fee"]],
  ["transport", ["öffis", "öffi", "öbb", "westbahn", "wiener linien", "bus", "zug", "bahn", "taxi", "uber", "tram", "train", "subway", "public transport", "bus zug"]],
  ["utilities", ["strom", "elektrizität", "heizung", "gasrechnung", "erdgas", "wasser", "nebenkosten", "electricity", "heating", "gas bill", "natural gas", "utilities", "water bill"]],
  ["internet", ["internet", "telefon", "handy", "magenta", "a1", "mobilfunk", "broadband", "phone", "mobile plan", "fernsehen telefon internet"]],
  ["pets", ["tierarzt", "tierfutter", "hundefutter", "katzenfutter", "haustiere", "fressnapf", "zooplus", "pets", "pet food", "vet", "veterinarian"]],
  ["health", ["arzt", "ärztin", "zahnarzt", "krankenhaus", "physio", "physiotherapie", "brille", "health", "doctor", "dentist", "hospital", "medical"]],
  ["car", ["auto", "autoreparatur", "werkstatt", "reifen", "vignette", "maut", "car", "car repair", "tires", "tyres", "toll"]],
  ["home", ["miete", "möbel", "haushaltsgegenstände", "haushalt", "baumarkt", "ikea", "obi", "bauhaus", "hornbach", "instandhaltung", "rent", "furniture", "household", "home", "maintenance"]],
  ["shopping", ["kleidung", "schuhe", "drogerie", "bipa", "dm", "h m", "zara", "zalando", "shopping", "clothes", "clothing", "shoes", "electronics", "elektronik"]],
  ["travel", ["hotel", "hotels", "urlaub", "reise", "flug", "flugzeug", "airbnb", "booking", "travel", "holiday", "vacation", "flight", "airfare"]],
  ["gifts", ["geschenk", "geschenke", "geburtstagsgeschenk", "gift", "gifts", "present"]],
  ["insurance", ["versicherung", "versicherungen", "insurance"]],
  ["education", ["schule", "kindergarten", "universität", "studium", "kurs", "education", "school", "university", "tuition"]],
  ["entertainment", ["kino", "netflix", "spotify", "konzert", "museum", "theater", "fitness", "sport", "unterhaltung", "cinema", "movie", "concert", "gym", "entertainment", "games"]]
];

const normalizedRules = rules.map(([category, terms]) => [category, terms.map(normalizeText)] as const);
const aliases = new Map<string, Category>(
  Object.entries(categoryLabels).flatMap(([key, label]) => [[key, key as Category], [normalizeText(label), key as Category]])
);
for (const [category, terms] of normalizedRules) {
  for (const term of terms) if (!aliases.has(term)) aliases.set(term, category);
}
aliases.set("allgemein", "general");
aliases.set("zahlung", "payment");
aliases.set("ausgleich", "payment");
aliases.set("settlement", "payment");
aliases.set("nebenkosten sonstiges", "utilities");
aliases.set("unterhaltung sonstiges", "entertainment");
aliases.set("utilities other", "utilities");
aliases.set("entertainment other", "entertainment");
aliases.set("alcohol", "restaurant");
aliases.set("alkohol", "restaurant");

export function storedCategory(value: string): Category | undefined {
  return aliases.get(normalizeText(value));
}

export function detectCategory(description: string): Category {
  const text = ` ${normalizeText(description)} `;
  // Household gas bills are utilities, not a petrol purchase.
  if (["gas bill", "natural gas", "gasrechnung", "erdgas"].some((term) => text.includes(` ${term} `))) return "utilities";
  for (const [category, terms] of normalizedRules) {
    if (terms.some((term) => text.includes(` ${term} `))) return category;
  }
  return "general";
}

export function expenseCategory(description: string, category = "", kind: EntryKind = "expense", mode?: "auto" | "manual"): Category {
  if (kind === "settlement" || kind === "imported" && storedCategory(category) === "payment") return "payment";
  const stored = storedCategory(category);
  if (kind !== "imported" && mode === "auto") return detectCategory(description);
  if (mode === "manual" && stored && stored !== "payment") return stored;
  if (stored && stored !== "general" && stored !== "payment") return stored;
  return detectCategory(description);
}
