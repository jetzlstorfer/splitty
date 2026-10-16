import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { liveQuery } from "dexie";
import {
  ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronDown, Cloud, CloudOff,
  Download, Heart, History, Plus, Receipt, RefreshCw, Settings, Trash2, Upload, Wallet, X
} from "lucide-react";
import { calculateShareA, expenseBalance, parseMoney, validateEntry, type Entry, type Member, type SplitType } from "../shared/model";
import { db, getPreferences, queueEntries, resolveConflict, type Conflict, type Preferences } from "./db";
import { previewImport, readCsv, type ImportPreview } from "./importer";
import { api, ApiError, synchronize, type Identity } from "./sync";

const money = (cents: number) => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(cents / 100);
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const names = (p: Preferences, member: Member) => member === p.member ? "You" : member === "a" ? p.nameA : p.nameB;

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
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return <dialog ref={dialog} onCancel={close} className="sheet" aria-labelledby={heading}>
    <div className="sheet-head"><button className="icon-button" onClick={close} aria-label="Close"><X size={22} /></button><h2 id={heading}>{title}</h2><span /></div>
    {children}
  </dialog>;
}

function ExpenseForm({ entry, settlement, preferences: p, close, saved }: {
  entry?: Entry; settlement: boolean; preferences: Preferences; close: () => void; saved: () => void;
}) {
  const imported = entry?.kind === "imported";
  const [description, setDescription] = useState(entry?.description ?? (settlement ? "Payment" : ""));
  const [amount, setAmount] = useState(entry ? (entry.amountCents / 100).toFixed(2) : "");
  const [date, setDate] = useState(entry?.date ?? today());
  const [paidBy, setPaidBy] = useState<Member>(entry?.paidBy ?? p.member);
  const [split, setSplit] = useState(() => {
    if (!entry || entry.kind !== "expense") return "equal";
    if (entry.splitType === "all-a") return p.member === "a" ? "self" : "other";
    if (entry.splitType === "all-b") return p.member === "b" ? "self" : "other";
    return entry.splitType ?? "exact";
  });
  const [share, setShare] = useState(entry?.splitType === "percent" ? String(entry.percentageA) : entry?.shareA !== null && entry?.shareA !== undefined ? (entry.shareA / 100).toFixed(2) : "");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        if (split === "exact") shareA = parseMoney(share);
        value = {
          id: entry?.id ?? crypto.randomUUID(), kind: settlement ? "settlement" : "expense",
          description: description.trim(), date, category: entry?.category ?? (settlement ? "Payment" : "General"),
          currency: "EUR", amountCents, paidBy, shareA: settlement ? null : shareA,
          balanceA: settlement ? (paidBy === "a" ? amountCents : -amountCents) : expenseBalance(amountCents, paidBy, shareA),
          revision: entry?.revision ?? 0, updatedAt: new Date().toISOString(), deleted: false,
          ...(!settlement ? { splitType, ...(split === "percent" ? { percentageA: Number(share.replace(",", ".")) } : {}) } : {})
        };
      }
      await queueEntries([value]);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this expense."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!entry || !window.confirm("Delete this entry for both of you? This will sync when you are online.")) return;
    setBusy(true);
    try { await queueEntries([{ ...entry, deleted: true }]); saved(); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this entry."); }
    finally { setBusy(false); }
  }

  const other = p.member === "a" ? p.nameB : p.nameA;
  return <Sheet title={entry ? "Edit entry" : settlement ? "Settle up" : "Add an expense"} close={close}>
    <form onSubmit={submit} className="expense-form">
      <div className="form-symbol"><Receipt size={28} /></div>
      <label>Description<input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder={settlement ? "Payment" : "What's it for?"} required maxLength={500} /></label>
      <label>Amount in EUR<div className="amount-input"><span>€</span><input aria-label="Amount in EUR" inputMode="decimal" value={amount} readOnly={imported} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required /></div></label>
      {imported ? <p className="notice">Imported balance: {money(entry.balanceA)} for {p.nameA}. The CSV does not reliably identify the original payer or split, so those amounts are preserved. Description and date can be edited.</p> : <>
        <div className="split-summary">
          <span>{settlement ? "Payment from" : "Paid by"}</span>
          <select aria-label="Paid by" value={paidBy} onChange={(e) => setPaidBy(e.target.value as Member)}>
            <option value="a">{names(p, "a")}</option><option value="b">{names(p, "b")}</option>
          </select>
          {settlement && <span>to {names(p, paidBy === "a" ? "b" : "a")}</span>}
        </div>
        {!settlement && <>
          <button type="button" className="split-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <span>{split === "equal" ? "Split equally" : split === "other" ? `All for ${other}` : split === "self" ? "All for you" : "Custom split"}<small>{money(shareA)} · {p.nameA} &nbsp;/&nbsp; {money(cents - shareA)} · {p.nameB}</small></span><ChevronDown size={20} />
          </button>
          {expanded && <fieldset className="split-options"><legend>How should we split it?</legend>
            {[
              ["equal", "Equally · 50/50"], ["other", `${other} owes the full amount`],
              ["self", "I owe the full amount"], ["percent", "By percentage"], ["exact", "By exact amount"]
            ].map(([value, label]) => <label key={value} className="radio"><input type="radio" name="split" value={value} checked={split === value} onChange={() => { setSplit(value); setShare(value === "percent" ? "50" : ""); }} />{label}</label>)}
            {(split === "percent" || split === "exact") && <label>{p.nameA === "You" ? "Your" : `${p.nameA}'s`} share {split === "percent" ? "(%)" : "(EUR)"}<input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} required /></label>}
          </fieldset>}
        </>}
      </>}
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy} type="submit"><Check size={19} />{busy ? "Saving…" : "Save"}</button>
      {entry && <button className="danger-link" type="button" disabled={busy} onClick={remove}><Trash2 size={16} />Delete entry</button>}
    </form>
  </Sheet>;
}

