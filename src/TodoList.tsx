import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ClipboardCheck, GripVertical, Sun } from "lucide-react";
import type { Entry } from "../shared/model";
import type { Todo } from "../shared/todo";
import type { Conflict } from "./db";
import { useLocale } from "./i18n";
import { expenseCategory } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import SwipeableRow from "./SwipeableRow";
import { reorderTodos, replaceManualSlots, type HouseholdTodo } from "./todos";

function householdTodoId(item: HouseholdTodo) {
  return item.kind === "manual" ? `manual-${item.todo.id}` : `insurance-${item.entry.id}`;
}

export default function TodoList({ todos, conflicts, openCount, blocked, open, toggle, edit, toggleManual, reorder, remove, onError }: {
  todos: HouseholdTodo[]; conflicts: Conflict<Todo>[];
  openCount: number; blocked: Set<string>;
  open: (entry: Entry) => void; toggle: (entry: Entry, submitted: boolean) => void;
  edit: (todo: Todo) => void; toggleManual: (todo: Todo, done: boolean) => void;
  reorder: (changes: Todo[]) => Promise<void>;
  remove: (item: HouseholdTodo) => Promise<void>; onError: (error: unknown) => void;
}) {
  const { t, number, money } = useLocale();
  const [swipedTodo, setSwipedTodo] = useState<string | null>(null);
  const swipedTodoRef = useRef<string | null>(null);
  const [celebratingTodo, setCelebratingTodo] = useState<string | null>(null);
  const [celebrationPosition, setCelebrationPosition] = useState<{ id: string; index: number } | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  const pendingDrag = useRef<{ id: string; pointer: number; x: number; y: number } | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const [announcement, setAnnouncement] = useState("");
  const openList = useRef<HTMLUListElement>(null);
  const rowPositions = useRef(new Map<HTMLElement, number>());
  const rowAnimations = useRef(new Map<HTMLElement, Animation>());
  const dragPosition = useRef<{ element: HTMLElement; grabOffset: number; y: number } | null>(null);
  const focusAfterMove = useRef<string | null>(null);
  const reorderHint = useId();
  const manualBlocked = new Set(conflicts.map((conflict) => conflict.entryId));
  const openManual = todos.flatMap((item) => item.kind === "manual" && !item.done ? [item.todo] : []);
  const canReorder = openManual.length > 1 && openManual.every((todo) => !manualBlocked.has(todo.id));
  useLayoutEffect(() => {
    const list = openList.current;
    const positions = new Map<HTMLElement, number>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (list) {
      const listTop = list.getBoundingClientRect().top;
      for (const element of list.querySelectorAll<HTMLElement>("[data-manual-id]")) {
        const top = element.offsetTop;
        positions.set(element, top);
        if (element === dragPosition.current?.element) {
          rowAnimations.current.get(element)?.cancel();
          rowAnimations.current.delete(element);
          element.style.transform = `translateY(${dragPosition.current.y - dragPosition.current.grabOffset - listTop - top}px)`;
          continue;
        }
        const previous = rowPositions.current.get(element);
        const settling = element.style.transform !== "";
        if (previous === undefined || (previous === top && !settling)) continue;
        // Include unfinished motion so rapid direction changes never snap a row.
        const offset = element.getBoundingClientRect().top - listTop - top + previous - top;
        rowAnimations.current.get(element)?.cancel();
        element.style.transform = "";
        rowAnimations.current.delete(element);
        if (!reducedMotion && Math.abs(offset) > .5) {
          const animation = element.animate([
            { transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }
          ], { duration: 280, easing: "cubic-bezier(.22, 1, .36, 1)" });
          rowAnimations.current.set(element, animation);
          animation.onfinish = () => {
            if (rowAnimations.current.get(element) === animation) rowAnimations.current.delete(element);
          };
        }
      }
    }
    for (const [element, animation] of rowAnimations.current) {
      if (!positions.has(element)) { animation.cancel(); rowAnimations.current.delete(element); }
    }
    rowPositions.current = positions;
  });
  useEffect(() => {
    const animations = rowAnimations.current;
    return () => { for (const animation of animations.values()) animation.cancel(); };
  }, []);
  useEffect(() => {
    if (!celebratingTodo) return;
    let timeout = window.setTimeout(finish, 850);
    function finish() {
      if (document.querySelector("dialog[open]")) {
        timeout = window.setTimeout(finish, 100);
        return;
      }
      if (swipedTodoRef.current !== celebratingTodo) setCelebrationPosition(null);
      setCelebratingTodo(null);
    }
    return () => window.clearTimeout(timeout);
  }, [celebratingTodo]);
  useEffect(() => {
    if (draggingRef.current) return;
    setPreview(null);
    if (focusAfterMove.current) {
      openList.current?.querySelector<HTMLButtonElement>(`[data-reorder-id="${CSS.escape(focusAfterMove.current)}"]`)?.focus();
      focusAfterMove.current = null;
    }
  }, [todos]);

  function startDrag(id: string | null) { draggingRef.current = id; setDragging(id); }

  function updateSwipedTodo(id: string | null) {
    swipedTodoRef.current = id;
    setSwipedTodo(id);
    if (celebrationPosition && celebrationPosition.id !== id && celebrationPosition.id !== celebratingTodo) {
      setCelebrationPosition(null);
    }
  }

  function completeTodo(id: string, complete: () => void) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      complete();
      return;
    }
    const index = orderedGroup(todos.filter((item) => !item.done)).findIndex((item) => householdTodoId(item) === id);
    if (index >= 0) setCelebrationPosition({ id, index });
    setCelebratingTodo(id);
    complete();
  }

  function beginDrag(todo: Todo, pointerId: number, startY: number, currentY: number) {
    const list = openList.current;
    const element = list?.querySelector<HTMLElement>(`[data-manual-id="${CSS.escape(todo.id)}"]`);
    if (!list || !element) return;
    dragPosition.current = { element, grabOffset: startY - element.getBoundingClientRect().top, y: currentY };
    list.setPointerCapture(pointerId);
    let order = openManual.map((item) => item.id);
    updateSwipedTodo(null);
    setPreview(order);
    startDrag(todo.id);
    const updatePosition = (y: number) => {
      const drag = dragPosition.current;
      if (!drag) return;
      const listTop = list.getBoundingClientRect().top;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-manual-id]")];
      const bottom = Math.max(...rows.map((row) => row.offsetTop + row.offsetHeight));
      const top = Math.max(0, Math.min(bottom - element.offsetHeight, y - drag.grabOffset - listTop));
      drag.y = listTop + top + drag.grabOffset;
      element.style.transform = `translateY(${top - element.offsetTop}px)`;
      const others = rows
        .filter((element) => element.dataset.manualId !== todo.id);
      const index = others.findIndex((element) => y < listTop + element.offsetTop + element.offsetHeight / 2);
      const next = others.map((element) => element.dataset.manualId!);
      next.splice(index === -1 ? next.length : index, 0, todo.id);
      if (next.join() !== order.join()) { order = next; setPreview(next); }
    };
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointerId) updatePosition(event.clientY);
    };
    const end = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      stopDrag.current?.();
      dragPosition.current = null;
      startDrag(null);
      if (event.type === "pointercancel") setPreview(null);
      else move(todo, order.indexOf(todo.id));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    stopDrag.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
      stopDrag.current = null;
    };
    updatePosition(currentY);
  }

  function move(todo: Todo, to: number) {
    const from = openManual.findIndex((item) => item.id === todo.id);
    const changes = reorderTodos(openManual, from, to);
    if (!changes.length) { setPreview(null); return; }
    const order = openManual.filter((item) => item.id !== todo.id).map((item) => item.id);
    order.splice(to, 0, todo.id);
    setPreview(order);
    setAnnouncement(t("Moved {title} to position {position} of {total}.", { title: todo.title, position: number(to + 1), total: number(openManual.length) }));
    reorder(changes).catch((error: unknown) => { setPreview(null); focusAfterMove.current = null; onError(error); });
  }

  function orderedGroup(group: HouseholdTodo[]) {
    if (!preview) return group;
    const rank = new Map(preview.map((id, index) => [id, index]));
    const manual = group.filter((item): item is Extract<HouseholdTodo, { kind: "manual" }> => item.kind === "manual" && !item.done)
      .sort((a, b) => (rank.get(a.todo.id) ?? 0) - (rank.get(b.todo.id) ?? 0));
    return replaceManualSlots(group, manual);
  }

  return <section className="todos-page"><header className="page-heading"><div><h1>{t("To-dos")}</h1><p>{t("{count} open", { count: number(openCount) })}</p></div></header>
    <div aria-live="polite" aria-atomic="true">
      {openCount === 0 && <div className="empty-state todo-clear-state">
        <span className="todo-clear-icon" aria-hidden="true"><Sun size={30} /></span>
        <h2>{t("All caught up!")}</h2>
        <p>{t("Nothing left to chase. Enjoy your day.")}</p>
        {!todos.length && <p className="todo-clear-hint">{t("Add your own to-dos here. You can turn automatic insurance to-dos on or off in Settings.")}</p>}
      </div>}
    </div>
    <p className="sr-only" aria-live="polite">{announcement}</p>
    <p id={reorderHint} hidden>{t("Drag, or use the arrow keys, to change the order.")}</p>
    {[false, true].map((done) => {
        const group = orderedGroup(todos.filter((todo) => {
          const id = householdTodoId(todo);
          return celebratingTodo === id || swipedTodo === id ? !done : todo.done === done;
        }));
        if (!done && celebrationPosition && (celebratingTodo === celebrationPosition.id || swipedTodo === celebrationPosition.id)) {
          const currentIndex = group.findIndex((item) => householdTodoId(item) === celebrationPosition.id);
          if (currentIndex >= 0 && currentIndex !== celebrationPosition.index) {
            const [item] = group.splice(currentIndex, 1);
            if (item) group.splice(Math.min(celebrationPosition.index, group.length), 0, item);
          }
        }
        return !!group.length && <section key={String(done)} className="todo-group" aria-label={t(done ? "Done" : "Open to-dos")}>
          {done && <h2 className="section-label">{t("Done")}</h2>}
          <ul className="todo-list" ref={done ? undefined : openList}>{group.map((item) => {
            if (item.kind === "manual") {
              const { todo } = item;
              const id = `manual-${todo.id}`;
              const reorderable = !done && canReorder;
              return <li key={id} className={`todo-item manual-todo ${done ? "done" : ""}${dragging === todo.id ? " reordering" : ""}`}
                data-manual-id={done ? undefined : todo.id}>
                <SwipeableRow description={todo.title} disabled={manualBlocked.has(todo.id)} open={swipedTodo === id}
                  setOpen={(open) => updateSwipedTodo(open ? id : null)} edit={() => edit(todo)} remove={() => remove(item)} onError={onError}
                  actionsLabel={t("To-do actions")} editLabel={t("Edit to-do")} deleteLabel={t("Delete to-do")}
                  deleteConfirmation={t("Delete this to-do for everyone in your household? This will sync when you are online.")}>
                  <div className="todo-row">
                    <label className="todo-check"><input type="checkbox" aria-label={todo.title} checked={item.done} disabled={manualBlocked.has(todo.id)} onChange={(event) => {
                      const completed = event.target.checked;
                      if (completed) completeTodo(id, () => toggleManual(todo, true));
                      else {
                        if (celebratingTodo === id) {
                          setCelebratingTodo(null);
                          setCelebrationPosition(null);
                        }
                        toggleManual(todo, false);
                      }
                    }} /></label>
                    {celebratingTodo === id && <TodoConfetti />}
                    <button id={`todo-details-${id}`} className="todo-details" disabled={manualBlocked.has(todo.id)} onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      edit(todo);
                    }}>
                      <span className="entry-icon"><ClipboardCheck size={20} /></span>
                      <span className="entry-description"><strong>{todo.title}</strong>{todo.description && <small>{todo.description}</small>}</span>
                    </button>
                    {reorderable && <button type="button" className="reorder-handle icon-button" data-reorder-id={todo.id}
                      aria-label={`${t("Reorder to-do")}: ${todo.title}`} aria-describedby={reorderHint}
                      onPointerDown={(event) => {
                        if (!event.isPrimary || event.button !== 0) return;
                        pendingDrag.current = { id: todo.id, pointer: event.pointerId, x: event.clientX, y: event.clientY };
                      }}
                      onPointerMove={(event) => {
                        const pending = pendingDrag.current;
                        if (pending?.id !== todo.id || pending.pointer !== event.pointerId) return;
                        const dx = event.clientX - pending.x, dy = event.clientY - pending.y;
                        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 8) return;
                        pendingDrag.current = null;
                        // Horizontal gestures stay with the swipe row; vertical ones reorder.
                        if (Math.abs(dy) > Math.abs(dx)) beginDrag(todo, event.pointerId, pending.y, event.clientY);
                      }}
                      onPointerUp={() => { pendingDrag.current = null; }}
                      onPointerCancel={() => { pendingDrag.current = null; }}
                      onKeyDown={(event) => {
                        const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                        if (!offset) return;
                        event.preventDefault();
                        const to = openManual.findIndex((item) => item.id === todo.id) + offset;
                        if (to < 0 || to >= openManual.length) return;
                        focusAfterMove.current = todo.id;
                        move(todo, to);
                      }}>
                      <GripVertical size={20} aria-hidden="true" />
                    </button>}
                  </div>
                </SwipeableRow>
              </li>;
            }
            const { entry } = item;
            const category = expenseCategory(entry.description, entry.category, entry.kind, entry.categoryMode);
            const id = `insurance-${entry.id}`;
            return <li key={id} className={`todo-item ${done ? "done" : ""}`}>
              <SwipeableRow description={entry.description} disabled={blocked.has(entry.id)} open={swipedTodo === id}
                setOpen={(open) => updateSwipedTodo(open ? id : null)} edit={() => open(entry)} remove={() => remove(item)} onError={onError}
                actionsLabel={t("To-do actions")} editLabel={t("Open expense")} deleteLabel={t("Delete entry")}
                deleteConfirmation={t("Delete this entry for both of you? This will sync when you are online.")}>
                <div className="todo-row">
                  <label className="todo-check"><input type="checkbox" aria-label={`${t("Submit to insurance")}: ${entry.description}`} checked={item.done} disabled={blocked.has(entry.id)} onChange={(event) => {
                    const completed = event.target.checked;
                    if (completed) completeTodo(id, () => toggle(entry, true));
                    else {
                      if (celebratingTodo === id) {
                        setCelebratingTodo(null);
                        setCelebrationPosition(null);
                      }
                      toggle(entry, false);
                    }
                  }} /></label>
                  {celebratingTodo === id && <TodoConfetti />}
                  <button id={`todo-details-${id}`} className="todo-details" disabled={blocked.has(entry.id)} onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    open(entry);
                  }}>
                    <span className="entry-icon" data-category={category}><ExpenseIcon category={category} /></span>
                    <span className="entry-description"><strong>{entry.description}</strong><small>{t("Submit to insurance · {amount}", { amount: money(entry.amountCents) })}</small></span>
                  </button>
                </div>
              </SwipeableRow>
            </li>;
          })}</ul>
        </section>;
      })}
  </section>;
}

function TodoConfetti() {
  return <span className="todo-confetti" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} />)}</span>;
}
