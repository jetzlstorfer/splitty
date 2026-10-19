import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

const actionWidth = 160;

export default function SwipeableRow({ children, description, disabled, open, setOpen, edit, remove, onError,
  actionsLabel, editLabel, deleteLabel, deleteConfirmation }: {
  children: ReactNode; description: string; disabled: boolean; open: boolean;
  setOpen: (open: boolean) => void; edit: () => void; remove: () => Promise<void>;
  onError: (error: unknown) => void;
  actionsLabel: string; editLabel: string; deleteLabel: string; deleteConfirmation: string;
}) {
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

  function start(event: PointerEvent<HTMLDivElement>) {
    if (blocked || !event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    const offset = open ? -actionWidth : 0;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: offset, offset, direction: null };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.direction && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
      current.direction = Math.abs(dx) > Math.abs(dy) * 1.2 ? "horizontal" : "vertical";
      suppressClick.current = true;
    }
    if (current.direction !== "horizontal") return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    current.offset = Math.max(-actionWidth, Math.min(0, current.start + dx));
    setDrag(current.offset);
  }

  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
    if (!cancelled && current.direction === "horizontal") setOpen(current.offset < -actionWidth / 2);
  }

  return <div ref={root} className="swipe-row" onKeyDown={(event) => {
    if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".row-actions-toggle")?.focus(); }
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className={`swipe-front${drag !== null ? " dragging" : ""}`} aria-disabled={blocked}
      style={{ transform: `translateX(${drag ?? (open ? -actionWidth : 0)}px)` }}>
      <div className="swipe-content" tabIndex={-1}
        onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget) finish(event, true);
        }}
        onClickCapture={(event) => {
          if (blocked || (event.detail !== 0 && suppressClick.current)) {
            suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return;
          }
          if (open) { setOpen(false); event.preventDefault(); event.stopPropagation(); }
        }}>{children}</div>
      <button className="row-actions-toggle icon-button" aria-label={`${actionsLabel}: ${description}`}
        aria-expanded={open} aria-controls={actionsId} disabled={blocked} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
    </div>
    <div id={actionsId} className="swipe-actions" inert={!open || blocked}>
      <button className="row-edit-action" aria-label={`${editLabel}: ${description}`} disabled={blocked} onClick={() => { setOpen(false); edit(); }}>
        <Pencil size={20} aria-hidden="true" /><span>{editLabel}</span>
      </button>
      <button className="row-delete-action" aria-label={`${deleteLabel}: ${description}`} disabled={blocked} onClick={async () => {
        if (!window.confirm(deleteConfirmation)) return;
        setBusy(true);
        try { await remove(); setOpen(false); }
        catch (error) { onError(error); }
        finally { setBusy(false); }
      }}><Trash2 size={20} aria-hidden="true" /><span>{deleteLabel}</span></button>
    </div>
  </div>;
}
