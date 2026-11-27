import { useEffect, useState } from "react";
import { ChevronRight, ClipboardCheck, Download, House, Languages, Lock, Pencil, RotateCcw, Smartphone, UserRound } from "lucide-react";
import type { Member } from "../shared/model";
import { profilePictureUrl } from "../shared/profile";
import { automaticInsuranceTodos, queueInsuranceTodoSetting, updatePreferences, type Preferences } from "./db";
import HouseholdInvitation from "./HouseholdInvitation";
import { LocalRecordsNotice } from "./Onboarding";
import SignInOptions from "./SignInOptions";
import type { SyncController } from "./useSync";
import { useLocale } from "./i18n";
import { Select } from "./Controls";
import type { AccountController } from "./useAccount";
import type { LocalRecords } from "./useLocalRecords";

type AccountSyncState = Pick<SyncController, "identity" | "online" | "busy">;
export type SettingsSection = "account" | "household" | "invite" | "device";

function AccountDetails({ sync: { identity, online, busy }, account }: { sync: AccountSyncState; account: AccountController }) {
  const { t, message } = useLocale();
  const [failedPicture, setFailedPicture] = useState<string>();
  const picture = profilePictureUrl(identity?.pictureUrl);
  const provider = identity?.signInProvider;
  const error = account.errorFor("account");
  const signInMethod = !identity ? t("Not signed in") : provider === "local" ? t("Signed in for local development")
    : provider === "google" ? t("Signed in with Google")
    : provider === "microsoft" ? t("Signed in with Microsoft")
    : provider === "email" ? t("Signed in with email") : t("Sign-in provider unavailable");
  return <section id="settings-account" className="settings-card" tabIndex={-1} aria-label={t("Account")}>
    <h2 className="section-label">{t("Account")}</h2>
    <div className="settings-row account-details">
      <span className="avatar" aria-hidden="true">
        {picture && picture !== failedPicture
          ? <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setFailedPicture(picture)} />
          : identity?.displayName?.trim().charAt(0).toUpperCase() || <UserRound size={20} />}
      </span>
      <span className="entry-description">
        <strong>{identity?.displayName || signInMethod}</strong>
        {identity?.displayName && <small>{signInMethod}</small>}
        {identity?.email && <small>{identity.email}</small>}
      </span>
    </div>
    {identity && !provider &&
      <p className="settings-note">{t("Sign in again to refresh your provider and profile details. Some providers do not share all details.")}</p>}
    {provider === "unknown" &&
      <p className="settings-note">{t("Entra did not identify a single sign-in method for this session.")}</p>}
    {identity ? <>
      <div className="button-row">
        <button className="secondary" disabled={!online || busy || account.signOutBusy} aria-busy={busy || account.signOutBusy} onClick={() => void account.signOut()}>{t("Sign out")}</button>
      </div>
      <p className="settings-note">{t("Signing out does not erase this device's offline history. Use a trusted device.")}</p>
      {account.providerAccount && <div className="button-row">
        <button className="secondary danger-button" disabled={!online || account.signOutBusy} onClick={() => void account.runHouseholdAction(
          "account/delete", "Delete your account", "Delete your account? Your sessions will be revoked immediately and deletion will be scheduled."
        )}>{t("Delete your account")}</button>
      </div>}
    </> : <>
      <p className="settings-note">{t("Without an account, entries stay on this device. Sign in to share expenses and to-dos with the other person and to sync your devices.")}</p>
      <SignInOptions account={account} online={online} busy={busy} />
    </>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </section>;
}

