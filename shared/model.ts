export type Member = "a" | "b";
export type EntryKind = "expense" | "settlement" | "imported";
export type SplitType = "equal" | "exact" | "percent" | "all-a" | "all-b";

export interface Entry {
  id: string;
  kind: EntryKind;
  description: string;
  date: string;
  category: string;
  currency: "EUR";
  amountCents: number;
  paidBy: Member | null;
  shareA: number | null;
  balanceA: number;
  revision: number;
  updatedAt: string;
  deleted: boolean;
  importKey?: string;
  splitType?: SplitType;
  percentageA?: number;
  categoryMode?: "auto" | "manual";
}

export interface Mutation {
  id: string;
  entry: Entry;
  expectedRevision: number;
}

export type MutationResult =
  | { id: string; status: "ok"; entry: Entry }
  | { id: string; status: "conflict"; entry: Entry | null };

export interface SyncPage {
  entries: Entry[];
  cursor: number;
  more: boolean;
}

export const MAX_CENTS = 100_000_000_000;
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;

export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function parseMoney(value: string, allowNegative = false): number {
  const normalized = value.trim().replace(",", ".");
  if (!(allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(normalized)) {
    throw new Error("Enter an amount with at most two decimal places.");
  }
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace("-", "").split(".");
  const cents = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) {
    throw new Error("This amount is too large.");
  }
  return cents;
}

export function expenseBalance(amountCents: number, paidBy: Member, shareA: number): number {
  return (paidBy === "a" ? amountCents : 0) - shareA;
}

export function calculateShareA(amount: number, paidBy: Member, splitType: SplitType, custom = 0): number {
  if (splitType === "equal") return paidBy === "a" ? Math.ceil(amount / 2) : Math.floor(amount / 2);
  if (splitType === "all-a") return amount;
  if (splitType === "all-b") return 0;
  if (splitType === "percent") return Math.round(amount * Math.round(custom * 100) / 10_000);
  return custom;
}

export function validateEntry(value: unknown): Entry {
  if (!value || typeof value !== "object") throw new Error("Invalid expense.");
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !identifier.test(e.id)
    || !["expense", "settlement", "imported"].includes(String(e.kind))
    || typeof e.description !== "string" || !e.description.trim() || e.description.length > 500
    || typeof e.category !== "string" || e.category.length > 100
    || typeof e.date !== "string" || !validDate(e.date)
    || e.currency !== "EUR"
    || typeof e.amountCents !== "number" || !Number.isSafeInteger(e.amountCents) || Math.abs(e.amountCents) > MAX_CENTS
    || typeof e.balanceA !== "number" || !Number.isSafeInteger(e.balanceA) || Math.abs(e.balanceA) > MAX_CENTS
    || typeof e.revision !== "number" || !Number.isSafeInteger(e.revision) || e.revision < 0
    || typeof e.updatedAt !== "string" || !Number.isFinite(Date.parse(e.updatedAt))
    || typeof e.deleted !== "boolean"
    || (e.paidBy !== null && e.paidBy !== "a" && e.paidBy !== "b")
    || (e.shareA !== null && (typeof e.shareA !== "number" || !Number.isSafeInteger(e.shareA)))
    || (e.importKey !== undefined && (typeof e.importKey !== "string" || !identifier.test(e.importKey)))) {
    throw new Error("Invalid expense fields.");
  }
  if (e.splitType !== undefined && !["equal", "exact", "percent", "all-a", "all-b"].includes(String(e.splitType))) {
    throw new Error("Invalid split method.");
  }
  if (e.categoryMode !== undefined && e.categoryMode !== "auto" && e.categoryMode !== "manual") {
    throw new Error("Invalid expense fields.");
  }
  if (e.percentageA !== undefined && (typeof e.percentageA !== "number" || !Number.isFinite(e.percentageA)
    || e.percentageA < 0 || e.percentageA > 100
    || Math.abs(e.percentageA * 100 - Math.round(e.percentageA * 100)) > 0.000001)) {
    throw new Error("Invalid percentage.");
  }
  if (e.kind !== "imported") {
    if (e.amountCents <= 0 || e.paidBy === null) throw new Error("A positive amount and payer are required.");
    if (e.kind === "expense") {
      if (typeof e.shareA !== "number" || e.shareA < 0 || e.shareA > e.amountCents
        || e.balanceA !== expenseBalance(e.amountCents, e.paidBy, e.shareA)) {
        throw new Error("The shares must add up to the expense.");
      }
      if (e.splitType && (e.splitType === "percent" && e.percentageA === undefined
        || e.shareA !== calculateShareA(e.amountCents, e.paidBy, e.splitType as SplitType,
          e.splitType === "percent" ? e.percentageA as number : e.shareA))) {
        throw new Error("The shares do not match the split method.");
      }
    } else if (e.shareA !== null || e.balanceA !== (e.paidBy === "a" ? e.amountCents : -e.amountCents)) {
      throw new Error("Invalid settlement.");
    }
  } else if (e.paidBy !== null || e.shareA !== null || !e.importKey) {
    throw new Error("Imported entries must preserve their original balance contribution.");
  }
  return {
    id: e.id, kind: e.kind as EntryKind, description: e.description.trim(), date: e.date,
    category: e.category, currency: "EUR", amountCents: e.amountCents,
    paidBy: e.paidBy, shareA: e.shareA as number | null, balanceA: e.balanceA,
    revision: e.revision, updatedAt: e.updatedAt, deleted: e.deleted,
    ...(e.importKey ? { importKey: e.importKey as string } : {}),
    ...(e.splitType && e.kind === "expense" ? { splitType: e.splitType as SplitType } : {}),
    ...(e.splitType === "percent" && e.kind === "expense" ? { percentageA: e.percentageA as number } : {}),
    ...(e.categoryMode ? { categoryMode: e.categoryMode as "auto" | "manual" } : {})
  };
}

export function validateMutation(value: unknown): Mutation {
  if (!value || typeof value !== "object") throw new Error("Invalid change.");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !identifier.test(m.id)
    || typeof m.expectedRevision !== "number" || !Number.isSafeInteger(m.expectedRevision) || m.expectedRevision < 0) {
    throw new Error("Invalid change identifier or version.");
  }
  const entry = validateEntry(m.entry);
  if (entry.revision !== m.expectedRevision + 1) throw new Error("Invalid change version.");
  return { id: m.id, expectedRevision: m.expectedRevision, entry };
}
