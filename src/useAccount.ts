import { useCallback, useEffect, useState } from "react";
import type { Member } from "../shared/model";
import type { MessageKey } from "../shared/i18n";
import { activateAccountDatabase, activateAnonymousDatabase, clearAccountDatabase, db, localQueueState, prepareDeviceKey, setDeviceKey, updatePreferences } from "./db";
import { api, signInLocally, signOutDevice } from "./sync";
import { SYNC_STATUS } from "./syncStatus";
import type { SyncController } from "./useSync";
import { useLocale } from "./i18n";
import { useConfirm } from "./Controls";

export interface AuthOptions { entraEnabled: boolean; localSignInEnabled: boolean; newHouseholdsEnabled?: boolean }
export interface Invitation { id: string; slot: Member; expiresAt: number }
export interface HouseholdSummary { householdId: string; member: Member; nameA: string; nameB: string; current: boolean }
/** Where a failed account action is reported, so the message appears beside the control that caused it. */
export type AccountErrorArea = "sign-in" | "account" | "household" | "invitation" | "join" | "device";
const authOptionsKey = "splitty-auth-options";
const stableId = /^[a-zA-Z0-9_-]{1,100}$/;

const pendingInviteCode = () => new URLSearchParams(location.hash.slice(1)).get("invite") ?? "";

function isHouseholdSummary(value: unknown): value is HouseholdSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.householdId === "string" && stableId.test(item.householdId)
    && (item.member === "a" || item.member === "b")
    && typeof item.nameA === "string" && typeof item.nameB === "string" && typeof item.current === "boolean";
}

function savedAuthOptions(): AuthOptions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(authOptionsKey) ?? "null");
    if (value && typeof value === "object" && "entraEnabled" in value
      && typeof value.entraEnabled === "boolean") {
      return {
        entraEnabled: value.entraEnabled,
        localSignInEnabled: "localSignInEnabled" in value && value.localSignInEnabled === true,
        newHouseholdsEnabled: "newHouseholdsEnabled" in value && value.newHouseholdsEnabled === true
      };
    }
  } catch { /* The API refresh below remains authoritative. */ }
  return { entraEnabled: false, localSignInEnabled: false };
}

/** The part of the sync controller that account flows read or drive. */
export type AccountSync = Pick<SyncController,
  "online" | "identity" | "setIdentity" | "sync" | "endSession" | "startSession" | "suspendSync" | "resumeSync">;

/**
 * Sign-in, household and invitation flows. Failures are reported per area through `errorFor`, not as
 * sync problems, and an ended session is cleared through the sync controller's `endSession`.
 */
