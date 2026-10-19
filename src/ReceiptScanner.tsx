import { useEffect, useRef, useState } from "react";
import { Camera, ScanLine, Upload } from "lucide-react";
import type { MessageKey } from "../shared/i18n";
import { useLocale } from "./i18n";
import type { ReceiptDraft, ReceiptWarning } from "./receipt";
import { downloadReceiptScanner, receiptScannerReady, scanReceipt, type OcrProgress } from "./receiptOcr";

const warningMessages: Record<ReceiptWarning, MessageKey> = {
  confidence: "The text is unclear. No fields were filled. Try a clearer photo or enter the expense manually.",
  merchant: "No merchant was identified. Check the description manually.",
  date: "No unambiguous date was found. Check the date manually.",
  total: "No unambiguous total was found. Enter the amount manually.",
  currency: "Currency was not identified. Confirm EUR before using the amount.",
  foreign: "This receipt uses {currency}. Its amount will not be filled. Enter a converted EUR amount manually."
};

export default function ReceiptScanner({ apply, onBusyChange }: {
  apply: (draft: ReceiptDraft) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t, message, number, locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReceiptDraft | null>(null);
  const [confirmedEUR, setConfirmedEUR] = useState(false);
  const [applied, setApplied] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    receiptScannerReady().then((value) => { if (!disposed) setReady(value); }).catch(() => {
      if (!disposed) setError("Scanner storage is unavailable. Check your browser storage settings; manual entry still works.");
    });
    return () => {
      disposed = true;
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [expanded]);

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    onBusyChange(true);
    setProgress({ phase: "prepare", progress: 0 });
    setError(""); setResult(null); setConfirmedEUR(false); setApplied(false);
    try {
      await operation(controller.signal);
    } catch (cause) {
      if (active.current === controller) {
        setError(cause instanceof Error ? cause.message : "Could not read this receipt. Try a clearer photo or enter it manually.");
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress(null); onBusyChange(false);
      }
    }
  }

  function cancel() {
    const controller = active.current;
    active.current = null;
    controller?.abort();
    setProgress(null); onBusyChange(false);
    setError("Receipt scanning cancelled. Retry or enter the expense manually.");
  }

  function choose(file?: File) {
    if (!file) return;
    void run(async (signal) => {
      const draft = await scanReceipt(file, signal, setProgress);
      signal.throwIfAborted();
      setResult(draft);
    });
  }

  const canUseAmount = !!result?.amountCents && (result.currency === "EUR" || (!result.currency && confirmedEUR));
  const amountFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <section className="receipt-scanner" aria-label={t("Receipt scanning")}>
    <button className="secondary" type="button" aria-expanded={expanded} disabled={!!progress} onClick={() => {
      setExpanded(!expanded); setResult(null); setApplied(false);
    }}><ScanLine size={18} />{t(expanded ? "Close scanner" : "Scan receipt (optional)")}</button>
    {expanded && <div className="receipt-content">
      <p className="muted">{t("Photos are read on this device, never uploaded or stored by Splitty. Only expenses you save are synced.")}</p>
      {ready ? <p className="success">{t("Scanner downloaded. You can scan offline on this device.")}</p> : <>
        <p className="muted">{t("Download the scanner once (about 16 MB) for German and English receipts. Clearing browser data removes it.")}</p>
        <button className="secondary" type="button" disabled={!!progress} onClick={() => void run(async (signal) => {
          await downloadReceiptScanner(signal, setProgress);
          setReady(true);
        })}>{t("Download scanner")}</button>
      </>}
      <div className="button-row receipt-inputs">
        {([["Take receipt photo", Camera, "environment"], ["Choose receipt image", Upload, undefined]] as const).map(([label, Icon, capture]) =>
          <label className="file-picker" key={label}><Icon size={18} /><span>{t(label)}</span>
            <input type="file" aria-label={t(label)} accept="image/jpeg,image/png,image/webp" capture={capture} disabled={!ready || !!progress}
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; choose(file); }} />
          </label>)}
      </div>
      {progress && <div role="status">
        <p>{t(progress.phase === "download" ? "Downloading scanner: {progress}%" : progress.phase === "recognize" ? "Reading receipt: {progress}%" : "Preparing receipt scanner…",
          { progress: number(Math.round(progress.progress * 100)) })}</p>
        <progress aria-label={t("Receipt scan progress")} max={1} value={progress.progress} />
        <button className="text-button" type="button" onClick={cancel}>{t("Cancel scan")}</button>
      </div>}
      {error && <p className="error" role="alert">{message(error)}</p>}
      {result && <div className="receipt-result">
        <p className="notice">{t("Suggestions only. Check every field against your receipt before saving. Nothing has been saved.")}</p>
        <dl>
          <dt>{t("Merchant")}</dt><dd>{result.merchant ?? t("Not identified")}</dd>
          <dt>{t("Date")}</dt><dd>{result.date ?? t("Not identified")}</dd>
          <dt>{t("Receipt total")}</dt><dd>{result.amountCents ? amountFormat.format(result.amountCents / 100) : t("Not identified")}</dd>
          <dt>{t("Receipt currency")}</dt><dd>{result.currency ?? t("Not identified")}</dd>
        </dl>
        {result.warnings.map((warning) => <p className="receipt-warning" key={warning} role="status">{t(warningMessages[warning], { currency: result.currency ?? "" })}</p>)}
        {!result.currency && !!result.amountCents && <label className="radio">
          <input type="checkbox" checked={confirmedEUR} onChange={(event) => { setConfirmedEUR(event.target.checked); setApplied(false); }} />
          {t("I confirm this receipt is in EUR.")}
        </label>}
        <button className="secondary" type="button" disabled={applied || (!result.merchant && !result.date && !canUseAmount)} onClick={() => {
          apply({ ...result, amountCents: canUseAmount ? result.amountCents : undefined });
          setApplied(true);
        }}>{t("Use suggestions")}</button>
        {applied && <p className="success" role="status">{t("Suggestions applied. Review the expense below, then save it yourself.")}</p>}
        {!!result.text.trim() && <details><summary>{t("Recognized text")}</summary><pre>{result.text}</pre></details>}
      </div>}
    </div>}
  </section>;
}
