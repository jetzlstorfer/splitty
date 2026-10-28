import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { liveQuery } from "dexie";
import {
  BarChart3, Check, ChevronDown, ClipboardCheck, Cloud, CloudAlert, CloudOff,
  Download, Languages, Plus, Receipt, RefreshCw, Search, Settings, Sparkles, Sun, Trash2, Upload, Users, X
} from "lucide-react";
import { calculateShareA, expenseBalance, parseMoney, type Entry, type Member, type SplitType } from "../shared/model";
import { translate } from "../shared/i18n";
import { MAX_TODO_TITLE, MAX_TODO_DESCRIPTION, type Todo } from "../shared/todo";
import { db, queueEntries, queueTodos, resolveConflict, resolveStoreConflict, todoStore, updatePreferences, getPreferences, type Conflict, type Preferences } from "./db";
import { missingBackupRecords, readBackup, restoreBackup } from "./backup";
import type { ImportPreview } from "./importer";
import { ApiError, identify, signInDevice, signOutDevice, synchronize, type Identity } from "./sync";
import { LanguageContext, useLocale } from "./i18n";
import { categoryLabels, detectCategory, expenseCategory, normalizeText, storedCategory, type Category } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import SwipeableRow from "./SwipeableRow";
import { householdTodos, type HouseholdTodo } from "./todos";
import { ConfirmationProvider, DateField, Form, Select, Sheet, dateValue as today, useConfirm } from "./Controls";

const loadStatistics = () => import("./StatisticsPage");
const Statistics = lazy(loadStatistics);

interface Snapshot {
  entries: Entry[]; todos: Todo[]; pending: number; preferences: Preferences;
  conflicts: Conflict[]; todoConflicts: Conflict<Todo>[];
}

function useLedger(): Snapshot | null {
  const [value, setValue] = useState<Snapshot | null>(null);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const [entries, todos, outboxCount, todoOutboxCount, preferences, conflicts, todoConflicts] = await Promise.all([
        db.entries.toArray(), db.todos.toArray(), db.outbox.count(), db.todoOutbox.count(),
        getPreferences(), db.conflicts.toArray(), db.todoConflicts.toArray()
      ]);
      return { entries, todos, pending: outboxCount + todoOutboxCount, preferences, conflicts, todoConflicts };
    }).subscribe({
      next: setValue,
      error: (error: unknown) => window.dispatchEvent(new CustomEvent("splitty-error", {
        detail: `Local storage failed: ${error instanceof Error ? error.message : String(error)}`
      }))
    });
    return () => subscription.unsubscribe();
  }, []);
  return value;
}

