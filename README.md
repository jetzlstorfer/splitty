# Splitty

A private, Android-first expense ledger for two people. Install it as a PWA, enter
an amount in EUR, and split equally by default. It works locally without an
account; email sign-in enables shared history across your devices.

## What is implemented

- Mobile expense entry, payer selection, 50/50, exact amounts, percentages, and
  100% on-behalf splits. For odd-cent equal splits, the payer takes the extra cent.
- Shared running balance, settlements, search, editing and deletion.
- IndexedDB persistence and a transactional outbox: saving never waits for a server.
- An installable app shell, offline reloads, and explicit prompts for app updates.
- German by default, with a persistent **Einstellungen > App-Sprache** switch to
  English. Dates, amounts, messages, accessible labels, and sign-in emails follow
  the selected language. Language is a device preference, not a shared household setting.
- Live category icons while entering descriptions and throughout the expense list,
  with an optional manual category override.
- Reviewed German/English Splitwise CSV import for two-person EUR groups, with
  cent-exact accounting, duplicate prevention and final-balance reconciliation.
- JSON backups and restoration of missing entries without overwriting local history.
- Azure Functions/Table Storage sync, single-use email sign-in links, two-person
  access control, and explicit conflict resolution.

This is an independent implementation, not affiliated with Splitwise. No branding,
screenshots, or proprietary assets are copied.

The mobile UI uses a Splitwise-inspired teal palette, green credit/orange debt
indicators, a compact ledger, and a floating add-expense button. Light and dark
themes share the same visual language. The original app icon is a heart containing
a euro symbol, used consistently in the app, favicon, and Android install icons.

### Expense categories

Detection runs entirely on the device and recognizes both German and English,
regardless of the selected interface language. It ignores case and handles umlauts
and common transliterations. Terms match whole words or phrases, so `spar` does
not match `spare parts` and `uni` does not match `university`.

| Category | Examples |
| --- | --- |
| Groceries / Lebensmittel | Billa, Hofer, Spar, Interspar, Uni, Unimarkt, Lidl, groceries |
| Fuel / Tanken | Tanken, Tankstelle, Benzin, Diesel, OMV, petrol, gas station |
| Cleaning / Reinigung | Putzfrau, Putzhilfe, Reinigung, cleaning lady |
| Hairdresser / Friseur | Friseur, Frisör, hairdresser, haircut, barber |
| Pharmacy / Apotheke | Apotheke, Medikamente, pharmacy, medication |
| Restaurant / Essen | Essen, Mittagessen, Abendessen, Gasthaus, restaurant, dinner |

Additional categories cover restaurants, coffee, transport, parking, cars, home,
utilities, phone/internet, shopping, health, pets, entertainment, travel, gifts,
insurance, and education. Unknown descriptions use a general receipt icon.
`Gasrechnung` and `gas bill` mean utilities, not car fuel.

Automatic categories update when a description changes. Manual selections stay
fixed, including an explicit General selection. Imported expenses retain their
original category and accounting data; icons use a recognized source category first,
or infer one from the description for general/unknown source categories.
Payments always use the payment icon. Changing language does not translate or
rewrite personal expense descriptions, names, imported data, or import IDs.

## Run locally

Use Node.js 22.13+ (22 LTS) or Node.js 24+ and npm. From the repository root:

```powershell
npm ci
npm ci --prefix api
npm run dev
```

Open `http://127.0.0.1:5173`. The frontend works on its own; until the API is running,
sync is unavailable and entries remain on that browser. Service-worker/offline
reload behavior is enabled in production builds, not the Vite development server.

For local sign-in and sync, copy `api\local.settings.example.json` to
`api\local.settings.json`, configure the two names and emails, and run these in
separate terminals:

```powershell
# Terminal 1: local Azure Table Storage emulator; use an ignored directory.
.\api\node_modules\.bin\azurite-table.cmd --silent --skipApiVersionCheck --location .\.azure\azurite

# Terminal 2: API; reads api\local.settings.json, listening on loopback only.
npm --prefix api run dev

# Terminal 3: frontend with its same-origin API proxy.
npm run dev
```

The example emails are `first@example.com` and `second@example.com`. In explicitly
enabled local mode, the sign-in form displays a development link rather than
sending email. This mode is rejected for non-loopback origins, production Node
environments, and Azure-hosted instances. No sign-in token is logged.

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
2. Select **Import** and choose the group CSV. Map the export column for the first
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
  hashed sign-in tokens and server-side sessions
                 |
Azure Communication Services Email
  sign-in links only
```

Azure is not necessary for local-only use, but automatic sharing requires a shared
backend somewhere. This setup avoids an always-on server and database. Static Web
Apps Free includes managed API hosting; Table Storage charges for storage and
operations, and Communication Services charges for email. For two people this is
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
- Sync runs after saves, on reconnect/foreground, and every minute while visible.
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

1. Create/link Azure Communication Services and an Email Communication Services
   domain. An Azure-managed domain is sufficient; obtain its allowed sender and
   the Communication Services connection string. Do not put these in Git.
2. Deploy `infra\main.bicep` into your chosen resource group, providing the two
   emails/names, stable household ID, globally unique resource names, sender and
   secret email connection string through secure deployment parameters.
3. Add the Static Web App deployment token as the GitHub environment secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN` in the `production` environment.
4. Run the **Deploy to Azure** workflow manually from your intended branch.
5. Open the resulting HTTPS URL, sign in as each person on separate devices,
   import once, and verify both devices show the same balance.

For a custom domain, set `APP_ORIGIN` to that exact HTTPS origin, without a trailing
slash. The frontend and API must share that origin. Keep `LOCAL_DEVELOPMENT=false`.
The API's table connection setting is separate from Functions' runtime storage.
Both members are trusted household editors; neither can access another household.
Do not repoint an existing device to a different household without first backing
up and clearing that site's local data.

Authentication uses random, hashed-at-rest, 15-minute single-use links. The link
token is in the URL fragment (not an HTTP URL/query) and is removed from browser
history on load. An explicit confirmation consumes the link, preventing ordinary
email preview fetches from signing a device in. Sessions last 30 days and use an
HttpOnly, Secure, SameSite cookie in production. Writes require an exact matching
Origin and JSON content type. Email requests are allowlisted and limited to one
per minute per household member. Expired auth records remain inert in Table
Storage; periodically remove expired tokens/sessions as an operational cleanup.
Rotate storage/email credentials through Azure settings, never through client code.

Table Storage LRS is replication, not protection against accidental deletion.
Retain JSON backups separately and back up the table account, including change
logs/operation receipts. Do not prune the change log without a coordinated
snapshot-and-cursor migration for all devices.

References: [Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/overview),
[Table Storage](https://learn.microsoft.com/azure/storage/tables/table-storage-overview),
[Storage concurrency](https://learn.microsoft.com/azure/storage/common/storage-concurrency),
[Communication Services Email](https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview).

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

Dependabot checks frontend and API npm dependencies and GitHub Actions weekly.
Its configuration is in [.github/dependabot.yml](.github/dependabot.yml).

The API pins Azurite's transitive `uuid` dependency to the CommonJS-compatible
11.1.1 release to address GHSA-w5hq-g745-h8pq. Remove this override once Azurite's
dependency tree selects patched versions without it. Azurite is development-only;
after changing its dependencies, run the storage-backed integration checks.

Receipt scanning/OCR is deferred; multiple currencies, multi-person groups, push
notifications and recurring-expense automation are outside the initial scope.