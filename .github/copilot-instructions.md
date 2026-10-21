# Splitty project rules

- Keep accounting in integer EUR cents. Reuse the validation and rounding rules in
  [the shared model](../shared/model.ts); imported balance contributions must not
  be reinterpreted as original payer or split information.
- Save changes locally through the transactional queues in
  [db.ts](../src/db.ts), then sync. Preserve outboxes, revisions, tombstones,
  conflict resolution, and separate expense/to-do cursors.
- Insurance reminders are derived from expenses; their completion state belongs
  to the expense. Manual to-dos are separate records and never affect balances.
- Keep user-facing strings and errors localized through
  [shared translations](../shared/i18n.ts) and the existing locale helpers.
  Personal descriptions and imported data are not translated.
- Never commit member tokens, local settings, private CSV exports, or backups.
  Use synthetic households and records for tests.
- Follow the [setup and checks documentation](../README.md#checks) and
  [CI workflow](./workflows/check.yml). Run checks relevant to the change; builds
  include TypeScript checking. Do not reinstall dependencies unless needed.
- Use [browser validation](./skills/browser-validation/SKILL.md) for UI, touch,
  keyboard, responsive layout, and PWA/offline behavior. Use
  [offline-sync validation](./skills/offline-sync-validation/SKILL.md) for
  persistence, outbox, conflict, or cross-device changes.
