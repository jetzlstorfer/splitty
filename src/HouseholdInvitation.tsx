import { QRCodeSVG } from "qrcode.react";
import type { Preferences } from "./db";
import { useLocale } from "./i18n";
import type { AccountController } from "./useAccount";

/**
 * Invites the other person into a vacant slot. Shown only when the server confirmed that the slot
 * is vacant, so a pending invitation or an offline device never looks like a missing member.
 */
export default function HouseholdInvitation({ preferences: p, online, account }: {
  preferences: Preferences; online: boolean;
  account: Pick<AccountController, "invitations" | "invitationsLoaded" | "invitationLink" | "invitationBusy" | "invitationCopied"
    | "errorFor" | "createHouseholdInvitation" | "copyInvitationLink" | "revokeHouseholdInvitation" | "replaceHouseholdInvitation">;
}) {
  const { t, locale, message, person } = useLocale();
  const { invitations, invitationsLoaded, invitationLink, invitationBusy, invitationCopied } = account;
  const error = account.errorFor("invitation");
  const expiry = (expiresAt: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(expiresAt));
  return <section id="settings-invite" className="invitation-panel" tabIndex={-1} aria-labelledby="settings-invite-title">
    <h3 id="settings-invite-title">{t("Invite the other person")}</h3>
    <p className="muted">{t("Share the link or QR code with the person you share expenses with. Splitty households have exactly two members.")}</p>
    <p className="muted">{t("Invitation is valid for 7 days and takes over the invited member slot's existing balance.")}</p>
    {!invitations.length && (invitationsLoaded || !!error) && <button className="secondary" disabled={!online || invitationBusy} onClick={() => void account.createHouseholdInvitation()}>
      {t(invitationBusy ? "Creating invitation…" : "Create invitation")}
    </button>}
    {invitationLink && <div className="invitation-link">
      <label>{t("Invitation link")}<input aria-label={t("Invitation link")} readOnly value={invitationLink} onFocus={(event) => event.currentTarget.select()} /></label>
      <QRCodeSVG value={invitationLink} size={192} level="M" includeMargin role="img" aria-label={t("Invitation QR code")} />
      <button className="secondary" disabled={invitationBusy} onClick={() => void account.copyInvitationLink()}>{t("Copy invite link")}</button>
      {invitationCopied && <p role="status">{t("Invite was copied.")}</p>}
    </div>}
    {!!invitations.length && <ul>{invitations.map((invite) => <li key={invite.id}>
      <p>{t("Pending invitation to {name}, expires {date}.", { name: person(p, invite.slot), date: expiry(invite.expiresAt) })}</p>
      {!invitationLink && <p className="muted">{t("For security, an invitation link is shown only once. Replace it if you need the link again.")}</p>}
      <div className="button-row">
        {!invitationLink && <button className="text-button" disabled={!online || invitationBusy} onClick={() => void account.replaceHouseholdInvitation(invite)}>{t("Replace invitation")}</button>}
        <button className="text-button" disabled={!online || invitationBusy} onClick={() => void account.revokeHouseholdInvitation(invite)}>{t("Revoke invitation")}</button>
      </div>
    </li>)}</ul>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </section>;
}
