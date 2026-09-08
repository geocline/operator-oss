"use client";

import { useEffect, useState } from "react";
import { jget } from "../api";

interface TaskLite {
  id: string;
  project_id: string;
  title: string;
  status: string;
  updated_at: number;
  project_name: string;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Collapsed footer that, once expanded, lists done/cancelled tasks — they
 * leave the floor (tasks/todo.md: "done / cancelled leave the floor") but
 * nothing is deleted, so this is where they still live in Operator. */
export function AlumniDrawer({ onGoToTask }: { onGoToTask: (projectId: string, taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskLite[] | null>(null);

  useEffect(() => {
    if (!open || tasks !== null) return;
    jget<{ tasks: TaskLite[] }>("/api/tasks")
      .then((r) => setTasks(r.tasks.filter((t) => t.status === "done" || t.status === "cancelled")))
      .catch(() => setTasks([]));
  }, [open, tasks]);

  return (
    <div className={`ofc-alumni${open ? " open" : ""}`}>
      <button className="ofc-alumni-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Alumni</span>
        <span className="ofc-alumni-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="ofc-alumni-list">
          {tasks === null ? (
            <div className="ofc-notes-empty">Loading…</div>
          ) : tasks.length === 0 ? (
            <div className="ofc-notes-empty">No retired tasks yet.</div>
          ) : (
            tasks
              .sort((a, b) => b.updated_at - a.updated_at)
              .map((t) => (
                <button key={t.id} className="ofc-alumni-row" onClick={() => onGoToTask(t.project_id, t.id)}>
                  <span className="ofc-alumni-title" title={t.title}>{t.title}</span>
                  <span className="ofc-alumni-proj">{t.project_name}</span>
                  <span className="ofc-alumni-status">{t.status}</span>
                  <span className="ofc-alumni-date">{fmtDate(t.updated_at)}</span>
                </button>
              ))
          )}
        </div>
      )}
    </div>
  );
}
