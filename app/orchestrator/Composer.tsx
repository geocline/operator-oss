"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { attachmentMarker, fileAttachmentMarker } from "./format";
import { PASTE_ATTACH_THRESHOLD } from "@/lib/promptLimits";
import type { TaskRow } from "./types";

// Drafts persist per-task in localStorage so switching tasks, opening Settings,
// or reloading the page doesn't throw away half-typed messages. (SessionView is
// keyed by task.id, so the Composer remounts on every task switch.)
const draftKey = (taskId: string) => `orch:draft:${taskId}`;
const loadDraft = (taskId: string) => {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(draftKey(taskId)) ?? ""; } catch { return ""; }
};
const saveDraft = (taskId: string, v: string) => {
  if (typeof window === "undefined") return;
  try {
    if (v) window.localStorage.setItem(draftKey(taskId), v);
    else window.localStorage.removeItem(draftKey(taskId));
  } catch { /* private mode / quota — drafts just won't persist */ }
};

// An attachment on the draft — any picked/dropped file, pasted image, or large
// text paste diverted to a .txt file (see PASTE_ATTACH_THRESHOLD) so it never
// bloats the prompt and poisons the session. Uploaded eagerly on attach so send
// stays instant; on send its server path is appended to the message as a marker
// line (attachmentMarker for images, fileAttachmentMarker for other files). Not
// persisted with the draft — object URLs don't survive a remount, and an unsent
// upload is just an orphaned file that the task's hard delete sweeps away.
type Attachment = {
  key: string;
  kind: "image" | "file";
  name: string;
  preview: string; // local object URL for the image thumbnail ("" for other files)
  path: string; // absolute server path once uploaded
  status: "uploading" | "ready" | "error";
  error?: string;
};

