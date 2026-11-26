import { useEffect, useState, type FormEvent } from "react";
import type { Member } from "../shared/model";
import type { MessageKey } from "../shared/i18n";
import { activateAnonymousDatabase, clearAccountDatabase, db, localQueueState, setDeviceKey, updatePreferences } from "./db";
import { api, signInDevice, signOutDevice } from "./sync";
import { SYNC_STATUS } from "./syncStatus";
import type { SyncController } from "./useSync";
import { useLocale } from "./i18n";
import { useConfirm } from "./Controls";

export interface AuthOptions { entraEnabled: boolean; legacyEnabled: boolean; newHouseholdsEnabled?: boolean }
export interface Invitation { id: string; slot: Member; expiresAt: number }
const authOptionsKey = "splitty-auth-options";

function savedAuthOptions(): AuthOptions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(authOptionsKey) ?? "null");
    if (value && typeof value === "object" && "entraEnabled" in value && "legacyEnabled" in value
      && typeof value.entraEnabled === "boolean" && typeof value.legacyEnabled === "boolean") {
      return {
        entraEnabled: value.entraEnabled,
        legacyEnabled: value.legacyEnabled,
        newHouseholdsEnabled: "newHouseholdsEnabled" in value && value.newHouseholdsEnabled === true
      };
    }
  } catch { /* The API refresh below remains authoritative. */ }
  return { entraEnabled: false, legacyEnabled: false };
}

/** The part of the sync controller that account flows read or drive. */
export type AccountSync = Pick<SyncController,
  "online" | "identity" | "setIdentity" | "setActionError" | "sync" | "endSession" | "suspendSync" | "resumeSync">;

/**
 * Sign-in, household and invitation flows. Failures are reported through the sync controller's
 * `actionError`, and an ended session is cleared through its `endSession`.
 */
