type SyncIconState = "current" | "syncing" | "pending" | "attention" | "offline";

export default function SyncIcon({ state }: { state: SyncIconState }) {
  return <svg className="sync-icon" data-sync-state={state} width="24" height="24" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    <path className="sync-cloud" d="M7 20.5h10.75a4.75 4.75 0 0 0 .7-9.45 6.5 6.5 0 0 0-12.8-1.4A5.5 5.5 0 0 0 7 20.5Z" />
    {state === "current" && <path className="sync-check" d="m8.75 14 2.25 2.25 4.5-4.5" />}
    {state === "syncing" && <g className="sync-arrows" strokeWidth="1.4">
      <path d="M9.12 12.6a3.06 3.06 0 0 1 5.22-1.26l.72.99m0-1.98v1.98h-1.98" />
      <path d="M14.88 14.4a3.06 3.06 0 0 1-5.22 1.26l-.72-.99m0 1.98v-1.98h1.98" />
    </g>}
    {state === "pending" && <g strokeWidth="1.5">
      <circle cx="12" cy="13.5" r="4.25" />
      <path d="M12 11v2.5l1.75 1" />
    </g>}
    {state === "attention" && <path d="M12 11.25v3m0 2.5h.01" />}
    {state === "offline" && <path d="m9.75 11.75 4.5 4.5m0-4.5-4.5 4.5" />}
  </svg>;
}
