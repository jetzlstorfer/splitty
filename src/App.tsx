import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import {
  BarChart3, Check, ClipboardCheck, Download, Plus, Receipt, RefreshCw, Search, Settings, Sparkles, Upload, UsersRound, X
} from "lucide-react";
import type { Entry } from "../shared/model";
import { translate } from "../shared/i18n";
import type { Todo } from "../shared/todo";
import { queueEntries, queueTodos } from "./db";
import { missingBackupRecords, readBackup, restoreBackup } from "./backup";
import { LanguageContext, useLocale } from "./i18n";
import { categoryLabels, expenseCategory, normalizeText } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import ExpenseForm from "./ExpenseForm";
import ImportForm from "./ImportForm";
import { LegalLinks } from "./LegalPage";
import SettingsPage from "./SettingsPage";
import SwipeableRow from "./SwipeableRow";
import { SyncPanel, SyncPopover } from "./SyncPopover";
import TodoForm from "./TodoForm";
import TodoList from "./TodoList";
import { householdTodos } from "./todos";
import { ConfirmationProvider, Sheet, dateValue as today, useConfirm } from "./Controls";
import { describeSyncStatus, deriveSyncStatus } from "./syncStatus";
import { useAccount } from "./useAccount";
import { useInstall } from "./useInstall";
import { useLedger, type Snapshot } from "./useLedger";
import { useSync } from "./useSync";

