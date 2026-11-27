import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import type { Entry } from "../shared/model";
import type { Todo } from "../shared/todo";
import { db, localQueueState, type Conflict, type Preferences, type SplittyDatabase } from "./db";

export interface Snapshot {
  database: SplittyDatabase;
  entries: Entry[]; todos: Todo[]; pending: number; preferences: Preferences;
  conflicts: Conflict[]; todoConflicts: Conflict<Todo>[];
}

export function useLedger(): Snapshot | null {
  const [value, setValue] = useState<Snapshot | null>(null);
  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    const subscribe = () => {
      const database = db;
      subscription = liveQuery(async () => {
        const [entries, todos, queue, conflicts, todoConflicts] = await Promise.all([
          database.entries.toArray(), database.todos.toArray(), localQueueState(database),
          database.conflicts.toArray(), database.todoConflicts.toArray()
        ]);
        return { database, entries, todos, ...queue, conflicts, todoConflicts };
      }).subscribe({
        next: setValue,
        error: (error: unknown) => window.dispatchEvent(new CustomEvent("splitty-error", {
          detail: `Local storage failed: ${error instanceof Error ? error.message : String(error)}`
        }))
      });
    };
    const stop = () => { subscription?.unsubscribe(); subscription = undefined; setValue(null); };
    subscribe();
    window.addEventListener("splitty-database-changing", stop);
    window.addEventListener("splitty-database-changed", subscribe);
    return () => {
      stop();
      window.removeEventListener("splitty-database-changing", stop);
      window.removeEventListener("splitty-database-changed", subscribe);
    };
  }, []);

  return value;
}
