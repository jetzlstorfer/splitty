import { useState } from "react";
import { db, queueNewReceipts, type Preferences } from "./db";
import type { ImportPreview } from "./importer";
import { useLocale } from "./i18n";
import { Select, Sheet } from "./Controls";

function FilePicker({ label, accept, disabled, choose }: { label: string; accept: string; disabled?: boolean; choose: (file?: File) => void }) {
  const { t } = useLocale();
  const [filename, setFilename] = useState("");
  return <label className="file-label">{label}<span className="file-picker">
    <span className="file-picker-button">{t("Choose file")}</span><span>{filename || t("No file selected")}</span>
    <input type="file" aria-label={label} accept={accept} disabled={disabled} onChange={(event) => {
      const file = event.target.files?.[0];
      setFilename(file?.name ?? ""); choose(file); event.target.value = "";
    }} />
  </span></label>;
}

export default function ImportForm({ preferences: p, close, saved }: { preferences: Preferences; close: () => void; saved: () => void }) {
  const { t, message, money, number } = useLocale();
  const [text, setText] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [memberA, setMemberA] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(file?: File) {
    if (!file) return;
    setError(""); setPreview(null); setText("");
    try {
      if (file.size > 10_000_000) throw new Error("Choose an export smaller than 10 MB.");
      const content = await file.text();
      const { readCsv } = await import("./importer");
      const parsed = readCsv(content);
      setText(content); setMembers(parsed.members);
      setMemberA(parsed.members.includes(p.nameA) ? p.nameA : parsed.members[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read this file."); }
  }
  async function inspect() {
    setBusy(true); setError("");
    try {
      const { previewImport } = await import("./importer");
      setPreview(await previewImport(text, memberA, new Set(await db.entries.toCollection().primaryKeys())));
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not preview this import."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || preview.errors.length) return;
    setBusy(true); setError("");
    try {
      await queueNewReceipts(preview.entries);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed. No entries were added."); }
    finally { setBusy(false); }
  }
  return <Sheet title={t("Import from Splitwise")} close={close}><div className="panel-content">
    <p>{t("Choose a CSV export for two people in EUR. Entries stay on this device until you confirm, then sync with your household.")}</p>
    <FilePicker label={t("Splitwise CSV")} accept=".csv,text/csv" choose={(file) => void choose(file)} disabled={busy} />
    {!!members.length && <>
      <label>{t("Export column for {name}", { name: p.nameA })}<Select label={t("Export column for {name}", { name: p.nameA })} value={memberA} disabled={busy} onChange={(value) => { setMemberA(value); setPreview(null); }} options={members.map((member) => ({ value: member, label: member }))} /></label>
      <p className="muted">{t("{source} maps to {name}. Use the same mapping on every device.", { source: members.find((member) => member !== memberA) ?? "", name: p.nameB })}</p>
      <button className="secondary" disabled={busy} onClick={inspect}>{t(busy ? "Reading history…" : "Preview import")}</button>
    </>}
    {preview && <div className="import-preview">
      <h3>{preview.entries.length === 1 ? t("1 new entry") : t("{count} new entries", { count: number(preview.entries.length) })}</h3><p>{t("{count} already imported · skipped", { count: number(preview.duplicates) })}</p>
      <p>{t("File balance for {name}:", { name: p.nameA })} <strong>{money(preview.balanceA)}</strong></p>
      {preview.expectedBalanceA !== null ? <p className={preview.errors.length ? "muted" : "success"}>{t(preview.errors.length ? "Reconciliation needs attention." : "Matches the final balance in your export.")}</p> : <p className="notice">{t("No final balance row found. Check this total against Splitwise before confirming.")}</p>}
      {preview.errors.length > 0 && <div className="error" role="alert"><strong>{t("Nothing will be imported.")}</strong><ul>{preview.errors.slice(0, 8).map((error, i) => <li key={i}>{message(error)}</li>)}</ul>{preview.errors.length > 8 && <p>{t("And {count} more errors.", { count: number(preview.errors.length - 8) })}</p>}</div>}
      <p className="muted">{t("Original balance contributions are preserved, including payments and rounding. Payer and share details are not guessed. Identical rows within the export remain separate expenses.")}</p>
      <button className="primary" disabled={busy || !!preview.errors.length || !preview.entries.length} onClick={confirm}>{t(busy ? "Saving history…" : "Confirm import")}</button>
    </div>}
    {error && <p className="error" role="alert">{message(error)}</p>}
  </div></Sheet>;
}
