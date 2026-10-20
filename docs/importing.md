# Importing a Splitwise export

Splitty imports German or English CSV exports for a two-person group using EUR:

1. Configure person A and person B in **Settings**, or sign in to use the backend names. Keep the same A/B mapping on every device.
2. Open **Search → Import**, select the CSV, and map the first person's column. The other member maps to person B.
3. Review the number of new entries, skipped duplicates, and resulting balance.
4. Compare the preview with Splitwise before confirming. Invalid rows, unsupported currencies, inconsistent contributions, and a mismatched final balance block the entire import.

The export's final `Gesamtbilanz` row is checked, not imported. Member columns represent signed balance contributions—not original payer or split information—so Splitty preserves them and does not infer missing accounting details. Imported amounts cannot be reallocated; change a description or date, or delete the entry and create a new expense with explicit payer and shares.

Import IDs hash normalized source rows with occurrence numbers. Re-importing a complete export is safe; distinct but identical rows remain distinct. A partial export cannot identify which occurrence of an indistinguishable duplicate row it contains, so use complete exports for repeat imports. Deleted imports remain tombstones and are not resurrected by a later import.

Import previews are processed locally. Confirmed entries are saved locally first, then sync only to the configured backend. Keep exports private; CSVs, backups, and local settings are excluded from Git.
