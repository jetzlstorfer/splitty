import { useState } from "react";
import { Check, ChevronRight, Receipt, Smartphone, UsersRound, X } from "lucide-react";
import { useLocale } from "./i18n";
import type { AccountController } from "./useAccount";

/** Remembers on this device that a prompt was dismissed for one account database. */
export function useDismissal(kind: string, scope: string | undefined): [boolean, () => void] {
  const key = scope ? `splitty-${kind}-dismissed:${scope}` : "";
  const [dismissed, setDismissed] = useState<string[]>([]);
  let stored = false;
  try { stored = !!key && localStorage.getItem(key) === "1"; } catch { /* Treat unreadable storage as not dismissed. */ }
  const dismiss = () => {
    if (!key) return;
    try { localStorage.setItem(key, "1"); } catch { /* Still hide it for this session. */ }
    setDismissed((current) => [...current, key]);
  };
  return [!!key && (stored || dismissed.includes(key)), dismiss];
}

export type SharingAvailability = "available" | "closed" | "unavailable";

/** Localized "1 expense" / "3 to-dos" phrases for messages about local records. */
export function recordCounts({ t, number }: Pick<ReturnType<typeof useLocale>, "t" | "number">, entries: number, todos: number) {
  return {
    expenses: entries === 1 ? t("1 expense") : t("{count} expenses", { count: number(entries) }),
    todos: todos === 1 ? t("1 to-do") : t("{count} to-dos", { count: number(todos) })
  };
}

