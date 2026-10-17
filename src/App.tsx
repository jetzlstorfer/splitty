import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { liveQuery } from "dexie";
import {
  BarChart3, Check, ChevronDown, ClipboardCheck, Cloud, CloudOff,
  Download, Languages, Plus, Receipt, RefreshCw, Search, Settings, Trash2, Upload, Users, X
} from "lucide-react";
import { calculateShareA, expenseBalance, parseMoney, validateEntry, type Entry, type Member, type SplitType } from "../shared/model";
import { db, queueEntries, resolveConflict, updatePreferences, getPreferences, type Conflict, type Preferences } from "./db";
import { previewImport, readCsv, type ImportPreview } from "./importer";
import { api, ApiError, synchronize, type Identity } from "./sync";
import { LanguageContext, useLocale } from "./i18n";
import { categoryLabels, detectCategory, expenseCategory, normalizeText, storedCategory, type Category } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import Statistics from "./Statistics";
import { insuranceTodos, type InsuranceTodo } from "./todos";

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

interface Snapshot { entries: Entry[]; pending: number; preferences: Preferences; conflicts: Conflict[] }

function useLedger(): Snapshot | null {
  const [value, setValue] = useState<Snapshot | null>(null);
  useEffect(() => {
    const subscription = liveQuery(async () => ({
      entries: await db.entries.toArray(), pending: await db.outbox.count(),
      preferences: await getPreferences(), conflicts: await db.conflicts.toArray()
    })).subscribe({
      next: setValue,
      error: (error: unknown) => window.dispatchEvent(new CustomEvent("splitty-error", {
        detail: `Local storage failed: ${error instanceof Error ? error.message : String(error)}`
      }))
    });
    return () => subscription.unsubscribe();
  }, []);
  return value;
}

function Sheet({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} onCancel={close} className="sheet" aria-labelledby={heading}>
    <div className="sheet-head"><button className="icon-button" onClick={close} aria-label={t("Close")}><X size={22} /></button><h2 id={heading}>{title}</h2><span /></div>
    {children}
  </dialog>;
}

function FilePicker({ label, accept, disabled, choose }: { label: string; accept: string; disabled?: boolean; choose: (file?: File) => void }) {
  const { t } = useLocale();
  const [filename, setFilename] = useState("");
  return <label className="file-label">{label}<span className="file-picker">
    <span className="file-picker-button">{t("Choose file")}</span><span>{filename || t("No file selected")}</span>
    <input type="file" aria-label={label} accept={accept} disabled={disabled} onChange={(event) => {
      const file = event.target.files?.[0];
      setFilename(file?.name ?? ""); choose(file); event.target.value = "";
    }} />
  </span></label>;
}

