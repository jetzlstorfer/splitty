import { localizeMessage, type Language, type MessageKey } from "../shared/i18n";

export type SyncStatus =
  | {
    kind: "saved-on-device" | "saved-locally" | "up-to-date" | "syncing" | "offline" | "needs-attention"
      | "local-only" | "sign-in-required" | "signed-out" | "access-ended" | "local-data-removed";
  }
  | { kind: "error"; message: string };

type FixedSyncStatus = Exclude<SyncStatus, { kind: "error" }>;

export const SYNC_STATUS = {
  savedOnDevice: { kind: "saved-on-device" },
  savedLocally: { kind: "saved-locally" },
  upToDate: { kind: "up-to-date" },
  syncing: { kind: "syncing" },
  offline: { kind: "offline" },
  needsAttention: { kind: "needs-attention" },
  localOnly: { kind: "local-only" },
  signInRequired: { kind: "sign-in-required" },
  signedOut: { kind: "signed-out" },
  accessEnded: { kind: "access-ended" },
  localDataRemoved: { kind: "local-data-removed" }
} as const satisfies Record<string, FixedSyncStatus>;

const messageKeys = {
  "saved-on-device": "Saved on this device",
  "saved-locally": "Saved locally · changes waiting to sync",
  "up-to-date": "Up to date",
  syncing: "Syncing…",
  offline: "Offline · changes stay on this device",
  "needs-attention": "Some edits need your attention",
  "local-only": "Not signed in · saved only on this device",
  "sign-in-required": "Sign in to sync",
  "signed-out": "Signed out · local history remains on this device",
  "access-ended": "Your household access has ended.",
  "local-data-removed": "Local account data was removed from this device."
} as const satisfies Record<FixedSyncStatus["kind"], MessageKey>;

// Using the app without an account, including after signing out on purpose, is not a problem to fix.
const quietKinds: ReadonlySet<SyncStatus["kind"]> = new Set([
  "up-to-date", "syncing", "saved-on-device", "saved-locally", "offline", "local-only", "signed-out"
]);

export interface SyncStatusInputs {
  online: boolean;
  busy: boolean;
  pending: number;
  conflictCount: number;
  actionError: string;
  status: SyncStatus;
}

export interface SyncStatusView {
  current: SyncStatus;
  upToDate: boolean;
  needsAttention: boolean;
  /** This device is intentionally used without an account, so nothing will sync. */
  localOnly: boolean;
}

export function deriveSyncStatus({ online, busy, pending, conflictCount, actionError, status }: SyncStatusInputs): SyncStatusView {
  // Another tab can acknowledge shared queued writes after this tab's sync finishes.
  const idle = status.kind === "saved-locally" && !pending && !conflictCount ? SYNC_STATUS.upToDate : status;
  const current: SyncStatus = !online ? SYNC_STATUS.offline : busy ? SYNC_STATUS.syncing : idle;
  return {
    current,
    upToDate: online && !busy && !pending && !conflictCount && idle.kind === "up-to-date",
    needsAttention: !!actionError || !!conflictCount || !quietKinds.has(current.kind),
    localOnly: idle.kind === "local-only" || idle.kind === "signed-out"
  };
}

export function describeSyncStatus(status: SyncStatus, language: Language): string {
  return localizeMessage(status.kind === "error" ? status.message : messageKeys[status.kind], language);
}