/** Empty-ledger introduction. Signed-out visitors learn that sharing is optional and how to start it. */
export function ExpenseWelcome({ signedIn, sharing, signInBusy, online, error, onShare }: {
  signedIn: boolean; sharing: SharingAvailability; signInBusy: boolean; online: boolean; error: string; onShare: () => void;
}) {
  const { t, message } = useLocale();
  return <div className="empty-state expense-welcome">
    <span className="expense-welcome-icon" aria-hidden="true"><Receipt size={30} /></span>
    <h2>{t("Together, fairly split")}</h2>
    <p>{t("Track shared expenses, split them your way and see who owes whom. Add your first expense to get started.")}</p>
    {signedIn ? <p className="expense-welcome-hint">{t("Saved on this device first, even offline, then synced with your household.")}</p>
      : sharing === "unavailable" ? <p className="expense-welcome-hint">{t("Saved on this device, even offline.")}</p>
      : <>
        <p className="expense-welcome-hint">{t("Splitty is for two people. Sign in to share expenses and to-dos with the other person, or keep using it on this device only.")}</p>
        <button className="secondary expense-welcome-action" disabled={!online || signInBusy} onClick={onShare}>
          <UsersRound size={18} aria-hidden="true" />{t("Sign in to share")}
        </button>
        {sharing === "closed" && <p className="expense-welcome-hint">{t("New household registration is currently closed. Ask a household member for an invitation.")}</p>}
      </>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </div>;
}

/** A short, order-free checklist for a household whose second member has not joined yet. */
export function HouseholdSetup({ namesDone, invitationPending, hasExpenses, onNames, onInvite, onAddExpense, onDismiss }: {
  namesDone: boolean; invitationPending: boolean; hasExpenses: boolean;
  onNames: () => void; onInvite: () => void; onAddExpense: () => void; onDismiss: () => void;
}) {
  const { t } = useLocale();
  const steps = [
    { id: "names", done: namesDone, label: t("Check both names"), hint: t("Names appear on expenses and balances."), action: onNames },
    {
      id: "invite", done: false, label: t("Invite the other person"),
      hint: invitationPending ? t("Invitation pending") : t("Share a link or QR code from Settings."), action: onInvite
    },
    { id: "expense", done: hasExpenses, label: t("Add your first expense"), hint: t("You can start before the other person joins."), action: onAddExpense }
  ];
  return <section className="setup-card" aria-labelledby="setup-title">
    <div className="setup-heading">
      <h2 id="setup-title">{t("Set up your household")}</h2>
      <button className="icon-button" aria-label={t("Hide setup")} onClick={onDismiss}><X size={20} /></button>
    </div>
    <p>{t("Splitty works best when you both use it. Do these steps in any order.")}</p>
    <ol className="setup-steps">
      {steps.map((step, index) => <li key={step.id} className={step.done ? "done" : undefined}>
        <button className="setup-step" onClick={step.action}>
          <span className="setup-step-mark" aria-hidden="true">{step.done ? <Check size={16} /> : index + 1}</span>
          <span className="entry-description"><strong>{step.label}</strong><small>{step.done ? t("Done") : step.hint}</small></span>
          <ChevronRight className="settings-chevron" size={18} aria-hidden="true" />
        </button>
      </li>)}
    </ol>
  </section>;
}

/** Invitation link opened on a device that is not signed in yet. */
export function InvitationLanding({ account, online, busy, onLocalSignIn }: {
  account: Pick<AccountController, "authOptions" | "signInBusy" | "errorFor" | "startProviderSignIn" | "dismissInvite">;
  online: boolean; busy: boolean; onLocalSignIn: () => void;
}) {
  const { t, message } = useLocale();
  const { authOptions, signInBusy } = account;
  const error = account.errorFor("sign-in");
  return <section className="update-card accent-hero" aria-labelledby="invitation-landing-title">
    <h2 id="invitation-landing-title"><UsersRound size={24} aria-hidden="true" />{t("You're invited to a shared household")}</h2>
    <p>{t("Sign in to join. You will share expenses, to-dos and the balance with the person who invited you. Entries already on this device are not added automatically.")}</p>
    <div className="button-row">
      {authOptions.entraEnabled
        ? <button className="primary" disabled={!online || busy || signInBusy} aria-busy={signInBusy} onClick={() => void account.startProviderSignIn()}>{t("Sign in to join")}</button>
        : authOptions.localSignInEnabled && <button className="primary" onClick={onLocalSignIn}>{t("Sign in to join")}</button>}
      <button className="secondary" disabled={signInBusy} onClick={account.dismissInvite}>{t("Not now")}</button>
    </div>
    {error && <p className="error" role="alert">{message(error)}</p>}
  </section>;
}

/** Invitation link opened while already signed in to another household. */
export function JoinInvitation({ account, online }: {
  account: Pick<AccountController, "householdsBusy" | "errorFor" | "joinHousehold" | "dismissInvite">; online: boolean;
}) {
  const { t, message } = useLocale();
  const error = account.errorFor("join");
  return <section className="update-card accent-hero" aria-labelledby="join-household-title">
    <h2 id="join-household-title"><UsersRound size={24} aria-hidden="true" />{t("Household invitation")}</h2>
    <p>{t("Join the invited household with this account? Your current household stays available in Settings.")}</p>
    <div className="button-row">
      <button className="primary" disabled={!online || account.householdsBusy} aria-busy={account.householdsBusy}
        onClick={() => void account.joinHousehold()}>{t("Join this household")}</button>
      <button className="secondary" disabled={account.householdsBusy} onClick={account.dismissInvite}>{t("Not now")}</button>
    </div>
    {error && <p className="error" role="alert">{message(error)}</p>}
  </section>;
}

/** Entries saved on this device before sign-in, which stay separate until the user adds them explicitly. */
export function LocalRecordsNotice({ entries, todos, matchesMember, compact, onReview, onAdd, onDownload, onDismiss }: {
  entries: number; todos: number; matchesMember: boolean; compact?: boolean;
  onReview?: () => void; onAdd?: () => void; onDownload?: () => void; onDismiss?: () => void;
}) {
  const locale = useLocale();
  const { t } = locale;
  const counts = recordCounts(locale, entries, todos);
  return <section className="local-records" aria-labelledby={compact ? "local-records-banner-title" : "local-records-title"}>
    <h3 id={compact ? "local-records-banner-title" : "local-records-title"}><Smartphone size={18} aria-hidden="true" />{t("Entries from before you signed in")}</h3>
    <p>{t("{expenses} and {todos} are saved only on this device. They are not part of this household.", counts)}</p>
    {!compact && !matchesMember && <p className="muted">{t("On this device they were recorded with you as the other person, so they cannot be added automatically. Download them instead.")}</p>}
    <div className="button-row">
      {compact ? <>
        <button className="secondary" onClick={onReview}>{t("Review")}</button>
        <button className="text-button" onClick={onDismiss}>{t("Not now")}</button>
      </> : <>
        {matchesMember && <button className="secondary" onClick={onAdd}>{t("Add to this household")}</button>}
        <button className="text-button" onClick={onDownload}>{t("Download these entries")}</button>
      </>}
    </div>
  </section>;
}
