[![Deploy to Azure](https://github.com/jetzlstorfer/splitty/actions/workflows/deploy.yml/badge.svg)](https://github.com/jetzlstorfer/splitty/actions/workflows/deploy.yml)

# Splitty

A private, Android-first expense ledger for two people. Install it as a PWA, enter
an amount in EUR, and split equally by default. It works locally without an
account; reusable member tokens enable shared history across your devices.

## What is implemented

- Mobile expense entry, payer selection, 50/50, exact amounts, percentages, and
  100% on-behalf splits. For odd-cent equal splits, the payer takes the extra cent.
- Shared running balance, settlements, search, editing and deletion.
- IndexedDB persistence and a transactional outbox: saving never waits for a server.
- An installable app shell, offline reloads, and explicit prompts for app updates.
- German by default, with a persistent **Einstellungen > App-Sprache** switch to
  English. Dates, amounts, messages, accessible labels, and sign-in text follow
  the selected language. Language is a device preference, not a shared household setting.
- Live category icons while entering descriptions and throughout the expense list,
  with an optional manual category override.
- Reviewed German/English Splitwise CSV import for two-person EUR groups, with
  cent-exact accounting, duplicate prevention and final-balance reconciliation.
- A **To-dos** tab with a "Bei Versicherung einreichen" (submit to insurance) item
  for every doctor (Arzt) or pharmacy (Apotheke) expense. The submitted state is
  stored on the expense itself, so it syncs across devices for the whole household.
- Manual household to-dos alongside the automatic insurance items. Use **To-dos >
  Add to-do** to enter a required title (up to 200 characters) and optional plain-text
  description (up to 2,000 characters). Either member can edit, complete, reopen,
  or delete them; changes save offline and sync using the same household sign-in.
  Manual to-dos never affect expenses, balances, search, or statistics.
- JSON backups of expenses and manual to-dos, and restoration of missing records
  without overwriting local history or resurrecting locally deleted items.
  New backups use `splitty-v2`; the app also restores older `splitty-v1` expense-only
  backups. Update older app installations before restoring a new-format backup.
- Optional on-device receipt OCR for German/English photos, with reviewed expense
  suggestions and a separately downloaded offline scanner.
- Azure Functions/Table Storage sync, reusable member tokens, two-person
  access control, and explicit conflict resolution.

This is an independent implementation, not affiliated with Splitwise. No branding,
screenshots, or proprietary assets are copied.

The mobile UI uses a Splitwise-inspired teal palette, green credit/orange debt
indicators, and a compact balance summary and ledger. The bottom navigation is
**Ausgaben / Expenses**, **To-dos**, **Suche / Search**, **Statistik / Statistics**,
**Einstellungen / Settings**.
Search and Splitwise import live on **Suche / Search**; search filters never hide
entries on the main expense page. The floating add-expense button appears only on
**Ausgaben / Expenses**, leaving search and settings unobstructed. Light and dark
themes share the same visual language. The original app icon is a heart containing
a euro symbol, used consistently in the app, favicon, and Android install icons.

### Expense categories

Detection runs entirely on the device and recognizes both German and English,
regardless of the selected interface language. It ignores case and handles umlauts
and common transliterations. Terms match whole words or phrases, so `spar` does
not match `spare parts` and `uni` does not match `university`.
Common German compounds (such as `Stromrechnung`, `Kindergartenbeitrag` and
`Tierarztrechnung`) are recognized explicitly rather than guessing from arbitrary
substrings. Specific phrases such as `car insurance`, `Handy kaufen` and
`Amazon Prime` take precedence over generic words.

| Category | Examples |
| --- | --- |
| Groceries / Lebensmittel | Billa, Hofer, Spar, Interspar, Uni, Unimarkt, Lidl, groceries |
| Fuel / Tanken | Tanken, Tankstelle, Benzin, Diesel, OMV, petrol, gas station |
| Cleaning / Reinigung | Putzfrau, Putzhilfe, Reinigung, cleaning lady |
| Hairdresser / Friseur | Friseur, Frisör, hairdresser, haircut, barber |
| Pharmacy / Apotheke | Apotheke, Medikamente, pharmacy, medication |
| Restaurant / Essen | Essen, Mittagessen, Abendessen, Gasthaus, restaurant, dinner |
| Sport / Sport | Hallenbad, Freibad, Schwimmkurs, Fitnessstudio, Skipass, Kletterhalle, gym, swimming pool |

Additional categories cover restaurants, coffee, transport, parking, cars, home,
utilities, phone/internet, shopping, health, pets, entertainment, travel, gifts,
insurance, and education. Unknown descriptions use a general receipt icon.
`Gasrechnung` and `gas bill` mean utilities, not car fuel.
German/Austrian retailers, public transport passes, household bills, childcare,
medical visits and leisure activities are also covered. Ambiguous descriptions
such as `Ticket`, `Eintritt` or `Mitgliedsbeitrag` remain General unless a more
specific term or a manual category is provided.

Automatic categories update when a description changes. Manual selections stay
fixed, including an explicit General selection. Imported expenses retain their
original category and accounting data; icons use a recognized source category first,
or infer one from the description for general/unknown source categories.
Payments always use the payment icon. Changing language does not translate or
rewrite personal expense descriptions, names, imported data, or import IDs.
Detection improvements apply immediately to existing automatic expenses and
general/unknown imports, including synced history, without rewriting stored data.
Explicit manual and recognized imported categories remain unchanged; an imported
`Sport` category is recognized in either interface language.

### Local receipt scanning

In a **new expense**, choose **Beleg scannen (optional) / Scan receipt (optional)**,
then **Scanner herunterladen / Download scanner**. The optional download is about
16 MB, hosted with Splitty rather than a third-party OCR service. It includes the
Tesseract.js WebAssembly runtime and German/English language data. Manual entry
does not download these assets and does not depend on the scanner.

Take a photo with the Android camera picker or choose a JPEG, PNG, or WebP image
under 20 MB. Use a sharp, upright photo cropped around the receipt. Processing
runs locally in a cancellable worker; keep the app open while scanning. Large
photos are resized before recognition. Speed and accuracy depend on the phone,
receipt layout, print quality, and lighting; this is best-effort autofill, not
reliable financial document understanding.

Review the suggested merchant, date, total, currency, and any warnings. **Use
suggestions** copies identified fields into the editable expense form; fields
without a suggestion keep their existing value. Payer and split are unchanged.
Review/correct the form and explicitly **Save** it. Scanning, retrying, cancelling,
closing the form, or applying suggestions never creates an expense on its own.
Low-confidence text and ambiguous totals/dates are left for manual entry.
Recognized text is available for inspection while the form is open.

The ledger remains EUR-only. A detected foreign or mixed currency never fills
the amount; enter a converted EUR amount manually. If no currency is recognized,
confirm that the receipt is in EUR before applying its total. No exchange rates
or automatic currency conversion are provided.

After the scanner download and app service-worker activation, scanning works
offline, including after an offline reload. The OCR assets use a separate cache
and are excluded from the normal app-shell download. Clearing or evicting browser
storage requires another download. Offline behavior requires a production build;
the Vite development server is for online development. If downloading or scanning
fails, an error is shown and manual entry remains available.

Splitty never uploads or persists receipt photos or OCR text, and provides no
receipt-image sharing or retrieval endpoint. The camera/gallery may retain its
own original photo outside Splitty. Only the confirmed expense fields enter the
existing household sync and backups. There is no cloud OCR fallback, OCR API key,
per-scan OCR charge, or added receipt storage; normal static hosting/download
costs still apply. Use a trusted device with a screen lock, as with the ledger.

The build serves the pinned OCR packages under `receipt-ocr-v1`, including their
runtime license notices. When updating the runtime or language packages, bump
the asset/cache version in `src\receiptAssets.ts`, the service-worker route in
`vite.config.ts`, and the fallback exclusion in `public\staticwebapp.config.json`
together so cached assets cannot mix incompatible versions.

## Run locally

Use Node.js 22.13+ (22 LTS) or Node.js 24+ and npm. From the repository root:

```powershell
npm ci
npm ci --prefix api
npm run dev
```

Both lockfiles omit registry tarball URLs while retaining pinned versions and
integrity hashes. Installs use the registry configured for the environment rather
than a Microsoft feed URL captured on another machine. The root and API `.npmrc`
files preserve this behavior when updating dependencies.

### Approved Microsoft npm registry

When the approved Microsoft proxy is required, run this from the repository root
instead of the two `npm ci` commands:

```powershell
npm run setup:approved
```

This dependency-free setup command works in local Windows, macOS, and Linux
terminals, Copilot agent sessions, and GitHub Actions. It selects
`https://packagefeedproxy.microsoft.io/npm/` and enables TLS certificate verification
for every nested npm command, without changing your saved npm configuration or
the lockfiles. It prints the registry, requests TypeScript package metadata with
bounded retries/timeouts, then installs the frontend and API dependencies in order.
Any failure stops setup and preserves npm's diagnostic output. The proxy returns
404 for `npm ping`'s `/-/ping` endpoint, so that endpoint is not a usable health check.
`npm run setup:dependencies` runs the same steps against your current registry.

Copilot's `.github/workflows/copilot-setup-steps.yml` invokes `npm run setup:approved`
before cloud-agent sessions once merged into the default branch. The same workflow
runs in GitHub Actions when its setup or dependency configuration changes, and can
be run manually from the Actions tab after merging. Other workflows can opt in by
using `run: npm run setup:approved` after checkout and Node.js setup. Normal Check
and Deploy workflows keep their existing registry selection. Local Copilot
App/CLI sessions do not run the cloud setup workflow; use the command above there.

The registry selection lasts for the setup command and its child processes only.
For subsequent npm commands in cloud-agent sessions, configure
`npm_config_registry=https://packagefeedproxy.microsoft.io/npm/` and
`npm_config_strict_ssl=true` under the repository's
**Settings → Secrets and variables → Agents → Variables**.
GitHub has migrated the old `copilot` environment variables to
[Agents secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables).
For other Actions steps, set those variables in the workflow's `env`. Locally, set
them for the current terminal session (PowerShell example):

```powershell
$env:npm_config_registry = "https://packagefeedproxy.microsoft.io/npm/"
$env:npm_config_strict_ssl = "true"
```

If setup reports `ENOTFOUND` or a DNS lookup failure, the environment administrator
must restore DNS/network access to `packagefeedproxy.microsoft.io`. For HTTPS
failures, inspect the npm error and check outbound access, proxy availability,
and trusted certificates. If access is blocked only during agent execution,
check the Copilot firewall allowlist for the approved registry host. A setup
workflow cannot fix unavailable DNS or network infrastructure: do not substitute
an unapproved registry or disable TLS/integrity checks. Copilot may still start
after setup fails, with dependencies missing; restore connectivity and rerun both
installs with `npm run setup:approved` before validation. `ERR_MODULE_NOT_FOUND`
can be a consequence of an incomplete install, but check which package is missing.
For intermittent `ECONNRESET` errors during package downloads, retry with fewer
concurrent connections: `npm --maxsockets=5 run setup:approved`. Windows `EBUSY` or
`EPERM` errors instead indicate local file access problems; close processes using
the affected dependency files before retrying.

### Start the app

Open `http://127.0.0.1:5173`. The frontend works on its own; until the API is running,
sync is unavailable and entries remain on that browser. Service-worker/offline
reload behavior is enabled in production builds, not the Vite development server.

For local sign-in and sync, copy `api\local.settings.example.json` to
`api\local.settings.json`, replace both example member tokens with random values,
configure the two names, and run these in separate terminals. Generate a token
with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
and repeat the command for the second member:

```powershell
# Terminal 1: local Azure Table Storage emulator; use an ignored directory.
.\api\node_modules\.bin\azurite-table.cmd --silent --skipApiVersionCheck --location .\.azure\azurite

# Terminal 2: API; reads api\local.settings.json, listening on loopback only.
npm --prefix api run dev

# Terminal 3: frontend with its same-origin API proxy.
npm run dev
```

The two tokens are independent 256-bit credentials. Keep them private and send
each member only their own token. The local example values are placeholders, not
secure credentials. Local development mode is rejected for non-loopback origins,
production Node environments, and Azure-hosted instances. No sign-in token is logged.

To exercise the installable production build locally, build and preview:

```powershell
npm run build
npm run preview -- --port 5173
```

Stop the development server before previewing on the same port. Keep the local
API running if testing sync. Install on Android from Chrome's **Install app** menu.
A physical phone needs an HTTPS deployment (or a separately configured HTTPS local
development environment); a PC's loopback URL is not reachable from the phone.

## Import your Splitwise history

1. Configure the two names under Settings, or sign in to use the backend names.
   Keep person A/B consistent on every device and in the backend configuration.
2. Open **Suche / Search > Importieren / Import** and choose the group CSV. Map the export column for the first
   person; the other column maps to the second person.
3. Preview the entry count, skipped duplicates and resulting file balance.
4. Confirm only after comparing with Splitwise. A malformed row, unsupported
   currency, inconsistent contribution or mismatched summary blocks the whole import.

The supplied export has a final `Gesamtbilanz` row, which is checked, not imported.
The CSV's member columns are **signed balance changes**, not original expense
shares. Splitty preserves them exactly, including payments, refunds and rounding.
It intentionally does not invent missing payer/split information. Imported
descriptions and dates can be edited; changing their financial allocation requires
deleting the original and creating an explicit replacement.

Import IDs hash normalized source rows with occurrence numbers. Re-importing the
same full export is safe, while genuine identical rows remain separate. For
partially overlapping exports that contain indistinguishable duplicate rows, the
CSV cannot prove which occurrence is which; use complete exports for repeat imports.
Changing source descriptions/categories or person names can change import IDs.
Deleted imported entries remain tombstones, so re-importing does not resurrect them.

**Private exports and local credentials are ignored by Git.** Do not commit the
`splitwise-data` directory, CSVs, backups or `local.settings.json`. Export previews
are processed locally; confirmed entries are sent only to your configured backend.

## Azure architecture

```text
Android / another device
  React PWA + cached app shell
  IndexedDB ledger + durable pending changes
                 |
       HTTPS, same-origin JSON API
                 |
Azure Static Web Apps (Free)
  static frontend + managed Azure Functions API
                 |
Azure Storage / Table Storage (Standard LRS)
  household entries, ordered changes, operation receipts
  server-side device sessions
```

Azure is not necessary for local-only use, but automatic sharing requires a shared
backend somewhere. This setup avoids an always-on server and database. Static Web
Apps Free includes managed API hosting; Table Storage charges for storage and
operations. For two people this is
intended to be a very small pay-as-you-go workload, not a guaranteed free service.
Verify current regional pricing and set budget alerts. Alerts are not spending caps.
Cold starts can delay sync/sign-in, but not expense entry, which always saves locally.
No receipt/blob storage, SQL database or Cosmos DB is needed for this first version.

### Synchronization and correctness

- Mutations have stable operation IDs and expected per-entry revisions.
- Every server write atomically commits the entry, a sequence-numbered change,
  an operation receipt and a conditional update of the household sequence.
- Retrying an acknowledged write does not create a second expense. Replays return
  the latest entry, so a lost acknowledgement cannot revert newer remote edits.
- Pulls page through an ordered durable change log, not client timestamps.
- Pending local edits are never replaced by a pull. Stale writes become conflicts;
  the app preserves both versions until you explicitly choose one.
- Deletion is a versioned tombstone. Settlements are ledger changes, not another
  shared purchase. Amounts and balances use integer cents.
- Manual to-dos use their own IndexedDB stores, outbox, cursor, and `/api/todo-sync`
  change stream. The existing Azure table and household access control are reused;
  separate row-key prefixes keep the expense stream compatible with older clients.
  Conflicting manual edits are shown on **To-dos**, with both versions and an
  explicit choice of which to keep. Automatic insurance items remain expense-backed.
- Sync runs after saves, on reconnect/foreground or window focus, and every minute
  while visible. Saves during an active sync schedule another pass immediately
  afterward, so checking off several to-dos does not leave later changes waiting
  for the next periodic sync. Completed and reopened to-dos sync for the household,
  including devices signed in with the same member token.
  There is no promise of background execution or push delivery while Android has
  suspended the app. Both devices converge when opened and connected.

Browser storage can be evicted or cleared. Offline use starts after the first
successful online load and service-worker activation. Download backups regularly,
and sync before clearing site data or replacing a device. Signing out revokes the
server session but deliberately does not erase the local ledger; use trusted
devices with OS screen locks. This is not end-to-end encrypted storage.

### Deploy

No resources are provisioned automatically. `infra\main.bicep` describes a Free
Static Web App and a Standard LRS storage account, with the API application settings.

1. Generate two random member tokens with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
   Store them in a password manager and distribute each only to its member.
2. Deploy `infra\main.bicep` into your chosen resource group, providing the two
   names/tokens, stable household ID and globally unique resource names. The Bicep
   token parameters are secure; never commit token values or deployment parameter files.
3. Add the Static Web App deployment token as the GitHub environment secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN` in the `production` environment. This is the
   deployment token from the Azure Static Web App, not either member's sign-in
   token. The workflow checks that it is configured before installing dependencies.
4. Merge or push to `main` to run **Deploy to Azure** automatically. You can also
   run the workflow manually from your intended branch. Production deployments
   share one concurrency group, so automatic and manual runs cannot deploy in
   parallel; an active deployment is allowed to finish.
5. Open the resulting HTTPS URL, sign in with the matching member token on each
   device, import once, and verify both devices show the same balance.

For an existing Static Web App, add or replace `MEMBER_A_TOKEN` and
`MEMBER_B_TOKEN` under **Configuration** with the same generated values, remove
the old email-related settings, and deploy the updated app/API.

For a custom domain, set `APP_ORIGIN` to that exact HTTPS origin, without a trailing
slash. The frontend and API must share that origin. Keep `LOCAL_DEVELOPMENT=false`.
The API's table connection setting is separate from Functions' runtime storage.
Both members are trusted household editors; neither can access another household.
Do not repoint an existing device to a different household without first backing
up and clearing that site's local data.

Each member has a reusable 256-bit token that does not expire. The server keeps
these tokens in backend settings and never stores them in browser storage; signing
in exchanges one for a server-side session using an HttpOnly, Secure, SameSite
cookie in production with no expiry. A device stays signed in until it signs out
or that member token is rotated. The session stores the member-token digest, so
replacing a member token revokes that member's existing sessions. Treat tokens
like passwords: anyone who has one can access the shared ledger. Rotate storage
and member tokens through Azure settings, never through client code.

Table Storage LRS is replication, not protection against accidental deletion.
Retain JSON backups separately and back up the table account, including change
logs/operation receipts. Do not prune the change log without a coordinated
snapshot-and-cursor migration for all devices.

References: [Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/overview),
[Table Storage](https://learn.microsoft.com/azure/storage/tables/table-storage-overview),
[Storage concurrency](https://learn.microsoft.com/azure/storage/common/storage-concurrency),

## Checks

```powershell
npm run lint        # ESLint for frontend, API, shared code, tests, and configuration
npm run lint:fix    # Apply available safe autofixes; remaining issues still fail
npm test
npm run build
npm run build:api

# With the local table emulator running:
$env:RUN_AZURE_TESTS = "1"
npm test -- tests\api.integration.test.ts

# Optional: reconcile a real export locally, without committing it:
$env:SPLITWISE_EXPORT = "C:\path\to\export.csv"
npm test -- src\importer.test.ts

# With the emulator running and frontend built; ports 5173/7071 must be free:
npx playwright install chromium
npm run test:e2e
```

ESLint uses the recommended JavaScript, TypeScript, and React Hooks rules,
including dependency-array checks. Warnings fail the command, and generated
output, dependencies, test reports, and private imports are excluded. Both CI
and the deployment workflow run lint before tests and builds. TypeScript
type-checking remains part of `build` and `build:api`; lint does not replace it.

The optional private-export check targets the original supplied 3,001-entry EUR
export (including 15 payments). Ordinary tests use synthetic data. CI runs the
synthetic checks, production builds, storage-backed integration tests, and mobile
browser checks including offline reloads and two-device synchronization. Browser
tests use a fresh synthetic household and launch/stop their own frontend/API.
Receipt browser checks use generated, non-personal receipt images and the real
local OCR engine. They cover editable suggestions, currency safeguards, retries,
cancellation, download failures, and scanning again after an offline reload.

Dependabot checks frontend and API npm dependencies and GitHub Actions weekly.
Its configuration is in [.github/dependabot.yml](.github/dependabot.yml).

Multiple currencies, multi-person groups, push
notifications and recurring-expense automation are outside the initial scope.
