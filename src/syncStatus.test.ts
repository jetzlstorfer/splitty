import { describe, expect, it } from "vitest";
import { describeSyncStatus, deriveSyncStatus, SYNC_STATUS, type SyncStatus, type SyncStatusInputs } from "./syncStatus";

const inputs = (overrides: Partial<SyncStatusInputs> = {}): SyncStatusInputs => ({
  online: true, busy: false, pending: 0, conflictCount: 0, actionError: "", status: SYNC_STATUS.upToDate, ...overrides
});

const fixed = Object.values(SYNC_STATUS);
const quiet = [SYNC_STATUS.upToDate, SYNC_STATUS.syncing, SYNC_STATUS.savedOnDevice, SYNC_STATUS.savedLocally, SYNC_STATUS.offline];
const loud = [
  SYNC_STATUS.needsAttention, SYNC_STATUS.signInRequired, SYNC_STATUS.signedOut,
  SYNC_STATUS.accessEnded, SYNC_STATUS.localDataRemoved
];

// The original derivation compared the displayed English sentences.
function compared(input: SyncStatusInputs) {
  const status = describeSyncStatus(input.status, "en");
  const idle = status === "Saved locally · changes waiting to sync" && !input.pending && !input.conflictCount ? "Up to date" : status;
  const current = !input.online ? "Offline · changes stay on this device" : input.busy ? "Syncing…" : idle;
  return {
    current,
    upToDate: input.online && !input.busy && !input.pending && !input.conflictCount && idle === "Up to date",
    needsAttention: !!input.actionError || !!input.conflictCount || ![
      "Up to date", "Syncing…", "Saved on this device", "Saved locally · changes waiting to sync",
      "Offline · changes stay on this device"
    ].includes(current)
  };
}

describe("sync status derivation", () => {
  it("matches the message-based derivation for every status and input combination", () => {
    for (const status of fixed) {
      for (const online of [true, false]) for (const busy of [true, false])
        for (const pending of [0, 2]) for (const conflictCount of [0, 1]) for (const actionError of ["", "Could not sign in."]) {
          const input = inputs({ status, online, busy, pending, conflictCount, actionError });
          const view = deriveSyncStatus(input);
          expect({ current: describeSyncStatus(view.current, "en"), upToDate: view.upToDate, needsAttention: view.needsAttention })
            .toEqual(compared(input));
        }
    }
  });

  it.each(quiet)("does not need attention for $kind", (status) => {
    expect(deriveSyncStatus(inputs({ status })).needsAttention).toBe(false);
  });

  it.each(loud)("needs attention for $kind", (status) => {
    expect(deriveSyncStatus(inputs({ status })).needsAttention).toBe(true);
  });

  it("treats every error as needing attention, whatever its text", () => {
    for (const message of ["Network request failed.", "Up to date", "Syncing…", ""]) {
      const view = deriveSyncStatus(inputs({ status: { kind: "error", message } }));
      expect(view.needsAttention).toBe(true);
      expect(view.upToDate).toBe(false);
    }
  });

  it("does not need attention while offline, syncing, saved locally, or waiting for the next pass", () => {
    expect(deriveSyncStatus(inputs({ online: false, status: SYNC_STATUS.savedLocally, pending: 3 })).needsAttention).toBe(false);
    expect(deriveSyncStatus(inputs({ busy: true, status: SYNC_STATUS.savedLocally, pending: 3 })).needsAttention).toBe(false);
    expect(deriveSyncStatus(inputs({ status: SYNC_STATUS.savedLocally, pending: 3 })).needsAttention).toBe(false);
  });

  it("lets offline and syncing override an attention status without hiding action errors or conflicts", () => {
    expect(deriveSyncStatus(inputs({ online: false, status: SYNC_STATUS.signInRequired })).current).toEqual(SYNC_STATUS.offline);
    expect(deriveSyncStatus(inputs({ busy: true, status: SYNC_STATUS.signedOut })).current).toEqual(SYNC_STATUS.syncing);
    expect(deriveSyncStatus(inputs({ online: false, actionError: "Could not sign out." })).needsAttention).toBe(true);
    expect(deriveSyncStatus(inputs({ busy: true, conflictCount: 1 })).needsAttention).toBe(true);
  });

  it("settles a saved-locally status into up-to-date once nothing is pending and no conflicts remain", () => {
    const waiting = deriveSyncStatus(inputs({ status: SYNC_STATUS.savedLocally, pending: 1 }));
    expect(waiting.current).toEqual(SYNC_STATUS.savedLocally);
    expect(waiting.upToDate).toBe(false);

    const withConflict = deriveSyncStatus(inputs({ status: SYNC_STATUS.savedLocally, conflictCount: 1 }));
    expect(withConflict.current).toEqual(SYNC_STATUS.savedLocally);
    expect(withConflict.upToDate).toBe(false);

    const settled = deriveSyncStatus(inputs({ status: SYNC_STATUS.savedLocally }));
    expect(settled.current).toEqual(SYNC_STATUS.upToDate);
    expect(settled.upToDate).toBe(true);
    expect(settled.needsAttention).toBe(false);
  });

  it("is only up to date while online and idle", () => {
    expect(deriveSyncStatus(inputs({ online: false })).upToDate).toBe(false);
    expect(deriveSyncStatus(inputs({ busy: true })).upToDate).toBe(false);
    expect(deriveSyncStatus(inputs({ status: SYNC_STATUS.savedOnDevice })).upToDate).toBe(false);
  });
});

describe("sync status descriptions", () => {
  const english: [SyncStatus, string][] = [
    [SYNC_STATUS.savedOnDevice, "Saved on this device"],
    [SYNC_STATUS.savedLocally, "Saved locally · changes waiting to sync"],
    [SYNC_STATUS.upToDate, "Up to date"],
    [SYNC_STATUS.syncing, "Syncing…"],
    [SYNC_STATUS.offline, "Offline · changes stay on this device"],
    [SYNC_STATUS.needsAttention, "Some edits need your attention"],
    [SYNC_STATUS.signInRequired, "Sign in to sync"],
    [SYNC_STATUS.signedOut, "Signed out · local history remains on this device"],
    [SYNC_STATUS.accessEnded, "Your household access has ended."],
    [SYNC_STATUS.localDataRemoved, "Local account data was removed from this device."]
  ];

  it.each(english)("describes %j in English and German", (status, text) => {
    expect(describeSyncStatus(status, "en")).toBe(text);
    expect(describeSyncStatus(status, "de")).not.toBe(text);
  });

  it("localizes error text like any other message", () => {
    const status: SyncStatus = { kind: "error", message: "Sync failed; your changes remain on this device." };
    expect(describeSyncStatus(status, "en")).toBe("Sync failed; your changes remain on this device.");
    expect(describeSyncStatus(status, "de")).toBe("Die Synchronisierung ist fehlgeschlagen. Deine Änderungen bleiben auf diesem Gerät.");
    expect(describeSyncStatus({ kind: "error", message: "" }, "de")).toBe("");
  });
});