export function useAccount({ online, identity, setIdentity, setActionError, sync, endSession, suspendSync, resumeSync }: AccountSync) {
  const { t, number } = useLocale();
  const confirm = useConfirm();
  const [memberToken, setMemberToken] = useState("");
  const [legacyClaimToken, setLegacyClaimToken] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [authOptions, setAuthOptions] = useState<AuthOptions>(savedAuthOptions);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationLink, setInvitationLink] = useState("");
  const [createdInvitationId, setCreatedInvitationId] = useState("");
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  // Invitations belong to a signed-in household, so every ended session discards them.
  if (signedIn !== !!identity) {
    setSignedIn(!!identity);
    if (!identity) { setInvitations([]); setInvitationLink(""); setCreatedInvitationId(""); }
  }

  useEffect(() => {
    const refresh = () => {
      void api<AuthOptions>("auth/config").then((options) => {
        setAuthOptions(options);
        try { localStorage.setItem(authOptionsKey, JSON.stringify(options)); }
        catch { /* Sign-in options can still be fetched again when online. */ }
      }).catch(() => undefined);
    };
    refresh();
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, []);

  useEffect(() => {
    if (!identity?.householdId || !authOptions.entraEnabled || !online) return;
    let active = true;
    void api<{ invitations: Invitation[] }>("household/invitations").then((result) => {
      if (!Array.isArray(result.invitations) || result.invitations.some((invite) =>
        !invite || typeof invite.id !== "string" || (invite.slot !== "a" && invite.slot !== "b")
        || typeof invite.expiresAt !== "number")) {
        throw new Error("Invalid invitation response.");
      }
      if (active) setInvitations(result.invitations);
    }).catch((e: unknown) => {
      if (active) setActionError(e instanceof Error ? e.message : "Could not load household invitations.");
    });
    return () => { active = false; };
  }, [authOptions.entraEnabled, identity?.householdId, online, setActionError]);

  const providerAccount = !!identity?.userId && !identity.userId.startsWith("legacy-");
  const canRemoveLocalData = providerAccount && db.name.startsWith("splitty-account-");

  async function signIn(event: FormEvent) {
    event.preventDefault(); setSignInBusy(true); setActionError("");
    try {
      await signInDevice(memberToken);
      setMemberToken(""); await sync();
    } catch (e) { setActionError(e instanceof Error ? e.message : "Could not sign in with this token."); }
    finally { setSignInBusy(false); }
  }

  async function startProviderSignIn(legacyToken?: string) {
    const inviteCode = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (!inviteCode && !legacyToken) {
      window.location.assign("/api/auth/start");
      return;
    }
    setSignInBusy(true);
    setActionError("");
    try {
      const result = await api<{ authorizationUrl?: unknown }>("auth/start", {
        ...(inviteCode ? { inviteCode } : {}),
        ...(legacyToken ? { legacyToken } : {})
      });
      if (typeof result.authorizationUrl !== "string") throw new Error("Invalid sign-in response.");
      window.location.assign(result.authorizationUrl);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not start provider sign-in.");
      setSignInBusy(false);
    }
  }

  async function createHouseholdInvitation() {
    setInvitationBusy(true);
    setActionError("");
    setInvitationCopied(false);
    try {
      const result = await api<{ invitation: Invitation; code: string }>("household/invitations", {});
      if (!result.invitation || typeof result.invitation.id !== "string"
        || (result.invitation.slot !== "a" && result.invitation.slot !== "b")
        || typeof result.invitation.expiresAt !== "number" || typeof result.code !== "string") {
        throw new Error("Invalid invitation response.");
      }
      const link = new URL(location.pathname + location.search, location.origin);
      link.hash = new URLSearchParams({ invite: result.code }).toString();
      setInvitationLink(link.href);
      setCreatedInvitationId(result.invitation.id);
      setInvitations((current) => [...current.filter((invite) => invite.id !== result.invitation.id), result.invitation]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not create an invitation.");
    } finally { setInvitationBusy(false); }
  }

  async function copyInvitationLink() {
    try {
      await navigator.clipboard.writeText(invitationLink);
      setInvitationCopied(true);
    } catch {
      setActionError("Could not copy the invitation link. Select and copy the link above.");
    }
  }

  async function revokeHouseholdInvitation(invitation: Invitation) {
    setInvitationBusy(true);
    setActionError("");
    try {
      await api("household/invitations/revoke", { id: invitation.id });
      setInvitations((current) => current.filter((item) => item.id !== invitation.id));
      if (createdInvitationId === invitation.id) {
        setInvitationLink("");
        setCreatedInvitationId("");
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not revoke the invitation.");
    } finally { setInvitationBusy(false); }
  }

  async function saveHouseholdName(member: Member, value: string) {
    const name = value.trim();
    try {
      await api("household/member-name", { slot: member, name });
      await updatePreferences({ [member === "a" ? "nameA" : "nameB"]: name });
      setIdentity((current) => current && ({
        ...current,
        [member === "a" ? "nameA" : "nameB"]: name
      }));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update the household member name.");
    }
  }

  async function runHouseholdAction(
    path: "household/leave" | "household/remove-member" | "household/delete" | "account/delete",
    title: MessageKey,
    description: MessageKey
  ) {
    if (!await confirm({ title: t(title), description: t(description), action: t(title), dangerous: true })) return;
    setSignOutBusy(true);
    setActionError("");
    try {
      await api(path, {});
      if (path === "household/remove-member") {
        await sync();
        return;
      }
      await setDeviceKey(null);
      await activateAnonymousDatabase();
      endSession(SYNC_STATUS.accessEnded);
      window.location.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update household access.");
    } finally { setSignOutBusy(false); }
  }

  async function signOut() {
    setSignOutBusy(true); setActionError("");
    try {
      await signOutDevice();
      await activateAnonymousDatabase();
      endSession(SYNC_STATUS.signedOut);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Could not sign out."); }
    finally { setSignOutBusy(false); }
  }

  async function removeLocalAccountData() {
    const database = db;
    if (!identity?.userId || identity.userId.startsWith("legacy-") || !database.name.startsWith("splitty-account-")) return;
    setSignOutBusy(true); setActionError("");
    try {
      const [queue, conflicts, todoConflicts] = await Promise.all([
        localQueueState(database), database.conflicts.count(), database.todoConflicts.count()
      ]);
      const unsynced = queue.pending + conflicts + todoConflicts;
      const warning = unsynced
        ? t("This device has {count} unsynced changes or conflicts. Removing local data permanently discards them. Synced household data is not deleted. Continue?", { count: number(unsynced) })
        : t("Remove this account's data from this device? Synced household data is not deleted.");
      if (!await confirm({
        title: t("Remove local data from this device"),
        description: warning,
        action: t("Remove local data from this device"),
        dangerous: true
      })) return;
      await suspendSync();
      await api("auth/logout", {});
      await activateAnonymousDatabase();
      await setDeviceKey(null);
      await clearAccountDatabase(database);
      endSession(SYNC_STATUS.localDataRemoved);
      window.location.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not remove local account data.");
    } finally { resumeSync(); setSignOutBusy(false); }
  }

  return {
    authOptions, memberToken, setMemberToken, legacyClaimToken, setLegacyClaimToken, signInBusy, signOutBusy,
    invitations, invitationLink, invitationBusy, invitationCopied, providerAccount, canRemoveLocalData,
    signIn, startProviderSignIn, createHouseholdInvitation, copyInvitationLink, revokeHouseholdInvitation,
    saveHouseholdName, runHouseholdAction, signOut, removeLocalAccountData
  };
}

export type AccountController = ReturnType<typeof useAccount>;
