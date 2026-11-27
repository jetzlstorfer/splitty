import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw, Settings, X } from "lucide-react";
import type { Todo } from "../shared/todo";
import { resolveConflict, resolveStoreConflict, todoStore, type Preferences } from "./db";
import { useLocale } from "./i18n";
import SignInOptions from "./SignInOptions";
import SyncIcon from "./SyncIcon";
import type { AccountController } from "./useAccount";
import type { Snapshot } from "./useLedger";
import type { SyncController } from "./useSync";

export function SyncPopover({ id, online, busy, pending, attention, upToDate, localOnly, status, children }: {
  id: string; online: boolean; busy: boolean; pending: number; attention: boolean; upToDate: boolean; localOnly: boolean;
  status: string; children: ReactNode;
}) {
  const { t, number } = useLocale();
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
      <SyncIcon state={!online ? "offline" : busy ? "syncing" : attention ? "attention" : localOnly ? "local" : upToDate ? "current" : "pending"} />
      <span className={online && !attention && !localOnly ? "sr-only" : undefined}>{!online ? t("Offline") : busy ? t("Syncing…")
        : localOnly && !attention ? t("Local only") : pending ? t("{count} pending", { count: number(pending) })
        : attention ? t("Needs attention") : upToDate ? t("Up-to-date") : t("Saved on this device")}</span>
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

/** Contents of the sync popover: connection details, sign-in, and conflict resolution. Household management lives in Settings. */
export function SyncPanel({ id, ledger, preferences: p, conflictCount, localOnly, sync, account, conflictResolved, openSettings }: {
  id: string; ledger: Snapshot; preferences: Preferences; conflictCount: number; localOnly: boolean;
  sync: Pick<SyncController, "online" | "identity" | "busy" | "lastSynced" | "actionError" | "setActionError" | "sync">;
  account: AccountController; conflictResolved: () => void;
  openSettings: (section: "account" | "household") => void;
}) {
  const { t, locale, number, money, message, person } = useLocale();
  const { online, identity, busy, lastSynced, actionError, setActionError, sync: syncNow } = sync;
  const { signInBusy, signOutBusy } = account;
  const todoVersion = (todo: Todo | null | undefined) => !todo ? t("Not present") : todo.deleted ? t("Deleted")
    : `${todo.title}${todo.description ? `\n${todo.description}` : ""}\n${t(todo.done ? "Done" : "Open to-dos")}`;
  const goToSettings = (section: "account" | "household") => {
    document.getElementById(id)?.hidePopover();
    openSettings(section);
  };
  return <>
    <dl className="sync-details">
      <div><dt>{t("Connection")}</dt><dd>{t(online ? "Online" : "Offline")}</dd></div>
      <div><dt>{t(localOnly ? "Saved only on this device" : "Changes waiting to sync")}</dt><dd>{number(ledger.pending)}</dd></div>
      {!!conflictCount && <div><dt>{t("Edits needing attention")}</dt><dd>{number(conflictCount)}</dd></div>}
      <div><dt>{t("Last sync this session")}</dt><dd>{lastSynced ? <time dateTime={lastSynced.toISOString()}>{lastSynced.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</time> : t("Not yet synced")}</dd></div>
    </dl>
    {actionError && <p className="error" role="alert">{message(actionError)}</p>}
    {identity && <p>{t("Signed in as {name}.", { name: person(p, identity.member) })}</p>}
    <div className="button-row"><button className="secondary" disabled={!online || busy || signInBusy || signOutBusy} onClick={() => void syncNow()}><RefreshCw size={16} />{t("Sync now")}</button></div>
    {identity ? <button className="text-button sync-settings-link" onClick={() => goToSettings("household")}>
      <Settings size={16} aria-hidden="true" />{t("Household and invitations in Settings")}
    </button> : <>
      <p className="muted">{t("Sign in to share expenses and to-dos with the other person and to sync your devices.")}</p>
      <SignInOptions account={account} online={online} busy={busy} />
    </>}
    {!!ledger.conflicts.length && <section className="conflict-panel" aria-label={t("Conflicting edits")}><h3>{t("Conflicting edits")}</h3><p>{t("These entries changed on another device. Choose which version to keep.")}</p>{ledger.conflicts.map((conflict) => {
      const local = ledger.entries.find((entry) => entry.id === conflict.entryId);
      return <div key={conflict.entryId}><strong>{local?.description}</strong><p>{t("This device: {local} · Other device: {remote} ({name}'s balance)", { local: local?.deleted ? t("Deleted") : money(local?.balanceA ?? 0), remote: conflict.remote?.deleted ? t("Deleted") : conflict.remote ? money(conflict.remote.balanceA) : t("Not present"), name: p.nameA })}</p><div className="button-row">
        <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, false).then(conflictResolved).catch((e: Error) => setActionError(e.message))}>{t("Keep other device")}</button>
        <button className="secondary" onClick={() => void resolveConflict(conflict.entryId, true).then(conflictResolved).catch((e: Error) => setActionError(e.message))}>{t("Keep this device")}</button>
      </div></div>;
    })}</section>}
    {!!ledger.todoConflicts.length && <section className="conflict-panel" aria-label={t("Conflicting to-do edits")}><h3>{t("Conflicting to-do edits")}</h3>
      <p>{t("These to-dos changed on another device. Choose which version to keep.")}</p>
      {ledger.todoConflicts.map((conflict) => <div key={conflict.entryId}>
        <p className="todo-version"><strong>{t("This device")}</strong>{"\n"}{todoVersion(ledger.todos.find((todo) => todo.id === conflict.entryId))}</p>
        <p className="todo-version"><strong>{t("Other device")}</strong>{"\n"}{todoVersion(conflict.remote)}</p>
        <div className="button-row"><button className="secondary" onClick={() => void resolveStoreConflict(conflict.entryId, false, todoStore()).then(conflictResolved).catch((e: Error) => setActionError(e.message))}>{t("Keep other device")}</button>
          <button className="secondary" onClick={() => void resolveStoreConflict(conflict.entryId, true, todoStore()).then(conflictResolved).catch((e: Error) => setActionError(e.message))}>{t("Keep this device")}</button></div>
      </div>)}
    </section>}
  </>;
}
