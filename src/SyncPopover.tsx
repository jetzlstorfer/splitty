import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { Todo } from "../shared/todo";
import { resolveConflict, resolveStoreConflict, todoStore, type Preferences } from "./db";
import { useLocale } from "./i18n";
import { Form } from "./Controls";
import SyncIcon from "./SyncIcon";
import type { AccountController } from "./useAccount";
import type { Snapshot } from "./useLedger";
import type { SyncController } from "./useSync";

export function SyncPopover({ online, busy, pending, attention, upToDate, status, children }: {
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
      <SyncIcon state={!online ? "offline" : busy ? "syncing" : attention ? "attention" : upToDate ? "current" : "pending"} />
      <span className={online && !attention ? "sr-only" : undefined}>{!online ? t("Offline") : busy ? t("Syncing…") : pending ? t("{count} pending", { count: number(pending) })
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

/** Contents of the sync popover: connection details, sign-in, invitations, and conflict resolution. */
export function SyncPanel({ ledger, preferences: p, conflictCount, sync, account, conflictResolved }: {
  ledger: Snapshot; preferences: Preferences; conflictCount: number;
  sync: Pick<SyncController, "online" | "identity" | "busy" | "lastSynced" | "actionError" | "setActionError" | "sync">;
  account: AccountController; conflictResolved: () => void;
}) {
  const { t, locale, number, money, message, person } = useLocale();
  const { online, identity, busy, lastSynced, actionError, setActionError, sync: syncNow } = sync;
  const {
    authOptions, memberToken, setMemberToken, legacyClaimToken, setLegacyClaimToken, signInBusy, signOutBusy,
    invitations, invitationLink, invitationBusy, invitationCopied, canRemoveLocalData,
    signIn, startProviderSignIn, createHouseholdInvitation, copyInvitationLink, revokeHouseholdInvitation,
    signOut, removeLocalAccountData
  } = account;
  const todoVersion = (todo: Todo | null | undefined) => !todo ? t("Not present") : todo.deleted ? t("Deleted")
    : `${todo.title}${todo.description ? `\n${todo.description}` : ""}\n${t(todo.done ? "Done" : "Open to-dos")}`;
  return <>
    <dl className="sync-details">
      <div><dt>{t("Connection")}</dt><dd>{t(online ? "Online" : "Offline")}</dd></div>
      <div><dt>{t("Changes waiting to sync")}</dt><dd>{number(ledger.pending)}</dd></div>
      {!!conflictCount && <div><dt>{t("Edits needing attention")}</dt><dd>{number(conflictCount)}</dd></div>}
      <div><dt>{t("Last sync this session")}</dt><dd>{lastSynced ? <time dateTime={lastSynced.toISOString()}>{lastSynced.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</time> : t("Not yet synced")}</dd></div>
    </dl>
    {actionError && <p className="error" role="alert">{message(actionError)}</p>}
    {identity && <p>{t("Signed in as {name}.", { name: person(p, identity.member) })}</p>}
    <div className="button-row"><button className="secondary" disabled={!online || busy || signInBusy || signOutBusy} onClick={() => void syncNow()}><RefreshCw size={16} />{t("Sync now")}</button>
      {identity && <button className="text-button" disabled={!online || busy || signOutBusy} aria-busy={signOutBusy} onClick={() => void signOut()}>{t("Sign out")}</button>}
      {canRemoveLocalData
        && <button className="text-button" disabled={!online || busy || signOutBusy} aria-busy={signOutBusy} onClick={() => void removeLocalAccountData()}>{t("Remove local data from this device")}</button>}</div>
    {identity && identity.householdId && authOptions.entraEnabled && <section className="invitation-panel" aria-label={t("Household invitations")}>
      <h3>{t("Invite your partner")}</h3>
      <p className="muted">{t("Invitation is valid for 7 days and takes over the invited member slot's existing balance.")}</p>
      <button className="secondary" disabled={!online || invitationBusy} onClick={() => void createHouseholdInvitation()}>
        {t(invitationBusy ? "Creating invitation…" : "Create invitation")}
      </button>
      {invitationLink && <div className="invitation-link">
        <label>{t("Invitation link")}<input aria-label={t("Invitation link")} readOnly value={invitationLink} onFocus={(event) => event.currentTarget.select()} /></label>
        <QRCodeSVG value={invitationLink} size={192} level="M" includeMargin role="img" aria-label={t("Invitation QR code")} />
        <button className="secondary" disabled={invitationBusy} onClick={() => void copyInvitationLink()}>{t("Copy invite link")}</button>
        {invitationCopied && <p role="status">{t("Invite was copied.")}</p>}
      </div>}
      {!!invitations.length && <ul>{invitations.map((invite) => <li key={invite.id}>
        <p>{t("Pending invitation to {name}, expires {date}.", {
          name: person(p, invite.slot),
          date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(invite.expiresAt))
        })}</p>
        <button className="text-button" disabled={!online || invitationBusy} onClick={() => void revokeHouseholdInvitation(invite)}>{t("Revoke invitation")}</button>
      </li>)}</ul>}
    </section>}
    {identity ? <p className="muted">{t("Signing out does not erase this device's offline history. Use a trusted device.")}</p> :
      <div className="sync-sign-in">
        {authOptions.entraEnabled && <>
          <button className="primary" disabled={busy || signInBusy || !online} onClick={() => void startProviderSignIn()}>{t("Continue with email, Google, or Microsoft")}</button>
          {authOptions.newHouseholdsEnabled === false && !new URLSearchParams(location.hash.slice(1)).has("invite")
            && <p className="muted">{t("New household registration is closed. Existing members can claim their household with a member token.")}</p>}
          {authOptions.legacyEnabled && <Form onSubmit={(event) => {
            event.preventDefault();
            if (!legacyClaimToken) return;
            void startProviderSignIn(legacyClaimToken);
          }}>
            <label>{t("Existing household member token")}<input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={43} value={legacyClaimToken} onChange={(event) => setLegacyClaimToken(event.target.value)} /></label>
            <button className="secondary" disabled={busy || signInBusy || !online}>{t(signInBusy ? "Signing in…" : "Continue and claim existing household")}</button>
            <p className="muted">{t("Your existing household history and this device's offline changes will be kept.")}</p>
          </Form>}
        </>}
        {authOptions.legacyEnabled && <Form onSubmit={(event) => void signIn(event)}><label>{t("Member token")}<input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={43} value={memberToken} onChange={(event) => setMemberToken(event.target.value)} /></label>
          <button className="primary" disabled={signInBusy || busy || !online}>{t(signInBusy ? "Signing in…" : "Sign in")}</button>
          <p className="muted">{t("This device stays signed in until you sign out or the member token is rotated.")}</p></Form>}
      </div>}
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
