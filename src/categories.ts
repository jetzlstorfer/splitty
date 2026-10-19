import type { EntryKind } from "../shared/model";
import { translate, type MessageKey } from "../shared/i18n";

export const categoryLabels = {
  general: "General", groceries: "Groceries", fuel: "Fuel", cleaning: "Cleaning",
  hairdresser: "Hairdresser", pharmacy: "Pharmacy", restaurant: "Restaurant",
  coffee: "Coffee", transport: "Transport", parking: "Parking", car: "Car",
  home: "Home", utilities: "Utilities", internet: "Phone & internet",
  shopping: "Shopping", health: "Health", pets: "Pets", entertainment: "Entertainment",
  travel: "Travel", gifts: "Gifts", insurance: "Insurance", education: "Education", sports: "Sport",
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
  ["pharmacy", [
    "apotheke", "apotheken", "medikamente", "medikament", "rezeptgebühr", "rezeptgebühren",
    "schmerzmittel", "hustensaft", "nasenspray", "antibiotika", "pharmacy", "pharmacies", "medicine", "medication", "prescription"
  ]],
  ["hairdresser", [
    "friseur", "frisör", "friseurin", "friseurbesuch", "friseursalon", "haarschnitt", "haare schneiden",
    "hairdresser", "haircut", "barber", "hair salon"
  ]],
  ["cleaning", [
    "putzfrau", "putzhilfe", "reinigung", "reinigungskraft", "endreinigung", "gebäudereinigung",
    "textilreinigung", "wäscherei", "putzmittel", "reinigungsmittel", "waschmittel",
    "cleaning", "cleaner", "cleaning lady", "housekeeping", "laundry", "dry cleaning"
  ]],
  ["fuel", [
    "tanken", "tankstelle", "tankstellen", "tankrechnung", "benzin", "diesel", "treibstoff", "kraftstoff",
    "ladestation", "ladesäule", "ladestrom", "auto laden", "e auto laden",
    "fuel", "petrol", "gas", "gas station", "ev charging", "omv", "bp", "eni", "shell", "avanti", "jet"
  ]],
  ["groceries", [
    "billa", "hofer", "spar", "interspar", "eurospar", "spar gourmet", "uni", "unimarkt", "lidl", "aldi",
    "penny", "rewe", "edeka", "merkur", "mpreis", "denn s", "denns", "denn's biomarkt", "nah frisch",
    "adeg", "sutterlüty", "kaufland", "netto", "norma", "tegut", "supermarkt", "lebensmittel",
    "lebensmitteleinkauf", "wocheneinkauf", "gemüse", "obst", "bäckerei", "bäcker", "backerei",
    "fleischerei", "metzger", "metzgerei", "bauernmarkt", "wochenmarkt", "biomarkt", "brot", "semmeln",
    "groceries", "grocery", "supermarket", "bakery", "butcher", "farmers market"
  ]],
  ["coffee", [
    "kaffee", "café", "cafe", "kaffeehaus", "coffee", "starbucks", "cappuccino", "espresso", "latte macchiato"
  ]],
  ["restaurant", [
    "restaurant", "restaurants", "restaurantbesuch", "gasthaus", "gasthof", "wirtshaus", "wirt", "heuriger", "buschenschank",
    "abendessen", "mittagessen", "frühstück", "brunch", "jause", "jausn", "essen", "essen gehen",
    "pizza", "pizzeria", "döner", "kebab", "imbiss", "würstelstand", "kantine", "mensa",
    "schnitzel", "burger", "sushi", "eis essen", "eissalon", "eisdiele", "bier", "wein", "cocktails",
    "dinner", "lunch", "breakfast", "takeaway", "takeout", "food delivery", "lieferando", "foodora",
    "mcdonalds", "mcdonald s", "burger king", "vapiano", "l osteria", "wolt", "pub"
  ]],
  ["parking", [
    "parken", "parkhaus", "parkgarage", "parkgebühr", "parkgebühren", "parkschein", "parkscheine",
    "parkticket", "parkplatz", "parkpickerl", "kurzparkzone", "handyparken", "easypark",
    "parking", "garage fee", "parking meter"
  ]],
  ["transport", [
    "öffis", "öffi", "öbb", "westbahn", "wiener linien", "linz ag linien", "graz linien", "vorteilscard",
    "klimaticket", "busticket", "bahnticket", "zugticket", "fahrkarte", "fahrkarten", "fahrschein",
    "monatskarte", "jahreskarte öffis", "deutschlandticket", "bahncard", "bahnfahrt", "zugfahrt",
    "bus", "zug", "bahn", "taxi", "uber", "bolt", "tram", "straßenbahn", "u bahn", "s bahn",
    "train", "subway", "public transport", "bus zug", "flixbus", "ferry", "fähre"
  ]],
  ["utilities", [
    "strom", "stromrechnung", "stromkosten", "stromnachzahlung", "elektrizität", "heizung", "heizkosten",
    "fernwärme", "gasrechnung", "erdgas", "wasser", "wasserrechnung", "abwasser", "kanalgebühr",
    "müllabfuhr", "müllgebühr", "müllgebühren", "betriebskosten", "nebenkosten", "rundfunkbeitrag",
    "orf beitrag", "gis", "electricity", "heating", "gas bill", "natural gas", "utilities", "water bill"
  ]],
  ["internet", [
    "internet", "internetrechnung", "telefon", "telefonrechnung", "handy", "handyrechnung", "handytarif",
    "magenta", "a1", "drei tarif", "drei rechnung", "spusu", "hot tarif", "yesss", "mobilfunk", "sim karte", "breitband",
    "glasfaser", "wlan", "broadband", "phone", "mobile plan", "phone bill", "fernsehen telefon internet"
  ]],
  ["pets", [
    "tierarzt", "tierärztin", "tierarztkosten", "tierarztrechnung", "tierklinik", "tierrettung", "tierfutter",
    "hundefutter", "katzenfutter", "katzenstreu", "hundeschule", "hundesteuer", "hundesitter", "tierpension",
    "haustiere", "fressnapf", "zooplus", "futterhaus", "pets", "pet food", "vet", "veterinarian", "pet sitter"
  ]],
  ["health", [
    "arzt", "ärztin", "arztbesuch", "arztkosten", "arztrechnung", "arzthonorar", "wahlarzt", "wahlärztin", "ordination",
    "augenarzt", "augenärztin", "zahnarzt", "zahnärztin", "hausarzt", "hausärztin", "hautarzt", "hautärztin",
    "kinderarzt", "kinderärztin", "frauenarzt", "frauenärztin", "hno arzt", "hno ärztin", "hnoarzt", "hnoärztin",
    "facharzt", "fachärztin", "orthopäde", "orthopädin", "gynäkologe", "gynäkologin", "urologe", "urologin",
    "dermatologe", "dermatologin", "krankenhaus", "spital", "physio", "physiotherapie", "ergotherapie",
    "psychotherapie", "psychologe", "psychologin", "logopädie", "zahnarztkosten", "zahnarztrechnung",
    "zahnreinigung", "zahnspange", "mundhygiene",
    "impfung", "impfungen", "blutbild", "laborbefund", "brille", "kontaktlinsen", "optiker", "fielmann",
    "gesundheit", "health", "doctor", "dentist", "hospital", "medical", "therapy", "vaccination"
  ]],
  ["car", [
    "auto", "autoreparatur", "autowerkstatt", "autoservice", "werkstatt", "ölwechsel", "reifen", "reifenwechsel",
    "winterreifen", "sommerreifen", "pickerl", "vignette", "maut", "asfinag", "öamtc", "arbö", "adac",
    "autowäsche", "waschstraße", "scheibenwischer", "ersatzteile auto", "car", "car repair", "car wash",
    "tires", "tyres", "toll", "vehicle inspection"
  ]],
  ["home", [
    "miete", "monatsmiete", "wohnungsmiete", "möbel", "haushaltsgegenstände", "haushaltswaren", "haushalt",
    "baumarkt", "ikea", "obi", "bauhaus", "hornbach", "möbelix", "mömax", "xxxlutz", "jysk", "kika", "leiner",
    "instandhaltung", "renovierung", "umzug", "kaution", "küche", "geschirr", "bettwäsche", "matratze",
    "waschmaschine", "geschirrspüler", "kühlschrank", "staubsauger", "vorhänge", "lampe",
    "installateur", "elektriker", "schlüsseldienst", "garten", "gartencenter", "bellaflora",
    "rent", "furniture", "household", "home", "maintenance", "plumber", "house moving"
  ]],
  ["shopping", [
    "kleidung", "schuhe", "bekleidung", "hose", "hosen", "jacke", "jacken", "pullover", "t shirt", "socken",
    "drogerie", "bipa", "dm", "müller", "rossmann", "kosmetik", "shampoo", "windeln", "feuchttücher",
    "h m", "c a", "zara", "zalando", "primark", "hervis", "deichmann", "humanic", "peek cloppenburg", "tk maxx", "tedi",
    "shopping", "clothes", "clothing", "shoes", "electronics", "elektronik", "mediamarkt", "media markt",
    "saturn", "amazon", "handy kaufen", "neues handy", "phone case"
  ]],
  ["travel", [
    "hotel", "hotels", "urlaub", "reise", "reisen", "flug", "flugzeug", "flugticket", "flugtickets",
    "flugbuchung", "airbnb", "booking", "pension", "ferienwohnung", "unterkunft", "übernachtung",
    "nächtigung", "hostel", "camping", "campingplatz", "mietwagen", "autovermietung", "kurtaxe",
    "tourismusabgabe", "austrian airlines", "ryanair", "lufthansa",
    "travel", "holiday", "vacation", "flight", "airfare", "accommodation", "car rental"
  ]],
  ["gifts", [
    "geschenk", "geschenke", "geburtstagsgeschenk", "geburtstagsgeschenke", "weihnachtsgeschenk",
    "weihnachtsgeschenke", "hochzeitsgeschenk", "mitbringsel", "blumenstrauß", "spende", "spenden",
    "gift", "gifts", "present", "birthday gift", "christmas gift", "wedding gift", "donation", "donations"
  ]],
  ["insurance", [
    "versicherung", "versicherungen", "versicherungsprämie", "haushaltsversicherung", "haftpflicht",
    "haftpflichtversicherung", "kfz versicherung", "auto versicherung", "autoversicherung", "krankenversicherung",
    "unfallversicherung", "rechtsschutz", "rechtsschutzversicherung", "reiseversicherung",
    "lebensversicherung", "kasko", "vollkasko", "teilkasko", "insurance", "car insurance", "health insurance"
  ]],
  ["sports", [
    "sport", "sports", "hallenbad", "hallenbäder", "freibad", "freibäder", "schwimmbad", "schwimmbäder",
    "schwimmen", "schwimmkurs", "schwimmkurse", "schwimmunterricht", "schwimmtraining",
    "schwimmhalle", "strandbad", "seebad", "erlebnisbad", "hallenbadeintritt", "freibadeintritt",
    "hallenbadbesuch", "freibadbesuch", "freibadkarte", "freibadkarten", "badekarte", "fitness", "fitnessstudio", "fitnesscenter",
    "fitnessbeitrag", "fitnessabo", "fitinn", "mcfit", "clever fit", "john harris", "kieser",
    "yoga", "yogakurs", "pilates", "turnen", "turnverein", "sportverein", "sportbeitrag", "tennis", "tennisplatz", "tenniskurs",
    "fußball", "volleyball", "basketball", "badminton", "padel", "squash", "klettern", "kletterhalle",
    "bouldern", "boulderhalle", "skifahren", "schifahren", "skipass", "schipass", "skikarte", "schikarte",
    "skikurs", "schikurs", "skiverleih", "langlaufen", "loipe", "eislaufen", "eishalle", "eislaufplatz",
    "fahrrad", "fahrradreparatur", "fahrradservice", "radservice", "rennrad", "mountainbike", "e bike",
    "laufschuhe", "sportausrüstung", "sportbekleidung", "decathlon", "intersport", "gigasport",
    "gym", "swimming", "swimming pool", "swimming lessons", "indoor pool", "outdoor pool",
    "gym membership", "climbing", "bouldering", "ski pass", "skiing", "ice skating", "bicycle", "bike repair"
  ]],
  ["education", [
    "schule", "schulbeitrag", "schulgeld", "schulbedarf", "schulbücher", "schulausflug", "kindergarten",
    "kindergartenbeitrag", "kiga", "kinderkrippe", "kinderbetreuung", "hort", "tagesmutter", "babysitter",
    "elternbeitrag", "universität", "studium", "studiengebühr", "studiengebühren", "öh beitrag",
    "semesterbeitrag", "nachhilfe", "musikschule", "sprachkurs", "fahrschule", "kurs",
    "bildung", "education", "school", "university", "tuition", "daycare", "childcare", "textbooks"
  ]],
  ["entertainment", [
    "kino", "kinokarten", "kinotickets", "netflix", "spotify", "disney", "disney plus", "amazon prime",
    "konzert", "konzertkarten", "konzerttickets", "festival", "museum", "museumsbesuch", "theater", "theaterkarten",
    "oper", "kabarett", "zoo", "tiergarten", "tierpark", "freizeitpark", "prater", "ausflug", "ausflüge",
    "therme", "sauna", "wellness", "bowling", "minigolf", "escape room", "brettspiel", "brettspiele",
    "videospiel", "videospiele", "playstation", "nintendo", "steam", "bücher", "buch", "hörbuch", "thalia",
    "unterhaltung", "freizeit", "cinema", "movie", "concert", "entertainment", "games", "books"
  ]]
];

