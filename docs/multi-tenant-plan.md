# Multi-tenant plan and Azure cost outlook

Status: proposal, not implemented. Planning date: 2026-10-25.

## Recommendation and scope

Support multiple two-person households on one shared Azure deployment first.
Keep the existing offline-first ledger and Table Storage rather than provisioning
an application or database per household. The substantial work is user
onboarding, authorization, and local data isolation, not a database migration.

Supporting three or more members in a household is a separate project. The
current accounting model explicitly uses members `a` and `b`, `shareA`, and
`balanceA`; arbitrary-sized households would require changes to splits,
balances, settlements, imports, statistics, and the interface.

This proposal does not change the existing application's behavior or deploy any
Azure resources.

## Current architecture

- [`infra/main.bicep`](../infra/main.bicep) provisions Static Web Apps Free and
  Standard LRS Table Storage, with West Europe as the default location. The
  frontend uses a same-origin managed Functions API.
- [`api/src/config.ts`](../api/src/config.ts) selects one `HOUSEHOLD_ID` and two
  deployment-wide member tokens and names.
- [`api/src/auth.ts`](../api/src/auth.ts) exchanges a member token for a
  server-side device session. Authentication identifies member `a` or `b` within
  the configured household, not an independent user with memberships.
- [`api/src/ledger.ts`](../api/src/ledger.ts) already partitions records by
  household. Atomic writes preserve the record, sequence, change log, and
  operation receipt within that partition.
- [`src/db.ts`](../src/db.ts) uses one default IndexedDB database with unscoped
  records, outboxes, conflicts, preferences, cursors, and a device session.
  Signing out deliberately retains the local ledger.

The server partitioning is a useful foundation, but it does not by itself make
the API or browser safe for multiple households.

## Proposed changes

### Users, households, and authorization

Introduce stable user IDs, household records, and membership records mapping a
user to a household and its `a` or `b` accounting slot. A user's identity must be
independent of their role within any particular household.

Replace deployment-wide member credentials with user authentication and
revocable sessions. Evaluate a managed identity provider such as Microsoft
Entra External ID; provider selection and integration remain implementation
decisions. If using Static Web Apps' custom authentication configuration,
account for its Standard-plan requirement.

Add household creation, expiring single-use invitations, joining, leaving, and
member removal. Define owner/member permissions and what happens when an owner
leaves before implementing those operations.

Every expense, to-do, sync, export, and administrative request must verify the
authenticated user's current membership and permissions. Never treat a
client-supplied household ID as proof of access. Revoking membership must block
subsequent server access, including queued writes and session recovery.

### Offline data and sync isolation

Namespace local data by signed-in user and household, using separate databases
or consistently scoped keys. Include entries, manual to-dos, outboxes,
conflicts, preferences, and both expense and to-do cursors. Scope device-session
recovery to the signed-in user rather than a household's accounting slot.

Capture the user and household context for each sync pass. Switching accounts
or households must stop or fence in-flight work so responses and pending edits
cannot be applied to another context. Preserve unsynced changes in their
original context; never silently discard or upload them elsewhere.

Provide household selection and explicit sign-out/local-data handling for
shared devices. Server revocation cannot remotely erase data already downloaded
to an offline device; document this limitation.

Retain transactional local queues, revisions, operation receipts, tombstones,
conflict resolution, and separate expense/to-do change streams. Keep integer
EUR-cent accounting and imported signed balance contributions unchanged.
Insurance completion remains on the expense; manual to-dos remain separate
from balances. Localize new interface strings through the existing helpers.

### Migration and household lifecycle

Map the current household and its two members into the new identity model
without changing ledger IDs, revisions, or sequence history. Adopt existing
local data only into that explicitly verified household context. Preserve
pending writes and device recovery through a coordinated migration, and reject
incompatible old clients rather than allowing unscoped sync.

Make backup, restore, and deletion household-aware. Restore must explicitly
confirm the destination household, never grant membership from imported
metadata, and preserve imported accounting semantics. Define retention and
recovery procedures before pruning history; LRS replication is not a backup.