export default function SettingsPage({
  preferences: p, sync, account, localRecords, focus, onFocused, saved, backup, restore, addLocalRecords, downloadLocalRecords, onError
}: {
  preferences: Preferences; sync: AccountSyncState; account: AccountController; localRecords: LocalRecords | null;
  focus: SettingsSection | null; onFocused: () => void;
  saved: () => void; backup: () => void; restore: (file?: File) => void | Promise<void>;
  addLocalRecords: () => void; downloadLocalRecords: () => void; onError: (message: string) => void;
}) {
  const { t, language, message } = useLocale();
  const { identity, online, busy } = sync;
  const { providerAccount, signOutBusy, saveHouseholdName, runHouseholdAction, households, canCreateHousehold, householdsBusy } = account;
  const householdError = account.errorFor("household"), deviceError = account.errorFor("device");
  const householdLabel = (household: { nameA: string; nameB: string }) =>
    `${household.nameA.trim() || t("Unnamed")} & ${household.nameB.trim() || t("Unnamed")}`;
  const currentHousehold = households.find((household) => household.householdId === identity?.householdId);
  const otherJoined = identity?.otherMemberJoined;
  const memberStatus = (member: Member): { text: string; joined: boolean } | null => !providerAccount || !identity ? null
    : member === identity.member ? { text: t("You"), joined: true }
    : otherJoined === true ? { text: t("Joined"), joined: true }
    : otherJoined === false ? { text: t(account.invitations.length ? "Invitation pending" : "Not joined yet"), joined: false } : null;

  useEffect(() => {
    if (!focus) return;
    const target = document.getElementById(`settings-${focus}`) ?? document.getElementById("settings-household");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
    onFocused();
  }, [focus, onFocused]);

  return <section className="settings-page"><header className="page-heading"><div><h1>{t("Settings")}</h1><p>{p.nameA} & {p.nameB}</p></div></header>
    <AccountDetails sync={sync} account={account} />
    <section className="settings-card"><h2 className="section-label">{t("Language")}</h2>
      <label className="settings-row"><span className="settings-tile" aria-hidden="true"><Languages size={19} /></span><span className="entry-description"><strong>{t("App language")}</strong></span>
        <Select label={t("App language")} value={language} onChange={(value) => void updatePreferences({ language: value }).catch((e: Error) => onError(e.message))}
          options={[{ value: "de", label: "Deutsch", lang: "de" }, { value: "en", label: "English", lang: "en" }]} /></label>
    </section>
    <section id="settings-household" className="settings-card" tabIndex={-1} aria-labelledby="settings-household-title">
      <h2 id="settings-household-title" className="section-label">{t("Household")}</h2>
      {providerAccount && currentHousehold && households.length > 1 && <label className="settings-row">
        <span className="settings-tile" aria-hidden="true"><House size={19} /></span>
        <span className="entry-description"><strong>{t("Active household")}</strong></span>
        <Select label={t("Active household")} value={currentHousehold.householdId} disabled={!online || busy || householdsBusy || signOutBusy}
          onChange={(value) => void account.switchHousehold(value)}
          options={households.map((household) => ({ value: household.householdId, label: householdLabel(household) }))} /></label>}
      {(["a", "b"] as const).map((member) => {
        const name = member === "a" ? p.nameA : p.nameB, key = member === "a" ? "nameA" : "nameB";
        const status = memberStatus(member);
        return <div className="settings-row" key={member}><span className={`avatar payer-${member}`} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>
          <span className="entry-description settings-name-field"><span className="settings-name-input"><input id={`household-name-${member}`} className="settings-name" defaultValue={name} key={`${identity?.userId}:${identity?.householdId}:${member}-${name}`} maxLength={60} readOnly={!!identity && !providerAccount} aria-describedby={identity ? "household-names-note" : undefined}
            onBlur={(e) => { const value = e.target.value.trim(); if (value !== name) {
              if (providerAccount) void saveHouseholdName(member, value);
              else if (!identity && value) void updatePreferences({ [key]: value }).catch((err: Error) => onError(err.message));
            } }} />
            {identity && !providerAccount ? <Lock className="settings-name-lock" size={16} aria-hidden="true" /> : <Pencil className="settings-name-edit" size={16} aria-hidden="true" />}</span>
            <span className="settings-name-meta"><label htmlFor={`household-name-${member}`}>{t(member === "a" ? "First person" : "Second person")}</label>
              {status && <span className={`member-status${status.joined ? " is-member" : ""}`}> · {status.text}</span>}</span></span></div>;
      })}
      {!identity && <label className="settings-row"><span className="settings-tile" aria-hidden="true"><Smartphone size={19} /></span><span className="entry-description"><strong>{t("This device belongs to")}</strong></span>
        <Select<Member> label={t("This device belongs to")} value={p.member} onChange={(value) => void updatePreferences({ member: value }).catch((err: Error) => onError(err.message))} options={[{ value: "a", label: p.nameA }, { value: "b", label: p.nameB }]} /></label>}
      <p id="household-names-note" className="settings-note">{t(providerAccount
        ? "EUR and an equal split are always the default. Signed-in names are shared with your household."
        : "EUR and an equal split are always the default. Signed-in names come from your household configuration.")}</p>
      {providerAccount && otherJoined === false && account.authOptions.entraEnabled
        && <HouseholdInvitation preferences={p} online={online} account={account} />}
      {providerAccount && canCreateHousehold && <div className="button-row">
        <button className="secondary" disabled={!online || busy || householdsBusy || signOutBusy} aria-busy={householdsBusy}
          onClick={() => void account.createHousehold()}>{t("Create another household")}</button>
      </div>}
      {providerAccount && <div className="household-access">
        <h3>{t("Leave or remove")}</h3>
        <div className="button-row">
          {otherJoined && <button className="secondary danger-button" disabled={!online || signOutBusy} onClick={() => void runHouseholdAction(
            "household/remove-member", "Remove the other member", "Remove the other member? They will lose server access, but data already on their devices will remain."
          )}>{t("Remove the other member")}</button>}
          <button className="secondary danger-button" disabled={!online || signOutBusy} onClick={() => void runHouseholdAction(
            "household/leave", "Leave this household", "Leave this household? Its ledger will remain available to the other member."
          )}>{t("Leave this household")}</button>
          <button className="secondary danger-button" disabled={!online || signOutBusy} onClick={() => void runHouseholdAction(
            "household/delete", "Delete this household", "Delete this household? It will be inaccessible and recoverable for 30 days."
          )}>{t("Delete this household")}</button>
        </div>
      </div>}
      {householdError && <p className="error" role="alert">{message(householdError)}</p>}
    </section>
    <section className="settings-card"><h2 className="section-label">{t("To-dos")}</h2>
      <label className="settings-row insurance-setting"><span className="settings-tile" aria-hidden="true"><ClipboardCheck size={19} /></span>
        <span className="entry-description"><strong>{t("Automatic insurance to-dos")}</strong></span>
        <span className="todo-check"><input type="checkbox" checked={automaticInsuranceTodos(p)} aria-describedby="insurance-todo-note"
          onChange={(event) => void queueInsuranceTodoSetting(event.target.checked).then(saved).catch((e: Error) => onError(e.message))} /></span></label>
      <p id="insurance-todo-note" className="settings-note">{t("Create a to-do for each new doctor or pharmacy receipt. This setting is shared with your household. Existing receipts and to-dos stay as they are.")}</p>
    </section>
    <section id="settings-device" className="settings-card" tabIndex={-1} aria-labelledby="settings-device-title">
      <h2 id="settings-device-title" className="section-label">{t("This device")}</h2>
      <button className="settings-row" onClick={backup} aria-label={t("Download a backup")} aria-describedby="backup-download-hint"><span className="settings-tile" aria-hidden="true"><Download size={19} /></span>
        <span className="entry-description"><strong>{t("Download a backup")}</strong><small id="backup-download-hint">{t("Expenses and your own to-dos")}</small></span><ChevronRight className="settings-chevron" size={18} aria-hidden="true" /></button>
      <label className="settings-row"><span className="settings-tile" aria-hidden="true"><RotateCcw size={19} /></span>
        <span className="entry-description"><strong>{t("Restore from backup")}</strong><small>{t("Only missing entries are added")}</small></span><ChevronRight className="settings-chevron" size={18} aria-hidden="true" />
        <input type="file" className="sr-only" aria-label={t("Restore missing entries from a backup")} accept=".json,application/json" onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; void restore(file);
        }} /></label>
      <p className="settings-note">{t("Backups include expenses and manual to-dos. Offline data lives in this browser; sync or back up before clearing site data or changing devices.")}</p>
      {localRecords && <LocalRecordsNotice entries={localRecords.entries.length} todos={localRecords.todos.length}
        matchesMember={localRecords.member === localRecords.householdMember} onAdd={addLocalRecords} onDownload={downloadLocalRecords} />}
      {account.canRemoveLocalData && <div className="button-row">
        <button className="secondary danger-button" disabled={!online || busy || signOutBusy} aria-busy={signOutBusy}
          onClick={() => void account.removeLocalAccountData()}>{t("Remove local data from this device")}</button>
      </div>}
      {deviceError && <p className="error" role="alert">{message(deviceError)}</p>}
    </section>
  </section>;
}
