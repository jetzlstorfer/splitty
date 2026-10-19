import { MAX_CENTS } from "../shared/model";

export type ReceiptWarning = "confidence" | "merchant" | "date" | "total" | "currency" | "foreign";
export interface ReceiptDraft {
  merchant?: string;
  date?: string;
  amountCents?: number;
  currency?: string;
  warnings: ReceiptWarning[];
  text: string;
}

const totalLabel = /\b(?:gesamt(?:betrag|summe)?|summe|endbetrag|total(?:\s+(?:amount|due))?|amount\s+due|zu\s+zahlen|zahlbetrag|brutto)\b/i;
const nonTotalLabel = /\b(?:zwischensumme|sub\s*total|netto|net\s+total|mwst|ust|vat|tax|steuer|ersparnis|saved|savings|rückgeld|rueckgeld|wechselgeld|change|cash|gegeben|tendered|trinkgeld|tip)\b/i;
const moneyPattern = /(?<![\d.,])(?:[-+−]\s*|\(\s*)?(?:\d{1,3}(?:[., '\u00a0]\d{3})+|\d+)[.,]\d{2}(?:\s*[-−]|\))?(?![\d.,])/g;

function amounts(line: string): number[] {
  return [...line.replace(/\bEUR\b|€/gi, "").matchAll(moneyPattern)].map(([value]) => {
    const negative = /^[-−(]|[-−)]$/.test(value);
    return Number(value.replace(/\D/g, "")) * (negative ? -1 : 1);
  });
}

function receiptDate(text: string): string | undefined {
  const candidates = new Set<string>();
  let ambiguous = false;
  for (const match of text.matchAll(/\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})([./])(\d{1,2})\5(\d{2}|\d{4}))\b/g)) {
    const year = Number(match[1] ?? (match[7].length === 2 ? `20${match[7]}` : match[7]));
    const month = Number(match[2] ?? match[6]);
    const day = Number(match[3] ?? match[4]);
    if (match[5] === "/" && day <= 12 && month <= 12 && day !== month) ambiguous = true;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (year >= 2000 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31
      && new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date) candidates.add(date);
    else ambiguous = true;
  }
  return !ambiguous && candidates.size === 1 ? [...candidates][0] : undefined;
}

export function extractReceipt(text: string, confidence: number): ReceiptDraft {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const currencies = new Set<string>();
  for (const match of text.matchAll(/\b(EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|RMB|PLN|CZK|HUF|DKK|SEK|NOK|RON|TRY|INR|RUB|UAH|BRL|MXN|ZAR)\b/gi)) {
    currencies.add(match[1].toUpperCase());
  }
  if (/€|\bEUROS?\b/i.test(text)) currencies.add("EUR");
  if (/\$/.test(text) && ![...currencies].some((code) => ["USD", "CAD", "AUD", "NZD", "MXN"].includes(code))) currencies.add("$");
  if (/£/.test(text)) currencies.add("GBP");
  if (/[¥￥]/.test(text) && !currencies.has("JPY") && !currencies.has("CNY")) currencies.add("¥");
  const currency = currencies.size ? [...currencies].join(" / ") : undefined;
  const warnings: ReceiptWarning[] = [];
  if (!currency) warnings.push("currency");
  else if (currency !== "EUR") warnings.push("foreign");

  if (!Number.isFinite(confidence) || confidence < 70) {
    return { text, currency, warnings: ["confidence", ...warnings] };
  }

  const totals = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!totalLabel.test(line) || nonTotalLabel.test(line)) continue;
    let values = amounts(line);
    if (!values.length && lines[index + 1] && /^(?:(?:EUR|€)\s*)?[-+\d., '\u00a0]+(?:\s*(?:EUR|€))?$/i.test(lines[index + 1])) {
      values = amounts(lines[index + 1]);
    }
    for (const value of values) totals.add(value);
  }
  const [total] = totals;
  const amountCents = totals.size === 1 && Number.isSafeInteger(total) && total > 0 && total <= MAX_CENTS ? total : undefined;
  const date = receiptDate(text);
  const merchant = lines.slice(0, 5).find((line) => {
    return line.length >= 3 && line.length <= 100 && (line.match(/\p{L}/gu)?.length ?? 0) >= 3
      && !/\d{2}|[€$£¥]|https?:|www\.|@/i.test(line)
      && !/\b(?:receipt|rechnung|kassenbon|beleg|datum|date|tel|telefon|uid|ust|mwst|vat|welcome|willkommen|danke|thank|vielen|strasse|straße|street|road)\b|str\./i.test(line)
      && !totalLabel.test(line) && !nonTotalLabel.test(line);
  });
  if (!merchant) warnings.push("merchant");
  if (!date) warnings.push("date");
  if (!amountCents) warnings.push("total");
  return { merchant, date, amountCents, currency, warnings, text };
}
