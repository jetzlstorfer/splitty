import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useLocale } from "./i18n";

const actionWidth = 160;

export default function SwipeableExpenseRow({ children, description, disabled, open, setOpen, edit, remove }: {
  children: ReactNode; description: string; disabled: boolean; open: boolean;
  setOpen: (open: boolean) => void; edit: () => void; remove: () => Promise<void>;
}) {
  const { t } = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const actionsId = useId();
  const gesture = useRef<{ id: number; x: number; y: number; start: number; offset: number; direction: "horizontal" | "vertical" | null } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = disabled || busy;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, setOpen]);

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (blocked || !event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    const offset = open ? -actionWidth : 0;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: offset, offset, direction: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.direction && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
      current.direction = Math.abs(dx) > Math.abs(dy) * 1.2 ? "horizontal" : "vertical";
      suppressClick.current = true;
    }
    if (current.direction !== "horizontal") return;
    current.offset = Math.max(-actionWidth, Math.min(0, current.start + dx));
    setDrag(current.offset);
  }

  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
    if (!cancelled && current.direction === "horizontal") setOpen(current.offset < -actionWidth / 2);
  }

  return <div ref={root} className="swipe-expense" onKeyDown={(event) => {
    if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".expense-actions-toggle")?.focus(); }
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className={`expense-swipe-front${drag !== null ? " dragging" : ""}`} style={{ transform: `translateX(${drag ?? (open ? -actionWidth : 0)}px)` }}>
      <button className="expense-row" disabled={blocked}
        onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
        onClick={(event) => {
          if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
          if (open) setOpen(false); else edit();
        }}>{children}</button>
      <button className="expense-actions-toggle icon-button" aria-label={`${t("Entry actions")}: ${description}`}
        aria-expanded={open} aria-controls={actionsId} disabled={blocked} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
    </div>
    <div id={actionsId} className="expense-swipe-actions" inert={!open || blocked}>
      <button className="expense-edit-action" aria-label={`${t("Edit entry")}: ${description}`} disabled={blocked} onClick={() => { setOpen(false); edit(); }}>
        <Pencil size={20} aria-hidden="true" /><span>{t("Edit entry")}</span>
      </button>
      <button className="expense-delete-action" aria-label={`${t("Delete entry")}: ${description}`} disabled={blocked} onClick={async () => {
        if (!window.confirm(t("Delete this entry for both of you? This will sync when you are online."))) return;
        setBusy(true);
        try { await remove(); setOpen(false); }
        finally { setBusy(false); }
      }}><Trash2 size={20} aria-hidden="true" /><span>{t("Delete entry")}</span></button>
    </div>
  </div>;
}
