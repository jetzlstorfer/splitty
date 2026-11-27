import { useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, Trash2 } from "lucide-react";
import { calculateShareA, expenseBalance, parseMoney, type Entry, type Member, type SplitType } from "../shared/model";
import { isActiveDatabase, queueEntries, queueNewReceipts, type Preferences, type SplittyDatabase } from "./db";
import { useLocale } from "./i18n";
import { categoryLabels, detectCategory, expenseCategory, storedCategory, type Category } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import ReceiptScanner from "./ReceiptScanner";
import { DateField, Form, Select, Sheet, dateValue as today, useConfirm } from "./Controls";

export default function ExpenseForm({ database, entry, settlement, preferences: p, close, saved }: {
  database: SplittyDatabase;
  entry?: Entry; settlement: boolean; preferences: Preferences; close: () => void; saved: (entry?: Entry) => void;
}) {
  const { t, message, money, payer, language } = useLocale();
  const confirm = useConfirm();
  const imported = entry?.kind === "imported";
  const [description, setDescription] = useState(entry?.description ?? (settlement ? t("Payment") : ""));
  const [amount, setAmount] = useState(entry ? (entry.amountCents / 100).toFixed(2).replace(".", language === "de" ? "," : ".") : "");
  const [date, setDate] = useState(entry?.date ?? today());
  const [paidBy, setPaidBy] = useState<Member>(entry?.paidBy ?? p.member);
  const [split, setSplit] = useState(() => {
    if (!entry || entry.kind !== "expense") return "equal";
    if (entry.splitType === "all-a") return p.member === "a" ? "self" : "other";
    if (entry.splitType === "all-b") return p.member === "b" ? "self" : "other";
    return entry.splitType ?? "exact";
  });
  const [share, setShare] = useState((entry?.splitType === "percent" ? String(entry.percentageA) : entry?.shareA !== null && entry?.shareA !== undefined ? (entry.shareA / 100).toFixed(2) : "").replace(".", language === "de" ? "," : "."));
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const [categoryChoice, setCategoryChoice] = useState<Category | "auto">(() => {
    const category = entry ? storedCategory(entry.category) : undefined;
    if (entry?.categoryMode === "manual" && category && category !== "payment") return category;
    return !entry || entry.categoryMode === "auto" || !category || category === "general" || category === "payment" ? "auto" : category;
  });
  const category = imported && entry ? expenseCategory(description, entry.category, entry.kind)
    : settlement ? "payment" : categoryChoice === "auto" ? detectCategory(description) : categoryChoice;
  const splitType: SplitType = split === "other" ? p.member === "a" ? "all-b" : "all-a"
    : split === "self" ? p.member === "a" ? "all-a" : "all-b" : split as SplitType;
  let cents = 0, shareA = 0;
  try {
    cents = parseMoney(amount);
    if (split === "equal") shareA = calculateShareA(cents, paidBy, "equal");
    if (split === "other") shareA = p.member === "a" ? 0 : cents;
    if (split === "self") shareA = p.member === "a" ? cents : 0;
    if (split === "exact") shareA = parseMoney(share);
    if (split === "percent") {
      if (!/^\d+(?:[.,]\d{1,2})?$/.test(share) || Number(share.replace(",", ".")) > 100) throw new Error("Enter a percentage between 0 and 100.");
      shareA = calculateShareA(cents, paidBy, "percent", Number(share.replace(",", ".")));
    }
  } catch { /* Input errors are displayed on submission, not while typing. */ }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || scanBusy) return;
    setBusy(true); setError("");
    try {
      let value: Entry;
      if (imported && entry) {
        value = { ...entry, description, date };
      } else {
        const amountCents = parseMoney(amount);
        if (amountCents <= 0) throw new Error("Enter an amount greater than zero.");
        if (split === "percent" && (!/^\d+(?:[.,]\d{1,2})?$/.test(share) || Number(share.replace(",", ".")) > 100)) {
          throw new Error("Enter a percentage between 0 and 100.");
        }
        const submittedShareA = split === "exact" ? parseMoney(share) : shareA;
        value = {
          id: entry?.id ?? crypto.randomUUID(), kind: settlement ? "settlement" : "expense",
          description: description.trim(), date, category,
          currency: "EUR", amountCents, paidBy, shareA: settlement ? null : submittedShareA,
          balanceA: settlement ? (paidBy === "a" ? amountCents : -amountCents) : expenseBalance(amountCents, paidBy, submittedShareA),
          revision: entry?.revision ?? 0, updatedAt: new Date().toISOString(), deleted: false,
          ...(!settlement ? {
            categoryMode: categoryChoice === "auto" ? "auto" : "manual",
            splitType, ...(split === "percent" ? { percentageA: Number(share.replace(",", ".")) } : {})
          } : {}),
          ...(entry?.insuranceSubmittedAt ? { insuranceSubmittedAt: entry.insuranceSubmittedAt } : {}),
          ...(entry?.skipInsuranceTodo ? { skipInsuranceTodo: true } : {})
        };
      }
      if (!entry && !settlement) await queueNewReceipts([value], database);
      else await queueEntries([value], database);
      if (isActiveDatabase(database)) { saved(value); close(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this expense."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!entry || !await confirm({ title: t("Delete entry"), description: t("Delete this entry for both of you? This will sync when you are online."), action: t("Delete entry"), dangerous: true })) return;
    setBusy(true);
    try {
      await queueEntries([{ ...entry, deleted: true }], database);
      if (isActiveDatabase(database)) { saved(); close(); }
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this entry."); }
    finally { setBusy(false); }
  }

  const other = p.member === "a" ? p.nameB : p.nameA;
  return <Sheet title={t(entry ? "Edit entry" : settlement ? "Settle up" : "Add an expense")} close={close} initialFocus={!entry ? "#expense-description" : undefined}>
    <Form onSubmit={submit} className="expense-form" lang={language}>
      {!entry && !settlement && <ReceiptScanner onBusyChange={setScanBusy} apply={(draft) => {
        if (draft.merchant) setDescription(draft.merchant);
        if (draft.date) setDate(draft.date);
        if (draft.amountCents) setAmount((draft.amountCents / 100).toFixed(2).replace(".", language === "de" ? "," : "."));
      }} />}
      <div className="description-field"><label htmlFor="expense-description">{t("Description")}</label><div className="description-input" data-category={category}><ExpenseIcon category={category} size={24} /><input id="expense-description" value={description} enterKeyHint={imported ? undefined : "next"} onKeyDown={(event) => {
        if (!imported && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault(); amountInput.current?.focus();
        }
      }} onChange={(e) => setDescription(e.target.value)} placeholder={t(settlement ? "Payment" : "Enter a description")} required maxLength={500} /></div></div>
      <label>{t("Amount in EUR")}<div className="amount-input"><span>€</span><input ref={amountInput} aria-label={t("Amount in EUR")} inputMode="decimal" enterKeyHint={imported ? undefined : "done"} value={amount} readOnly={imported} onKeyDown={(event) => {
        if (!imported && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!busy && !scanBusy) event.currentTarget.form?.requestSubmit();
        }
      }} onChange={(e) => setAmount(e.target.value)} placeholder={language === "de" ? "0,00" : "0.00"} required /></div></label>
      {imported ? <p className="notice">{t("Imported balance: {amount} for {name}. The CSV does not reliably identify the original payer or split, so those amounts are preserved. Description and date can be edited.", { amount: money(entry.balanceA), name: p.nameA })}</p> : <>
        <fieldset className="payer-switch" aria-label={t("Paid by")}>
          <legend>{t(settlement ? "Payment from" : "Paid by")}</legend>
          <div className="payer-segments">
            {(["a", "b"] as const).map((member) => <label key={member}>
              <input type="radio" name="paid-by" value={member} checked={paidBy === member} onChange={() => setPaidBy(member)} />
              <span><Check size={18} aria-hidden="true" />{payer(p, member)}</span>
            </label>)}
          </div>
        </fieldset>
        {settlement && <p className="payment-recipient">{paidBy !== p.member ? t("to you") : other === t("Your spouse") ? t("to your spouse") : t("to {name}", { name: other })}</p>}
        {!settlement && <>
          <button type="button" className="split-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <span>{split === "other" ? t("All for {name}", { name: other }) : t(split === "equal" ? "Split equally" : split === "self" ? "All for you" : "Custom split")}<small>{money(shareA)} · {p.nameA} &nbsp;/&nbsp; {money(cents - shareA)} · {p.nameB}</small></span><ChevronDown size={20} />
          </button>
          {expanded && <fieldset className="split-options"><legend>{t("How should we split it?")}</legend>
            {[
              ["equal", t("Equally · 50/50")], ["other", t("{name} owes the full amount", { name: other })],
              ["self", t("I owe the full amount")], ["percent", t("By percentage")], ["exact", t("By exact amount")]
            ].map(([value, label]) => <label key={value} className="radio"><input type="radio" name="split" value={value} checked={split === value} onChange={() => { setSplit(value); setShare(value === "percent" ? "50" : ""); }} />{label}</label>)}
            {(split === "percent" || split === "exact") && <label>{p.nameA === t("You") ? t("Your share") : t("{name}'s share", { name: p.nameA })} {split === "percent" ? "(%)" : "(EUR)"}<input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} required /></label>}
          </fieldset>}
        </>}
      </>}
      <DateField value={date} onChange={setDate} />
      {!imported && !settlement && <div className="category-picker"><label>{t("Category")}
        <Select<Category | "auto"> label={t("Category")} value={categoryChoice} onChange={setCategoryChoice}
          options={[{ value: "auto", label: t("Automatic") }, ...(Object.keys(categoryLabels) as Category[]).filter((key) => key !== "payment").map((key) => ({ value: key, label: t(categoryLabels[key]) }))]} />
      </label><span className="category-detected" role="status">{t(categoryChoice === "auto" ? "Detected: {category}" : "Selected: {category}", { category: t(categoryLabels[category]) })}</span></div>}
      {error && <p className="error" role="alert">{message(error)}</p>}
      <button className="primary" disabled={busy || scanBusy} type="submit"><Check size={19} />{t(busy ? "Saving…" : "Save")}</button>
      {entry && <button className="danger-link" type="button" disabled={busy} onClick={(event) => { event.currentTarget.focus(); void remove(); }}><Trash2 size={16} />{t("Delete entry")}</button>}
    </Form>
  </Sheet>;
}