function ImportForm({ preferences: p, close, saved }: { preferences: Preferences; close: () => void; saved: () => void }) {
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
  return <Sheet title="Bring your history" close={close}><div className="panel-content">
    <div className="form-symbol"><Upload size={28} /></div>
    <p>Your Splitwise history belongs here, too. Choose a two-person EUR group export. The file stays on this device until you confirm; imported entries then sync with your household.</p>
    <label className="file-label">Splitwise CSV<input type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} disabled={busy} /></label>
    {!!members.length && <>
      <label>Export column for {p.nameA}<select value={memberA} disabled={busy} onChange={(e) => { setMemberA(e.target.value); setPreview(null); }}>{members.map((member) => <option key={member}>{member}</option>)}</select></label>
      <p className="muted">{members.find((member) => member !== memberA)} maps to {p.nameB}. Use the same mapping on every device.</p>
      <button className="secondary" disabled={busy} onClick={inspect}>{busy ? "Reading history…" : "Preview import"}</button>
    </>}
    {preview && <div className="import-preview">
      <h3>{preview.entries.length.toLocaleString()} new entries</h3><p>{preview.duplicates} already imported · skipped</p>
      <p>File balance for {p.nameA}: <strong>{money(preview.balanceA)}</strong></p>
      {preview.expectedBalanceA !== null ? <p className={preview.errors.length ? "muted" : "success"}>{preview.errors.length ? "Reconciliation needs attention." : "Matches the final balance in your export."}</p> : <p className="notice">No final balance row found. Check this total against Splitwise before confirming.</p>}
      {preview.errors.length > 0 && <div className="error" role="alert"><strong>Nothing will be imported.</strong><ul>{preview.errors.slice(0, 8).map((message, i) => <li key={i}>{message}</li>)}</ul>{preview.errors.length > 8 && <p>And {preview.errors.length - 8} more errors.</p>}</div>}
      <p className="muted">Original balance contributions are preserved, including payments and rounding. Payer and share details are not guessed. Identical rows within the export remain separate expenses.</p>
      <button className="primary" disabled={busy || !!preview.errors.length || !preview.entries.length} onClick={confirm}>{busy ? "Saving history…" : "Confirm import"}</button>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </div></Sheet>;
}