const normalizedRules = rules.map(([category, terms]) => [category, terms.map(normalizeText)] as const);
const aliases = new Map<string, Category>(
  Object.entries(categoryLabels).flatMap(([key, label]) =>
    [key, label, translate("de", label)].map((value) => [normalizeText(value), key as Category] as const))
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
for (const [category, terms] of [
  ["home", ["wohnen", "mietkosten"]],
  ["transport", ["transport sonstiges", "beförderung", "öffentliche verkehrsmittel"]],
  ["restaurant", ["essen und trinken", "food and drink", "essen trinken sonstiges"]],
  ["sports", ["unterhaltung sport", "entertainment sports", "sport freizeit"]],
  ["shopping", ["einkaufen", "einkäufe"]],
  ["gifts", ["geschenke spenden", "gifts donations"]]
] satisfies Array<[Category, string[]]>) {
  for (const term of terms) aliases.set(normalizeText(term), category);
}

// Prefer specific phrases over individual words and short retailer names (e.g. "H&M").
const detectionRules = normalizedRules.flatMap(([category, terms]) =>
  terms.map((term) => ({ category, term, words: term.split(" ").length })))
  .sort((a, b) => b.words - a.words || (a.words > 1 ? b.term.length - a.term.length : 0));

export function storedCategory(value: string): Category | undefined {
  return aliases.get(normalizeText(value));
}

export function detectCategory(description: string): Category {
  const text = ` ${normalizeText(description)} `;
  // Household gas bills are utilities, not a petrol purchase.
  if (["gas bill", "natural gas", "gasrechnung", "erdgas"].some((term) => text.includes(` ${term} `))) return "utilities";
  for (const { category, term } of detectionRules) {
    if (text.includes(` ${term} `)) return category;
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
