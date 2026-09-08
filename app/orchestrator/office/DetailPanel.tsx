"use client";

import { useEffect, useRef, useState } from "react";
import { jget, jsend } from "../api";
import { agentLabel } from "../agents";
import type { AgentsBundle } from "../types";
import {
  recipeFromSeed, paintPortrait, type Recipe,
  SKIN_OPTIONS, HAIR_STYLE_OPTIONS, CLOTH_OPTIONS, BROW_OPTIONS, MOUTH_OPTIONS, FACIAL_OPTIONS,
  HAIR_COLOR_SWATCHES, CLOTH_COLOR_SWATCHES,
} from "./portraitArt";
import { ROOM_LABEL, roomFor, type OfficeTask, type TaskNoteRow } from "./types";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Swatch({ rgb, active, onClick, title }: { rgb: [number, number, number]; active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className={`ofc-swatch${active ? " on" : ""}`}
      style={{ background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    />
  );
}

const rgbEq = (a: [number, number, number], b: [number, number, number]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Live canvas preview of the recipe being edited. */
function LookPreview({ recipe }: { recipe: Recipe }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) paintPortrait(ctx, recipe, 5);
  }, [recipe]);
  return <canvas ref={ref} width={18 * 5} height={28 * 5} className="ofc-look-preview" />;
}

