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
4. Check listeners before starting services. Defaults are frontend `5173`, API
   `7071`, and Azurite Table Storage `10002`. Start an isolated table emulator using
   the README command and a task-owned scratch directory. Confirm it responds
   over HTTP; an Azurite response such as `400` still proves the listener is up.
   Playwright starts and stops its own frontend/API with synthetic member tokens
   and a unique household. Do not supply production credentials or real exports.
5. If a port is occupied, identify its owner. Never kill or reuse an unknown
   process, and do not set `reuseExistingServer: true` merely to bypass the check.
   If only the frontend port is occupied:
   - Pick a free loopback port and create a temporary config next to the existing
     config, importing it and spreading the original configuration into one object.
   - Replace `use.baseURL`, the preview command's `--port`, its readiness URL, and
     the API server environment's `APP_ORIGIN` together. Preserve the remaining
     settings, synthetic household, strict port check, and server lifecycle.
   - Replace the `webServer` array explicitly. Do not use multi-argument
     `defineConfig(original, overrides)` for this: it can append server arrays.
   - Leave the API target consistent with [Vite's proxy](../../../vite.config.ts).
     The development API binds to `7071` and the emulator defaults to `10002`;
     changing only the frontend port cannot solve a collision on either.
     If these ports are unavailable, report the blocker rather than touching
     another process or silently testing an unrelated server.
6. Run filename selectors from the repository root, for example:

   ```powershell
   npm run test:e2e -- mobile.spec.ts manual-todos.spec.ts todos.spec.ts
   ```

   For an isolated config, add `--config <temporary-config-name>` after `--`.
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
   For storage or sync changes, also follow
   [offline-sync validation](../offline-sync-validation/SKILL.md).
9. On failure, inspect the assertion, error context, and retained trace. Fix the
   behavior or incorrect test assumption; do not weaken the assertion to make
   the test pass. Rerun the failing selectors, then the affected spec set.

## Completion

- Report exact commands, passed/failed counts, viewports and interaction types
  covered, and any skipped or blocked checks.
- Stop only processes started for this task, using their recorded handles/PIDs.
  Playwright owns its preview/API processes; do not start competing copies.
- Remove temporary configs and task-owned emulator data after stopping the
  emulator. Never clear an existing user's browser storage or broad directories.
- Do not claim success until the regression passes against the rebuilt app.