export function Composer({ task, agentLabel, disabled, running, models, onSend, onStop, onClear, onHandoff }: { task: TaskRow; agentLabel: string; disabled: boolean; running: boolean; models: { value: string; label: string }[]; onSend: (t: string) => void; onStop: () => void; onClear: () => void; onHandoff: (model: string | null) => void }) {
  const [val, setVal] = useState(() => loadDraft(task.id));
  const [slash, setSlash] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire per child element — depth-count to know when the
  // pointer has really left the drop zone.
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const attSeq = useRef(0);
  // Reset the stopping state once the turn actually ends.
  useEffect(() => { if (!running) setStopping(false); }, [running]);
  // Mirror the draft to localStorage so it survives remounts/navigation.
  useEffect(() => { saveDraft(task.id, val); }, [task.id, val]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const autosize = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; };
  // Grow the box to fit a restored draft and reflect the slash menu state.
  useEffect(() => {
    if (ref.current) autosize(ref.current);
    setSlash(val.trim().startsWith("/"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const addFiles = (files: File[]) => {
    if (disabled) return;
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const key = `att-${++attSeq.current}`;
      const kind = isImage ? "image" : "file";
      const name = f.name || (isImage ? "image" : "pasted-text.txt");
      // Only images get a local object-URL thumbnail; other files render a label.
      const preview = isImage ? URL.createObjectURL(f) : "";
      setAtts((prev) => [...prev, { key, kind, name, preview, path: "", status: "uploading" }]);
      const body = new FormData();
      body.append("file", f, name);
      fetch(`/api/tasks/${task.id}/uploads`, { method: "POST", body })
        .then(async (res) => {
          const j = await res.json().catch(() => ({} as { path?: string; error?: string }));
          if (!res.ok || !j.path) throw new Error(j.error || `Upload failed (${res.status})`);
          setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, path: j.path as string, status: "ready" } : a)));
        })
        .catch((err: unknown) => {
          setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, status: "error", error: err instanceof Error ? err.message : String(err) } : a)));
        });
    }
  };
  const removeAtt = (key: string) => {
    setAtts((prev) => {
      const gone = prev.find((a) => a.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.key !== key);
    });
  };
  const hasFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const ready = atts.filter((a) => a.status === "ready");
  const uploading = atts.some((a) => a.status === "uploading");
  const cmds = [
    // /clear and /handoff need a live session to act on; a fresh (or just-
    // cleared) generation only offers /help.
    ...(task.started === 1 ? [
      { cmd: "/clear", desc: "renew: save summary, fresh session (transcript kept, waits for your first prompt)", run: () => { onClear(); setVal(""); setSlash(false); } },
      { cmd: "/handoff", desc: "write a handoff doc, then fresh session — pick the model", run: () => { setVal("/handoff "); setSlash(true); ref.current?.focus(); } },
    ] : []),
    { cmd: "/help", desc: "show all commands", run: () => { setVal("/"); setSlash(true); ref.current?.focus(); } },
  ];
  // /handoff's second step: a model submenu (keep current, or any of the
  // driver's models). Chosen model rides across the clear boundary.
  const handoffMode = val.trim().toLowerCase().startsWith("/handoff");
  const handoffFilter = handoffMode ? val.trim().slice("/handoff".length).trim().toLowerCase() : "";
  const handoffOpts: { key: string; label: string; model: string | null }[] = [
    { key: "same", label: `Keep current model (${models.find((m) => m.value === task.model)?.label ?? "Default"})`, model: null },
    ...models.map((m) => ({ key: m.value, label: m.label, model: m.value as string | null })),
  ].filter((o) => !handoffFilter || o.label.toLowerCase().includes(handoffFilter));
  const pickHandoff = (model: string | null) => {
    onHandoff(model);
    setVal(""); setSlash(false);
    if (ref.current) ref.current.style.height = "auto";
  };
  const submit = () => {
    const v = val.trim();
    if ((!v && ready.length === 0) || disabled || uploading) return;
    // /clear can't run mid-turn (it would collide with the live session) — while
    // running, everything you type is queued as a follow-up instead.
    if (v === "/clear" && !running && ready.length === 0) { onClear(); setVal(""); setSlash(false); if (ref.current) ref.current.style.height = "auto"; return; }
    // /handoff opens the model submenu; Enter with one option left picks it.
    if (handoffMode && !running && ready.length === 0 && task.started === 1) {
      if (handoffFilter && handoffOpts.length === 1) pickHandoff(handoffOpts[0].model);
      else { setVal("/handoff "); setSlash(true); }
      return;
    }
    if (v === "/help") { setVal("/"); setSlash(true); return; }
    // Attachments ride along as marker lines after the typed text — an image or
    // file marker depending on the attachment kind.
    onSend([v, ...ready.map((a) => (a.kind === "image" ? attachmentMarker(a.path) : fileAttachmentMarker(a.path)))].filter(Boolean).join("\n\n"));
    atts.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });
    setAtts([]); setVal(""); setSlash(false);
    if (ref.current) ref.current.style.height = "auto";
  };
  const canSend = (!!val.trim() || ready.length > 0) && !uploading;
  const filtered = cmds.filter((c) => c.cmd.startsWith(val.trim()));
  return (
    <div className="composer">
      <div className="composer-inner">
        {slash && !running && handoffMode && task.started === 1 && (
          <div className="slash">
            <div className="slash-item" style={{ pointerEvents: "none", opacity: 0.7 }}>
              <span className="cmd">/handoff</span><span className="cd">hand off to… (type to filter, click or ⏎ to pick)</span>
            </div>
            {handoffOpts.map((o) => (
              <div key={o.key} className="slash-item" onMouseDown={(e) => { e.preventDefault(); pickHandoff(o.model); }}>
                <span className="cmd">{o.label}</span>
              </div>
            ))}
          </div>
        )}
        {slash && !running && !handoffMode && filtered.length > 0 && (
          <div className="slash">
            {filtered.map((c) => (
              <div key={c.cmd} className="slash-item" onMouseDown={(e) => { e.preventDefault(); c.run(); }}>
                <span className="cmd">{c.cmd}</span><span className="cd">{c.desc}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className={`comp-box${dragging ? " dropping" : ""}`}
          onDragEnter={(e) => { if (!disabled && hasFileDrag(e)) { e.preventDefault(); dragDepth.current++; setDragging(true); } }}
          onDragOver={(e) => { if (!disabled && hasFileDrag(e)) e.preventDefault(); }}
          onDragLeave={() => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); }}
          onDrop={(e) => { if (disabled || !hasFileDrag(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          {atts.length > 0 && (
            <div className="attach-row">
              {atts.map((a) => (
                <div key={a.key} className={`attach-chip ${a.kind} ${a.status}`} title={a.error || a.name}>
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.preview} alt={a.name} />
                  ) : (
                    <span className="attach-file">{Icon.clip()} {a.name}</span>
                  )}
                  {a.status === "uploading" && <span className="attach-badge">uploading…</span>}
                  {a.status === "error" && <span className="attach-badge err">failed</span>}
                  <button className="attach-x" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a.key)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="comp-area">
            <textarea
              ref={ref} rows={1} value={val} disabled={disabled}
              placeholder={disabled ? "Start the session to reply…" : running ? "Queue a follow-up… (sent when this turn ends)" : task.started !== 1 ? "Fresh session ready — nothing runs until you send. Write its opening prompt (pick the model above first), or press Start for the task description…" : `Reply to ${agentLabel} in “${task.title}”…  (try Renew, drop a file)`}
              onChange={(e) => { setVal(e.target.value); autosize(e.target); setSlash(e.target.value.trim().startsWith("/")); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") setSlash(false); }}
              onPaste={(e) => {
                const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                if (imgs.length) { e.preventDefault(); addFiles(imgs); return; }
                // A huge text paste would balloon the prompt and can permanently
                // poison the session ("Prompt is too long"). Divert anything over
                // the threshold to a .txt attachment instead of inlining it.
                const text = e.clipboardData?.getData("text/plain") ?? "";
                if (text.length > PASTE_ATTACH_THRESHOLD) {
                  e.preventDefault();
                  addFiles([new File([text], "pasted-text.txt", { type: "text/plain" })]);
                }
              }}
            />
            {running ? (
              // Mid-turn: queue the typed follow-up (when there's text), and keep
              // Stop available to interrupt the current turn.
              <div className="send-group">
                {canSend && <button className="send queue" onClick={submit} title="Queue this follow-up — it'll send when the current turn ends">{Icon.send()}</button>}
                <button className="send stop" onClick={() => { setStopping(true); onStop(); }} disabled={stopping} title={stopping ? "Stopping…" : "Stop the current turn"}>{Icon.stop()}</button>
              </div>
            ) : (
              <button className="send" disabled={!canSend || disabled} onClick={submit}>{Icon.send()}</button>
            )}
          </div>
          <div className="comp-foot">
            <span className="hint"><span className="kbd">⏎</span> send</span>
            <span className="hint"><span className="kbd">⇧⏎</span> newline</span>
            <span className="hint"><span className="kbd">/</span> commands</span>
            <span className="spacer" />
            <input
              ref={fileRef} type="file" multiple hidden
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
            {!disabled && (
              <button className="hint" style={{ cursor: "pointer" }} title="Attach a file - image, PDF, spreadsheet, anything (or drag & drop / paste)" onMouseDown={(e) => { e.preventDefault(); fileRef.current?.click(); }}>{Icon.clip()} file</button>
            )}
            {/* Renew is a real mid-turn capability (tests/clearMidTurn.test.ts pins
                it) — rendered whenever a session exists, suppressed (not
                disabled) otherwise. Same rule as the header and SessionRail
                Renew controls. */}
            {task.started === 1 && (
              <button className="hint" style={{ cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); onClear(); }} title="Summarize and continue in a fresh context window (also: type /clear)">{Icon.clear()} Renew</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
