# Operations

Operational infrastructure was first deployed on 2026-11-27: a separate jobs app and backup storage, Log Analytics,
Application Insights with ingestion-time scrubbing, three alerts, and a monthly resource-group budget of EUR 20.
SWA remains **Free**. The rollout uses the existing custom domain and ledger
storage. New households have been accepted since the same day (see [Registration](#registration)). The verification
record is below and the [open items](#open-items) are at the end; the plan has the
[operations decisions](multi-tenant-plan.md#operations).

## Registration

New households can be created while the Static Web App application setting `ALLOW_NEW_HOUSEHOLDS` is `true`.
Production has accepted them since 2026-11-27. It was opened by changing the live setting directly, without a
staging pilot (see [open items](#open-items)).

The setting is not managed by Bicep. [`main.bicep`](../infra/main.bicep) defaults `allowNewHouseholds` to `false`
and rewrites every SWA application setting, so deploying it to production would close registration and replace the
other settings. Change only this setting instead. `az staticwebapp appsettings set` merges the named setting into
the existing ones. Suppress its output with `-o none`, because it echoes every setting, including secrets, and pass
the subscription explicitly, because the default Azure CLI subscription may not be the production one:

```powershell
az staticwebapp appsettings set --name <static-web-app-name> --resource-group <resource-group> `
  --subscription <subscription> --setting-names ALLOW_NEW_HOUSEHOLDS=false -o none
```

Use `ALLOW_NEW_HOUSEHOLDS=true` to reopen. The change takes effect within seconds. Confirm it without signing in;
the response reports `newHouseholdsEnabled`:

```powershell
Invoke-RestMethod https://<app-origin>/api/auth/config
```

- Only the values `true` and `false` are valid. Any other non-empty value makes the API answer 503
  `ALLOW_NEW_HOUSEHOLDS must be true or false.`; an empty value means `false` on a hosted deployment.
- While `true`, any account that signs in with a supported provider can create a household. The limits still apply:
  3 new households per user per 30 days, 20 sign-in or session-recovery attempts per IP address per minute, and the
  per-household quotas in the [plan](multi-tenant-plan.md#operations). The plan relies on Entra's email verification
  as the initial protection against automated sign-ups.
- While `false`, an account with no household and no valid invitation gets 403
  `New household registration is currently closed.`, including a former member who left their household. Existing
  members, their sessions and valid invitations are unaffected, so pausing does not sign anyone out.
- A new deployment has no household and no invitation, so it needs `true` once for its first household.

## Scheduled jobs

[`jobs/`](../jobs) is a separate timer-triggered Azure Functions app (Node 22, Flex Consumption, system-assigned
managed identity). It is separate because Static Web Apps managed Functions are HTTP-only and have no managed
identity. It reads and writes the same `SplittyAuth` and `SplittyLedger` tables as the API, so its key formats must
stay in step with `api/src`; [`jobs.integration.test.ts`](../jobs/src/jobs.integration.test.ts) creates the data
through the real API functions to catch drift.

| Job | Time (UTC) | What it does |
| --- | --- | --- |
| `backup` | 02:00 | Writes `<date>/SplittyAuth.ndjson.gz`, `<date>/SplittyLedger.ndjson.gz` and finally `<date>/manifest.json` to the backup container. A manifest means the backup is complete. A second run on the same day leaves the existing blobs untouched. |
| `purge` | 03:00 | Resumes interrupted account deletions using the remaining household membership index rows. Newly empty households inherit the account's deletion deadline; shared households keep their ledger. Accounts and households are permanently purged only after their 30-day grace period, with tombstones removed last. A household with an active member is skipped. |
| `cleanup` | 04:00 | Deletes expired sign-in transactions, device-bootstrap keys and invitations, and rate-limit counters older than two days. Deletes use the row's ETag, so a row the API rewrote in the meantime is kept. |

Household additions reserve one place on the account row using its ETag. If an API invocation stops mid-write, the next addition, sign-in, or account deletion finishes the pending operation. A receipt in the household partition keeps retries from creating another membership or consuming a second invitation. Keep these receipts and pending account fields when restoring a backup.

Backups contain users (including their household membership index), households, memberships, invitations and both ledgers. They exclude sessions, legacy
sessions, rate-limit counters and short-lived sign-in state, which are credentials or transient. Binary values are
stored as `{ "$base64": ... }`, 64-bit integers as strings and dates as ISO strings.

### Restore

There is no restore tool yet, and restore has not been rehearsed. A backup blob is gzip-compressed NDJSON with one
table entity per line. A restore tool must confirm the destination household, never grant membership from backup
metadata, and re-type the `$base64`, 64-bit integer and date values by schema before upserting. Backups of purged
data expire within the retention period, which is what makes the 60-day deletion timeline true.

**Settings → This device** in the app is a separate, client-side feature: it exports expenses and manual to-dos as JSON,
and restoring adds only the missing ones without overwriting existing data.

### Known gaps

- A session created between the purge's session scan and its deletion can be left behind. It cannot reach purged
  data, but it is not removed until sessions get an expiry, which is not implemented.
- Member accounts of a purged household that never requested their own account deletion keep their `users` row.
- Sessions are not expired by the cleanup job.

## Infrastructure

Use [`infra/operations.bicep`](../infra/operations.bicep) to add or update operations on an existing deployment.
It does not manage the Static Web App, its application settings, or the ledger storage account; it adds only a
scoped jobs identity role assignment on that account. [`infra/main.bicep`](../infra/main.bicep) calls the same
template for new deployments. Features remain opt-in in both entry points.

| Parameter | Default | Effect |
| --- | --- | --- |
| `enableMonitoring` | `false` | Log Analytics workspace and Application Insights. `main.bicep` also sets the SWA connection string; the operations-only rollout connects it separately after verifying scrubbing. |
| `scrubTelemetry` | `true` | Workspace transformation that redacts sensitive telemetry before it is stored. |
| `monitoringWorkspaceExists` | `false` | Set `true` after the workspace's first creation, including retries after partial deployments. Skips the bootstrap deployment that would temporarily unlink the scrubbing rule. |
| `logRetentionDays` | `30` | Workspace retention (30-730). |
| `logDailyQuotaGb` | `'0.2'` | Daily ingestion cap. Once reached, ingestion stops for the day, including the data the alerts depend on. |
| `enableScheduledJobs` | `false` | Flex Consumption Functions app and its runtime storage, plus the backup storage account. |
| `backupRetentionDays` | `30` | Immutability period for backups; lifecycle management deletes them one day later. |
| `backupContainerName` | `splitty-backups` | Backup container name. |
| `jobsDeploymentSubject` | `''` | Exact GitHub OIDC subject for the production environment. Creates a separate secretless deployment identity with Website Contributor on the jobs app only. |
| `alertEmails` | `[]` | Alert and budget recipients. Alerts and the budget are only created when this is not empty. |
| `monthlyBudget` | `0` | Monthly resource-group budget in the billing currency. `0` disables it. Notifies at 80% actual and 100% forecast spend. |
| `budgetStartDate` | current month | First day of the budget month. Pin it when redeploying in a later month. |

Alerts are not spending caps. The budget only notifies.

The jobs app uses managed identity and no secrets. It gets **Storage Table Data Contributor** on the data account,
**Storage Blob Data Contributor** on the backup container only, and the roles the Functions runtime needs on its own
host storage. Backups live in a separate account with shared-key access disabled, because runtime blobs cannot live
in an immutable container.

`main.bicep` still writes all Static Web App application settings. Its `appOrigin` and `allowNewHouseholds`
parameters default to the SWA hostname and `false`, so deploying it to production would close
[registration](#registration) and replace the other settings; it is not a safe patch for an existing site's settings.
Use `operations.bicep` for the operational rollout, preserve unrelated settings when connecting Insights, and
review `az deployment group what-if` before every production infrastructure change.

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

1. Confirm the subscription, resource group, existing SWA and storage account. Obtain approval for recurring costs,
   the budget amount and notification recipients. Do not change the SWA SKU, and leave `ALLOW_NEW_HOUSEHOLDS` as it
   is (see [Registration](#registration)).
2. Compile and preview `infra/operations.bicep`, then deploy it in incremental mode with the same parameters.
   Supply `enableMonitoring=true`, `enableScheduledJobs=true`, `alertEmails`, `monthlyBudget`, and a pinned
   `budgetStartDate`. Set `monitoringWorkspaceExists=true` if the workspace already exists. Keep recipient
   addresses and secret settings out of committed parameter files.
3. Check that the four telemetry tables are configured and the workspace's
   `defaultDataCollectionRuleResourceId` points at the scrubbing rule. Only then merge
   `APPLICATIONINSIGHTS_CONNECTION_STRING` into the SWA settings with `az staticwebapp appsettings set`;
   suppress its output. Compare the other settings before and after, especially `APP_ORIGIN`,
   `ALLOW_NEW_HOUSEHOLDS`, Entra credentials and storage configuration.
4. Configure the jobs deployment identity using `jobsDeploymentSubject`. Copy the exact `subject claim` from
   the `azure/login` workflow output: GitHub's immutable format includes IDs, for example
   `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:production`. Do not assume the older name-only subject.
   Set repository variable `JOBS_FUNCTION_APP_NAME` from `scheduledJobsAppName` and `JOBS_RESOURCE_GROUP` to
   the resource group containing it, and production-environment
   variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` from the deployment identity
   outputs. Run [Deploy scheduled jobs](../.github/workflows/deploy-jobs.yml). Until the app-name variable exists,
   the workflow skips itself. The deployment identity is separate from the jobs' runtime managed identity.
   The workflow checks that all three timers are registered after publishing; a successful ZIP upload alone
   does not establish that the package is usable.
5. Before manually invoking purge, audit eligible household/account deletion timestamps and active memberships.
   Run backup first; verify the two blobs and manifest, then exercise the purge and cleanup functions.
   Verify successful job request telemetry and the backup alert's query. Do not use a successful deployment
   as evidence that the timers can access storage.
6. Send synthetic request, trace, exception and dependency telemetry through the Insights ingestion endpoint;
   verify that query strings, credentials and email-shaped canaries are absent from stored values. Also verify
   real API request telemetry. Test notification delivery to the configured recipient.
7. Leave the backup retention policy **unlocked** until the retention period receives explicit final approval.
   Locking cannot be undone or shortened. When approved, use
   `az storage container immutability-policy lock --account-name <backup account> --container-name splitty-backups
   --if-match <etag>`.

## Deployment verification

The first rollout caught and corrected Azure-specific issues that local Bicep compilation did not detect:

- workspace-transformation flows must omit `outputStream`;
- the ingestion KQL parser accepts `parse_json("null")`, not the `dynamic(null)` literal used initially;
- the backup alert uses a supported two-day evaluation window with an explicit 26-hour query filter;
- built-in telemetry tables are explicitly configured for workspace transformations;
- table retention is explicitly set to the workspace retention; Application Insights otherwise defaults these
  tables to 90 days even when the workspace is configured for 30;
- GitHub's actual OIDC subject includes immutable owner/repository IDs.
- `.funcignore` must anchor `/src/` at the package root; unanchored `src` also excluded the compiled
  `dist/jobs/src` directory and produced a successful deployment with no registered timers.

Verified on 2026-11-27:

- The GitHub jobs deployment passed its checks and registered all three timers after the packaging fix.
- Manual backup, purge and cleanup invocations all produced successful request telemetry. Purge had no eligible
  households or accounts and deleted no rows; cleanup removed two expired sign-in transactions.
- The first backup's manifest and both nonempty table blobs were verified. Only the manifest and blob metadata
  were read, not the ledger backup. The temporary container-scoped reader grant used for verification was removed.
- All four synthetic telemetry types were ingested with the expected redactions; actual managed-API request
  telemetry also arrived with query strings removed. The scrub-rule link and 30-day table retention were verified.
- The EUR 20 budget is active, with 80% actual and 100% forecast notifications.

**Open: alert email delivery.** The action group and receiver are enabled, the configured address matches
the approved recipient, and all three rules point at that group. Azure recorded `ActionsTriggered` for the expected
initial `splitty-backup-missing` alert, but the recipient reported no email. Both the CLI and documented REST
test-notification endpoints returned `There are no valid receivers in the request`. Do not treat alert delivery
as working until a real notification arrives; check the recipient's filtering and Azure Monitor delivery settings,
and watch the alerts in the Azure portal in the meantime.
The first successful backup now satisfies the backup rule's query; its initial fired state can remain until Azure's
scheduled reevaluation and automatic resolution.

The backup policy remains unlocked by design, pending explicit approval to lock it. A restore tool and restore
rehearsal are still outstanding; deploying backups does not establish recoverability. See the
[open items](#open-items).

### Member-token retirement cleanup

Completed on 2026-11-27 after confirming both accounting slots had provider-backed memberships:

- removed the seven obsolete SWA settings listed in the [retirement guide](../README.md#existing-household-sign-in-retirement);
- deleted 10 legacy sessions and one `login-rate` counter (11 rows total) from the retired `auth-<household-id>`
  partition using their ETags;
- verified no legacy rows remained and the ledger and all non-legacy auth rows were unchanged;
- preserved provider sessions, memberships, `legacyClaimed` markers and the custom origin.

## Open items

Registration is open with these items unresolved:

- **Alert email delivery** is unconfirmed ([Deployment verification](#deployment-verification)).
- **Restore:** there is no server-side restore tool and no restore rehearsal ([Restore](#restore)).
- **Backup retention** is unlocked. Locking it is irreversible and needs explicit approval (step 7 of
  [Enabling it](#enabling-it)).
- **Sign-up with each provider** (email one-time passcode, Google and Microsoft) has not been verified in production
  with a new account.
- **No staging pilot:** registration was opened in production without a staging pilot or measured cost, latency and
  failure rates.
- **Legal pages:** `/privacy` and `/terms` are published, but their legal review is not recorded here and there is
  no imprint page.

Deferred features:

- Session expiry and the matching cleanup.
- A `Content-Security-Policy` header in `public/staticwebapp.config.json`.