## Delivery sequence and acceptance criteria

1. Define identity, membership, invitation, permissions, and migration contracts;
   select the authentication integration and confirm its Azure requirements.
2. Implement household-scoped server authorization and migrate the existing
   household, with tests that deny cross-household reads, writes, and invitation
   misuse.
3. Isolate local storage and sync context; cover pending edits, switching during
   in-flight sync, session recovery, revocation, and offline account switching.
4. Add onboarding, household selection, scoped backup/restore, and lifecycle
   operations. Validate two-device convergence and existing accounting behavior.
5. Pilot with synthetic households, then a small invited cohort. Measure costs,
   latency, concurrency, and failure rates before broader rollout.

Use the existing [checks](../README.md#checks),
[offline-sync validation](../.github/skills/offline-sync-validation/SKILL.md),
and [browser validation](../.github/skills/browser-validation/SKILL.md) during
implementation. Multi-tenancy is not complete until isolation holds across
server requests, local data, queued edits, and account transitions.

## Azure cost outlook

These are rough monthly planning budgets in USD before tax, not measured
capacity, a verified West Europe quote, or an inspection of the current bill.
Assume one shared deployment, two people per household, text-only records,
modest daily use, controlled logging, and no paid identity add-ons.

| Monthly active users | Two-person households | Planning budget per month |
| ---: | ---: | --- |
| 100 | 50 | $0-5 on Free hosting; approximately $10-20 with Standard |
| 1,000 | 500 | $10-30 |
| 10,000 | 5,000 | $30-150+, depending on usage and backend configuration |

Hundreds of light users could plausibly remain near-free. For a public
production service, budget for Standard hosting rather than promise permanent
Free-tier operation. The 1,000-user range is a useful initial budget target,
not a validated capacity guarantee.

### Cost drivers and assumptions to verify

- **Hosting:** Static Web Apps Standard has an indicative base price of about
  $9 per app/month, not per household. Confirm regional pricing, bandwidth
  allowances, API limits, and the chosen authentication integration.
- **Storage:** Table Storage is inexpensive for small text records. Include
  current records, retained changes, operation receipts, tombstones, and
  sessions in the estimate, not just the visible ledger.
- **Identity:** Entra External ID advertises its core offering free for the
  first 50,000 monthly active users. This is not a free allowance for the
  entire application. SMS, premium features, and other services can cost extra.
- **API usage:** The current deployment uses managed Functions. Do not assume
  that standalone Functions Consumption quotas and billing apply unchanged.
  If moving to a separately hosted backend, recalculate both hosting and
  execution costs.
- **Operations:** Log ingestion, backup retention, outbound bandwidth,
  invitation email, SMS, receipt uploads, abuse, and additional infrastructure
  can exceed the basic ledger costs. Bound logging, add rate limits and usage
  quotas, and configure budget alerts. Alerts are not spending caps.

The current visible app polls once per minute. An unchanged successful sync
makes five API requests: `/me`, then two pulls each for expenses and manual
to-dos. Ten minutes of daily use over 30 days therefore gives roughly 1,500 API
requests per user, or 1.5 million for 1,000 users, before saves, initial loads,
pagination, focus events, and retries. API requests are not equivalent to Table
Storage transactions; mutations perform several storage operations.

Evaluate less frequent or adaptive idle polling while preserving save,
reconnect, and foreground sync. Measure actual API execution time, request
volume, storage operations, retained data, bandwidth, and log ingestion. Model
peak concurrent use as well as monthly active users before committing to a
larger user count or budget.

### Pricing references

Recheck these sources in the Azure Pricing Calculator for the deployment
region and billing agreement before implementation:

- [Static Web Apps pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/)
- [Static Web Apps quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)
- [Static Web Apps custom authentication](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-custom)
- [Table Storage pricing](https://azure.microsoft.com/en-us/pricing/details/storage/tables/)
- [Microsoft Entra External ID pricing](https://azure.microsoft.com/en-us/pricing/details/microsoft-entra-external-id/)
- [Azure Pricing Calculator](https://azure.microsoft.com/en-us/pricing/calculator/)
