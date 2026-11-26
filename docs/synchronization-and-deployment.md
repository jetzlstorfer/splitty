# Synchronization and deployment

## Data flow and correctness

Each device stores its ledger and pending mutations in IndexedDB. Saving is transactional and does not wait for a server; queued changes sync after saves, when connectivity returns, on foreground/focus, and periodically while the app is visible. The service worker caches the app shell for offline reloads.

The header's cloud indicator opens the synchronization popover on every page, including while syncing or offline. It contains the current status and errors, connection state, combined expense/to-do queue count, last successful sync in the current session, sign-in/out, manual sync, and conflict resolution for both record types. A theme-aware overlay dims and softly blurs the page below the header, keeping both the header and the popover clear in both themes. The overlay and popover follow the header's actual height, including safe-area padding. No page or Settings section repeats a sync status line; a single screen-reader live region beside the indicator announces status changes even when the popover is closed. Escape, the close button, or an outside click dismisses the popover.

Sign-in validation is shown inline in the selected app language, not in a native
browser validation bubble. A successful conflict-resolution retry clears its
previous action error; unresolved conflicts and sync failures remain visible.
If another tab acknowledges the shared queued writes, a pending-only status
clears when both queues and conflict lists are empty; real sync errors are not
cleared just because the queues are empty.

The API stores versioned records and an ordered change log in Azure Table Storage. Writes use stable operation IDs and expected revisions; atomic commits record the mutation, its change-log entry, and an operation receipt. Retried writes do not duplicate an expense. Clients pull changes by sequence rather than client timestamps. Pending local edits are preserved; stale writes become explicit conflicts instead of silently replacing either side. Deletions are versioned tombstones.

Expenses and manual to-dos have separate IndexedDB stores, outboxes, cursors, and change streams. Insurance reminders are derived from health and pharmacy expenses, and their submitted state is part of the expense. Manual household to-dos never affect expenses or balances. Money is stored and calculated as integer EUR cents.

Devices converge when reopened and connected; there is no promise of background sync or push delivery while Android suspends the app. Both household members can edit shared records. This is not end-to-end encrypted storage, and browser storage can be evicted. Download backups before clearing site data or changing devices.

## Azure resources

[`infra/main.bicep`](../infra/main.bicep) describes an Azure Static Web App (Free) and an Azure Storage account using Standard LRS Table Storage. The frontend and managed Functions API share an HTTPS origin; Table Storage holds household entries, ordered changes, operation receipts, and server-side device sessions. Local-only use does not require Azure.

Storage replication is not protection from accidental deletion. Keep JSON backups separately; the optional [scheduled backup job](operations.md#scheduled-jobs) adds immutable server-side backups. Do not prune change logs without a coordinated snapshot and cursor migration for all devices. Table Storage and API operations can incur costs; check current regional pricing and set budget alerts (the template can create one, see [operations](operations.md#infrastructure)). Alerts are not spending caps.

## Deployment

Resources are not provisioned automatically. For a new environment, create the
Entra External ID application and deploy [`infra/main.bicep`](../infra/main.bicep)
with globally unique app and storage names plus its `entraAuthority`,
`entraClientId`, and secure `entraClientSecret` parameters. Never commit secrets
or deployment parameter files. Do not redeploy the template to the existing
production resource group as part of the sign-in retirement.

1. Configure the Entra External ID application and its callback at
   `https://<app-origin>/api/auth/callback`.
2. Deploy Bicep to the intended new resource group.
3. Add the Static Web App deployment token as the GitHub `production`
   environment secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
4. Push or merge to `main` to run [Deploy to Azure](../.github/workflows/deploy.yml),
   or start the workflow manually from the intended branch.
5. Keep `ALLOW_NEW_HOUSEHOLDS=false` until scheduled jobs, backups, monitoring,
   alerts, and the legal pages have been verified. Then sign in on each device,
   import existing local history once, and confirm both devices show the shared
   balance.

Both automatic and manual deployments depend on the reusable [Check workflow](../.github/workflows/check.yml), including lint, unit tests, TypeScript checks, builds, and API integration tests. Pull requests and manual deployments also install browsers and run the Playwright suite. Automatic deployments on `main` pass `run-e2e: false` to avoid repeating the PR browser suite; other callers default to running it. Direct pushes to `main` also skip browser tests, so use pull requests for changes and require the PR check before merging. If enabled checks fail or are cancelled, the deployment job is skipped.

After all enabled checks pass, the check job uploads the frontend and API build output as an artifact for that workflow run, using the repository's artifact retention policy. The deployment job downloads those same builds and installs only the API's production dependencies; it does not repeat lint, tests, or builds. Pull-request checks do not upload deployment artifacts. The Azurite integration test run remains separate because the normal unit-test run skips it.

For an existing Static Web App, configure Entra and keep `LOCAL_DEVELOPMENT=false`. A custom domain must use the exact HTTPS origin in `APP_ORIGIN` (no trailing slash); the API and frontend must share that origin.

Production sign-in creates a server-side session in an HttpOnly, Secure, SameSite cookie that lasts 400 days. Signing out or revoking household membership invalidates the server session but deliberately keeps the device's local ledger.

Some Android Chrome installs have dropped the session cookie while keeping IndexedDB. Sign-in therefore also returns the session value as a device key, stored in a separate IndexedDB table (never included in backups). When `/api/me` returns 401, the app exchanges that key for a fresh cookie via `POST /api/auth/resume`. The key is the same server session: signing out (which sends the key, so it works even without a cookie) or revoking membership invalidates it. Unlike the HttpOnly cookie, scripts running on the Splitty origin can read the key, so keep the app free of third-party scripts and use trusted devices.

References: [Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/overview), [Table Storage](https://learn.microsoft.com/azure/storage/tables/table-storage-overview), and [Storage concurrency](https://learn.microsoft.com/azure/storage/common/storage-concurrency).