function LookEditor({ recipe, onChange }: { recipe: Recipe; onChange: (r: Recipe) => void }) {
  return (
    <div className="ofc-look-editor">
      <LookPreview recipe={recipe} />
      <div className="ofc-look-fields">
        <div className="ofc-look-row">
          <span className="ofc-look-label">Skin</span>
          <div className="ofc-swatch-row">
            {SKIN_OPTIONS.map((s) => (
              <button key={s} type="button" className={`ofc-pill${recipe.skin === s ? " on" : ""}`} onClick={() => onChange({ ...recipe, skin: s })}>{s}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Hair color</span>
          <div className="ofc-swatch-row">
            {HAIR_COLOR_SWATCHES.map((c, i) => (
              <Swatch key={i} rgb={c} active={rgbEq(recipe.hairc, c)} title={`hair ${i + 1}`} onClick={() => onChange({ ...recipe, hairc: c })} />
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Hairstyle</span>
          <div className="ofc-swatch-row">
            {HAIR_STYLE_OPTIONS.map((h) => (
              <button key={h} type="button" className={`ofc-pill${recipe.hair === h ? " on" : ""}`} onClick={() => onChange({ ...recipe, hair: h })}>{h.replace("style", "")}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Clothing</span>
          <div className="ofc-swatch-row">
            {CLOTH_OPTIONS.map((c) => (
              <button key={c} type="button" className={`ofc-pill${recipe.cloth === c ? " on" : ""}`} onClick={() => onChange({ ...recipe, cloth: c })}>{c}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Clothing color</span>
          <div className="ofc-swatch-row">
            {CLOTH_COLOR_SWATCHES.map((c, i) => (
              <Swatch key={i} rgb={c} active={rgbEq(recipe.c1, c)} title={`color ${i + 1}`} onClick={() => onChange({ ...recipe, c1: c })} />
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Brow</span>
          <div className="ofc-swatch-row">
            {BROW_OPTIONS.map((b) => (
              <button key={b} type="button" className={`ofc-pill${recipe.brow === b ? " on" : ""}`} onClick={() => onChange({ ...recipe, brow: b })}>{b}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Mouth</span>
          <div className="ofc-swatch-row">
            {MOUTH_OPTIONS.map((m) => (
              <button key={m} type="button" className={`ofc-pill${recipe.mouth === m ? " on" : ""}`} onClick={() => onChange({ ...recipe, mouth: m })}>{m}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row">
          <span className="ofc-look-label">Facial hair</span>
          <div className="ofc-swatch-row">
            {FACIAL_OPTIONS.map((f) => (
              <button key={f ?? "none"} type="button" className={`ofc-pill${recipe.facial === f ? " on" : ""}`} onClick={() => onChange({ ...recipe, facial: f })}>{f ?? "none"}</button>
            ))}
          </div>
        </div>
        <div className="ofc-look-row ofc-look-toggles">
          <label className="ofc-toggle"><input type="checkbox" checked={!!recipe.glasses} onChange={(e) => onChange({ ...recipe, glasses: e.target.checked })} /> Glasses</label>
          <label className="ofc-toggle"><input type="checkbox" checked={!!recipe.lashes} onChange={(e) => onChange({ ...recipe, lashes: e.target.checked })} /> Lashes</label>
          <label className="ofc-toggle"><input type="checkbox" checked={!!recipe.blush} onChange={(e) => onChange({ ...recipe, blush: e.target.checked })} /> Blush</label>
          <label className="ofc-toggle"><input type="checkbox" checked={!!recipe.heavy} onChange={(e) => onChange({ ...recipe, heavy: e.target.checked })} /> Heavier build</label>
        </div>
      </div>
    </div>
  );
}

export function DetailPanel({
  task, projectName, agents, mobile, onClose, onGoToTask, onPatched,
}: {
  task: OfficeTask;
  projectName: string;
  agents: AgentsBundle;
  mobile: boolean;
  onClose: () => void;
  onGoToTask: (projectId: string, taskId: string) => void;
  /** The panel owns its own PATCH calls (visual data isn't part of the shared
   * orchestrator store); this just lets the floor update its local copy of
   * the task so the name tag / avatar reflect the change immediately. */
  onPatched: (taskId: string, patch: { display_name?: string; avatar?: Recipe | null }) => void;
}) {
  const [alias, setAlias] = useState(task.display_name);
  const [recipe, setRecipe] = useState<Recipe>(task.avatar ?? recipeFromSeed(task.id));
  const [showLook, setShowLook] = useState(false);
  const [notes, setNotes] = useState<TaskNoteRow[] | null>(null);
  const [notesError, setNotesError] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    setAlias(task.display_name);
    setRecipe(task.avatar ?? recipeFromSeed(task.id));
    setShowLook(false);
    setNotes(null);
    setNotesError(false);
    setDraft("");
    let cancelled = false;
    jget<{ notes: TaskNoteRow[] }>(`/api/tasks/${task.id}/notes`)
      .then((r) => { if (!cancelled) setNotes(r.notes); })
      .catch(() => { if (!cancelled) setNotesError(true); });
    return () => { cancelled = true; };
  }, [task.id, task.display_name, task.avatar]);

  const saveAlias = () => {
    const trimmed = alias.trim().slice(0, 24);
    if (trimmed === task.display_name) return;
    onPatched(task.id, { display_name: trimmed });
    jsend(`/api/tasks/${task.id}/visual`, "PATCH", { display_name: trimmed }).catch(() => {});
  };

  const saveLook = (r: Recipe) => {
    setRecipe(r);
    onPatched(task.id, { avatar: r });
    jsend(`/api/tasks/${task.id}/visual`, "PATCH", { avatar: r }).catch(() => {});
  };

  const submitNote = () => {
    const content = draft.trim();
    if (!content || posting) return;
    setPosting(true);
    jsend<TaskNoteRow>(`/api/tasks/${task.id}/notes`, "POST", { content })
      .then((n) => { setNotes((prev) => [n, ...(prev ?? [])]); setDraft(""); })
      .catch(() => {})
      .finally(() => setPosting(false));
  };

  const room = ROOM_LABEL[roomFor(task)];

  return (
    <div className={`ofc-detail${mobile ? " ofc-detail-sheet" : " ofc-detail-panel"}`} role="region" aria-label="Task details">
      <div className="ofc-detail-bar">
        <span className="ofc-detail-title" title={task.title}>{task.title}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <div className="ofc-detail-body">
        <div className="ofc-detail-meta">
          <div><span className="ofc-meta-k">Project</span><span className="ofc-meta-v">{projectName}</span></div>
          <div><span className="ofc-meta-k">Room</span><span className="ofc-meta-v">{room}</span></div>
          <div><span className="ofc-meta-k">Status</span><span className="ofc-meta-v">{task.status}{task.awaiting_input ? " · waiting on you" : ""}</span></div>
          <div><span className="ofc-meta-k">Agent</span><span className="ofc-meta-v">{agentLabel(agents, task.agent)}</span></div>
        </div>

        <div className="ofc-detail-actions">
          <button className="btn btn-accent" onClick={() => onGoToTask(task.project_id, task.id)}>Open session</button>
          {task.card_url && (
            <a className="btn btn-line" href={task.card_url} target="_blank" rel="noopener noreferrer">Open card</a>
          )}
        </div>

        <label className="ofc-field">
          <span className="ofc-field-label">Alias (name tag)</span>
          <input
            className="ofc-input"
            value={alias}
            maxLength={24}
            placeholder={task.title.slice(0, 14)}
            onChange={(e) => setAlias(e.target.value)}
            onBlur={saveAlias}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        </label>

        <button className="ofc-collapse-toggle" onClick={() => setShowLook((v) => !v)}>
          {showLook ? "Hide look editor" : "Edit look"}
        </button>
        {showLook && <LookEditor recipe={recipe} onChange={saveLook} />}

        <div className="ofc-notes">
          <div className="ofc-notes-h">Status log</div>
          <div className="ofc-notes-compose">
            <textarea
              className="ofc-textarea"
              placeholder="Add a status note…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitNote(); } }}
            />
            <button className="btn btn-line" disabled={!draft.trim() || posting} onClick={submitNote}>Add status</button>
          </div>
          {notesError ? (
            <div className="ofc-notes-empty">Status log isn&apos;t available yet.</div>
          ) : notes === null ? (
            <div className="ofc-notes-empty">Loading…</div>
          ) : notes.length === 0 ? (
            <div className="ofc-notes-empty">No status notes yet.</div>
          ) : (
            <ul className="ofc-notes-list">
              {notes.map((n) => (
                <li key={n.id} className="ofc-note">
                  <div className="ofc-note-content">{n.content}</div>
                  <div className="ofc-note-meta">gen {n.generation} · {timeAgo(n.created_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
