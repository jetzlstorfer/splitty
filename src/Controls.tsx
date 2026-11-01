import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { validDate } from "../shared/model";
import { useLocale } from "./i18n";

export function Sheet({ title, children, close, initialFocus, compact = false, describedBy }: {
  title: string; children: ReactNode; close: () => void; initialFocus?: string; compact?: boolean; describedBy?: string;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    if (initialFocus) element?.querySelector<HTMLElement>(initialFocus)?.focus();
    // Close before removal so the browser restores focus to the opener.
    return () => {
      element?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return <dialog ref={dialog} onCancel={(event) => {
    event.preventDefault(); event.stopPropagation(); close();
  }} onClick={(event) => {
    if (!compact || event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  }} className={`sheet${compact ? " control-dialog" : ""}`} aria-labelledby={heading} aria-describedby={describedBy}>
    <div className="sheet-head"><button type="button" className="icon-button" onClick={close} aria-label={t("Close")}><X size={22} /></button><h2 id={heading}>{title}</h2><span /></div>
    {children}
  </dialog>;
}

export function Form({ children, onSubmit, ...props }: ComponentProps<"form">) {
  const { t } = useLocale();
  const [error, setError] = useState("");
  return <form {...props} noValidate onInvalidCapture={(event) => event.preventDefault()} onSubmit={(event) => {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      const field = event.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input:invalid, textarea:invalid, select:invalid"
      );
      setError(field?.validity.valueMissing ? t("Please fill out this field.") : t("Enter a valid date."));
      field?.focus();
      return;
    }
    setError("");
    onSubmit?.(event);
  }} onInputCapture={() => setError("")}>
    {children}
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

export function Select<Value extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: Value; options: readonly { value: Value; label: string; lang?: string }[];
  onChange: (value: Value) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const search = useRef({ text: "", time: 0 });
  const selected = options.find((option) => option.value === value);
  function show() { search.current = { text: "", time: 0 }; setOpen(true); }
  return <>
    <button type="button" className="select-control" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} onClick={(event) => { event.currentTarget.focus(); show(); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
      }}>
      <span lang={selected?.lang}>{selected?.label}</span><ChevronDown size={18} aria-hidden="true" />
    </button>
    {open && <Sheet title={label} close={() => setOpen(false)} compact initialFocus='[aria-selected="true"]'>
      <div id={listId} ref={list} role="listbox" aria-label={label} className="select-options" onKeyDown={(event) => {
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const index = buttons.findIndex((button) => button === document.activeElement);
        let next = index;
        if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
        else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          search.current = { text: (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase(), time: now };
          const match = buttons.findIndex((button) => button.textContent?.trim().toLocaleLowerCase().startsWith(search.current.text));
          if (match >= 0) next = match;
        } else return;
        event.preventDefault();
        buttons[next]?.focus();
      }}>
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1} lang={option.lang} onClick={() => { onChange(option.value); setOpen(false); }}>
          <span>{option.label}</span>{value === option.value && <Check size={18} aria-hidden="true" />}
        </button>)}
      </div>
    </Sheet>}
  </>;
}

