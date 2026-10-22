# Synchronization and deployment

## Data flow and correctness

Each device stores its ledger and pending mutations in IndexedDB. Saving is transactional and does not wait for a server; queued changes sync after saves, when connectivity returns, on foreground/focus, and periodically while the app is visible. The service worker caches the app shell for offline reloads.

The API stores versioned records and an ordered change log in Azure Table Storage. Writes use stable operation IDs and expected revisions; atomic commits record the mutation, its change-log entry, and an operation receipt. Retried writes do not duplicate an expense. Clients pull changes by sequence rather than client timestamps. Pending local edits are preserved; stale writes become explicit conflicts instead of silently replacing either side. Deletions are versioned tombstones.

Expenses and manual to-dos have separate IndexedDB stores, outboxes, cursors, and change streams. Insurance reminders are derived from health and pharmacy expenses, and their submitted state is part of the expense. Manual household to-dos never affect expenses or balances. Money is stored and calculated as integer EUR cents.

Devices converge when reopened and connected; there is no promise of background sync or push delivery while Android suspends the app. Both household members can edit shared records. This is not end-to-end encrypted storage, and browser storage can be evicted. Download backups before clearing site data or changing devices.

## Azure resources

[`infra/main.bicep`](../infra/main.bicep) describes an Azure Static Web App (Free) and an Azure Storage account using Standard LRS Table Storage. The frontend and managed Functions API share an HTTPS origin; Table Storage holds household entries, ordered changes, operation receipts, and server-side device sessions. Local-only use does not require Azure.

Storage replication is not protection from accidental deletion. Keep JSON backups separately. Do not prune change logs without a coordinated snapshot and cursor migration for all devices. Table Storage and API operations can incur costs; check current regional pricing and set budget alerts. Alerts are not spending caps.

## Deployment

Resources are not provisioned automatically. Deploy the Bicep template to a resource group, providing the two member names and tokens, a stable household ID, and globally unique resource names. Token parameters are secure; never commit tokens or deployment parameter files.

1. Generate two independent tokens with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store them in a password manager.
2. Deploy [`infra/main.bicep`](../infra/main.bicep) to the intended resource group.
3. Add the Static Web App deployment token—not either member token—as the GitHub `production` environment secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
4. Push or merge to `main` to run [Deploy to Azure](../.github/workflows/deploy.yml), or start the workflow manually from the intended branch.
5. Open the HTTPS app URL, sign in with the matching member token on each device, import once, and confirm both devices show the shared balance.

For an existing Static Web App, configure `MEMBER_A_TOKEN` and `MEMBER_B_TOKEN` with the generated values and keep `LOCAL_DEVELOPMENT=false`. A custom domain must use the exact HTTPS origin in `APP_ORIGIN` (no trailing slash); the API and frontend must share that origin.

Member tokens act like passwords: anyone holding one can access the household. In production, sign-in exchanges the reusable token for a server-side session in an HttpOnly, Secure, SameSite cookie that lasts 400 days. The token itself is not stored in browser storage. Rotate tokens through Azure settings to revoke existing sessions. Signing out revokes the server session but deliberately keeps the device's local ledger.

Some Android Chrome installs have dropped the session cookie while keeping IndexedDB. Sign-in therefore also returns the session value as a device key, stored in a separate IndexedDB table (never included in backups). When `/api/me` returns 401, the app exchanges that key for a fresh cookie via `POST /api/auth/resume`. The key is the same server session: signing out (which sends the key, so it works even without a cookie) or rotating the member token revokes it. Unlike the HttpOnly cookie, scripts running on the Splitty origin can read the key, so keep the app free of third-party scripts and use trusted devices.

References: [Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/overview), [Table Storage](https://learn.microsoft.com/azure/storage/tables/table-storage-overview), and [Storage concurrency](https://learn.microsoft.com/azure/storage/common/storage-concurrency).