function SyncPopover({ online, busy, pending, attention, upToDate, status, children }: {
  online: boolean; busy: boolean; pending: number; attention: boolean; upToDate: boolean;
  status: string; children: ReactNode;
}) {
  const { t, number } = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const header = popover?.closest("header");
    if (!popover || !header) return;
    const align = () => popover.style.setProperty("--sync-header-bottom", `${header.getBoundingClientRect().bottom}px`);
    align();
    const observer = new ResizeObserver(align);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return <div className="sync-control">
    <button className={`sync-pill ${attention ? "needs-attention" : ""}`} popoverTarget={id}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-busy={busy} aria-label={t("Sync status")}>
      <span aria-hidden="true">{!online ? <CloudOff size={16} /> : attention ? <CloudAlert size={16} /> :
        <span className="sync-icon"><Cloud size={16} />{upToDate && <Check className="sync-check" size={9} strokeWidth={4} />}</span>}</span>
      <span>{!online ? t("Offline") : busy ? t("Syncing") : pending ? t("{count} pending", { count: number(pending) }) : t("Sync")}</span>
    </button>
    <span className="sync-status sr-only" role="status">{status}</span>
    <div ref={popoverRef} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-heading`} className="sync-popover"
      onToggle={(event) => setOpen(event.newState === "open")}>
      <div className="sync-popover-heading">
        <h2 id={`${id}-heading`}>{t("Synchronization")}</h2>
        <button className="icon-button" popoverTarget={id} popoverTargetAction="hide" aria-label={t("Close")}><X size={20} /></button>
      </div>
      <p className={`sync-summary ${attention ? "needs-attention" : ""}`}>{status}</p>
      {children}
    </div>
  </div>;
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
      saved(value); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this expense."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!entry || !await confirm({ title: t("Delete entry"), description: t("Delete this entry for both of you? This will sync when you are online."), action: t("Delete entry"), dangerous: true })) return;
    setBusy(true);
    try { await queueEntries([{ ...entry, deleted: true }]); saved(); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this entry."); }
    finally { setBusy(false); }
  }

  const other = p.member === "a" ? p.nameB : p.nameA;
  return <Sheet title={t(entry ? "Edit entry" : settlement ? "Settle up" : "Add an expense")} close={close} initialFocus={!entry ? "#expense-description" : undefined}>
    <Form onSubmit={submit} className="expense-form" lang={language}>
      <div className="description-field"><label htmlFor="expense-description">{t("Description")}</label><div className="description-input" data-category={category}><ExpenseIcon category={category} size={24} /><input id="expense-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t(settlement ? "Payment" : "Enter a description")} required maxLength={500} /></div></div>
      <label>{t("Amount in EUR")}<div className="amount-input"><span>€</span><input aria-label={t("Amount in EUR")} inputMode="decimal" value={amount} readOnly={imported} onChange={(e) => setAmount(e.target.value)} placeholder={language === "de" ? "0,00" : "0.00"} required /></div></label>
      {imported ? <p className="notice">{t("Imported balance: {amount} for {name}. The CSV does not reliably identify the original payer or split, so those amounts are preserved. Description and date can be edited.", { amount: money(entry.balanceA), name: p.nameA })}</p> : <>
        <div className="split-summary">
          <span>{t(settlement ? "Payment from" : "Paid by")}</span>
          <Select<Member> label={t("Paid by")} value={paidBy} onChange={setPaidBy} options={[{ value: "a", label: payer(p, "a") }, { value: "b", label: payer(p, "b") }]} />
          {settlement && <span>{paidBy !== p.member ? t("to you") : other === t("Your spouse") ? t("to your spouse") : t("to {name}", { name: other })}</span>}
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
      <DateField value={date} onChange={setDate} />
      {!imported && !settlement && <div className="category-picker"><label>{t("Category")}
        <Select<Category | "auto"> label={t("Category")} value={categoryChoice} onChange={setCategoryChoice}
          options={[{ value: "auto", label: t("Automatic") }, ...(Object.keys(categoryLabels) as Category[]).filter((key) => key !== "payment").map((key) => ({ value: key, label: t(categoryLabels[key]) }))]} />
      </label><span className="category-detected" role="status">{t(categoryChoice === "auto" ? "Detected: {category}" : "Selected: {category}", { category: t(categoryLabels[category]) })}</span></div>}
      {error && <p className="error" role="alert">{message(error)}</p>}
      <button className="primary" disabled={busy} type="submit"><Check size={19} />{t(busy ? "Saving…" : "Save")}</button>
      {entry && <button className="danger-link" type="button" disabled={busy} onClick={(event) => { event.currentTarget.focus(); void remove(); }}><Trash2 size={16} />{t("Delete entry")}</button>}
    </Form>
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
      const { readCsv } = await import("./importer");
      const parsed = readCsv(content);
      setText(content); setMembers(parsed.members);
      setMemberA(parsed.members.includes(p.nameA) ? p.nameA : parsed.members[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read this file."); }
  }
  async function inspect() {
    setBusy(true); setError("");
    try {
      const { previewImport } = await import("./importer");
      setPreview(await previewImport(text, memberA, new Set(await db.entries.toCollection().primaryKeys())));
    }
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
      <label>{t("Export column for {name}", { name: p.nameA })}<Select label={t("Export column for {name}", { name: p.nameA })} value={memberA} disabled={busy} onChange={(value) => { setMemberA(value); setPreview(null); }} options={members.map((member) => ({ value: member, label: member }))} /></label>
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

function TodoForm({ todo, close, saved }: { todo?: Todo; close: () => void; saved: () => void }) {
  const { t, message, language } = useLocale();
  const confirm = useConfirm();
  const [title, setTitle] = useState(todo?.title ?? "");
  const [description, setDescription] = useState(todo?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(deleted = false) {
    setBusy(true); setError("");
    try {
      const timestamp = new Date().toISOString();
      await queueTodos([deleted && todo ? { ...todo, deleted: true } : {
        id: todo?.id ?? crypto.randomUUID(), title, description, done: todo?.done ?? false,
        createdAt: todo?.createdAt ?? timestamp, updatedAt: timestamp, revision: todo?.revision ?? 0, deleted: false
      }]);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this to-do."); }
    finally { setBusy(false); }
  }

  return <Sheet title={t(todo ? "Edit to-do" : "Add to-do")} close={close} initialFocus={!todo ? "#todo-title" : undefined}>
    <Form className="panel-content" lang={language} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor="todo-title">{t("Title")}<input id="todo-title" required maxLength={MAX_TODO_TITLE} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t("Description (optional)")}<textarea rows={4} maxLength={MAX_TODO_DESCRIPTION} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      {error && <p className="error" role="alert">{message(error)}</p>}
      <button className="primary" disabled={busy}>{t(busy ? "Saving…" : "Save")}</button>
      {todo && <button type="button" className="danger-link" disabled={busy} onClick={async (event) => {
        event.currentTarget.focus();
        if (await confirm({ title: t("Delete to-do"), description: t("Delete this to-do for everyone in your household? This will sync when you are online."), action: t("Delete to-do"), dangerous: true })) await save(true);
      }}><Trash2 size={16} />{t("Delete to-do")}</button>}
    </Form>
  </Sheet>;
}

function TodoList({ todos, conflicts, openCount, blocked, open, toggle, edit, toggleManual, remove, onError }: {
  todos: HouseholdTodo[]; conflicts: Conflict<Todo>[];
  openCount: number; blocked: Set<string>;
  open: (entry: Entry) => void; toggle: (entry: Entry, submitted: boolean) => void;
  edit: (todo: Todo) => void; toggleManual: (todo: Todo, done: boolean) => void;
  remove: (item: HouseholdTodo) => Promise<void>; onError: (error: unknown) => void;
}) {
  const { t, number, money, locale } = useLocale();
  const [swipedTodo, setSwipedTodo] = useState<string | null>(null);
  const manualBlocked = new Set(conflicts.map((conflict) => conflict.entryId));
  return <section className="todos-page"><header className="page-heading"><h1>{t("To-dos")}<span className="entry-count">{number(openCount)}</span></h1></header>
    <div aria-live="polite" aria-atomic="true">
      {openCount === 0 && <div className="empty-state todo-clear-state">
        <span className="todo-clear-icon" aria-hidden="true"><Sun size={30} /></span>
        <h2>{t("All caught up!")}</h2>
        <p>{t("Nothing left to chase. Enjoy your day.")}</p>
        {!todos.length && <p className="todo-clear-hint">{t("Add your own to-dos here. Doctor and pharmacy expenses also appear automatically for insurance submission.")}</p>}
      </div>}
    </div>
    {[false, true].map((done) => {
        const group = todos.filter((todo) => todo.done === done);
        return !!group.length && <section key={String(done)} className="todo-group" aria-label={t(done ? "Done" : "Open to-dos")}>
          {done && <div className="section-title"><h2>{t("Done")}<span>{number(group.length)}</span></h2></div>}
          <ul className="todo-list">{group.map((item) => {
            if (item.kind === "manual") {
              const { todo } = item;
              const id = `manual-${todo.id}`;
              return <li key={id} className={`todo-item manual-todo ${done ? "done" : ""}`}>
                <SwipeableRow description={todo.title} disabled={manualBlocked.has(todo.id)} open={swipedTodo === id}
                  setOpen={(open) => setSwipedTodo(open ? id : null)} edit={() => edit(todo)} remove={() => remove(item)} onError={onError}
                  actionsLabel={t("To-do actions")} editLabel={t("Edit to-do")} deleteLabel={t("Delete to-do")}
                  deleteConfirmation={t("Delete this to-do for everyone in your household? This will sync when you are online.")}>
                  <div className="todo-row">
                    <label className="todo-check"><input type="checkbox" aria-label={todo.title} checked={done} disabled={manualBlocked.has(todo.id)} onChange={(event) => toggleManual(todo, event.target.checked)} /></label>
                    <button className="todo-details" disabled={manualBlocked.has(todo.id)} onClick={() => edit(todo)}>
                      <span className="entry-icon"><ClipboardCheck size={20} /></span>
                      <span className="entry-description"><strong>{todo.title}</strong>{todo.description && <small>{todo.description}</small>}</span>
                    </button>
                  </div>
                </SwipeableRow>
              </li>;
            }
            const { entry } = item;
            const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
            const details = t("Expense: {description} · {date} · {amount}", {
              description: entry.description, amount: money(entry.amountCents),
              date: new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })
            });
            const id = `insurance-${entry.id}`;
            return <li key={id} className={`todo-item ${done ? "done" : ""}`}>
              <SwipeableRow description={entry.description} disabled={blocked.has(entry.id)} open={swipedTodo === id}
                setOpen={(open) => setSwipedTodo(open ? id : null)} edit={() => open(entry)} remove={() => remove(item)} onError={onError}
                actionsLabel={t("To-do actions")} editLabel={t("Open expense")} deleteLabel={t("Delete entry")}
                deleteConfirmation={t("Delete this entry for both of you? This will sync when you are online.")}>
                <div className="todo-row">
                  <label className="todo-check"><input type="checkbox" aria-label={`${t("Submit to insurance")}: ${entry.description}`} checked={done} disabled={blocked.has(entry.id)} onChange={(event) => toggle(entry, event.target.checked)} /></label>
                  <button className="todo-details" disabled={blocked.has(entry.id)} onClick={() => open(entry)}>
                    <span className="entry-icon" data-category={category}><ExpenseIcon category={category} /></span>
                    <span className="entry-description"><strong>{t("Submit to insurance")}</strong><small>{details}</small></span>
                  </button>
                </div>
              </SwipeableRow>
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
  return <LanguageContext.Provider value={language}><ConfirmationProvider><AppContent ledger={ledger} /></ConfirmationProvider></LanguageContext.Provider>;
}

function AppContent({ ledger }: { ledger: Snapshot | null }) {
  const { t, language, locale, number, money, message, person, payer } = useLocale();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"expenses" | "todos" | "search" | "statistics" | "settings">("expenses");
  const [form, setForm] = useState<"expense" | "settlement" | Entry | null>(null);
  const [todoForm, setTodoForm] = useState<"new" | Todo | null>(null);
  const [swipedEntry, setSwipedEntry] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [online, setOnline] = useState(navigator.onLine);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [syncBusy, setSyncBusy] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [syncActionError, setSyncActionError] = useState("");
  const syncLock = useRef<Promise<void> | null>(null);
  const syncRequested = useRef(false);
  const [error, setError] = useState("");
  const [memberToken, setMemberToken] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ entry: Entry; settled: boolean } | null>(null);
  const [logoPulse, setLogoPulse] = useState({ sequence: 0, active: false });

  useEffect(() => {
    loadStatistics().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!logoPulse.active) return;
    const timeout = window.setTimeout(() => setLogoPulse((current) => ({ ...current, active: false })), 1800);
    return () => window.clearTimeout(timeout);
  }, [logoPulse.active, logoPulse.sequence]);

  useEffect(() => {
    if (!saveFeedback) return;
    const timeout = window.setTimeout(() => setSaveFeedback(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [saveFeedback]);

  const performSync = useCallback(() => {
    if (!navigator.onLine) return Promise.resolve();
    syncRequested.current = true;
    if (syncLock.current) return syncLock.current;
    syncLock.current = (async () => {
      do {
        syncRequested.current = false;
        const me = await identify();
        if ((me.member !== "a" && me.member !== "b") || !me.nameA || !me.nameB) throw new Error("Invalid sign-in response.");
        setIdentity(me);
        await updatePreferences({ member: me.member, nameA: me.nameA, nameB: me.nameB });
        setSyncStatus("Syncing…");
        await synchronize();
        setLastSynced(new Date());
        setSyncStatus(await db.conflicts.count() + await db.todoConflicts.count() ? "Some edits need your attention"
          : await db.outbox.count() + await db.todoOutbox.count() ? "Saved locally · changes waiting to sync" : "Up to date");
        // Saves during an in-flight pass need another pass, not a dropped request.
      } while (syncRequested.current && navigator.onLine);
    })().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) { setIdentity(null); setSyncStatus("Sign in to sync"); }
      else setSyncStatus(e instanceof Error ? e.message : "Sync failed; your changes remain on this device.");
    }).finally(() => { syncLock.current = null; setSyncBusy(false); });
    return syncLock.current;
  }, []);

  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
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
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("splitty-error", failure); window.addEventListener("splitty-update", available);
    void performSync();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void sync(); }, 60_000);
    return () => {
      window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected);
      window.removeEventListener("focus", focus);
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

  const saved = () => { setSaveFeedback(null); setSyncStatus("Saved on this device"); void sync(); };
  const conflictResolved = () => { setSyncActionError(""); saved(); };
  const pulseLogo = () => setLogoPulse((current) => ({ sequence: current.sequence + 1, active: true }));

  function navigate(next: typeof tab) {
    setSwipedEntry(null);
    setSaveFeedback(null);
    setTab(next);
    setLimit(100);
    window.scrollTo(0, 0);
  }

  async function signIn(event: FormEvent) {
    event.preventDefault(); setSignInBusy(true); setSyncActionError("");
    try {
      await signInDevice(memberToken);
      setMemberToken(""); await sync();
    } catch (e) { setSyncActionError(e instanceof Error ? e.message : "Could not sign in with this token."); }
    finally { setSignInBusy(false); }
  }

  async function signOut() {
    setSignOutBusy(true); setSyncActionError("");
    try {
      await signOutDevice();
      setLastSynced(null);
      setIdentity(null); setSyncStatus("Signed out · local history remains on this device");
    } catch (e) { setSyncActionError(e instanceof Error ? e.message : "Could not sign out."); }
    finally { setSignOutBusy(false); }
  }

  function backup() {
    if (!ledger) return;
    const blob = new Blob([JSON.stringify({ format: "splitty-v2", exportedAt: new Date().toISOString(), preferences: ledger.preferences, entries: ledger.entries, todos: ledger.todos }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `splitty-backup-${today()}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restore(file?: File) {
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error("Choose a backup smaller than 20 MB.");
      const data = readBackup(JSON.parse(await file.text()));
      const missing = await missingBackupRecords(data);
      if (!await confirm({ title: t("Restore backup"), description: t("Restore {entries} missing entries and {todos} missing to-dos? Existing data will not be overwritten. Keep the same person A/B mapping as the original device.",
        { entries: number(missing.entries.length), todos: number(missing.todos.length) }), action: t("Restore backup") })) return;
      await restoreBackup(data);
      saved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not restore the backup."); }
  }

  const active = useMemo(() => ledger?.entries.filter((entry) => !entry.deleted) ?? [], [ledger?.entries]);
  const balanceA = useMemo(() => active.reduce((sum, entry) => sum + entry.balanceA, 0), [active]);
  const query = tab === "search" ? normalizeText(search.trim()) : "";
  const sortedActive = useMemo(() => active.slice().sort((a, b) =>
    b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
  ), [active]);
  const searchIndex = useMemo(() => tab !== "search" ? [] : sortedActive.map((entry) => ({
    entry,
    text: normalizeText(`${entry.description} ${entry.category} ${translate(language, categoryLabels[expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode)])} ${entry.date}`)
  })), [language, sortedActive, tab]);
  const shown = useMemo(() => tab === "search"
    ? searchIndex.filter(({ text }) => !query || text.includes(query)).map(({ entry }) => entry)
    : sortedActive, [query, searchIndex, sortedActive, tab]);
  const conflictIds = useMemo(() => new Set(ledger?.conflicts.map((conflict) => conflict.entryId) ?? []), [ledger?.conflicts]);
  const todos = useMemo(() => householdTodos(active, ledger?.todos ?? []), [active, ledger?.todos]);
  const openTodos = useMemo(() => todos.filter((todo) => !todo.done).length, [todos]);

  if (!ledger) return <main className="loading"><img src="/icon.svg" width="64" height="64" alt="" /><h1>Splitty</h1><p>{t("Opening your shared ledger…")}</p>{error && <p className="error" role="alert">{message(error)}</p>}</main>;

  const p = { ...ledger.preferences, nameA: person(ledger.preferences, "a"), nameB: person(ledger.preferences, "b") };
  const other = p.member === "a" ? p.nameB : p.nameA;
  const balance = p.member === "a" ? balanceA : -balanceA;
  const conflictCount = ledger.conflicts.length + ledger.todoConflicts.length;
  // Another tab can acknowledge shared queued writes after this tab's sync finishes.
  const idleStatus = syncStatus === "Saved locally · changes waiting to sync" && !ledger.pending && !conflictCount ? "Up to date" : syncStatus;
  const currentStatus = !online ? "Offline · changes stay on this device" : syncBusy ? "Syncing…" : idleStatus;
  const upToDate = online && !syncBusy && !ledger.pending && !conflictCount && idleStatus === "Up to date";
  const needsAttention = !!syncActionError || !!conflictCount ||
    !["Up to date", "Syncing…", "Saved on this device", "Saved locally · changes waiting to sync", "Offline · changes stay on this device"].includes(currentStatus);
  const todoVersion = (todo: Todo | null | undefined) => !todo ? t("Not present") : todo.deleted ? t("Deleted")
    : `${todo.title}${todo.description ? `\n${todo.description}` : ""}\n${t(todo.done ? "Done" : "Open to-dos")}`;
  const expenseSaved = (entry?: Entry) => {
    saved();
    if (!entry) { setSaveFeedback(null); return; }
    if (form === "expense" && entry.kind === "expense") pulseLogo();
    // The live query may already contain this save, so reconstruct the previous balance from the form.
    const remaining = active.filter((item) => item.id !== entry.id).reduce((sum, item) => sum + item.balanceA, 0);
    const previous = typeof form === "object" && form ? form.balanceA : 0;
    setSaveFeedback({
      entry,
      settled: entry.kind === "settlement" && remaining + previous !== 0 && remaining + entry.balanceA === 0
    });
  };
  const markSubmitted = (entry: Entry, submitted: boolean) => {
    const { insuranceSubmittedAt: _previous, ...rest } = entry;
    return queueEntries([submitted ? { ...rest, insuranceSubmittedAt: new Date().toISOString() } : rest]);
  };

  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="/" aria-label={t("Splitty home")}><img key={logoPulse.sequence} className={`brand-mark ${syncBusy ? "is-syncing" : logoPulse.active ? "is-saving" : ""}`} src="/icon.svg" width="32" height="32" alt="" />Splitty</a>
      <SyncPopover online={online} busy={syncBusy} pending={ledger.pending} attention={needsAttention} upToDate={upToDate} status={message(currentStatus)}>
        <dl className="sync-details">
          <div><dt>{t("Connection")}</dt><dd>{t(online ? "Online" : "Offline")}</dd></div>
          <div><dt>{t("Changes waiting to sync")}</dt><dd>{number(ledger.pending)}</dd></div>
          {!!conflictCount && <div><dt>{t("Edits needing attention")}</dt><dd>{number(conflictCount)}</dd></div>}
          <div><dt>{t("Last sync this session")}</dt><dd>{lastSynced ? <time dateTime={lastSynced.toISOString()}>{lastSynced.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</time> : t("Not yet synced")}</dd></div>
        </dl>
        {syncActionError && <p className="error" role="alert">{message(syncActionError)}</p>}
        {identity && <p>{t("Signed in as {name}.", { name: person(p, identity.member) })}</p>}
        <div className="button-row"><button className="secondary" disabled={!online || syncBusy || signInBusy || signOutBusy} onClick={() => void sync()}><RefreshCw size={16} />{t("Sync now")}</button>
          {identity && <button className="text-button" disabled={!online || syncBusy || signOutBusy} aria-busy={signOutBusy} onClick={() => void signOut()}>{t("Sign out")}</button>}</div>
        {identity ? <p className="muted">{t("Signing out does not erase this device's offline history. Use a trusted device.")}</p> :
          <Form className="sync-sign-in" onSubmit={(event) => void signIn(event)}><label>{t("Member token")}<input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={43} value={memberToken} onChange={(event) => setMemberToken(event.target.value)} /></label>
            <button className="primary" disabled={signInBusy || syncBusy || !online}>{t(signInBusy ? "Signing in…" : "Sign in")}</button>
            <p className="muted">{t("This device stays signed in until you sign out or the member token is rotated.")}</p></Form>}
        {!!ledger.conflicts.length && <section className="conflict-panel" aria-label={t("Conflicting edits")}><h3>{t("Conflicting edits")}</h3><p>{t("These entries changed on another device. Choose which version to keep.")}</p>{ledger.conflicts.map((conflict) => {
          const local = ledger.entries.find((entry) => entry.id === conflict.entryId);
          return <div key={conflict.entryId}><strong>{local?.description}</strong><p>{t("This device: {local} · Other device: {remote} ({name}'s balance)", { local: local?.deleted ? t("Deleted") : money(local?.balanceA ?? 0), remote: conflict.remote?.deleted ? t("Deleted") : conflict.remote ? money(conflict.remote.balanceA) : t("Not present"), name: p.nameA })}</p><div className="button-row">
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, false).then(conflictResolved).catch((e: Error) => setSyncActionError(e.message))}>{t("Keep other device")}</button>
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, true).then(conflictResolved).catch((e: Error) => setSyncActionError(e.message))}>{t("Keep this device")}</button>
          </div></div>;
        })}</section>}
        {!!ledger.todoConflicts.length && <section className="conflict-panel" aria-label={t("Conflicting to-do edits")}><h3>{t("Conflicting to-do edits")}</h3>
          <p>{t("These to-dos changed on another device. Choose which version to keep.")}</p>
          {ledger.todoConflicts.map((conflict) => <div key={conflict.entryId}>
            <p className="todo-version"><strong>{t("This device")}</strong>{"\n"}{todoVersion(ledger.todos.find((todo) => todo.id === conflict.entryId))}</p>
            <p className="todo-version"><strong>{t("Other device")}</strong>{"\n"}{todoVersion(conflict.remote)}</p>
            <div className="button-row"><button className="secondary" onClick={() => void resolveStoreConflict(conflict.entryId, false, todoStore()).then(conflictResolved).catch((e: Error) => setSyncActionError(e.message))}>{t("Keep other device")}</button>
              <button className="secondary" onClick={() => void resolveStoreConflict(conflict.entryId, true, todoStore()).then(conflictResolved).catch((e: Error) => setSyncActionError(e.message))}>{t("Keep this device")}</button></div>
          </div>)}
        </section>}
      </SyncPopover>
    </header>
    <main className={tab === "expenses" || tab === "todos" ? "with-expense-action" : undefined}>
      {error && <div className="banner error" role="alert">{message(error)}<button className="icon-button" aria-label={t("Dismiss error")} onClick={() => setError("")}><X size={18} /></button></div>}
      {update && <section className="update-card accent-hero" aria-labelledby="update-title">
        <div role="status">
          <h2 id="update-title"><Sparkles size={24} aria-hidden="true" />{t("New version available")}</h2>
          <p>{t("Your saved entries will be kept.")}</p>
        </div>
        <button onClick={() => void update().catch((e: Error) => setError(e.message))} className="primary"><RefreshCw size={18} aria-hidden="true" />{t("Update")}</button>
      </section>}
      {tab === "todos" ? <TodoList todos={todos} openCount={openTodos} blocked={conflictIds} open={setForm}
        conflicts={ledger.todoConflicts}
        edit={setTodoForm}
        remove={async (item) => {
          if (item.kind === "manual") await queueTodos([{ ...item.todo, deleted: true }]);
          else await queueEntries([{ ...item.entry, deleted: true }]);
          saved();
        }}
        onError={(e) => setError(e instanceof Error ? e.message : "Could not save this to-do.")}
        toggleManual={(todo, done) => void queueTodos([{ ...todo, done }]).then(saved).catch((e: Error) => setError(e.message))}
        toggle={(entry, submitted) => void markSubmitted(entry, submitted).then(saved).catch((e: Error) => setError(e.message))} /> : tab === "statistics" ? <Suspense fallback={<p className="loading">{t("Loading…")}</p>}><Statistics entries={ledger.entries} preferences={p} /></Suspense> : tab !== "settings" ? <>
        {tab === "expenses" ? <>
          <header className="page-heading">
            <h1>{t("Expenses")}<span className="entry-count">{number(active.length)}</span></h1>
            <p className="household-members">{p.nameA} & {p.nameB}</p>
          </header>
          <section className={`balance-card ${balance === 0 ? "is-settled" : ""}`} aria-label={t("Household balance")}>
            <div className="balance-summary">
              {balance === 0 ? <div className="settled-heading">
                <span className={`settled-mark ${saveFeedback?.settled ? "celebrate" : ""}`} aria-hidden="true">
                  <img src="/icon.svg" width="28" height="28" alt="" />
                  {saveFeedback?.settled && <Sparkles className="settled-sparkles" size={18} />}
                </span>
                <p>{t("You are all settled up")}</p>
              </div> : <p>{balance < 0 && other === t("Your spouse") ? t("You owe your spouse") : t(balance > 0 ? "{name} owes you" : "You owe {name}", { name: other })}</p>}
              <div className={`balance-amount ${balance < 0 ? "owed" : balance === 0 ? "settled" : ""}`}>{money(Math.abs(balance))}</div>
              {balance === 0 && <small className="settled-note">{t("All square. Nicely done.")}</small>}
            </div>
            <button className="settle-button" onClick={() => setForm("settlement")}>{t("Settle up")}</button>
          </section>
        </> : <>
          <header className="page-heading search-heading"><h1>{t("Search")}</h1><button className="text-button" onClick={() => setImporting(true)}><Upload size={18} />{t("Import")}</button></header>
          <label className="search"><Search size={19} /><input aria-label={t("Search expenses")} type="search" placeholder={t("Search expenses")} value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} />{search && <button type="button" className="icon-button" aria-label={t("Clear search")} onClick={(event) => {
            setSearch(""); setLimit(100); event.currentTarget.parentElement?.querySelector("input")?.focus();
          }}><X size={18} /></button>}</label>
          <p className="search-hint">{t("Description, category or date")}</p>
        </>}
        <section className="ledger-section" aria-label={t(tab === "search" ? "Search results" : "Expenses")}>
          {tab === "search" && <div className="section-title"><h2>{t("Search results")}<span>{number(shown.length)}</span></h2></div>}
          {!shown.length ? tab === "expenses" ? <div className="empty-state expense-welcome">
            <span className="expense-welcome-icon" aria-hidden="true"><Receipt size={30} /></span>
            <h2>{t("Together, fairly split")}</h2>
            <p>{t("Track shared expenses, split them your way and see who owes whom. Add your first expense to get started.")}</p>
            <p className="expense-welcome-hint">{t("Saved on this device, even offline. Sign in via Sync to share across devices.")}</p>
          </div> : <div className="empty-state"><h2>{t(query ? "No matching expenses" : "No expenses yet")}</h2>{query && <p>{t("Try a different description, category or date.")}</p>}</div> :
            <div className="expense-list">{shown.slice(0, limit).map((entry, index) => {
              const month = new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { month: "long", year: "numeric" });
              const heading = index === 0 || entry.date.slice(0, 7) !== shown[index - 1].date.slice(0, 7);
              const contribution = p.member === "a" ? entry.balanceA : -entry.balanceA;
              const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
              const payment = category === "payment";
              return <div key={entry.id}>{heading && <h3 className="month-heading">{month}</h3>}<SwipeableRow
                description={entry.description} disabled={conflictIds.has(entry.id)} open={swipedEntry === entry.id}
                setOpen={(open) => setSwipedEntry(open ? entry.id : null)} edit={() => setForm(entry)}
                actionsLabel={t("Entry actions")} editLabel={t("Edit entry")} deleteLabel={t("Delete entry")}
                deleteConfirmation={t("Delete this entry for both of you? This will sync when you are online.")}
                onError={(e) => setError(e instanceof Error ? e.message : "Could not delete this entry.")}
                remove={async () => {
                  await queueEntries([{ ...entry, deleted: true }]); saved();
                }}>
                <button className="expense-row" disabled={conflictIds.has(entry.id)} onClick={() => setForm(entry)}>
                {saveFeedback?.entry.id === entry.id && <span key={saveFeedback.entry.updatedAt} className="saved-row-glow" aria-hidden="true" />}
                <span className="date-block"><small>{new Date(`${entry.date}T12:00:00`).toLocaleDateString(locale, { month: "short" })}</small>{Number(entry.date.slice(8))}</span>
                <span className={`entry-icon ${payment ? "payment" : ""}`} data-category={category}><ExpenseIcon category={category} /></span>
                <span className="entry-description"><strong>{entry.description}</strong><small>{entry.kind === "imported" ? t("{category} · imported", { category: t(categoryLabels[category]) }) : t("{name} paid {amount}", { name: payer(p, entry.paidBy!), amount: money(entry.amountCents) })}</small></span>
                <span className={`entry-balance ${contribution < 0 ? "owed" : contribution > 0 ? "lent" : ""}`}><small>{t(contribution === 0 ? "no balance change" : payment ? "balance change" : contribution > 0 ? "you lent" : "you borrowed")}</small><strong>{money(Math.abs(contribution))}</strong></span>
                </button>
              </SwipeableRow></div>;
            })}{shown.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 100)}>{t("Show more ({count})", { count: number(shown.length - limit) })}</button>}</div>}
        </section>
      </> : <section className="settings-page"><header className="page-heading"><h1>{t("Settings")}</h1></header>
        <section className="settings-card"><h2><Languages size={20} />{t("Language")}</h2>
          <label>{t("App language")}<Select label={t("App language")} value={language} onChange={(value) => void updatePreferences({ language: value }).catch((e: Error) => setError(e.message))}
            options={[{ value: "de", label: "Deutsch", lang: "de" }, { value: "en", label: "English", lang: "en" }]} /></label>
        </section>
        <section className="settings-card"><h2><Users size={20} />{t("Household")}</h2><label>{t("First person")}<input defaultValue={p.nameA} key={`a-${p.nameA}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== p.nameA) void updatePreferences({ nameA: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label><label>{t("Second person")}<input defaultValue={p.nameB} key={`b-${p.nameB}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== p.nameB) void updatePreferences({ nameB: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label>
          {!identity && <label>{t("This device belongs to")}<Select<Member> label={t("This device belongs to")} value={p.member} onChange={(value) => void updatePreferences({ member: value }).catch((err: Error) => setError(err.message))} options={[{ value: "a", label: p.nameA }, { value: "b", label: p.nameB }]} /></label>}
          <p className="muted">{t("EUR and an equal split are always the default. Signed-in names come from your household configuration.")}</p>
        </section>
        <section className="settings-card"><h2><Download size={20} />{t("Backups")}</h2><button className="secondary" onClick={backup}><Download size={17} />{t("Download a backup")}</button><FilePicker label={t("Restore missing entries from a backup")} accept=".json,application/json" choose={(file) => void restore(file)} /><p className="muted">{t("Backups include expenses and manual to-dos. Offline data lives in this browser; sync or back up before clearing site data or changing devices.")}</p></section>
      </section>}
    </main>
    {(tab === "expenses" || tab === "todos") && <div className="expense-action">
      <button className="add-button" aria-label={t(tab === "todos" ? "Add to-do" : "Add expense")}
        onClick={() => { if (tab === "todos") setTodoForm("new"); else setForm("expense"); }}>
        <Plus size={23} /><span>{t(tab === "todos" ? "Add to-do" : "Add expense")}</span>
      </button>
    </div>}
    <nav className="bottom-nav" aria-label={t("Main navigation")}>
      <button className={tab === "expenses" ? "active" : ""} aria-current={tab === "expenses" ? "page" : undefined} onClick={() => navigate("expenses")}><Receipt size={22} /><span>{t("Expenses")}</span></button>
      <button className={tab === "todos" ? "active" : ""} aria-current={tab === "todos" ? "page" : undefined} onClick={() => navigate("todos")}><ClipboardCheck size={22} /><span>{t("To-dos")}{!!openTodos && <span className="nav-badge" aria-hidden="true">{number(openTodos)}</span>}</span></button>
      <button className={tab === "search" ? "active" : ""} aria-current={tab === "search" ? "page" : undefined} onClick={() => navigate("search")}><Search size={22} /><span>{t("Search")}</span></button>
      <button className={tab === "statistics" ? "active" : ""} aria-current={tab === "statistics" ? "page" : undefined} onClick={() => navigate("statistics")}><BarChart3 size={22} /><span>{t("Statistics")}</span></button>
      <button className={tab === "settings" ? "active" : ""} aria-current={tab === "settings" ? "page" : undefined} onClick={() => navigate("settings")}><Settings size={22} /><span>{t("Settings")}</span></button>
    </nav>
    <div aria-live="polite" aria-atomic="true">
      {saveFeedback && <div className="save-feedback" key={saveFeedback.entry.updatedAt}><Check size={18} aria-hidden="true" /><span>{t(saveFeedback.entry.kind === "settlement" ? "Payment saved on this device" : "Expense saved on this device")}</span></div>}
    </div>
    {form && <ExpenseForm entry={typeof form === "object" ? form : undefined} settlement={form === "settlement" || (typeof form === "object" && form.kind === "settlement")} preferences={p} close={() => setForm(null)} saved={expenseSaved} />}
    {todoForm && <TodoForm todo={todoForm === "new" ? undefined : todoForm} close={() => setTodoForm(null)} saved={() => {
      if (todoForm === "new") pulseLogo();
      saved();
    }} />}
    {importing && <ImportForm preferences={p} close={() => setImporting(false)} saved={saved} />}
  </div>;
}
