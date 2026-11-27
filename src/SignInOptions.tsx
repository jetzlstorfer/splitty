import { useLocale } from "./i18n";
import type { AccountController } from "./useAccount";

/** The single sign-in control, shown in Settings, the cloud menu and the invitation landing card. */
export default function SignInOptions({ account, online, busy }: {
  account: Pick<AccountController, "authOptions" | "signInBusy" | "inviteCode" | "errorFor" | "signIn" | "startProviderSignIn">;
  online: boolean; busy: boolean;
}) {
  const { t, message } = useLocale();
  const { authOptions, signInBusy } = account;
  const error = account.errorFor("sign-in");
  return <div className="sync-sign-in">
    {authOptions.entraEnabled && <>
      <button className="primary" disabled={busy || signInBusy || !online} onClick={() => void account.startProviderSignIn()}>{t("Continue with email, Google, or Microsoft")}</button>
      {authOptions.newHouseholdsEnabled === false && !account.inviteCode
        && <p className="muted">{t("New household registration is currently closed. Ask a household member for an invitation.")}</p>}
    </>}
    {authOptions.localSignInEnabled && <div className="button-row">
      <button className="primary" disabled={signInBusy || busy || !online} onClick={() => void account.signIn("a")}>
        {t(signInBusy ? "Signing in…" : "Development sign-in as first member")}
      </button>
      <button className="secondary" disabled={signInBusy || busy || !online} onClick={() => void account.signIn("b")}>
        {t(signInBusy ? "Signing in…" : "Development sign-in as second member")}
      </button>
    </div>}
    {!authOptions.entraEnabled && !authOptions.localSignInEnabled
      && <p className="muted">{t("Sign-in is not available right now. Your entries stay on this device.")}</p>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </div>;
}