export default function App() {
  const ledger = useLedger();
  const [tab, setTab] = useState<"expenses" | "settings">("expenses");
  const [form, setForm] = useState<"expense" | "settlement" | Entry | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [online, setOnline] = useState(navigator.onLine);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [syncStatus, setSyncStatus] = useState("Saved on this device");
  const [syncBusy, setSyncBusy] = useState(false);
  const syncLock = useRef(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");
  const [devLink, setDevLink] = useState("");
  const [signInToken, setSignInToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("signin") ?? "");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);

  const sync = useCallback(async () => {
    if (syncLock.current || !navigator.onLine) return;
    syncLock.current = true; setSyncBusy(true);
    try {
      const me = await api<Identity>("me");
      if ((me.member !== "a" && me.member !== "b") || !me.nameA || !me.nameB) throw new Error("Invalid sign-in response.");
      setIdentity(me);
      const preferences = await getPreferences();
      await db.preferences.put({ ...preferences, member: me.member, nameA: me.nameA, nameB: me.nameB });
      setSyncStatus("Syncing…");
      await synchronize();
      setSyncStatus(await db.conflicts.count() ? "Some edits need your attention" : await db.outbox.count() ? "Saved locally · changes waiting to sync" : "Up to date");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setIdentity(null); setSyncStatus("Sign in to sync"); }
      else setSyncStatus(e instanceof Error ? e.message : "Sync failed; your changes remain on this device.");
    } finally { syncLock.current = false; setSyncBusy(false); }
  }, []);

  useEffect(() => {
    const signInHash = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("signin");
      if (token) {
        setSignInToken(token);
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    signInHash();
    const connected = () => { setOnline(true); void sync(); };
    const disconnected = () => { setOnline(false); setSyncStatus("Offline · changes stay on this device"); };
    const focus = () => { if (document.visibilityState === "visible") void sync(); };
    const failure = (event: Event) => setError(String((event as CustomEvent).detail));
    const available = (event: Event) => setUpdate(() => (event as CustomEvent<() => Promise<void>>).detail);
    window.addEventListener("online", connected); window.addEventListener("offline", disconnected);
    window.addEventListener("hashchange", signInHash);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("splitty-error", failure); window.addEventListener("splitty-update", available);
    void sync();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void sync(); }, 60_000);
    return () => {
      window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected);
      window.removeEventListener("hashchange", signInHash);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("splitty-error", failure); window.removeEventListener("splitty-update", available);
      window.clearInterval(interval);
    };
  }, [sync]);

  useEffect(() => {
    if (!ledger?.pending) return;
    const timeout = window.setTimeout(() => void sync(), 400);
    return () => window.clearTimeout(timeout);
  }, [ledger?.pending, sync]);

  const saved = () => { setSyncStatus("Saved on this device"); void sync(); };

  async function signIn(event: FormEvent) {
    event.preventDefault(); setEmailBusy(true); setEmailMessage(""); setError(""); setDevLink("");
    try {
      const result = await api<{ message: string; developmentLink?: string }>("auth/request", { email });
      setEmailMessage(result.message); setDevLink(result.developmentLink ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send a sign-in email."); }
    finally { setEmailBusy(false); }
  }

  async function signOut() {
    try {
      await api("auth/logout", {});
      setIdentity(null); setSyncStatus("Signed out · local history remains on this device");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not sign out."); }
  }

  async function confirmSignIn() {
    setConfirmBusy(true); setError("");
    try {
      await api("auth/consume", { token: signInToken });
      setSignInToken(""); setTab("settings"); await sync();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not use this sign-in link."); }
    finally { setConfirmBusy(false); }
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
      if (!window.confirm(`Restore ${fresh.length} missing entries? Existing entries will not be overwritten. Keep the same person A/B mapping as the original device.`)) return;
      await queueEntries(fresh);
      saved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not restore the backup."); }
  }

  if (!ledger) return <main className="loading"><Heart size={32} /><h1>Splitty</h1><p>Opening your shared ledger…</p>{error && <p className="error" role="alert">{error}</p>}</main>;

  const p = ledger.preferences, other = p.member === "a" ? p.nameB : p.nameA;
  const active = ledger.entries.filter((entry) => !entry.deleted);
  const balanceA = active.reduce((sum, entry) => sum + entry.balanceA, 0);
  const balance = p.member === "a" ? balanceA : -balanceA;
  const shown = active.filter((entry) => `${entry.description} ${entry.category} ${entry.date}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const conflictIds = new Set(ledger.conflicts.map((conflict) => conflict.entryId));
  let lastMonth = "";

  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="/" aria-label="Splitty home"><span className="brand-mark"><Heart size={19} /></span>splitty<span className="brand-dot">.</span></a>
      <button className={`sync-pill ${online ? "" : "offline"}`} onClick={() => void sync()} disabled={syncBusy} aria-label="Synchronize devices">{online ? <Cloud size={16} /> : <CloudOff size={16} />}<span>{syncBusy ? "Syncing" : ledger.pending ? `${ledger.pending} pending` : online ? "Sync" : "Offline"}</span></button>
    </header>
    <main>
      {error && <div className="banner error" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={18} /></button></div>}
      {update && <div className="banner">An app update is ready. Your saved entries will be kept.<button onClick={() => void update()} className="text-button">Update</button></div>}
      {tab === "expenses" ? <>
        <section className="household-heading"><div className="eyebrow">A LITTLE LESS COUNTING</div><h1>Just the two of us<span className="brand-dot">.</span></h1><p>Shared moments. Shared expenses.</p><div className="couple"><span>{(p.nameA[0] || "A").toUpperCase()}</span><span>{(p.nameB[0] || "B").toUpperCase()}</span><small>{p.nameA} & {p.nameB}</small></div></section>
        <section className="balance-card"><div className="balance-caption"><Wallet size={18} />OUR BALANCE<span>EUR</span></div>
          <p>{balance === 0 ? "All square. Nice and simple." : balance > 0 ? `${other} owes you` : `You owe ${other}`}</p>
          <div className={`balance-amount ${balance < 0 ? "owed" : ""}`}>{money(Math.abs(balance))}</div>
          <div className="balance-footer"><span><span className={`status-dot ${ledger.pending || !online ? "pending" : ""}`} />{ledger.pending ? "Saved locally · sync pending" : identity ? "Shared between you two" : "Local ledger · sign in to share"}</span><button className="settle-button" onClick={() => setForm("settlement")}>Settle up<ArrowUpRight size={16} /></button></div>
        </section>
        {!!ledger.conflicts.length && <section className="conflict-panel"><h3>Let's keep both edits safe</h3><p>These entries changed on another device. Choose which version to keep.</p>{ledger.conflicts.map((conflict) => {
          const local = ledger.entries.find((entry) => entry.id === conflict.entryId);
          return <div key={conflict.entryId}><strong>{local?.description}</strong><p>This device: {local?.deleted ? "Deleted" : money(local?.balanceA ?? 0)} · Other device: {conflict.remote?.deleted ? "Deleted" : conflict.remote ? money(conflict.remote.balanceA) : "Not present"} ({p.nameA}'s balance)</p><div className="button-row">
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, false).then(saved).catch((e: Error) => setError(e.message))}>Keep other device</button>
            <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, true).then(saved).catch((e: Error) => setError(e.message))}>Keep this device</button>
          </div></div>;
        })}</section>}
        <p className="sync-status" role="status">{syncStatus}</p>
        <section className="ledger-section"><div className="section-title"><h2>Our expenses<span>{active.length.toLocaleString()}</span></h2><button className="text-button" onClick={() => setImporting(true)}><Upload size={15} />Import</button></div>
          <label className="search"><History size={18} /><input aria-label="Search expenses" type="search" placeholder="Find an expense" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} /></label>
          {!shown.length ? <div className="empty-state"><span><Receipt size={30} /></span><h3>{search ? "No matches, just yet" : "Your next chapter starts here"}</h3><p>{search ? "Try a different description, category or date." : "Add your first shared expense, or bring all your memories over from Splitwise."}</p>{!search && <><button className="primary" onClick={() => setForm("expense")}><Plus size={18} />Add an expense</button><button className="text-button" onClick={() => setImporting(true)}>Import our Splitwise history<ArrowUpRight size={16} /></button></>}</div> :
            <div className="expense-list">{shown.slice(0, limit).map((entry) => {
              const month = new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
              const heading = month !== lastMonth; lastMonth = month;
              const contribution = p.member === "a" ? entry.balanceA : -entry.balanceA;
              const payment = entry.kind === "settlement" || entry.kind === "imported" && /^(zahlung|payment)$/i.test(entry.category);
              return <div key={entry.id}>{heading && <h3 className="month-heading">{month}</h3>}<button className="expense-row" onClick={() => setForm(entry)} disabled={conflictIds.has(entry.id)}>
                <span className="date-block"><small>{new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" })}</small>{Number(entry.date.slice(8))}</span>
                <span className={`entry-icon ${payment ? "payment" : ""}`}>{payment ? <ArrowDownLeft size={20} /> : <Receipt size={20} />}</span>
                <span className="entry-description"><strong>{entry.description}</strong><small>{entry.kind === "imported" ? `${entry.category} · imported` : entry.kind === "settlement" ? `${names(p, entry.paidBy!)} paid ${money(entry.amountCents)}` : `${names(p, entry.paidBy!)} paid ${money(entry.amountCents)}`}</small></span>
                <span className={`entry-balance ${contribution < 0 ? "owed" : contribution > 0 ? "lent" : ""}`}><small>{contribution === 0 ? "no balance change" : payment ? "balance change" : contribution > 0 ? "you lent" : "you borrowed"}</small><strong>{money(Math.abs(contribution))}</strong></span>
              </button></div>;
            })}{shown.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 100)}>Show more ({shown.length - limit})</button>}</div>}
        </section>
      </> : <section className="settings-page"><button className="text-button" onClick={() => setTab("expenses")}><ArrowLeft size={17} />Back to expenses</button><h1>Our little setup</h1><p className="muted">Two people. One shared ledger.</p>
        <section className="settings-card"><h2><Cloud size={20} />Keep us in sync</h2><p className="muted" role="status">{syncStatus}</p>
          {identity ? <><p>Signed in as {identity.member === "a" ? p.nameA : p.nameB}.</p><div className="button-row"><button className="secondary" disabled={syncBusy} onClick={() => void sync()}><RefreshCw size={16} />Sync now</button><button className="text-button" onClick={() => void signOut()}>Sign out</button></div><p className="muted">Signing out does not erase this device's offline history. Use a trusted device.</p></> :
            <form onSubmit={signIn}><p>Use your household email address. No passwords to remember.</p><label>Email address<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label><button className="primary" disabled={emailBusy || !online}>{emailBusy ? "Sending…" : "Email me a sign-in link"}</button>{emailMessage && <p role="status">{emailMessage}</p>}{devLink && <a className="development-link" href={devLink}>Local development sign-in link</a>}<p className="muted">Cross-device sync needs the configured backend. Until then, entries stay on this device.</p></form>}
        </section>
        <section className="settings-card"><h2><Heart size={20} />The two of us</h2><label>First person<input defaultValue={p.nameA} key={`a-${p.nameA}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim()) void db.preferences.put({ ...p, nameA: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label><label>Second person<input defaultValue={p.nameB} key={`b-${p.nameB}`} maxLength={60} readOnly={!!identity} onBlur={(e) => { if (e.target.value.trim()) void db.preferences.put({ ...p, nameB: e.target.value.trim() }).catch((err: Error) => setError(err.message)); }} /></label>
          {!identity && <label>This device belongs to<select value={p.member} onChange={(e) => void db.preferences.put({ ...p, member: e.target.value as Member }).catch((err: Error) => setError(err.message))}><option value="a">{p.nameA}</option><option value="b">{p.nameB}</option></select></label>}
          <p className="muted">EUR and an equal split are always the default. Signed-in names come from your household configuration.</p>
        </section>
        <section className="settings-card"><h2><Receipt size={20} />Your history, always yours</h2><button className="secondary" onClick={() => setImporting(true)}><Upload size={17} />Import from Splitwise</button><button className="secondary" onClick={backup}><Download size={17} />Download a backup</button><label>Restore missing entries from a backup<input type="file" accept=".json,application/json" onChange={(e) => void restore(e.target.files?.[0])} /></label><p className="muted">Offline data lives in this browser. Clearing site data removes unsynced entries. Keep backups, and sync before changing devices.</p></section>
        <div className="settings-footnote">Made for the everyday things we share.<br />Splitty · offline-first · just for two</div>
      </section>}
    </main>
    <nav className="bottom-nav" aria-label="Main navigation"><button className={tab === "expenses" ? "active" : ""} onClick={() => setTab("expenses")}><Receipt size={21} /><span>Expenses</span></button><button className="add-button" aria-label="Add expense" onClick={() => setForm("expense")}><Plus size={28} /></button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={21} /><span>Settings</span></button></nav>
    {form && <ExpenseForm entry={typeof form === "object" ? form : undefined} settlement={form === "settlement" || (typeof form === "object" && form.kind === "settlement")} preferences={p} close={() => setForm(null)} saved={saved} />}
    {importing && <ImportForm preferences={p} close={() => setImporting(false)} saved={saved} />}
    {!!signInToken && <Sheet title="Welcome back" close={() => setSignInToken("")}><div className="panel-content"><div className="form-symbol"><Heart size={28} /></div><p>Sign in on this device to share your ledger. Your offline entries will be kept and synchronized.</p><button className="primary" disabled={confirmBusy} onClick={() => void confirmSignIn()}>{confirmBusy ? "Signing in…" : "Sign in on this device"}</button>{error && <p role="alert" className="error">{error}</p>}</div></Sheet>}
  </div>;
}