export function dateValue(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function moveMonth(date: Date, amount: number) {
  const result = new Date(date);
  result.setDate(1);
  result.setMonth(result.getMonth() + amount);
  const last = new Date(result);
  last.setMonth(last.getMonth() + 1, 0);
  result.setDate(Math.min(date.getDate(), last.getDate()));
  return result;
}

function Calendar({ value, choose, close }: { value: string; choose: (value: string) => void; close: () => void }) {
  const { t, locale } = useLocale();
  const [active, setActive] = useState(() => new Date(`${validDate(value) ? value : dateValue()}T12:00:00`));
  const grid = useRef<HTMLDivElement>(null);
  const first = new Date(active);
  first.setDate(1);
  const last = new Date(first);
  last.setMonth(last.getMonth() + 1, 0);
  const weekStart = 1;
  const offset = (first.getDay() - weekStart + 7) % 7;
  const cells = Math.ceil((offset + last.getDate()) / 7) * 7;
  const activeValue = dateValue(active);
  useLayoutEffect(() => { grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(); }, [activeValue]);
  function move(next: Date) {
    if (validDate(dateValue(next))) setActive(next);
  }
  return <Sheet title={t("Choose date")} close={close} compact initialFocus='[role="gridcell"][tabindex="0"]'>
    <div className="calendar-content">
      <div className="calendar-heading">
        <button type="button" className="icon-button" aria-label={t("Previous month")} disabled={active.getFullYear() === 0 && active.getMonth() === 0} onClick={() => move(moveMonth(active, -1))}><ChevronLeft size={20} /></button>
        <h3 aria-live="polite">{active.toLocaleDateString(locale, { month: "long", year: "numeric" })}</h3>
        <button type="button" className="icon-button" aria-label={t("Next month")} disabled={active.getFullYear() === 9999 && active.getMonth() === 11} onClick={() => move(moveMonth(active, 1))}><ChevronRight size={20} /></button>
      </div>
      <div role="grid" aria-label={t("Date")} ref={grid} className="calendar-grid" onKeyDown={(event) => {
        const next = new Date(active);
        const days = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (days !== undefined) next.setDate(next.getDate() + days);
        else if (event.key === "Home") next.setDate(next.getDate() - (next.getDay() - weekStart + 7) % 7);
        else if (event.key === "End") next.setDate(next.getDate() + 6 - (next.getDay() - weekStart + 7) % 7);
        else if (event.key === "PageUp" || event.key === "PageDown") {
          event.preventDefault(); move(moveMonth(active, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1))); return;
        } else return;
        event.preventDefault(); move(next);
      }}>
        <div role="row">{Array.from({ length: 7 }, (_, index) => {
          const day = new Date(2026, 0, 4 + (index + weekStart) % 7, 12);
          return <span role="columnheader" key={index} aria-label={day.toLocaleDateString(locale, { weekday: "long" })}>{day.toLocaleDateString(locale, { weekday: "short" })}</span>;
        })}</div>
        {Array.from({ length: cells / 7 }, (_, week) => <div role="row" key={week}>
          {Array.from({ length: 7 }, (_, day) => {
            const number = week * 7 + day - offset + 1;
            if (number < 1 || number > last.getDate()) return <span role="gridcell" key={day} />;
            const date = new Date(first);
            date.setDate(number);
            const formatted = dateValue(date);
            return <button type="button" role="gridcell" key={day} tabIndex={formatted === activeValue ? 0 : -1}
              aria-selected={formatted === value} aria-current={formatted === dateValue() ? "date" : undefined}
              aria-label={date.toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
              onClick={() => choose(formatted)}>{number}</button>;
          })}
        </div>)}
      </div>
      <button type="button" className="secondary" onClick={() => choose(dateValue())}>{t("Today")}</button>
    </div>
  </Sheet>;
}

export function DateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const invalidMessage = t("Enter a valid date.");
  useLayoutEffect(() => { input.current?.setCustomValidity(value && !validDate(value) ? invalidMessage : ""); }, [value, invalidMessage]);
  return <div className="date-field">
    <label htmlFor={id}>{t("Date")}</label>
    <div className="date-input">
      <input ref={input} id={id} type="text" placeholder="YYYY-MM-DD" value={value} required maxLength={10} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="icon-button" aria-label={t("Choose date")} aria-haspopup="dialog" aria-expanded={open} onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}><CalendarDays size={21} /></button>
    </div>
    {open && <Calendar value={value} close={() => setOpen(false)} choose={(date) => { onChange(date); setOpen(false); }} />}
  </div>;
}

interface Confirmation {
  title: string; description: string; action: string; dangerous?: boolean;
}
const ConfirmationContext = createContext<((options: Confirmation) => Promise<boolean>) | null>(null);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const descriptionId = useId();
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolve = useRef<((accepted: boolean) => void) | null>(null);
  const confirm = useCallback((options: Confirmation) => new Promise<boolean>((done) => {
    resolve.current?.(false);
    resolve.current = done;
    setRequest(options);
  }), []);
  useEffect(() => () => { resolve.current?.(false); }, []);
  function finish(accepted: boolean) {
    resolve.current?.(accepted); resolve.current = null; setRequest(null);
  }
  return <ConfirmationContext.Provider value={confirm}>
    {children}
    {request && <Sheet title={request.title} close={() => finish(false)} compact initialFocus=".confirmation-cancel" describedBy={descriptionId}>
      <div className="panel-content">
        <p id={descriptionId}>{request.description}</p>
        <div className="button-row">
          <button type="button" className="secondary confirmation-cancel" onClick={() => finish(false)}>{t("Cancel")}</button>
          <button type="button" className={`primary${request.dangerous ? " danger-button" : ""}`} onClick={() => finish(true)}>{request.action}</button>
        </div>
      </div>
    </Sheet>}
  </ConfirmationContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("ConfirmationProvider is missing.");
  return confirm;
}