const loadStatistics = () => import("./StatisticsPage");
const Statistics = lazy(loadStatistics);

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
  const { t, language, locale, number, money, amount, message, person, payer } = useLocale();
  const confirm = useConfirm();
  const sync = useSync(ledger?.pending);
  const account = useAccount(sync);
  const syncPopoverId = useId();
  const [tab, setTab] = useState<"expenses" | "todos" | "search" | "statistics" | "settings">("expenses");
  const [form, setForm] = useState<"expense" | "settlement" | Entry | null>(null);
  const [todoForm, setTodoForm] = useState<"new" | Todo | null>(null);
  const [swipedEntry, setSwipedEntry] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [error, setError] = useState("");
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ entry: Entry; settled: boolean } | null>(null);
  const [logoPulse, setLogoPulse] = useState({ sequence: 0, active: false });
  const install = useInstall(setError);

  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => { root.dataset.inputMode = "pointer"; };
    const keyboard = () => { root.dataset.inputMode = "keyboard"; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete root.dataset.inputMode;
    };
  }, []);

  useEffect(() => {
    loadStatistics().catch(() => undefined);
  }, []);

  useEffect(() => {
    const failure = (event: Event) => setError(String((event as CustomEvent).detail));
    const available = (event: Event) => setUpdate(() => (event as CustomEvent<() => Promise<void>>).detail);
    window.addEventListener("splitty-error", failure); window.addEventListener("splitty-update", available);
    return () => {
      window.removeEventListener("splitty-error", failure); window.removeEventListener("splitty-update", available);
    };
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

  const saved = () => { setSaveFeedback(null); sync.markSaved(); };
  const conflictResolved = () => { sync.setActionError(""); saved(); };
  const pulseLogo = () => setLogoPulse((current) => ({ sequence: current.sequence + 1, active: true }));

  function navigate(next: typeof tab) {
    setSwipedEntry(null);
    setSaveFeedback(null);
    setTab(next);
    setLimit(100);
    window.scrollTo(0, 0);
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
  const status = deriveSyncStatus({
    online: sync.online, busy: sync.busy, pending: ledger.pending, conflictCount,
    actionError: sync.actionError, status: sync.status
  });
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
    <header className="topbar"><a className="wordmark" href="/" aria-label={t("Splitty home")}><img key={logoPulse.sequence} className={`brand-mark ${sync.busy ? "is-syncing" : logoPulse.active ? "is-saving" : ""}`} src="/icon.svg" width="36" height="36" alt="" />Splitty</a>
      <div className="topbar-actions">
      {install.canInstall && <button className="pill-button install-button" aria-label={t("Install")} onClick={() => void install.install()}><Download size={16} aria-hidden="true" /><span className="install-button-label">{t("Install")}</span></button>}
      <SyncPopover id={syncPopoverId} online={sync.online} busy={sync.busy} pending={ledger.pending} attention={status.needsAttention} upToDate={status.upToDate} status={describeSyncStatus(status.current, language)}>
        <SyncPanel ledger={ledger} preferences={p} conflictCount={conflictCount} sync={sync} account={account} conflictResolved={conflictResolved} />
      </SyncPopover>
      </div>
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
      {account.providerAccount && account.inviteCode && <section className="update-card accent-hero" aria-labelledby="join-household-title">
        <h2 id="join-household-title"><UsersRound size={24} aria-hidden="true" />{t("Household invitation")}</h2>
        <p>{t("Join the invited household with this account? Your current household stays available in Settings.")}</p>
        <div className="button-row">
          <button className="primary" disabled={!sync.online || account.householdsBusy} aria-busy={account.householdsBusy}
            onClick={() => void account.joinHousehold()}>{t("Join this household")}</button>
          <button className="secondary" disabled={account.householdsBusy} onClick={account.dismissInvite}>{t("Not now")}</button>
        </div>
      </section>}
      {tab === "todos" ? <TodoList todos={todos} openCount={openTodos} blocked={conflictIds} open={setForm}
        conflicts={ledger.todoConflicts}
        edit={setTodoForm}
        reorder={async (changes) => { await queueTodos(changes); saved(); }}
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
            <div><h1>{t("Expenses")}</h1><p className="household-members">{p.nameA} & {p.nameB}</p></div>
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
          <header className="page-heading">
            <div><h1>{t("Search")}</h1><p>{shown.length === 1 ? t("1 entry") : t("{count} entries", { count: number(shown.length) })}</p></div>
            <button className="pill-button" onClick={() => setImporting(true)}><Upload size={16} />{t("Import")}</button>
          </header>
          <label className="search"><Search size={19} /><input aria-label={t("Search expenses")} type="search" placeholder={t("Description, category or date")} value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} />{search && <button type="button" className="icon-button" aria-label={t("Clear search")} onClick={(event) => {
            setSearch(""); setLimit(100); event.currentTarget.parentElement?.querySelector("input")?.focus();
          }}><X size={18} /></button>}</label>
        </>}
        <section className="ledger-section" aria-label={t(tab === "search" ? "Search results" : "Expenses")}>
          {!shown.length ? tab === "expenses" ? <div className="empty-state expense-welcome">
            <span className="expense-welcome-icon" aria-hidden="true"><Receipt size={30} /></span>
            <h2>{t("Together, fairly split")}</h2>
            <p>{t("Track shared expenses, split them your way and see who owes whom. Add your first expense to get started.")}</p>
            <p className="expense-welcome-hint">{t("Saved on this device, even offline. Sign in via Sync to share across devices.")}</p>
          </div> : <div className="empty-state"><h2>{t(query ? "No matching expenses" : "No expenses yet")}</h2>{query && <p>{t("Try a different description, category or date.")}</p>}</div> :
            <div className="expense-list">{shown.slice(0, limit).map((entry, index) => {
              const day = new Date(`${entry.date}T12:00:00`);
              const month = day.toLocaleDateString(locale, { month: "long", ...(day.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
              const heading = index === 0 || entry.date.slice(0, 7) !== shown[index - 1].date.slice(0, 7);
              const contribution = p.member === "a" ? entry.balanceA : -entry.balanceA;
              const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
              const payment = category === "payment";
              const detail = entry.kind === "imported" ? t("{category} · imported", { category: t(categoryLabels[category]) })
                : entry.kind === "settlement" ? t("Payment from {name}", { name: payer(p, entry.paidBy!) })
                : t("{name} paid {amount}", { name: payer(p, entry.paidBy!), amount: money(entry.amountCents) });
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
                <span className={`entry-icon ${payment ? "payment" : ""}`} data-category={category}><ExpenseIcon category={category} /></span>
                <span className="entry-description"><strong>{entry.description}</strong><small>{day.toLocaleDateString(locale, { day: "numeric", month: "short" })} · {detail}</small></span>
                <span className={`entry-balance ${contribution < 0 ? "owed" : contribution > 0 ? "lent" : ""}`}>
                  <span className="sr-only">{t(contribution === 0 ? "no balance change" : payment ? "balance change" : contribution > 0 ? "you lent" : "you borrowed")}{contribution !== 0 && ` ${money(Math.abs(contribution))}`}</span>
                  <span aria-hidden="true">{contribution === 0 ? "–" : `${contribution > 0 ? "+" : "\u2212"}${amount(Math.abs(contribution))}`}</span>
                </span>
                </button>
              </SwipeableRow></div>;
            })}{shown.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 100)}>{t("Show more ({count})", { count: number(shown.length - limit) })}</button>}</div>}
        </section>
      </> : <SettingsPage preferences={p} sync={sync} account={account} syncPopoverId={syncPopoverId}
        saved={saved} backup={backup} restore={restore} onError={setError} />}
      <LegalLinks />
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
    {install.guideOpen && <Sheet title={t("Install Splitty")} close={install.closeGuide}>
      <div className="install-guide">
        <p>{t("Add Splitty to your Home Screen for quick access and offline use.")}</p>
        <ol>
          <li>{t("Tap the Share button in your browser.")}</li>
          <li>{t("Choose Add to Home Screen.")}</li>
          <li>{t("Tap Add to confirm.")}</li>
        </ol>
      </div>
    </Sheet>}
  </div>;
}
