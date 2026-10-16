import Papa from "papaparse";
import { parseMoney, validDate, type Entry } from "../shared/model";

export interface ImportPreview {
  entries: Entry[];
  duplicates: number;
  balanceA: number;
  expectedBalanceA: number | null;
  errors: string[];
}

const coreHeaders = [
  ["Datum", "Date"], ["Beschreibung", "Description"], ["Kategorie", "Category"],
  ["Kosten", "Cost"], ["Währung", "Currency"]
];

export function readCsv(text: string): { rows: Record<string, string>[]; members: string[]; headers: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim()
  });
  if (parsed.errors.length) throw new Error(`CSV could not be read: ${parsed.errors[0].message}`);
  const headers = parsed.meta.fields ?? [];
  const selected = coreHeaders.map((aliases) => aliases.find((h) => headers.includes(h)));
  if (selected.some((h) => !h)) throw new Error("Expected a German or English Splitwise group CSV export.");
  const members = headers.filter((h) => !selected.includes(h));
  if (members.length !== 2) throw new Error("This version supports exports with exactly two people.");
  return { rows: parsed.data, members, headers: selected as string[] };
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewImport(text: string, memberA: string, existing: Set<string>): Promise<ImportPreview> {
  const { rows, members, headers } = readCsv(text);
  if (!members.includes(memberA)) throw new Error("Choose which export column belongs to the first person.");
  const memberB = members.find((name) => name !== memberA)!;
  const [dateKey, descriptionKey, categoryKey, costKey, currencyKey] = headers;
  const preview: ImportPreview = { entries: [], duplicates: 0, balanceA: 0, expectedBalanceA: null, errors: [] };
  const occurrences = new Map<string, number>();
  const timestamp = new Date().toISOString();
  let summarySeen = false;
  for (const [index, row] of rows.entries()) {
    try {
      if (row[currencyKey]?.trim() !== "EUR") throw new Error("Only EUR is supported; no automatic currency conversion.");
      const a = parseMoney(row[memberA] ?? "", true);
      const b = parseMoney(row[memberB] ?? "", true);
      if (a + b !== 0) throw new Error("The two balance contributions do not cancel out.");
      if (!row[costKey]?.trim()) {
        if (!/^(total balance|gesamtbilanz)$/i.test(row[descriptionKey]?.trim())) {
          throw new Error("Unrecognized row without an amount.");
        }
        if (summarySeen || index !== rows.length - 1) throw new Error("The total balance must appear once, at the end.");
        preview.expectedBalanceA = a;
        summarySeen = true;
        continue;
      }
      if (!validDate(row[dateKey])) throw new Error("Invalid date; expected YYYY-MM-DD.");
      const amountCents = parseMoney(row[costKey], true);
      const description = row[descriptionKey]?.trim();
      if (!description || description.length > 500) throw new Error("Missing or overly long description.");
      const category = row[categoryKey]?.trim() || "General";
      if (category.length > 100) throw new Error("Category is too long.");
      if (Math.abs(a) > Math.abs(amountCents)) throw new Error("Balance contribution exceeds the expense amount.");
      const canonical = JSON.stringify([
        row[dateKey], description, category, amountCents, "EUR",
        ...members.slice().sort().map((member) => [member, parseMoney(row[member], true)])
      ]);
      const occurrence = (occurrences.get(canonical) ?? 0) + 1;
      occurrences.set(canonical, occurrence);
      const importKey = `${await hash(canonical)}-${occurrence}`;
      const id = `import-${importKey}`;
      preview.balanceA += a;
      if (existing.has(id)) {
        preview.duplicates++;
        continue;
      }
      preview.entries.push({
        id, kind: "imported", description, date: row[dateKey], category,
        amountCents, currency: "EUR", paidBy: null, shareA: null, balanceA: a,
        importKey, revision: 0, updatedAt: timestamp, deleted: false
      });
    } catch (error) {
      preview.errors.push(`Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid row."}`);
    }
  }
  if (preview.expectedBalanceA !== null && preview.balanceA !== preview.expectedBalanceA) {
    preview.errors.push("The ledger total does not match the export's final balance. Nothing will be imported.");
  }
  if (!rows.length) preview.errors.push("This export has no entries.");
  return preview;
}
