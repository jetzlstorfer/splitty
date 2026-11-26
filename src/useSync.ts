import { useCallback, useEffect, useRef, useState } from "react";
import { activateAnonymousDatabase, db, localQueueState, updatePreferences } from "./db";
import { ApiError, identify, syncPollingInterval, synchronize, type Identity } from "./sync";
import { SYNC_STATUS, type SyncStatus } from "./syncStatus";

/**
 * Owns the sync loop: passes triggered by saves, focus, reconnects, database changes and polling,
 * the signed-in identity those passes refresh, and the raw status they report.
 * `pending` is the local queue length, which schedules a pass shortly after a save.
 */
export function useSync(pending: number | undefined) {
  const [online, setOnline] = useState(navigator.onLine);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<SyncStatus>(SYNC_STATUS.savedOnDevice);
  const [busy, setBusy] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [actionError, setActionError] = useState("");
  const syncLock = useRef<Promise<void> | null>(null);
  const syncRequested = useRef(false);
  const identityRefreshRequested = useRef(false);
  const identityRef = useRef<Identity | null>(null);
  const lastIdentityCheck = useRef(0);
  const lastActivityAt = useRef(0);
  const lastPollAt = useRef(0);
  const removingLocalData = useRef(false);
  const signedOutByUser = useRef(false);

  /** Forgets the signed-in identity, e.g. after a rejected session, sign-out, or account removal. */
  const endSession = useCallback((next: SyncStatus, clearLastSynced = true) => {
    signedOutByUser.current = next.kind === "signed-out";
    identityRef.current = null;
    lastIdentityCheck.current = 0;
    setIdentity(null);
    if (clearLastSynced) setLastSynced(null);
    setStatus(next);
  }, []);

  const startSession = useCallback(() => { signedOutByUser.current = false; }, []);

  const performSync = useCallback((refreshIdentity = false) => {
    if (!navigator.onLine || removingLocalData.current || signedOutByUser.current) return Promise.resolve();
    syncRequested.current = true;
    identityRefreshRequested.current ||= refreshIdentity;
    if (syncLock.current) return syncLock.current;
    syncLock.current = (async () => {
      do {
        syncRequested.current = false;
        const mustIdentify = identityRefreshRequested.current
          || !identityRef.current || Date.now() - lastIdentityCheck.current >= 5 * 60_000;
        identityRefreshRequested.current = false;
        const me = mustIdentify ? await identify() : identityRef.current!;
        if (mustIdentify) lastIdentityCheck.current = Date.now();
        identityRef.current = me;
        if ((me.member !== "a" && me.member !== "b")
          || typeof me.nameA !== "string" || typeof me.nameB !== "string") {
          throw new Error("Invalid sign-in response.");
        }
        const database = db;
        setIdentity(me);
        await updatePreferences({ member: me.member, nameA: me.nameA, nameB: me.nameB }, database);
        setStatus(SYNC_STATUS.syncing);
        const syncContext = typeof me.userId === "string" && typeof me.householdId === "string"
          ? { userId: me.userId, householdId: me.householdId }
          : undefined;
        await synchronize(database, syncContext);
        if (db !== database) {
          syncRequested.current = true;
          continue;
        }
        lastPollAt.current = Date.now();
        setLastSynced(new Date());
        setStatus(await database.conflicts.count() + await database.todoConflicts.count() ? SYNC_STATUS.needsAttention
          : (await localQueueState(database)).pending ? SYNC_STATUS.savedLocally : SYNC_STATUS.upToDate);
        // Saves during an in-flight pass need another pass, not a dropped request.
      } while (syncRequested.current && navigator.onLine && !removingLocalData.current && !signedOutByUser.current);
    })().catch(async (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        await activateAnonymousDatabase();
        endSession(SYNC_STATUS.signInRequired, false);
      }
      else setStatus({ kind: "error", message: e instanceof Error ? e.message : "Sync failed; your changes remain on this device." });
    }).finally(() => { syncLock.current = null; setBusy(false); });
    return syncLock.current;
  }, [endSession]);

  const sync = useCallback(async (refreshIdentity = false) => {
    if (!navigator.onLine || removingLocalData.current || signedOutByUser.current) return;
    setBusy(true);
    await performSync(refreshIdentity);
  }, [performSync]);

  /** Records a local save and schedules a pass to deliver it. */
  const markSaved = useCallback(() => { setStatus(SYNC_STATUS.savedOnDevice); void sync(); }, [sync]);

  /** Stops new passes and waits for the running one; pair with `resumeSync`. */
  const suspendSync = useCallback(async () => {
    removingLocalData.current = true;
    if (syncLock.current) await syncLock.current;
  }, []);

  const resumeSync = useCallback(() => { setBusy(false); removingLocalData.current = false; }, []);

  useEffect(() => {
    lastActivityAt.current = Date.now();
    lastPollAt.current = Date.now();
    const connected = () => { setOnline(true); void sync(true); };
    const disconnected = () => { setOnline(false); setBusy(false); setStatus(SYNC_STATUS.offline); };
    const focus = () => {
      if (document.visibilityState === "visible") {
        lastActivityAt.current = Date.now();
        void sync(true);
      }
    };
    const activity = () => { lastActivityAt.current = Date.now(); };
    const databaseChanged = () => { void sync(true); };
    window.addEventListener("online", connected); window.addEventListener("offline", disconnected);
    window.addEventListener("focus", focus);
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("splitty-database-changed", databaseChanged);
    void performSync();
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const cadence = syncPollingInterval(now, lastActivityAt.current);
      if (now - lastPollAt.current < cadence) return;
      lastPollAt.current = now;
      void sync();
    }, 10_000);
    return () => {
      window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("splitty-database-changed", databaseChanged);
      window.clearInterval(interval);
    };
  }, [performSync, sync]);

  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(() => void sync(), 400);
    return () => window.clearTimeout(timeout);
  }, [pending, sync]);

  return {
    online, identity, setIdentity, status, busy, lastSynced, actionError, setActionError,
    sync, markSaved, endSession, startSession, suspendSync, resumeSync
  };
}

export type SyncController = ReturnType<typeof useSync>;
