# Development

## Requirements and install

Use Node.js 22.13+ (22 LTS) or 24+ and npm. From the repository root:

```powershell
npm ci
npm ci --prefix api
```

The lockfiles pin package versions and integrity hashes but omit registry tarball URLs, so npm uses the registry configured for the environment. If the approved Microsoft proxy is required, use `npm run setup:approved`; this selects `https://packagefeedproxy.microsoft.io/npm/` for that command without changing saved npm settings or lockfiles. `npm run setup:dependencies` uses the current npm registry.

## Local app and sync

Run `npm run dev` and open <http://127.0.0.1:5173> for local-only use. To test sign-in and sync, copy `api\local.settings.example.json` to `api\local.settings.json`, configure two independent member tokens and names, then start these processes in separate terminals:

```powershell
# Local Azure Table Storage emulator; keep its data in the ignored .azure folder.
.\api\node_modules\.bin\azurite-table.cmd --silent --skipApiVersionCheck --location .\.azure\azurite

# API and frontend
npm --prefix api run dev
npm run dev
```

Generate a token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and repeat it for the second member. These are credentials: keep them private and share each only with its member. Local development mode is restricted to loopback addresses. Never commit `local.settings.json`, CSV exports, or backups.

To check the installable production app shell locally:

```powershell
npm run build
npm run preview -- --port 5173
```

The service worker and offline reload behavior are enabled in production builds, not in the Vite development server. A phone needs an HTTPS deployment to install or reach the app; a computer's loopback address is not available to another device.

## Seeded local session

For manual testing or agent sessions with realistic data, start a self-contained stack with a synthetic household:

```powershell
npm run dev:seeded
npm run dev:seeded -- --reset --port 5180
```

This starts a private Table emulator, the real API handler, and the Vite development server at <http://127.0.0.1:5174> by default. The first run seeds Alex and Sam with expenses with equal, exact, percentage, and single-person splits, a settlement, open and completed insurance reminders, and open and completed manual to-dos. Dates are relative to the seeding day. Sign in from the cloud icon with the synthetic token `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (Alex) or `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB` (Sam); these only work on this loopback-only stack.

Data persists in the ignored `.azure\seeded` folder, so restarts keep your changes. `--reset` deletes it and seeds again; afterwards clear the browser's site data for that origin (or use a fresh profile), because a device cursor newer than the reset server is rejected. The default port keeps this data separate from `npm run dev` at port 5173. Use `--port` to run several sessions side by side. The emulator can take a minute or two to start on Windows. No `local.settings.json` is needed.

## Checks

```powershell
npm run lint
npm test
npm run check:e2e
npm run build
npm run build:api
```

The API integration suite uses the local emulator:

```powershell
$env:RUN_AZURE_TESTS = "1"
npm test -- tests\api.integration.test.ts
```

The browser suite uses the production build. Build first, then run:

```powershell
npx playwright install chromium webkit
npm run build
npm run test:e2e
```

[Browser fixtures](../tests/e2e/fixtures.ts) own a private Azurite instance and a
production preview per worker, using available loopback ports and random storage
credentials. The preview serves the real API handler over HTTP. Each test gets a
fresh synthetic household, removed on teardown; the worker's services and scratch
data are also cleaned up. Do not start browser-test servers manually or reuse
personal local settings. The separate API integration suite still needs its own
emulator.

Persistent Chromium profiles use short, task-owned OS temporary directories:
deep paths under test results can make CacheStorage fail on Windows. Close the
context before removing its profile.

Browser tests run with two workers, keeping tests within each file sequential.
Workers have separate process environments, emulators, and previews. The runner
stops scheduling tests after the first failure; another in-flight test may be
interrupted. Disable fail-fast for a full diagnostic report or select one worker
when investigating timing issues:

```powershell
npm run test:e2e -- --max-failures=0
npm run test:e2e -- --workers=1
```

Chromium owns the main regression suite. WebKit runs
[the mobile/PWA smoke tests](../tests/e2e/webkit.spec.ts) and
[the themed-control regressions](../tests/e2e/controls.spec.ts), plus
[sync action layout checks](../tests/e2e/sync-popover-layout.spec.ts), not the
Chromium-specific touch/CDP matrix. Use filename selectors and projects to focus a run:

```powershell
npm run test:e2e -- --project=chromium sync-popover.spec.ts
npm run test:e2e -- sync-popover-layout.spec.ts
npm run test:e2e -- --project=webkit
npm run test:e2e -- isolation.spec.ts persistence.spec.ts --repeat-each=2
```

Keep coverage at the narrowest useful layer:

- Category vocabulary and accounting rules belong in unit tests; browsers cover
  representative typing, manual overrides, localized rendering, and imports.
- [Popover tests](../tests/e2e/sync-popover.spec.ts) own sync controls, status,
  conflicts, keyboard access, and responsive geometry. Navigation tests own the
  logo's sync animation; polish tests own local-save feedback and logo pulses.
  Header appearance comparisons disable CSS animation and retain before/after
  crops, so incidental motion is not mistaken for backdrop blur.
  Sync action layout checks run in Chromium and mobile WebKit in German and
  English, light and dark mode, across phone widths from 320 to 440 CSS pixels
  (including the iPhone 17's 402x874 viewport), landscape, tablet, and desktop.
  They measure the full label inside button padding, preserve icon size and
  touch targets, and check overflow, manual sync, sign-out, and dismissal.
- [Mobile tests](../tests/e2e/mobile.spec.ts) own shared hover/swipe interactions.
  Manual-to-do tests retain their distinct checkbox and column geometry checks.
  To-do motion tests measure finger tracking, neighboring-row movement, drop
  settling and touch cancellation in Chromium, plus keyboard reordering and
  reduced-motion behavior across phone/desktop widths and both themes in
  Chromium and WebKit.
  Navigation density checks explicitly measure five visible expense rows at
  320x740 and six at 393x851 with both native and fallback fonts, rather than
  claiming the default viewport is 320px. Measure settled layouts rather than
  entrance-animation frames.
- [Persistence tests](../tests/e2e/persistence.spec.ts) cover shared-IndexedDB tabs,
  atomic local-write failures, and real waiting-worker activation with queued
  expense and to-do writes. The update test replaces the built service worker;
  it does not simulate compatibility between two different application bundles.
  The shared-tab test holds real final pull responses and pauses debounce timers
  so one tab can acknowledge writes after the other finishes its pass. Both
  status and queue counts must settle without another focus event or timer.
- Preserve separate expense, insurance-reminder, and manual-to-do regressions:
  they do not share all stores, queues, or completion semantics.
  Before reloading after Save, wait for the dialog to close and verify the
  transactional queues; a completed click alone does not mean a save persisted.
- [Isolation tests](../tests/e2e/isolation.spec.ts) deliberately repeat the same
  descriptions in sequential tests, proving that backend state cannot leak.

PR checks and manual deployments run lint, unit tests, E2E type-checking, frontend
and API builds, emulator-backed API tests, and both browser projects. Automatic
deployments on `main` skip browser installation and tests. For focused UI and offline
workflows, see [browser validation](../.github/skills/browser-validation/SKILL.md)
and [offline-sync validation](../.github/skills/offline-sync-validation/SKILL.md).