function ExpenseForm({ entry, settlement, preferences: p, close, saved }: {
  entry?: Entry; settlement: boolean; preferences: Preferences; close: () => void; saved: () => void;
}) {
  const { t, message, money, payer, language } = useLocale();
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
          ...(entry?.insuranceSubmittedAt ? { insuranceSubmittedAt: entry.insuranceSubmittedAt } : {})
        };
      }
      await queueEntries([value]);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this expense."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!entry || !window.confirm(t("Delete this entry for both of you? This will sync when you are online."))) return;
    setBusy(true);
    try { await queueEntries([{ ...entry, deleted: true }]); saved(); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this entry."); }
    finally { setBusy(false); }
  }

  const other = p.member === "a" ? p.nameB : p.nameA;
  return <Sheet title={t(entry ? "Edit entry" : settlement ? "Settle up" : "Add an expense")} close={close}>
    <form onSubmit={submit} className="expense-form" lang={language}>
      <div className="description-field"><label htmlFor="expense-description">{t("Description")}</label><div className="description-input"><ExpenseIcon category={category} size={24} /><input id="expense-description" autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t(settlement ? "Payment" : "Enter a description")} required maxLength={500} /></div></div>
      <label>{t("Amount in EUR")}<div className="amount-input"><span>€</span><input aria-label={t("Amount in EUR")} inputMode="decimal" value={amount} readOnly={imported} onChange={(e) => setAmount(e.target.value)} placeholder={language === "de" ? "0,00" : "0.00"} required /></div></label>
      {imported ? <p className="notice">{t("Imported balance: {amount} for {name}. The CSV does not reliably identify the original payer or split, so those amounts are preserved. Description and date can be edited.", { amount: money(entry.balanceA), name: p.nameA })}</p> : <>
        <div className="split-summary">
          <span>{t(settlement ? "Payment from" : "Paid by")}</span>
          <select aria-label={t("Paid by")} value={paidBy} onChange={(e) => setPaidBy(e.target.value as Member)}>
            <option value="a">{payer(p, "a")}</option><option value="b">{payer(p, "b")}</option>
          </select>
          {settlement && <span>{paidBy !== p.member ? t("to you") : other === t("Your wife") ? t("to your wife") : t("to {name}", { name: other })}</span>}
        </div>
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
      <label>{t("Date")}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
      {!imported && !settlement && <label className="category-picker">{t("Category")}<select aria-label={t("Category")} value={categoryChoice} onChange={(event) => setCategoryChoice(event.target.value as Category | "auto")}>
        <option value="auto">{t("Automatic")}</option>
        {(Object.keys(categoryLabels) as Category[]).filter((key) => key !== "payment").map((key) => <option key={key} value={key}>{t(categoryLabels[key])}</option>)}
      </select><span className="category-detected" role="status">{t(categoryChoice === "auto" ? "Detected: {category}" : "Selected: {category}", { category: t(categoryLabels[category]) })}</span></label>}
      {error && <p className="error" role="alert">{message(error)}</p>}
      <button className="primary" disabled={busy} type="submit"><Check size={19} />{t(busy ? "Saving…" : "Save")}</button>
      {entry && <button className="danger-link" type="button" disabled={busy} onClick={remove}><Trash2 size={16} />{t("Delete entry")}</button>}
    </form>
  </Sheet>;
}