export function useAccount({ online, identity, setIdentity, sync, endSession, startSession, suspendSync, resumeSync }: AccountSync) {
  const { t, number } = useLocale();
  const confirm = useConfirm();
  const [signInBusy, setSignInBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [authOptions, setAuthOptions] = useState<AuthOptions>(savedAuthOptions);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoaded, setInvitationsLoaded] = useState(false);
  const [invitationLink, setInvitationLink] = useState("");
  const [createdInvitationId, setCreatedInvitationId] = useState("");
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [shownHousehold, setShownHousehold] = useState<string>();
  const [households, setHouseholds] = useState<HouseholdSummary[]>([]);
  const [canCreateHousehold, setCanCreateHousehold] = useState(false);
  const [householdsBusy, setHouseholdsBusy] = useState(false);
  const [householdsVersion, setHouseholdsVersion] = useState(0);
  const [inviteCode, setInviteCode] = useState(pendingInviteCode);
  const [error, setError] = useState<{ area: AccountErrorArea; message: string } | null>(null);

  const userId = identity?.userId, householdId = identity?.householdId;
  const otherMemberJoined = identity?.otherMemberJoined;
  const context = userId && householdId ? { userId, householdId } : undefined;
  const householdKey = context && `${context.userId}:${context.householdId}`;
  if (shownHousehold !== householdKey) {
    setShownHousehold(householdKey);
    setInvitations([]); setInvitationsLoaded(false); setInvitationLink(""); setCreatedInvitationId("");
    setHouseholds([]); setCanCreateHousehold(false);
    setError(null);
  }

  const fail = useCallback((area: AccountErrorArea, e: unknown, fallback: string) => {
    setError({ area, message: e instanceof Error ? e.message : fallback });
  }, []);
  const errorFor = (area: AccountErrorArea) => error?.area === area ? error.message : "";
  const clearError = () => setError(null);

  useEffect(() => {
    const update = () => setInviteCode(pendingInviteCode());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

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
    if (!userId || !householdId || !authOptions.entraEnabled || !online) return;
    let active = true;
    // Also refetched when the other slot's membership changes: joining consumes the pending invitation.
    void api<{ invitations: Invitation[] }>("household/invitations", undefined, { userId, householdId }).then((result) => {
      if (!Array.isArray(result.invitations) || result.invitations.some((invite) =>
        !invite || typeof invite.id !== "string" || (invite.slot !== "a" && invite.slot !== "b")
        || typeof invite.expiresAt !== "number")) {
        throw new Error("Invalid invitation response.");
      }
      if (active) { setInvitations(result.invitations); setInvitationsLoaded(true); }
    }).catch((e: unknown) => {
      if (active) fail("invitation", e, "Could not load household invitations.");
    });
    return () => { active = false; };
  }, [authOptions.entraEnabled, userId, householdId, otherMemberJoined, online, fail]);

  const providerAccount = !!identity?.userId;
  const canRemoveLocalData = providerAccount && db.name.startsWith("splitty-account-");

  useEffect(() => {
    if (!identity?.userId || !identity.householdId || !online) return;
    let active = true;
    void api<{ households?: unknown; canCreate?: unknown }>("households").then((result) => {
      if (!Array.isArray(result.households) || !result.households.every(isHouseholdSummary)
        || typeof result.canCreate !== "boolean") {
        throw new Error("Invalid household response.");
      }
      if (active) { setHouseholds(result.households); setCanCreateHousehold(result.canCreate); }
    }).catch((e: unknown) => {
      if (active) fail("household", e, "Could not load your households.");
    });
    return () => { active = false; };
  }, [identity?.userId, identity?.householdId, online, householdsVersion, fail]);

  /** Adopts a session the server issued for another of the account's households. */
  async function enterHousehold(result: unknown) {
    const next = result && typeof result === "object" ? result as Record<string, unknown> : {};
    if (typeof next.userId !== "string" || typeof next.householdId !== "string"
      || typeof next.deviceKey !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(next.deviceKey)) {
      throw new Error("Invalid household response.");
    }
    await setDeviceKey(next.deviceKey);
    await activateAccountDatabase(next.userId, next.householdId);
    setInvitations([]); setInvitationsLoaded(false); setInvitationLink(""); setCreatedInvitationId("");
  }

  async function householdChanged() {
    setHouseholdsVersion((version) => version + 1);
    await sync(true);
  }

  // Persist the successor before the server retires this tab's cookie and device key.
  async function prepareHouseholdChange() {
    const result = await api<{ deviceKey: string; source: string }>("households/prepare", {}, context);
    if (typeof result?.deviceKey !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(result.deviceKey)
      || typeof result.source !== "string" || !/^s-[a-f0-9]{64}$/.test(result.source)) {
      throw new Error("Invalid household response.");
    }
    await prepareDeviceKey(result.deviceKey);
    return result.source;
  }

  /**
   * Switching, joining and creating return a session for the target household. Each household keeps
   * its own local database, so unsynced changes stay queued there until the account switches back.
   */
  async function changeHousehold(
    path: "households/switch" | "households/join" | "households/create", data: Record<string, string>
  ): Promise<boolean> {
    const area = path === "households/join" ? "join" : "household";
    setHouseholdsBusy(true);
    clearError();
    let changed = false;
    try {
      await sync();
      // A pass still using the previous session would fail once the server replaces it.
      await suspendSync();
      const source = await prepareHouseholdChange();
      await enterHousehold(await api(path, { ...data, source }, context));
      changed = true;
    } catch (e) {
      fail(area, e, "Could not change the household.");
    } finally { resumeSync(); setHouseholdsBusy(false); }
    if (changed) await householdChanged();
    return changed;
  }

  async function switchHousehold(householdId: string) {
    if (householdId === identity?.householdId) return;
    await changeHousehold("households/switch", { householdId });
  }

  async function joinHousehold() {
    if (!inviteCode) return;
    if (await changeHousehold("households/join", { inviteCode })) dismissInvite();
  }

  function dismissInvite() {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    setInviteCode("");
    setError((current) => current?.area === "join" ? null : current);
  }

  async function createHousehold() {
    if (!await confirm({
      title: t("Create another household"),
      description: t("Create a new household with its own ledger? You can switch between your households in Settings."),
      action: t("Create another household")
    })) return;
    await changeHousehold("households/create", {});
  }

  async function signIn(member: Member) {
    setSignInBusy(true); clearError();
    startSession();
    try {
      await signInLocally(member);
      await sync();
    } catch (e) { fail("sign-in", e, "Could not sign in for local development."); }
    finally { setSignInBusy(false); }
  }

  async function startProviderSignIn() {
    const inviteCode = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (!inviteCode) {
      window.location.assign("/api/auth/start");
      return;
    }
    setSignInBusy(true);
    clearError();
    try {
      const result = await api<{ authorizationUrl?: unknown }>("auth/start", {
        inviteCode
      });
      if (typeof result.authorizationUrl !== "string") throw new Error("Invalid sign-in response.");
      window.location.assign(result.authorizationUrl);
    } catch (e) {
      fail("sign-in", e, "Could not start provider sign-in.");
      setSignInBusy(false);
    }
  }

  async function createHouseholdInvitation() {
    const database = db;
    setInvitationBusy(true);
    clearError();
    setInvitationCopied(false);
    try {
      const result = await api<{ invitation: Invitation; code: string }>("household/invitations", {}, context);
      if (database !== db) return;
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
      fail("invitation", e, "Could not create an invitation.");
    } finally { setInvitationBusy(false); }
  }

  async function copyInvitationLink() {
    try {
      await navigator.clipboard.writeText(invitationLink);
      setInvitationCopied(true);
    } catch {
      setError({ area: "invitation", message: "Could not copy the invitation link. Select and copy the link above." });
    }
  }

  async function revokeHouseholdInvitation(invitation: Invitation): Promise<boolean> {
    setInvitationBusy(true);
    clearError();
    try {
      await api("household/invitations/revoke", { id: invitation.id }, context);
      setInvitations((current) => current.filter((item) => item.id !== invitation.id));
      if (createdInvitationId === invitation.id) {
        setInvitationLink("");
        setCreatedInvitationId("");
      }
      return true;
    } catch (e) {
      fail("invitation", e, "Could not revoke the invitation.");
      return false;
    } finally { setInvitationBusy(false); }
  }

  /** Only a hash of an invitation is stored, so a lost link can be replaced but not shown again. */
  async function replaceHouseholdInvitation(invitation: Invitation) {
    if (!await confirm({
      title: t("Replace invitation"),
      description: t("Create a new invitation link? The previous link will stop working."),
      action: t("Replace invitation")
    })) return;
    if (await revokeHouseholdInvitation(invitation)) await createHouseholdInvitation();
  }

  async function saveHouseholdName(member: Member, value: string) {
    const name = value.trim();
    const database = db;
    try {
      await api("household/member-name", { slot: member, name }, context);
      if (db !== database) return;
      await updatePreferences({ [member === "a" ? "nameA" : "nameB"]: name }, database);
      setIdentity((current) => current && current.userId === userId && current.householdId === householdId ? ({
        ...current,
        [member === "a" ? "nameA" : "nameB"]: name
      }) : current);
    } catch (e) {
      fail("household", e, "Could not update the household member name.");
    }
  }

  async function runHouseholdAction(
    path: "household/leave" | "household/remove-member" | "household/delete" | "account/delete",
    title: MessageKey,
    description: MessageKey
  ) {
    if (!await confirm({ title: t(title), description: t(description), action: t(title), dangerous: true })) return;
    setSignOutBusy(true);
    clearError();
    const endsAccess = path !== "household/remove-member";
    let continued = false;
    try {
      if (endsAccess) await suspendSync();
      const source = path === "household/delete" || path === "household/leave" ? await prepareHouseholdChange() : undefined;
      const result = await api<{ continued?: unknown }>(path, { source }, context);
      if (!endsAccess) {
        // Refresh the identity so the now vacant slot can be invited again.
        await sync(true);
        return;
      }
      if (result.continued === true) {
        await enterHousehold(result);
        continued = true;
      } else {
        await setDeviceKey(null);
        await activateAnonymousDatabase();
        endSession(SYNC_STATUS.accessEnded);
        window.location.reload();
      }
    } catch (e) {
      fail(path === "account/delete" ? "account" : "household", e, "Could not update household access.");
    } finally {
      if (endsAccess) resumeSync();
      setSignOutBusy(false);
    }
    if (continued) await householdChanged();
  }

  async function signOut() {
    if (!await confirm({
      title: t("Sign out"),
      description: t("Sign out on this device? Your offline history will remain on this device."),
      action: t("Sign out")
    })) return;
    setSignOutBusy(true); clearError();
    try {
      await suspendSync();
      await signOutDevice();
      await activateAnonymousDatabase();
      endSession(SYNC_STATUS.signedOut);
    } catch (e) { fail("account", e, "Could not sign out."); }
    finally { resumeSync(); setSignOutBusy(false); }
  }

  async function removeLocalAccountData() {
    const database = db;
    if (!identity?.userId || !database.name.startsWith("splitty-account-")) return;
    setSignOutBusy(true); clearError();
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
      await signOutDevice();
      await activateAnonymousDatabase();
      await clearAccountDatabase(database);
      endSession(SYNC_STATUS.localDataRemoved);
      window.location.reload();
    } catch (e) {
      fail("device", e, "Could not remove local account data.");
    } finally { resumeSync(); setSignOutBusy(false); }
  }

  return {
    authOptions, signInBusy, signOutBusy, errorFor,
    invitations, invitationsLoaded, invitationLink, invitationBusy, invitationCopied, providerAccount, canRemoveLocalData,
    households, canCreateHousehold, householdsBusy, inviteCode,
    signIn, startProviderSignIn, createHouseholdInvitation, copyInvitationLink, revokeHouseholdInvitation,
    replaceHouseholdInvitation, saveHouseholdName, runHouseholdAction, signOut, removeLocalAccountData,
    switchHousehold, joinHousehold, dismissInvite, createHousehold
  };
}

export type AccountController = ReturnType<typeof useAccount>;
