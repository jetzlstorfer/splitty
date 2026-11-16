---
name: browser-validation
description: 'Validate Splitty UI changes with Playwright and the production PWA. Use for browser testing, mobile or responsive layouts, row hover, swipe and touch gestures, checkbox or keyboard interactions, dialogs, and service-worker offline reloads. Covers isolated Azurite setup, occupied ports, focused tests, and cleanup.'
---

# Browser validation

## Goal

Verify the requested interaction in a real browser without disturbing another
developer's servers, credentials, or saved household data.

## Procedure

1. Read the relevant components, styles, and existing browser tests before adding
   coverage. Consult the [run/setup documentation](../../../README.md#run-locally),
   [checks](../../../README.md#checks), [Playwright configuration](../../../playwright.config.ts),
   and [CI setup](../../workflows/check.yml) for current commands and requirements.
   Reuse installed dependencies; restore them only if a check reports they are
   missing, following the documented registry policy.
2. Choose the smallest existing spec set covering the behavior. Add a regression
   test for the actual requirement, not just a screenshot or absence of errors.
   For example, full-row hover should cover both content and the three-dot menu;
   row alignment should compare bounding boxes rather than approximate appearance.
3. Run `npm run build` before Playwright. Browser tests use the production preview,
   not the Vite development server; service-worker offline reloads depend on the
   production build. Rebuild after app changes before rerunning browser tests.
4. Import `test` and `expect` from [the browser fixtures](../../../tests/e2e/fixtures.ts).
   They start private worker-owned Table emulators and production previews on
   available loopback ports, serving the real API handler. Each test receives a
   fresh synthetic household. No manual servers, fixed ports, local settings, or
   production credentials are needed; never reuse an unknown listener.
   For exploratory checks of populated screens, `npm run dev:seeded -- --reset
   --port <free port>` serves a synthetic household with expenses, insurance
   reminders, and manual to-dos (see [development](../../../docs/development.md#seeded-local-session)).
   It uses the Vite development server, so it does not replace browser tests or
   service-worker checks. Stop it when finished.
5. Reuse installed Chromium and WebKit browsers. Install a missing browser only
   after a validation command reports it absent. Chromium runs the main suite;
   WebKit runs the focused mobile/PWA and themed-control specs. Use `--project=chromium` or
   `--project=webkit` to select one. Run `npm run check:e2e` after editing tests or
   fixtures. Preserve fixture ownership and teardown when adding contexts.
6. Run filename selectors from the repository root, for example:

   ```powershell
   npm run test:e2e -- mobile.spec.ts manual-todos.spec.ts todos.spec.ts
   ```

   Playwright selectors are regular expressions: use filename selectors instead
   of unescaped Windows backslash paths. Run relevant unit tests and lint when
   code changes require them; avoid rerunning unrelated suites.
7. Exercise the behavior shifts relevant to the task:
   - Mouse click, hover over the row and its menu, short drag, horizontal swipe
     in both directions, vertical movement, and outside-click dismissal.
   - Real touch input for swipe changes, including `touchCancel`; mouse dragging
     alone does not validate touch capture. Ignore bubbled capture-loss events
     from children when diagnosing implicit touch-capture handoffs.
   - Checkbox state must not change during swipes or when merely closing actions.
     Normal label clicks and keyboard checkbox activation must still work.
   - Keyboard-only menu opening, Tab navigation, Escape dismissal, focus
     restoration, and inaccessible hidden actions.
   - Relevant narrow/wide viewports and both themes. For shared list layout,
     use `320`, `393`, and `1280` pixel widths and check horizontal overflow.
     Wait for state updates and CSS transitions using assertions, not fixed sleeps.
8. For offline reloads, wait for `navigator.serviceWorker.ready`, reload, and
   verify that a service worker controls the page before disconnecting.
   For persistent Chromium contexts, use a short OS temporary profile path;
   deeply nested test-result paths can break CacheStorage on Windows. Close the
   context before deleting its task-owned profile.
   For storage or sync changes, also follow
   [offline-sync validation](../offline-sync-validation/SKILL.md).
9. On failure, inspect the assertion, error context, and retained trace. Fix the
   behavior or incorrect test assumption; do not weaken the assertion to make
   the test pass. Rerun the failing selectors, then the affected spec set.

## Completion

- Report exact commands, passed/failed counts, viewports and interaction types
  covered, and any skipped or blocked checks.
- Fixtures own emulator/preview lifecycle, per-test household deletion, and
  scratch cleanup. Investigate teardown failures rather than hiding them.
  Stop only task-owned leftover processes by recorded handle/PID. Never clear an
  existing user's browser storage or broad directories.
- Do not claim success until the regression passes against the rebuilt app.
