---
name: offline-sync-validation
description: 'Validate Splitty offline-first persistence and household synchronization. Use when changing IndexedDB, transactional outboxes, expense or manual to-do sync, insurance completion, revisions, cursors, tombstones, conflict resolution, reconnect behavior, or edits saved during an in-flight sync. Covers targeted unit, Azurite integration, and two-device browser regressions.'
---

# Offline-sync validation

## Goal

Prove that local saves survive reloads and converge across the intended household
devices without losing edits, resurrecting deletions, or changing accounting.

## Map the affected path

Read only the parts relevant to the change:

- [Local queues, stores, and conflict application](../../../src/db.ts).
- [Client synchronization](../../../src/sync.ts) and its caller in
  [App.tsx](../../../src/App.tsx), including save-triggered sync scheduling.
- [API request handling](../../../api/src/handler.ts),
  [ledger mutation/change logic](../../../api/src/ledger.ts), and
  [table storage](../../../api/src/storage.ts).
- [Shared versioned expense model](../../../shared/model.ts),
  [manual to-do model](../../../shared/todo.ts), and
  [derived insurance reminders](../../../src/todos.ts).
- [Architecture and operating constraints](../../../README.md#azure-architecture)
  and [check commands](../../../README.md#checks).

Expense and manual to-do stores have separate outboxes, conflicts, and cursors.
Insurance submission is a field on an expense, not a separate manual to-do.
Reuse existing store helpers; do not introduce a parallel persistence path.

## Procedure

1. Identify a reproducible sequence and the invariant that fails. Determine
   whether it affects expenses, manual to-dos, insurance completion, or shared
   infrastructure. Test both stores when shared infrastructure changes.
2. Add the smallest regression at the appropriate layer. Follow prior art in:
   - [Expense storage tests](../../../src/db.test.ts).
   - [Manual to-do storage tests](../../../src/todo-db.test.ts).
   - [Sync scheduling/protocol tests](../../../src/sync.test.ts).
   - [Storage-backed API integration tests](../../../tests/api.integration.test.ts).
   - [Insurance/two-device tests](../../../tests/e2e/todos.spec.ts),
     [manual household to-do tests](../../../tests/e2e/manual-todos.spec.ts), and
     [mobile/offline expense tests](../../../tests/e2e/mobile.spec.ts).
3. Select the scenarios relevant to the changed path. Shared sync infrastructure
   should cover the complete set:

   | Scenario | Required evidence |
   | --- | --- |
   | Offline create/edit/complete/reopen | Immediate local state and persistence after reload; queued changes remain pending until connected. |
   | Reconnection | Another device receives changes; records and balances agree after synchronization. |
   | Same member on two devices | Separate browser contexts converge, not just member A versus member B. |
   | Both household members | Either member can receive and change shared records. |
   | Edit during an in-flight sync | Hold a real sync response, save another edit, release it, and verify a later pass delivers the newer edit. |
   | Concurrent edits | Both versions are visible; editing is blocked until explicit local/remote resolution. |
   | Delete versus stale edit | Deletions persist as tombstones; stale devices do not silently resurrect records. |
   | Retry and pagination | Retries do not duplicate operations; cursor advancement and acknowledgements do not discard pending edits. |

4. Use synthetic records and independent browser contexts, as in the existing
   tests. Assert record contents and completion/deletion state on the receiving
   device, then reload and assert again. A green sync-status message alone does
   not prove convergence. Check that manual to-dos leave expense balances unchanged.
5. Control races deterministically. Use request interception, held responses,
   promises, and the existing Playwright clock patterns rather than arbitrary
   delays. Always release held requests and close contexts in `finally`.
   Keep the expense and to-do endpoint distinction when selecting intercepted
   requests. Block service workers in these contexts when existing sync tests
   do so; test PWA offline reloads separately with a controlling service worker.
6. Run the relevant unit tests together, for example:

   ```powershell
   npm test -- src\db.test.ts src\todo-db.test.ts src\sync.test.ts
   ```

   Add model, derivation, importer, or backup tests only when those paths change.
   On other platforms, use the appropriate path separators.
7. For API/storage changes, start an isolated Azurite instance as described in
   [browser validation](../browser-validation/SKILL.md), then run:

   ```powershell
   $env:RUN_AZURE_TESTS = "1"
   npm test -- tests\api.integration.test.ts
   ```

   Restore the previous environment value afterward. Without this flag the
   integration suite is skipped; a skipped run is not integration evidence.
8. Run the affected two-device/offline browser regressions using the
   [browser validation procedure](../browser-validation/SKILL.md). Build before
   running the production preview. Run `npm run build:api` if backend code changes,
   and lint the changes using the repository's existing tooling.

## Completion

Report the reproduced sequence, the exact state asserted on both devices, test
commands/results, and any missing coverage. Confirm pending writes are delivered
or deliberately retained as conflicts, and that tombstones and accounting remain
intact. Clean up only task-owned processes, scratch data, and browser contexts.