function ImportForm({ preferences: p, close, saved }: { preferences: Preferences; close: () => void; saved: () => void }) {
  const { t, message, money, number } = useLocale();
  const [text, setText] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [memberA, setMemberA] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(file?: File) {
    if (!file) return;
    setError(""); setPreview(null); setText("");
    try {
      if (file.size > 10_000_000) throw new Error("Choose an export smaller than 10 MB.");
      const content = await file.text();
      const parsed = readCsv(content);
      setText(content); setMembers(parsed.members);
      setMemberA(parsed.members.includes(p.nameA) ? p.nameA : parsed.members[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read this file."); }
  }
  async function inspect() {
    setBusy(true); setError("");
    try { setPreview(await previewImport(text, memberA, new Set(await db.entries.toCollection().primaryKeys()))); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not preview this import."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || preview.errors.length) return;
    setBusy(true); setError("");
    try {
      await queueEntries(preview.entries);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed. No entries were added."); }
    finally { setBusy(false); }
  }
  return <Sheet title={t("Import from Splitwise")} close={close}><div className="panel-content">
    <p>{t("Choose a CSV export for two people in EUR. Entries stay on this device until you confirm, then sync with your household.")}</p>
    <FilePicker label={t("Splitwise CSV")} accept=".csv,text/csv" choose={(file) => void choose(file)} disabled={busy} />
    {!!members.length && <>
      <label>{t("Export column for {name}", { name: p.nameA })}<select value={memberA} disabled={busy} onChange={(e) => { setMemberA(e.target.value); setPreview(null); }}>{members.map((member) => <option key={member}>{member}</option>)}</select></label>
      <p className="muted">{t("{source} maps to {name}. Use the same mapping on every device.", { source: members.find((member) => member !== memberA) ?? "", name: p.nameB })}</p>
      <button className="secondary" disabled={busy} onClick={inspect}>{t(busy ? "Reading history…" : "Preview import")}</button>
    </>}
    {preview && <div className="import-preview">
      <h3>{preview.entries.length === 1 ? t("1 new entry") : t("{count} new entries", { count: number(preview.entries.length) })}</h3><p>{t("{count} already imported · skipped", { count: number(preview.duplicates) })}</p>
      <p>{t("File balance for {name}:", { name: p.nameA })} <strong>{money(preview.balanceA)}</strong></p>
      {preview.expectedBalanceA !== null ? <p className={preview.errors.length ? "muted" : "success"}>{t(preview.errors.length ? "Reconciliation needs attention." : "Matches the final balance in your export.")}</p> : <p className="notice">{t("No final balance row found. Check this total against Splitwise before confirming.")}</p>}
      {preview.errors.length > 0 && <div className="error" role="alert"><strong>{t("Nothing will be imported.")}</strong><ul>{preview.errors.slice(0, 8).map((error, i) => <li key={i}>{message(error)}</li>)}</ul>{preview.errors.length > 8 && <p>{t("And {count} more errors.", { count: number(preview.errors.length - 8) })}</p>}</div>}
      <p className="muted">{t("Original balance contributions are preserved, including payments and rounding. Payer and share details are not guessed. Identical rows within the export remain separate expenses.")}</p>
      <button className="primary" disabled={busy || !!preview.errors.length || !preview.entries.length} onClick={confirm}>{t(busy ? "Saving history…" : "Confirm import")}</button>
    </div>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </div></Sheet>;
}

function TodoList({ todos, openCount, status, blocked, open, toggle }: {
  todos: InsuranceTodo[]; openCount: number; status: string; blocked: Set<string>;
  open: (entry: Entry) => void; toggle: (entry: Entry, submitted: boolean) => void;
}) {
  const { t, number, money, locale } = useLocale();
  return <section className="todos-page"><header className="page-heading"><h1>{t("To-dos")}<span className="entry-count">{number(openCount)}</span></h1></header>
    <p className="sync-status" role="status">{status}</p>
    {!todos.length ? <div className="empty-state"><h2>{t("No to-dos")}</h2><p>{t("Doctor and pharmacy expenses appear here so you can submit them to your insurance.")}</p></div> :
      [false, true].map((done) => {
        const group = todos.filter((todo) => todo.done === done);
        return !!group.length && <section key={String(done)} className="todo-group" aria-label={t(done ? "Done" : "Open to-dos")}>
          <div className="section-title"><h2>{t(done ? "Done" : "Open to-dos")}<span>{number(group.length)}</span></h2></div>
          <ul className="todo-list">{group.map(({ entry }) => {
            const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
            const details = t("Expense: {description} · {date} · {amount}", {
              description: entry.description, amount: money(entry.amountCents),
              date: new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })
            });
            return <li key={entry.id} className={`todo-item ${done ? "done" : ""}`}>
              <label className="todo-check"><input type="checkbox" checked={done} disabled={blocked.has(entry.id)} onChange={(event) => toggle(entry, event.target.checked)} />
                <span className="entry-icon"><ExpenseIcon category={category} /></span>
                <span className="entry-description"><strong>{t("Submit to insurance")}</strong><small>{details}</small></span>
              </label>
              <button className="text-button" disabled={blocked.has(entry.id)} onClick={() => open(entry)} aria-label={`${t("Open expense")}: ${entry.description}`}>{t("Open expense")}</button>
            </li>;
          })}</ul>
        </section>;
      })}
  </section>;
}

export default function App() {
  const ledger = useLedger();
  const language = ledger?.preferences.language ?? "de";
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === "de" ? "Splitty · Gemeinsame Ausgaben" : "Splitty · Shared expenses";
  }, [language]);
  return <LanguageContext.Provider value={language}><AppContent ledger={ledger} /></LanguageContext.Provider>;
}

function AppContent({ ledger }: { ledger: Snapshot | null }) {
  const { t, language, locale, number, money, message, person, payer } = useLocale();
  const [tab, setTab] = useState<"expenses" | "todos" | "search" | "statistics" | "settings">("expenses");
  const [form, setForm] = useState<"expense" | "settlement" | Entry | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [online, setOnline] = useState(navigator.onLine);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [syncBusy, setSyncBusy] = useState(navigator.onLine);
  const syncLock = useRef(false);
  const [error, setError] = useState("");
  const [memberToken, setMemberToken] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);

  const performSync = useCallback(() => {
    if (syncLock.current || !navigator.onLine) return Promise.resolve();
    syncLock.current = true;
    return api<Identity>("me").then(async (me) => {
      if ((me.member !== "a" && me.member !== "b") || !me.nameA || !me.nameB) throw new Error("Invalid sign-in response.");
      setIdentity(me);
      await updatePreferences({ member: me.member, nameA: me.nameA, nameB: me.nameB });
      setSyncStatus("Syncing…");
      await synchronize();
      setSyncStatus(await db.conflicts.count() ? "Some edits need your attention" : await db.outbox.count() ? "Saved locally · changes waiting to sync" : "Up to date");
    }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) { setIdentity(null); setSyncStatus("Sign in to sync"); }
      else setSyncStatus(e instanceof Error ? e.message : "Sync failed; your changes remain on this device.");
    }).finally(() => { syncLock.current = false; setSyncBusy(false); });
  }, []);

  const sync = useCallback(async () => {
    if (syncLock.current || !navigator.onLine) return;
    setSyncBusy(true);
    await performSync();
  }, [performSync]);

  useEffect(() => {
    const connected = () => { setOnline(true); void sync(); };
    const disconnected = () => { setOnline(false); setSyncBusy(false); setSyncStatus("Offline · changes stay on this device"); };
    const focus = () => { if (document.visibilityState === "visible") void sync(); };
    const failure = (event: Event) => setError(String((event as CustomEvent).detail));
    const available = (event: Event) => setUpdate(() => (event as CustomEvent<() => Promise<void>>).detail);
    window.addEventListener("online", connected); window.addEventListener("offline", disconnected);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("splitty-error", failure); window.addEventListener("splitty-update", available);
    void performSync();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void sync(); }, 60_000);
    return () => {
      window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("splitty-error", failure); window.removeEventListener("splitty-update", available);
      window.clearInterval(interval);
    };
  }, [performSync, sync]);

  useEffect(() => {
    if (!ledger?.pending) return;
    const timeout = window.setTimeout(() => void sync(), 400);
    return () => window.clearTimeout(timeout);
  }, [ledger?.pending, sync]);

  const saved = () => { setSyncStatus("Saved on this device"); void sync(); };

  function navigate(next: typeof tab) {
    setTab(next);
    setLimit(100);
    window.scrollTo(0, 0);
  }

  async function signIn(event: FormEvent) {
    event.preventDefault(); setSignInBusy(true); setError("");
    try {
      await api("auth/token", { token: memberToken });
      setMemberToken(""); setTab("settings"); await sync();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not sign in with this token."); }
    finally { setSignInBusy(false); }
  }

  async function signOut() {
    try {
      await api("auth/logout", {});
      setIdentity(null); setSyncStatus("Signed out · local history remains on this device");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not sign out."); }
  }

  function backup() {
    if (!ledger) return;
    const blob = new Blob([JSON.stringify({ format: "splitty-v1", exportedAt: new Date().toISOString(), preferences: ledger.preferences, entries: ledger.entries }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `splitty-backup-${today()}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restore(file?: File) {
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error("Choose a backup smaller than 20 MB.");
      const data = JSON.parse(await file.text()) as { format?: unknown; entries?: unknown };
      if (data.format !== "splitty-v1" || !Array.isArray(data.entries)) throw new Error("Choose a Splitty JSON backup.");
      const entries = data.entries.map(validateEntry);
      const existing = new Set(await db.entries.toCollection().primaryKeys());
      const fresh = entries.filter((entry) => !existing.has(entry.id));
      if (!window.confirm(t("Restore {count} missing entries? Existing entries will not be overwritten. Keep the same person A/B mapping as the original device.", { count: number(fresh.length) }))) return;
      await queueEntries(fresh);
      saved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not restore the backup."); }
  }

  if (!ledger) return <main className="loading"><img src="/icon.svg" width="64" height="64" alt="" /><h1>Splitty</h1><p>{t("Opening your shared ledger…")}</p>{error && <p className="error" role="alert">{message(error)}</p>}</main>;

  const p = { ...ledger.preferences, nameA: person(ledger.preferences, "a"), nameB: person(ledger.preferences, "b") };
  const other = p.member === "a" ? p.nameB : p.nameA;
  const active = ledger.entries.filter((entry) => !entry.deleted);
  const balanceA = active.reduce((sum, entry) => sum + entry.balanceA, 0);
  const balance = p.member === "a" ? balanceA : -balanceA;
  const query = tab === "search" ? normalizeText(search.trim()) : "";
  const shown = active.filter((entry) => !query || normalizeText(`${entry.description} ${entry.category} ${t(categoryLabels[expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode)])} ${entry.date}`).includes(query))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const conflictIds = new Set(ledger.conflicts.map((conflict) => conflict.entryId));
  const todos = insuranceTodos(active);
  const openTodos = todos.filter((todo) => !todo.done).length;
  const markSubmitted = (entry: Entry, submitted: boolean) => {
    const { insuranceSubmittedAt: _previous, ...rest } = entry;
    return queueEntries([submitted ? { ...rest, insuranceSubmittedAt: new Date().toISOString() } : rest]);
  };

  return <div className="app-shell" onInvalidCapture={(event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
      input.setCustomValidity(input.validity.valueMissing ? t("Please fill out this field.")
        : input instanceof HTMLInputElement && input.type === "date" ? t("Enter a valid date.") : "");
    }
  }} onInputCapture={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) event.target.setCustomValidity("");
  }}>
    <header className="topbar"><a className="wordmark" href="/" aria-label={t("Splitty home")}><img className="brand-mark" src="/icon.svg" width="32" height="32" alt="" />Splitty</a>
      <button className={`sync-pill ${online ? "" : "offline"}`} onClick={() => void sync()} disabled={syncBusy} aria-label={t("Synchronize devices")}>{online ? <Cloud size={16} /> : <CloudOff size={16} />}<span>{syncBusy ? t("Syncing") : ledger.pending ? t("{count} pending", { count: number(ledger.pending) }) : t(online ? "Sync" : "Offline")}</span></button>
    </header>
    <main className={tab === "expenses" ? "with-expense-action" : undefined}>
      {error && <div className="banner error" role="alert">{message(error)}<button className="icon-button" aria-label={t("Dismiss error")} onClick={() => setError("")}><X size={18} /></button></div>}
      {update && <div className="banner">{t("An app update is ready. Your saved entries will be kept.")}<button onClick={() => void update().catch((e: Error) => setError(e.message))} className="text-button">{t("Update")}</button></div>}
      {tab === "todos" ? <TodoList todos={todos} openCount={openTodos} status={message(syncStatus)} blocked={conflictIds} open={setForm}
        toggle={(entry, submitted) => void markSubmitted(entry, submitted).then(saved).catch((e: Error) => setError(e.message))} /> : tab === "statistics" ? <Statistics entries={ledger.entries} preferences={p} /> : tab !== "settings" ? <>
        {tab === "expenses" ? <>
          <header className="page-heading">
            <h1>{t("Expenses")}<span className="entry-count">{number(active.length)}</span></h1>
            <p className="household-members">{p.nameA} & {p.nameB}</p>
          </header>
          <section className="balance-card" aria-label={t("Household balance")}>
            <div className="balance-summary">
              <p>{balance === 0 ? t("You are all settled up") : balance < 0 && other === t("Your wife") ? t("You owe your wife") : t(balance > 0 ? "{name} owes you" : "You owe {name}", { name: other })}</p>
              <div className={`balance-amount ${balance < 0 ? "owed" : balance === 0 ? "settled" : ""}`}>{money(Math.abs(balance))}</div>
            </div>
            <button className="settle-button" onClick={() => setForm("settlement")}>{t("Settle up")}</button>
          </section>
        </> : <>
          <header className="page-heading search-heading"><h1>{t("Search")}</h1><button className="text-button" onClick={() => setImporting(true)}><Upload size={18} />{t("Import")}</button></header>
          <label className="search"><Search size={19} /><input aria-label={t("Search expenses")} type="search" placeholder={t("Search expenses")} value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} /></label>
          <p className="search-hint">{t("Description, category or date")}</p>
        </>}
        {!!ledger.conflicts.length && <section className="conflict-panel"><h3>{t("Conflicting edits")}</h3><p>{t("These entries changed on another device. Choose which version to keep.")}</p>{ledger.conflicts.map((conflict) => {
          const local = ledger.entries.find((entry) => entry.id === conflict.entryId);
          return <div key={conflict.entryId}><strong>{local?.description}</strong><p>{t("This device: {local} · Other device: {remote} ({name}'s balance)", { local: local?.deleted ? t("Deleted") : money(local?.balanceA ?? 0), remote: conflict.remote?.deleted ? t("Deleted") : conflict.remote ? money(conflict.remote.balanceA) : t("Not present"), name: p.nameA })}</p><div className="button-row">
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, false).then(saved).catch((e: Error) => setError(e.message))}>{t("Keep other device")}</button>
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, true).then(saved).catch((e: Error) => setError(e.message))}>{t("Keep this device")}</button>
          </div></div>;
        })}</section>}
        <p className="sync-status" role="status">{message(syncStatus)}</p>
        <section className="ledger-section" aria-label={t(tab === "search" ? "Search results" : "Expenses")}>
          {tab === "search" && <div className="section-title"><h2>{t("Search results")}<span>{number(shown.length)}</span></h2></div>}
          {!shown.length ? <div className="empty-state"><h2>{t(query ? "No matching expenses" : "No expenses yet")}</h2>{query && <p>{t("Try a different description, category or date.")}</p>}</div> :
            <div className="expense-list">{shown.slice(0, limit).map((entry, index) => {
              const month = new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { month: "long", year: "numeric" });
              const heading = index === 0 || entry.date.slice(0, 7) !== shown[index - 1].date.slice(0, 7);
              const contribution = p.member === "a" ? entry.balanceA : -entry.balanceA;
              const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
              const payment = category === "payment";
              return <div key={entry.id}>{heading && <h3 className="month-heading">{month}</h3>}<button className="expense-row" onClick={() => setForm(entry)} disabled={conflictIds.has(entry.id)}>
                <span className="date-block"><small>{new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { month: "short" })}</small>{Number(entry.date.slice(8))}</span>
                <span className={`entry-icon ${payment ? "payment" : ""}`}><ExpenseIcon category={category} /></span>
                <span className="entry-description"><strong>{entry.description}</strong><small>{entry.kind === "imported" ? t("{category} · imported", { category: t(categoryLabels[category]) }) : t("{name} paid {amount}", { name: payer(p, entry.paidBy!), amount: money(entry.amountCents) })}</small></span>
                <span className={`entry-balance ${contribution < 0 ? "owed" : contribution > 0 ? "lent" : ""}`}><small>{t(contribution === 0 ? "no balance change" : payment ? "balance change" : contribution > 0 ? "you lent" : "you borrowed")}</small><strong>{money(Math.abs(contribution))}</strong></span>
              </button></div>;
            })}{shown.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 100)}>{t("Show more ({count})", { count: number(shown.length - limit) })}</button>}</div>}
        </section>
      </> : <section className="settings-page"><header className="page-heading"><h1>{t("Settings")}</h1></header>
        <section className="settings-card"><h2><Languages size={20} />{t("Language")}</h2>
          <label>{t("App language")}<select aria-label={t("App language")} value={language} onChange={(event) => void updatePreferences({ language: event.target.value === "en" ? "en" : "de" }).catch((e: Error) => setError(e.message))}>
            <option value="de" lang="de">Deutsch</option><option value="en" lang="en">English</option>
          </select></label>
        </section>
        <section className="settings-card"><h2><Cloud size={20} />{t("Synchronization")}</h2><p className="muted" role="status">{message(syncStatus)}</p>
          {identity ? <><p>{t("Signed in as {name}.", { name: person(p, identity.member) })}</p><div className="button-row"><button className="secondary" disabled={syncBusy} onClick={() => void sync()}><RefreshCw size={16} />{t("Sync now")}</button><button className="text-button" onClick={() => void signOut()}>{t("Sign out")}</button></div><p className="muted">{t("Signing out does not erase this device's offline history. Use a trusted device.")}</p></> :
            <form onSubmit={(event) => void signIn(event)}><label>{t("Member token")}<input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={43} value={memberToken} onChange={(event) => setMemberToken(event.target.value)} /></label><button className="primary" disabled={signInBusy || !online}>{t(signInBusy ? "Signing in…" : "Sign in")}</button><p className="muted">{t("This device stays signed in until you sign out or the member token is rotated.")}</p></form>}
        </section>
        <section className="settings-card"><h2><Users size={20} />{t("Household")}</h2><label>{t("First person")}<input defaultValue={p.nameA} key={`a-${p.nameA}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== p.nameA) void updatePreferences({ nameA: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label><label>{t("Second person")}<input defaultValue={p.nameB} key={`b-${p.nameB}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== p.nameB) void updatePreferences({ nameB: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label>
          {!identity && <label>{t("This device belongs to")}<select value={p.member} onChange={(e) => void updatePreferences({ member: e.target.value as Member }).catch((err: Error) => setError(err.message))}><option value="a">{p.nameA}</option><option value="b">{p.nameB}</option></select></label>}
          <p className="muted">{t("EUR and an equal split are always the default. Signed-in names come from your household configuration.")}</p>
        </section>
        <section className="settings-card"><h2><Download size={20} />{t("Backups")}</h2><button className="secondary" onClick={backup}><Download size={17} />{t("Download a backup")}</button><FilePicker label={t("Restore missing entries from a backup")} accept=".json,application/json" choose={(file) => void restore(file)} /><p className="muted">{t("Offline data lives in this browser. Clearing site data removes unsynced entries. Keep backups, and sync before changing devices.")}</p></section>
      </section>}
    </main>
    {tab === "expenses" && <div className="expense-action"><button className="add-button" aria-label={t("Add expense")} onClick={() => setForm("expense")}><Plus size={23} /><span>{t("Add expense")}</span></button></div>}
    <nav className="bottom-nav" aria-label={t("Main navigation")}>
      <button className={tab === "expenses" ? "active" : ""} aria-current={tab === "expenses" ? "page" : undefined} onClick={() => navigate("expenses")}><Receipt size={22} /><span>{t("Expenses")}</span></button>
      <button className={tab === "todos" ? "active" : ""} aria-current={tab === "todos" ? "page" : undefined} onClick={() => navigate("todos")}><ClipboardCheck size={22} /><span>{t("To-dos")}{!!openTodos && <span className="nav-badge" aria-hidden="true">{number(openTodos)}</span>}</span></button>
      <button className={tab === "search" ? "active" : ""} aria-current={tab === "search" ? "page" : undefined} onClick={() => navigate("search")}><Search size={22} /><span>{t("Search")}</span></button>
      <button className={tab === "statistics" ? "active" : ""} aria-current={tab === "statistics" ? "page" : undefined} onClick={() => navigate("statistics")}><BarChart3 size={22} /><span>{t("Statistics")}</span></button>
      <button className={tab === "settings" ? "active" : ""} aria-current={tab === "settings" ? "page" : undefined} onClick={() => navigate("settings")}><Settings size={22} /><span>{t("Settings")}</span></button>
    </nav>
    {form && <ExpenseForm entry={typeof form === "object" ? form : undefined} settlement={form === "settlement" || (typeof form === "object" && form.kind === "settlement")} preferences={p} close={() => setForm(null)} saved={saved} />}
    {importing && <ImportForm preferences={p} close={() => setImporting(false)} saved={saved} />}
  </div>;
}
