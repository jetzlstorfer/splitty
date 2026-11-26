# Operations

Scheduled jobs, monitoring, alerts and a budget exist as code and opt-in infrastructure. None of it has been
deployed or rehearsed in Azure yet, so treat the checklist below as the first deployment, not as routine upkeep.
Enable all of it before opening public sign-up; see [multi-tenant plan](multi-tenant-plan.md#operations) for the
decisions behind it.

## Scheduled jobs

[`jobs/`](../jobs) is a separate timer-triggered Azure Functions app (Node 22, Flex Consumption, system-assigned
managed identity). It is separate because Static Web Apps managed Functions are HTTP-only and have no managed
identity. It reads and writes the same `SplittyAuth` and `SplittyLedger` tables as the API, so its key formats must
stay in step with `api/src`; [`jobs.integration.test.ts`](../jobs/src/jobs.integration.test.ts) creates the data
through the real API functions to catch drift.

| Job | Time (UTC) | What it does |
| --- | --- | --- |
| `backup` | 02:00 | Writes `<date>/SplittyAuth.ndjson.gz`, `<date>/SplittyLedger.ndjson.gz` and finally `<date>/manifest.json` to the backup container. A manifest means the backup is complete. A second run on the same day leaves the existing blobs untouched. |
| `purge` | 03:00 | Permanently deletes households and accounts whose 30-day deletion grace period has ended. A household with an active member is skipped. The household tombstone is removed last, so an interrupted purge is finished by the next run. |
| `cleanup` | 04:00 | Deletes expired sign-in transactions, device-bootstrap keys and invitations, and rate-limit counters older than two days. Deletes use the row's ETag, so a row the API rewrote in the meantime is kept. |

Backups contain users, households, memberships, invitations and both ledgers. They exclude sessions, legacy
sessions, rate-limit counters and short-lived sign-in state, which are credentials or transient. Binary values are
stored as `{ "$base64": ... }`, 64-bit integers as strings and dates as ISO strings.

### Restore

There is no restore tool yet, and restore has not been rehearsed. A backup blob is gzip-compressed NDJSON with one
table entity per line. A restore tool must confirm the destination household, never grant membership from backup
metadata, and re-type the `$base64`, 64-bit integer and date values by schema before upserting. Backups of purged
data expire within the retention period, which is what makes the 60-day deletion timeline true.

### Known gaps

- A session created between the purge's session scan and its deletion can be left behind. It cannot reach purged
  data, but it is not removed until sessions get an expiry, which is not implemented.
- Member accounts of a purged household that never requested their own account deletion keep their `users` row.
- Sessions are not expired by the cleanup job.

## Infrastructure

All of this is off by default in [`infra/main.bicep`](../infra/main.bicep), so existing deployments are unchanged.

| Parameter | Default | Effect |
| --- | --- | --- |
| `enableMonitoring` | `false` | Log Analytics workspace, Application Insights, and the `APPLICATIONINSIGHTS_CONNECTION_STRING` app setting on the Static Web App. |
| `scrubTelemetry` | `true` | Workspace transformation that redacts sensitive telemetry before it is stored. |
| `logRetentionDays` | `30` | Workspace retention (30-730). |
| `logDailyQuotaGb` | `'0.2'` | Daily ingestion cap. Once reached, ingestion stops for the day, including the data the alerts depend on. |
| `enableScheduledJobs` | `false` | Flex Consumption Functions app and its runtime storage, plus the backup storage account. |
| `backupRetentionDays` | `30` | Immutability period for backups; lifecycle management deletes them one day later. |
| `backupContainerName` | `splitty-backups` | Backup container name. |
| `alertEmails` | `[]` | Alert and budget recipients. Alerts and the budget are only created when this is not empty. |
| `monthlyBudget` | `0` | Monthly resource-group budget in the billing currency. `0` disables it. Notifies at 80% actual and 100% forecast spend. |
| `budgetStartDate` | current month | First day of the budget month. Pin it when redeploying in a later month. |

Alerts are not spending caps. The budget only notifies.

The jobs app uses managed identity and no secrets. It gets **Storage Table Data Contributor** on the data account,
**Storage Blob Data Contributor** on the backup container only, and the roles the Functions runtime needs on its own
host storage. Backups live in a separate account with shared-key access disabled, because runtime blobs cannot live
in an immutable container.

`main.bicep` writes all Static Web App application settings. Redeploying it to a resource group that already hosts
production replaces settings set by hand (for example `ALLOW_NEW_HOUSEHOLDS`) and requires every existing setting as
a parameter. Review `az deployment group what-if` before deploying to an existing deployment.

## Telemetry scrubbing

The API only logs fixed messages, and `scrubLog` in [`shared/logScrub.ts`](../shared/logScrub.ts) is applied to
every logged message in the API and the jobs as defense in depth. The real exposure is telemetry the Functions host
generates: request URLs carrying `?code=&state=` during sign-in, exception messages and dependency URLs. Code cannot
see those, so the workspace transformation in
[`telemetryScrub.bicep`](../infra/modules/telemetryScrub.bicep) is the primary layer:

- request URLs and dependency data are truncated at the query string;
- trace and exception messages that contain a credential-bearing query parameter, a 43-character base64url token or an
  e-mail address are replaced as a whole.

`host.json` keeps the log level at `Warning`, with `Host.Results` at `Information` because request telemetry (and the
alerts built on it) disappears without it, and turns dependency tracking off.

## Alerts

With `enableMonitoring` and `alertEmails`, [`alerts.bicep`](../infra/modules/alerts.bicep) creates an action group and
these log alerts. Each one resolves automatically when the condition clears.

- `splitty-api-5xx`: five or more server errors in 15 minutes.
- `splitty-jobs-failed` (with jobs): a failed job run in the last hour.
- `splitty-backup-missing` (with jobs): no successful backup in 26 hours. This is a dead-man's switch, so it also
  fires until the first backup has run after a deployment.

## Enabling it

1. Deploy `infra/main.bicep` with `enableMonitoring`, `enableScheduledJobs`, `alertEmails` and `monthlyBudget`.
2. Lock the backup retention policy once the period is final. A locked policy cannot be shortened or removed:
   `az storage container immutability-policy lock --account-name <backup account> --container-name splitty-backups
   --if-match <etag>`.
3. Deploy the jobs app: set the repository variable `JOBS_FUNCTION_APP_NAME` (the `scheduledJobsAppName` deployment
   output), then run [Deploy scheduled jobs](../.github/workflows/deploy-jobs.yml). It also needs the variables
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` in the `production` environment, an Entra
   application with a federated credential for that environment, and **Website Contributor** on the Functions app.
   Until `JOBS_FUNCTION_APP_NAME` exists the workflow skips itself.
4. Verify:
   - the workspace's `defaultDataCollectionRuleResourceId` points at the scrubbing rule;
   - after signing in, an `AppRequests` query shows no `code=` or `state=` in `Url`, and `AppTraces` shows no tokens;
   - the first backup run produced a manifest, and `splitty-backup-missing` cleared;
   - an alert test notification reaches every recipient.

## Not verified

These templates compile with `az bicep build` but were never deployed. Check these when first deploying:

- the workspace is created twice (once without and once with the scrubbing rule), because the workspace and the rule
  reference each other. A redeploy briefly unlinks and relinks the rule;
- whether `extend` in a workspace transformation overwrites an existing column as the rule assumes;
- the name of the application setting Static Web Apps reads for Application Insights;
- the budget's `startDate` behavior on redeploys;
- the Flex Consumption `maximumInstanceCount` and the Azure login and deploy steps of the jobs workflow.

## Deferred

- Retiring the legacy member-token path, once the migration is finished.
- Session expiry and the matching cleanup.
- A `Content-Security-Policy` header in `public/staticwebapp.config.json`.
- A restore tool and a restore rehearsal.
