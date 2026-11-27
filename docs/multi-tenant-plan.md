# Multi-tenant plan and Azure cost outlook

Status: production migration, retirement cleanup and operations rollout complete; new households accepted since 2026-11-27. Originally prepared: 2026-10-25; key
decisions recorded: 2026-11-17. The code now includes server-derived
user/household sessions and revocation checks, an Entra authorization-code
flow with persisted PKCE/state and one-time device-key bootstrap, hashed
seven-day invitations with transactional redemption, per-user/household local
database isolation, household member renaming/removal/leaving/deletion, account
deletion requests, locally generated invitation QR codes, and adaptive polling.
The production household migration is complete: both members claimed provider
accounts, and the audit found no household dependent on member-token sign-in.
Retirement removes the obsolete token session and claim code while retaining
`legacyClaimed` for importing existing local IndexedDB history. The scheduled
backup, permanent-deletion and cleanup jobs, monitoring, alerts and budget now
exist as opt-in code and infrastructure; production infrastructure was deployed
on 2026-11-27 (see [operations](operations.md) for verification and open items).
Production has accepted new households since the same day through the
`ALLOW_NEW_HOUSEHOLDS` application setting ([registration](operations.md#registration));
the restore rehearsal, per-provider sign-up verification and other open items are
tracked there. Household record/daily
quotas, invitation and household-creation limits, per-session request limits,
and sign-in IP limits are enforced in the API. Real Entra callback validation
requires tenant and application credentials. Cost figures have not been
revalidated since the original
proposal.

## Recommendation and scope

Support multiple two-person households on one shared Azure deployment first.
Keep the existing offline-first ledger and Table Storage rather than provisioning
an application or database per household. The substantial work is user
onboarding, authorization, and local data isolation, not a database migration.

Supporting three or more members in a household is a separate project. The
current accounting model explicitly uses members `a` and `b`, `shareA`, and
`balanceA`; arbitrary-sized households would require changes to splits,
balances, settlements, imports, statistics, and the interface.

This plan does not provision Azure resources. Registration of new households is
controlled by the `ALLOW_NEW_HOUSEHOLDS` application setting; see
[operations](operations.md#registration).

## Decisions

These decisions guide the proposed changes below. Revisit the limits after the
pilot.

### Product and accounts

- **Distribution:** one hosted deployment shared by many households, rather than
  a separate deployment per household. Anyone can sign up.
- **Sign-in:** Microsoft Entra External ID with email one-time passcodes,
  Google, and Microsoft accounts. Splitty's API handles the sign-in flow and
  issues its own revocable server-side device sessions, preserving device-key
  cookie recovery. Entra sends the passcode emails; Splitty sends no email.
- **Memberships:** membership records allow a user to belong to several
  households, but v1 limits each user to one. Creating or joining another
  household requires leaving the current one.
- **Members and permissions:** each household keeps exactly two accounting
  slots, `a` and `b`, and both members have equal rights. Either member can
  invite someone into an empty slot, remove the other member, rename members,
  or delete the household. Member names move from deployment settings to the
  household record.
- **New households:** usable immediately, including imports, before the second
  member joins. The creator enters the partner's name for slot `b`, which the
  invitee can change on joining. A blank name shows a localized "Partner"
  placeholder; entered names are not translated.
- **Leaving and removal:** the remaining member keeps the full ledger. An empty
  slot can be filled by a new invitation; the newcomer takes over that slot's
  balance, and the invitation must state this. A removed member loses server
  access, but data already on their devices remains.
- **Invitations:** single-use links valid for 7 days that members share
  themselves, also shown as a QR code. Store only a hash of the invitation
  secret; either member can revoke a pending invitation. Check expiry when a
  link is redeemed.
- **Account deletion:** immediately revokes the user's sessions and memberships.
  The other member keeps the ledger, showing the deleted member under a neutral
  name. Identity data, including the Entra account, and any household left
  without members follow the [deletion timeline](#operations).
- **Sign-out:** local data stays on the device, separated by user and household,
  but is hidden until that user signs in again. An explicit "remove data from
  this device" action warns about unsynced changes. Hiding data is not
  encryption; anyone with access to the device can read browser storage.
- **Scope:** v1 remains EUR-only with German and English. Other currencies,
  languages, households of three or more, Sign in with Apple, and email or push
  notifications are out of scope.
- **Migration:** the existing production household has been migrated in place.
  Obsolete Static Web App member-token settings and 11 legacy auth rows
  (10 sessions and one rate counter) were removed on 2026-11-27. Devices that
  have not moved to Entra must sign in again; local-history claim markers remain.

### Operations

- **Hosting:** keep Static Web Apps Free for production and isolated staging
  (decision updated 2026-11-27). Standard is optional:
  Splitty's API handles Entra authentication, and scheduled jobs use a separate
  Functions app. Accept Free's lack of an SLA and its 100 GB monthly bandwidth
  allowance per subscription, with no paid overage. Monitor usage across all
  Free apps in the subscription and review an upgrade well before that limit,
  or when an SLA or Standard-only feature is needed. Production keeps its
  existing custom domain: IndexedDB is bound to the origin, so devices keep
  local data and unsynced edits, and installed PWAs keep working.
- **Data residency:** EU only. Azure resources stay in West Europe, and the
  Entra External ID tenant is created in Europe; its location cannot be changed
  later. Static assets may be served from global edge locations but contain no
  user data.
- **Funding:** free to use, with the operator paying Azure costs and configuring
  budget alerts.
- **Limits:** per household, 20,000 active expenses, 2,000 active manual to-dos,
  5,000 changes per day (enough for a large CSV import), and 10 invitations per
  day. Per device session, 600 API requests per 10 minutes, allowing bursts for
  initial syncs and imports. Per user, 3 new households per 30 days. Sign-in and
  session recovery allow 20 attempts per IP address per minute. Exceeding a
  limit returns 429 with `Retry-After`; local edits remain queued. Entra email
  verification is the initial protection against automated sign-ups; add paid
  fraud protection only if abuse appears.
- **Sync cadence:** keep syncing on start, focus, visibility changes,
  reconnect, and saves. While visible, poll every 60 seconds during use and
  every 5 minutes after 5 idle minutes. Request `/me` on start, on focus, and
  periodically instead of in every pass.
- **Backups:** a daily job exports users, households, memberships, invitations,
  and both ledgers, excluding sessions, to a separate storage account with
  30-day time-based immutable retention.
- **Deletion timeline:** deleting a household, or its last member leaving or
  deleting their account, starts a 30-day grace period. The data is
  inaccessible but can be restored on request. It is then permanently deleted
  and expires from backups within a further 30 days, 60 days in total.
- **Scheduled jobs:** a separate small Azure Functions app with timer triggers
  and a managed identity runs backups and permanent deletion, with only the
  storage permissions those jobs need. The managed API that serves requests
  stays unchanged.
- **Legal:** the operator writes the privacy policy, terms of use, and imprint
  from reputable templates for their jurisdiction and has them reviewed. Base
  them on documentation of the stored data, processors (Azure, Entra External
  ID, Google and Microsoft sign-in), retention, deletion, and a contact for
  restore and deletion requests. Privacy and terms pages are published; no
  imprint page and no legal review are recorded yet.

## Current architecture

- [`infra/main.bicep`](../infra/main.bicep) provisions Static Web Apps Free and
  Standard LRS Table Storage, with West Europe as the default location, and
  optionally monitoring, the scheduled jobs app with backup storage, alerts and
  a budget ([operations](operations.md#infrastructure)). The
  frontend uses a same-origin managed Functions API.
- [`api/src/config.ts`](../api/src/config.ts) selects Entra sign-in for hosted
  deployments and a synthetic household only for loopback development.
- [`api/src/auth.ts`](../api/src/auth.ts) supports server-side sessions carrying a
  user ID, household ID, and accounting slot. New-format sessions check the
  active membership and its generation on each request, so revoking and
  re-creating a membership does not revive an old device key. Provider sign-in
  creates initial memberships or redeems invitations for new accounts. The
  retired member-token claim flow is no longer available. Non-local deployments
  reject new household creation unless `ALLOW_NEW_HOUSEHOLDS=true`.
  Joining an invitation with an account already assigned to another household is
  rejected until leave/transfer is implemented.
- [`api/src/invitations.ts`](../api/src/invitations.ts) implements the
  household-scoped invitation lifecycle. The raw invitation code is returned
  only at creation; storage contains its SHA-256 digest and a transactional
  empty-slot reservation. Seven-day expiry is checked during listing and
  redemption, and consuming an invitation atomically creates the membership and
  removes the invitation and reservation.
- [`api/src/ledger.ts`](../api/src/ledger.ts) already partitions records by
  household. Atomic writes preserve the record, sequence, change log, and
  operation receipt within that partition.
- [`src/db.ts`](../src/db.ts) keeps anonymous/legacy data in the default
  IndexedDB database and selects a separate database derived from the signed-in
  user and household for Entra accounts. On an existing-household claim, it
  transactionally adopts entries, tombstones, both outboxes, conflicts,
  preferences, and both cursors while leaving the source data and Entra device
  session intact. Expenses, to-dos, outboxes, conflicts,
  preferences, and cursors therefore do not cross account boundaries.
  Device-session recovery is stored separately; signing out hides rather than
  deletes account data.
- Manual to-do order is shared through the to-do records' optional `position`
  field. Reordering can queue changes to multiple records; insurance reminders
  remain derived from expenses and occupy date-based slots in the combined list.
- A sync pass identifies the current member, updates local preferences, then
  pulls and pushes expenses and manual to-dos. Saves during a pass request
  another pass. A device key stored in IndexedDB can restore a lost cookie.
  Modern-account sync requests include the captured user/household context, and
  the API rejects stale or mismatched context. Tabs share cookies and coordinate
  database changes, but comprehensive fencing of in-flight sync work across
  tabs is still pending.

The server partitioning is a useful foundation, but it does not by itself make
the API or browser safe for multiple households.

## Proposed changes

### Users, households, and authorization

Introduce stable user IDs, household records, and membership records mapping a
user to a household and its `a` or `b` accounting slot. A user's identity must be
independent of their role within any particular household.

Replace deployment-wide member credentials with Entra External ID sign-in and
revocable Splitty device sessions. Splitty's API handles the sign-in flow
instead of Static Web Apps authentication, whose pre-configured providers are
GitHub and Microsoft Entra ID and whose custom providers require the Standard
plan. This keeps session lifetime, device-key recovery, and revocation under
Splitty's control.

Household creation, invitations, joining, leaving, member removal, renaming,
account deletion requests, and household deletion are implemented in the API
and client. Existing-household claims are implemented, and the member-token
session path is retired. Production settings and stale-session cleanup is complete,
as recorded in the [README](../README.md#existing-household-sign-in-retirement).

Every expense, to-do, sync, export, and administrative request must verify the
authenticated user's current membership and permissions. Never treat a
client-supplied household ID as proof of access. Revoking membership must block
subsequent server access, including queued writes and session recovery.

### Offline data and sync isolation

Namespace local data by signed-in user and household, using separate databases
or consistently scoped keys. Include entries, manual to-dos, outboxes,
conflicts, preferences, both expense and to-do cursors, and manual to-do
positions. Scope device-session recovery to the signed-in user rather than a
household's accounting slot; a stale device key must not restore a different
user or household after an account switch or revocation.

Capture the user and household context for each sync pass. Switching accounts
or households must stop or fence in-flight work so responses and pending edits
cannot be applied to another context, including identity updates, retries, and
the additional pass requested by an in-flight save. Coordinate context changes
across tabs sharing a cookie and database; a lock in one tab alone is not
sufficient. Preserve unsynced changes in their original context; never silently
discard or upload them elsewhere.

Implement the decided sign-out and local data removal behavior for shared
devices. v1 needs no household selector, but scope local storage so one can be
added without migrating data. Server revocation cannot remotely erase data
already downloaded to an offline device; document this limitation.

Retain transactional local queues, revisions, operation receipts, tombstones,
conflict resolution, and separate expense/to-do change streams. Keep integer
EUR-cent accounting and imported signed balance contributions unchanged.
Insurance completion remains on the expense; manual to-dos remain separate
from balances. Preserve shared manual to-do order and its date-based interaction
with insurance reminders, including queued multi-record reorders and conflicts.
Localize new interface strings through the existing helpers.

### Migration and household lifecycle

Map the current household and its two members into the new identity model
without changing ledger IDs, revisions, or sequence history. Adopt existing
local data, including to-do positions, only into that explicitly verified
household context. Preserve pending writes, conflicts, both cursors, and device
recovery through a coordinated migration, and reject incompatible old clients
rather than allowing unscoped sync.

Make backup, restore, and deletion household-aware. Restore must explicitly
confirm the destination household, never grant membership from imported
metadata, and preserve imported accounting semantics. Server backups and the
deletion timeline follow the [operations decisions](#operations). Define
retention before pruning change history or tombstones; LRS replication is not a
backup.

## Delivery sequence and acceptance criteria

1. Define identity, membership, invitation, permissions, and migration contracts;
   configure the Entra External ID integration and confirm its Azure
   requirements.
2. Implement household-scoped server authorization, limits, and the in-place
   migration of the existing household. Both existing members now have provider
   accounts; the retirement deploy preserves their account-scoped local queues
   and removes the remaining token-based session path.
3. Isolate local storage and sync context; cover pending edits and multi-record
   reorders, switching during in-flight sync, saves during a pass, multiple
   tabs, session recovery, revocation, and offline account switching.
4. The code now includes provider-aware sign-in, invitations, adaptive sync
   cadence, and household lifecycle operations. The scheduled backup and
   deletion jobs and infrastructure are implemented ([operations](operations.md));
   still add scoped restore and complete the operational verification. Validate two-device
   convergence and existing accounting behavior.
5. Pilot in a separate staging deployment with synthetic households, never the
   live production storage, and measure costs, latency, concurrency, and failure
   rates. The existing-household claim no longer needs a rehearsal because the
   migration is complete. Budget alerts exist, and production has accepted new
   households since 2026-11-27 without this pilot; the pilot, the restore
   rehearsal and the measurements remain open
   ([operations](operations.md#open-items)).

Use the existing [checks](../README.md#checks),
[offline-sync validation](../.github/skills/offline-sync-validation/SKILL.md),
and [browser validation](../.github/skills/browser-validation/SKILL.md) during
implementation. The browser fixtures use isolated emulators and synthetic
households; extend them to exercise multiple households and tabs rather than
reusing real settings or data. Multi-tenancy is not complete until isolation
holds across server requests, local data, queued edits, and account transitions.

## Azure cost outlook

These are historical, unverified October 2026 planning budgets in USD before
tax, not current prices, measured capacity, a verified West Europe quote, or
an inspection of the current bill. Recalculate before relying on them.
Assume one shared deployment, two people per household, text-only records,
modest daily use, controlled logging, and no paid identity add-ons.

| Monthly active users | Two-person households | Planning budget per month |
| ---: | ---: | --- |
| 100 | 50 | $0-5 on Free hosting; approximately $10-20 with Standard |
| 1,000 | 500 | $10-30 |
| 10,000 | 5,000 | $30-150+, depending on usage and backend configuration |

Hundreds of light users could plausibly remain near-free. Production will stay
on Free initially; this does not make storage, scheduled jobs, monitoring or
alerts free, or promise permanent Free-tier operation. The 1,000-user range is
a useful initial budget target, not a validated capacity guarantee.

### Cost drivers and assumptions to verify

- **Hosting:** the selected Static Web Apps Free plan has no hosting base fee.
  Standard is an optional upgrade with an indicative base price of about
  $9 per app/month, not per household. Recheck pricing and quotas before
  upgrading, and change the Bicep SKU as well as the live hosting plan.
  Include optional receipt-scanner downloads (about 16 MB per uncached device)
  when estimating bandwidth; an empty metric series is not proof of no usage.
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
pagination, focus events, retries, additional passes for in-flight saves, and
multiple visible tabs. Manual to-do reorders can queue multiple mutations.
API requests are not equivalent to Table Storage transactions; mutations
perform several storage operations.

The [decided sync cadence](#operations) reduces idle polling while preserving
save, reconnect, and foreground sync. Measure actual API execution time, request
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
