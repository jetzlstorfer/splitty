import { useState } from "react";
import { Trash2 } from "lucide-react";
import { MAX_TODO_TITLE, MAX_TODO_DESCRIPTION, type Todo } from "../shared/todo";
import { queueTodos } from "./db";
import { useLocale } from "./i18n";
import { Form, Sheet, useConfirm } from "./Controls";

export default function TodoForm({ todo, close, saved }: { todo?: Todo; close: () => void; saved: () => void }) {
  const { t, message, language } = useLocale();
  const confirm = useConfirm();
  const [title, setTitle] = useState(todo?.title ?? "");
  const [description, setDescription] = useState(todo?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(deleted = false) {
    setBusy(true); setError("");
    try {
      const timestamp = new Date().toISOString();
      await queueTodos([deleted && todo ? { ...todo, deleted: true } : {
        id: todo?.id ?? crypto.randomUUID(), title, description, done: todo?.done ?? false,
        ...(todo?.position !== undefined ? { position: todo.position } : {}),
        createdAt: todo?.createdAt ?? timestamp, updatedAt: timestamp, revision: todo?.revision ?? 0, deleted: false
      }]);
      saved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this to-do."); }
    finally { setBusy(false); }
  }

  return <Sheet title={t(todo ? "Edit to-do" : "Add to-do")} close={close} initialFocus={!todo ? "#todo-title" : undefined}>
    <Form className="panel-content" lang={language} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor="todo-title">{t("Title")}<input id="todo-title" required maxLength={MAX_TODO_TITLE} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t("Description (optional)")}<textarea rows={4} maxLength={MAX_TODO_DESCRIPTION} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      {error && <p className="error" role="alert">{message(error)}</p>}
      <button className="primary" disabled={busy}>{t(busy ? "Saving…" : "Save")}</button>
      {todo && <button type="button" className="danger-link" disabled={busy} onClick={async (event) => {
        event.currentTarget.focus();
        if (await confirm({ title: t("Delete to-do"), description: t("Delete this to-do for everyone in your household? This will sync when you are online."), action: t("Delete to-do"), dangerous: true })) await save(true);
      }}><Trash2 size={16} />{t("Delete to-do")}</button>}
    </Form>
  </Sheet>;
}
