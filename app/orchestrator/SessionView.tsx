"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Status, Priority, ToolData, AskQuestion, AskAnswers } from "@/lib/types";
import { Icon } from "../icons";
import TaskChanges, { type ResolveResult } from "../TaskChanges";
import { fmtTokens, fmtCost, modelLabel, isAwaiting, buildSessions, usageSplit, costDisplay, usageTooltip, elapsed, turnClockVisible, splitAttachments, producedFiles } from "./format";
import {
  SLABEL, SSUB, AWAIT_LABEL, STATUSES, PLABEL, PRIORITIES,
  modelOptions, reasoningOptions, permissionOptions, RAIL_W,
  type ProjectRow, type TaskRow, type Msg, type SyncStatusResp, type AgentsBundle,
  type WorkstreamLinkT,
} from "./types";
import { capsFor, agentLabel, findAgent, publicHarnessId } from "./agents";
import { launchModelReady, needsLaunchConfiguration } from "./launchConfig";
import { StatusDot, Avatar, Popover, Skel } from "./shared";
import { Modal } from "./Modal";
import { jsend } from "./api";
import { isFirstAssistantReply, MessageView, SessionBreak, AskPanel, ProducedFilesFooter } from "./Transcript";
import { Composer } from "./Composer";
import { SessionRail } from "./SessionRail";
import { ColResize, ColRail } from "./Layout";

// Optional "why is this done?" prompt shown on the not-done → done transition.
// The answer lands in the task's notes log (NOTES tab) — the freshest possible
// record of why the task closed. Skippable: done doesn't require a note.
function DoneNoteModal({ onClose, onDone }: {
  onClose: () => void; onDone: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const finish = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onDone(text);
    } catch {
      setErr("Couldn't save — try again.");
      setBusy(false);
    }
  };
  return (
    <Modal title="Mark done" sub="Leave a note about why - future you will ask." onClose={onClose} width={440}
      footer={<>
        <button className="btn btn-line" onClick={() => finish("")} disabled={busy}>Skip note</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-accent" onClick={() => finish(note.trim())} disabled={busy}>
          {busy ? "Saving…" : note.trim() ? "Save note & mark done" : "Mark done"}
        </button>
      </>}
    >
      <textarea
        className="notes-input"
        autoFocus
        rows={4}
        placeholder="Why is this done? Anything left for later?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") finish(note.trim()); }}
      />
      {err && <div className="notes-err">{err}</div>}
    </Modal>
  );
}

// Non-blocking banner shown when a reopened task's worktree is behind its base
// branch. Computed (read-only) on open; the actual git op fires only when the user
// clicks. Fast-forward-able tasks show nothing here — they catch up silently on the
// next message — so the banner only appears for tier 2 (clean merge → Sync) and
// tier 3 (conflicts → Fix with AI).
function SyncBanner({ taskId, running, onResolveWithAI, onSwitchToChat }: {
  taskId: string; running: boolean;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onSwitchToChat: () => void;
}) {
  const [st, setSt] = useState<SyncStatusResp | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await fetch(`/api/tasks/${taskId}/sync`, { cache: "no-store" }); setSt(await r.json()); }
    catch { setSt(null); }
  }, [taskId]);

  // Recompute on open and whenever a turn finishes (a turn may have fast-forwarded
  // or otherwise moved the branch). Skip while running to avoid mid-merge reads.
  useEffect(() => { if (!running) load(); }, [running, load]);

  if (!st || !st.isolated || !st.behind) return null;
  if (st.canFastForward) return null; // resolves silently on the next message

  const conflicts = st.conflicts?.length ?? 0;

  const doSync = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/sync`, { method: "POST" });
      const res = await r.json();
      // Prediction said clean but the real merge conflicted — escalate to Fix with AI.
      if (res?.conflicts?.length) { const fix = await onResolveWithAI(taskId); if (fix.ok && !fix.merged) onSwitchToChat(); }
    } finally { setBusy(false); load(); }
  };

  const doFix = async () => {
    setBusy(true);
    try { const res = await onResolveWithAI(taskId); if (res.ok && !res.merged) onSwitchToChat(); }
    finally { setBusy(false); load(); }
  };

  return (
    <div className={`sync-banner${conflicts ? " conflict" : ""}`}>
      <span className="sync-msg">
        {conflicts > 0
          ? `${st.behind} behind ${st.baseBranch} · conflicts in ${conflicts} file${conflicts === 1 ? "" : "s"}`
          : `${st.behind} commit${st.behind === 1 ? "" : "s"} behind ${st.baseBranch}`}
      </span>
      <span className="sync-spacer" />
      {conflicts > 0 ? (
        <button className="tc-btn primary" onClick={doFix} disabled={busy || running}>{busy ? "…" : "Fix with AI"}</button>
      ) : (
        <button className="tc-btn primary" onClick={doSync} disabled={busy || running}>{busy ? "Syncing…" : "Sync"}</button>
      )}
    </div>
  );
}

type WorkstreamUiCommand = "pause" | "resume" | "disconnect" | "post-now";

function WorkstreamTaskControls({ taskId }: { taskId: string }) {
  const [workstream, setWorkstream] = useState<
    WorkstreamLinkT | null | undefined
  >(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<WorkstreamUiCommand | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/tasks/${taskId}/workstream`,
        { cache: "no-store" },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        workstream?: WorkstreamLinkT | null;
      };
      return body.workstream ?? null;
    } catch {
      return null;
    }
  }, [taskId]);

  useEffect(() => {
    let current = true;
    setWorkstream(undefined);
    setOpen(false);
    setFailed(false);
    const refresh = () => {
      void load()
      .then((value) => {
        if (current) setWorkstream(value);
      });
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => {
      current = false;
      clearInterval(interval);
    };
  }, [load]);

  if (!workstream) return null;

  const label =
    workstream.state === "paused"
      ? "Updates paused"
      : workstream.state === "disconnected"
        ? "Disconnected"
        : workstream.state === "activating"
          ? "Connecting"
          : "Linked";

  const command = async (next: WorkstreamUiCommand) => {
    setBusy(next);
    setFailed(false);
    try {
      const response = await fetch(
        `/api/tasks/${taskId}/workstream/${next}`,
        { method: "POST" },
      );
      const body = (await response.json()) as {
        workstream?: WorkstreamLinkT;
      };
      if (!response.ok || !body.workstream) throw new Error("command failed");
      setWorkstream(body.workstream);
      if (next !== "post-now") setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const action = (
    next: WorkstreamUiCommand,
    text: string,
    disabled = false,
  ) => (
    <button
      className="pop-item"
      disabled={disabled || busy !== null}
      onClick={() => void command(next)}
      style={{ width: "100%", border: 0, background: "transparent" }}
    >
      <span>{busy === next ? "Working..." : text}</span>
    </button>
  );

  return (
    <div style={{ position: "relative" }}>
      <button
        className="status-ctl"
        title="Linked tracker workstream controls"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="cv">{label}</span>
        {Icon.chevDown()}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="pop-sec">Workstream updates</div>
          {workstream.state === "active" &&
            action("pause", "Pause updates")}
          {workstream.state === "paused" &&
            action("resume", "Resume updates")}
          {workstream.state === "paused" &&
            action("post-now", "Post update now")}
          {workstream.state !== "disconnected" &&
            action("disconnect", "Disconnect")}
          {failed && (
            <div className="pi-sub" style={{ padding: "7px 10px" }}>
              Command unavailable
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

function TaskHero({ task, project, agents, onStart, onEdit, running, blockedBy, agentReady }: { task: TaskRow; project: ProjectRow; agents: AgentsBundle; onStart: () => void; onEdit: () => void; running: boolean; blockedBy?: string[]; agentReady: boolean }) {
  const carried = task.generation > 1;
  const blocked = !!blockedBy?.length && !task.started;
  const needsSetup = needsLaunchConfiguration(task, agents);
  const statusLine = carried ? "Fresh window · summary carried" : `${SLABEL[task.status]} · no session yet`;
  return (
    <div className="hero">
      <div className="h-ic">{Icon.bolt()}</div>
      <div className="h-status"><StatusDot status={task.status} /> {statusLine}</div>
      <h2>{task.title}</h2>
      {task.description && <p className="h-desc">{task.description}</p>}
      <div className="h-prompt">
        <div className="hp-h">Initial prompt the agent will receive</div>
        <div className="hp-b">
          <span className="ctx-pre">↳ {project.name} project context{carried ? " + previous session summary" : ""} (auto-prepended)</span>
          <strong>{task.title}.</strong> {task.description}
        </div>
      </div>
      {blocked && (
        <div className="hero-blocked" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked until {blockedBy!.length === 1 ? <strong>{blockedBy![0]}</strong> : `${blockedBy!.length} tasks`} {blockedBy!.length === 1 ? "is" : "are"} done. Edit the task to change its dependencies.
        </div>
      )}
      {/* The reason a blocked/not-connected Start can't be used lives here, in a
          visible line under the button — not just in a title tooltip nobody
          hovers on a touch device. */}
      <div className="hero-start">
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-accent" style={{ height: 38, padding: "0 20px", fontSize: 14 }} onClick={needsSetup ? onEdit : onStart} disabled={running || blocked || (!needsSetup && !agentReady)}>
            {needsSetup ? Icon.sliders() : Icon.play()} {running ? "Starting…" : blocked ? "Blocked" : needsSetup ? "Review setup" : !agentReady ? "Harness not connected" : "Start session"}
          </button>
          <button className="btn btn-line" style={{ height: 38, padding: "0 16px", fontSize: 14 }} onClick={onEdit} disabled={running} title="Edit title & description before starting">
            {Icon.edit()} Edit
          </button>
        </div>
        {(blocked || needsSetup || !agentReady) && (
          <div className="start-reason">
            {blocked ? `Blocked until done: ${blockedBy!.join(", ")}` : needsSetup ? "Review Harness, Model, and Thinking strength before starting" : "Connect this task's harness before starting"}
          </div>
        )}
      </div>
    </div>
  );
}

// Ref-backed identity-stable wrapper: Orchestrator passes fresh inline handlers
// on every render, which would defeat MessageView's memo — the wrapper keeps one
// function identity for the component's lifetime while always invoking the
// latest handler.
function useStableHandler<A extends unknown[], R>(
  fn?: (...args: A) => R,
): (...args: A) => R | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current?.(...args), []);
}

// Queue dock (batch two, E1): replaces the old pinned `.msg.user.queued`
// transcript bubbles with a strip between the transcript and the composer.
// One pending message renders as a single compact row; two or more collapse
// to "N queued messages" behind an expand toggle. Cancel calls the exact same
// dequeue path the old `.queued-x` used (onCancel, unchanged); Edit cancels
// the row and hands its text to the composer draft via onEdit. Emptying the
// queue resets to collapsed for next time; at zero the dock renders nothing
// (suppressed, not disabled).
export function QueueDock({ queued, onCancel, onEdit }: {
  queued: Msg[];
  onCancel: (pendingId: string) => void;
  onEdit: (pendingId: string, text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (queued.length === 0) setExpanded(false); }, [queued.length]);
  if (queued.length === 0) return null;

  const row = (m: Msg) => {
    const { text } = splitAttachments(m.content);
    return (
      <div className="dock-row" key={m.id}>
        <span className="dock-row-text">{text || "(attachment only)"}</span>
        <button className="dock-row-edit" title="Edit: remove from the queue and put it back in the composer" aria-label="Edit queued message" onClick={() => onEdit(m.id, text)}>{Icon.edit()}</button>
        <button className="dock-row-x queued-x" title="Remove from queue" aria-label="Remove from queue" onClick={() => onCancel(m.id)}>{Icon.x()}</button>
      </div>
    );
  };

  if (queued.length === 1) {
    return <div className="queue-dock">{row(queued[0])}</div>;
  }

  return (
    <div className="queue-dock">
      <button className="dock-summary" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
        <span>{queued.length} queued messages</span>
        <span className={`dock-chev ${expanded ? "open" : ""}`}>{Icon.chevDown()}</span>
      </button>
      {expanded && <div className="dock-list">{queued.map(row)}</div>}
    </div>
  );
}

export function SessionView({ project, task, agents, messages, running, blockedBy, transcriptLoading, onSend, onStart, onStop, onClear, onHandoff, onHandoffModel, onSetAgent, focused, onToggleFocus, onEdit, onReconnect, onSetStatus, onSetPriority, onSetModel, onSetReasoning, onSetPermission, onResolveWithAI, onMerged, onPrCreated, onAnswer, onCancelQueued, onBack, mobile, railW, onRailWidth, onRailReset, railCollapsed, onRailCollapse, onRailExpand }: {
  project: ProjectRow; task: TaskRow; agents: AgentsBundle; messages: Msg[]; running: boolean; blockedBy?: string[]; transcriptLoading?: boolean;
  onSend: (t: string) => void; onStart: () => void; onStop: () => void; onClear: () => void; onEdit: () => void;
  // Hand the task to another connected driver across a /clear boundary (same
  // worktree, fresh context seeded with the summary) - the quota-handoff path.
  onHandoff?: (agent: string) => void;
  // /handoff: write a handoff document in a final turn, then clear with it as
  // the carried summary and the picked model (null = keep current) applied.
  onHandoffModel?: (model: string | null) => void;
  // Move a task that has no session yet straight onto another agent (a plain
  // column write - nothing to summarize). The agent picker chooses between this
  // and onHandoff by task state; see AGENT PICKER below.
  onSetAgent?: (agent: string) => void;
  // Focus mode: session fills the workspace (desktop). Esc exits in the shell.
  focused?: boolean;
  onToggleFocus?: () => void;
  // Deep-link to Settings → Agents, for the transcript's "your login died" recovery button.
  onReconnect?: () => void;
  onSetStatus: (s: Status) => void; onSetPriority: (p: Priority) => void; onSetModel: (m: string | null) => void;
  onSetReasoning: (r: string | null) => void; onSetPermission: (p: string | null) => void;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onMerged?: () => void;
  onPrCreated?: (url: string) => void;
  onAnswer: (askId: string, questions: AskQuestion[], answers: AskAnswers) => Promise<void>;
  onCancelQueued: (pendingId: string) => void;
  onBack?: () => void; mobile?: boolean;
  railW: number; onRailWidth: (w: number) => void; onRailReset: () => void;
  railCollapsed: boolean; onRailCollapse: () => void; onRailExpand: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [doneNoteOpen, setDoneNoteOpen] = useState(false);
  const [priOpen, setPriOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [view, setView] = useState<"chat" | "changes">("chat");
  // Armed agent id for the two-step handoff button; disarms after 5s or on task switch.
  const [armedHandoff, setArmedHandoff] = useState<string | null>(null);
  useEffect(() => {
    if (!armedHandoff) return;
    const t = setTimeout(() => setArmedHandoff(null), 5000);
    return () => clearTimeout(t);
  }, [armedHandoff]);
  useEffect(() => { setArmedHandoff(null); }, [task.id]);
  // "Chat about it" swaps the composer takeover panel back to a normal
  // textarea (see the render below). It resets on task switch and the moment
  // there's nothing left to answer — it must never outlive the ask it was
  // opened for.
  const [chatAboutIt, setChatAboutIt] = useState(false);
  useEffect(() => { setChatAboutIt(false); }, [task.id]);
  // Queue dock's Edit (E1): cancel the row, then seed the composer's live
  // draft with its text. `key` bumps on every Edit so re-editing the same
  // text still re-applies (see Composer's seedDraft effect).
  const [draftSeed, setDraftSeed] = useState<{ text: string; key: number } | null>(null);
  useEffect(() => { setDraftSeed(null); }, [task.id]);
  const sessions = useMemo(() => buildSessions(messages), [messages]);
  const hasSession = task.started === 1 || messages.length > 0;
  const awaiting = isAwaiting(task);
  const stableCancelQueued = useStableHandler(onCancelQueued);
  const stableClear = useStableHandler(onClear);
  const stableReconnect = useStableHandler(onReconnect);
  // Run-control pickers + feature gates come from this task's agent capabilities,
  // never a hardcoded list — so the options always match the agent it runs under.
  const caps = capsFor(agents, task.agent);
  const visibleCaps = caps && task.started === 1
    ? {
        ...caps,
        models: caps.models.filter((model) =>
          (model.driverId ?? publicHarnessId(task.agent)) === task.agent,
        ),
      }
    : caps;
  const models = modelOptions(visibleCaps);
  const reasoningOpts = reasoningOptions(caps);
  const permissionOpts = permissionOptions(caps);
  const managedCatalogPath = caps?.managedCatalogPath ?? `/api/agents/${task.agent}/models/refresh`;
  const refreshLiteLLMModels = async () => {
    setModelRefreshing(true);
    try {
      const response = await fetch(managedCatalogPath, {
        method: "POST",
      });
      if (response.ok) {
        window.dispatchEvent(new Event("operator:refresh-agents"));
      }
    } finally {
      setModelRefreshing(false);
      setModelOpen(false);
    }
  };
  // Usage chip: tokens split into fresh work vs re-read cache (the raw total is
  // mostly cache reads and wildly overstates what ran), and a dollar figure whose
  // presentation follows how this agent is signed in — a subscription login's
  // figure is an API-price equivalent covered by plan quota, not a bill. Both
  // derivations live in ./format so the wording has one home.
  const usage = usageSplit(task);
  const cost = costDisplay(findAgent(agents, task.agent));
  const multiAgent = agents.agents.length > 1;
  // Produced-files footer (E2): once a run settles (running is false) and the
  // transcript's last message is that run's assistant reply, show the files
  // its tool calls touched since the previous user message. Empty while
  // running (the run hasn't settled) or when the last message isn't an
  // assistant reply (e.g. the transcript ends on a system notice).
  const lastRunFiles = useMemo(() => {
    if (running) return [];
    const lastIdx = messages.length - 1;
    if (lastIdx < 0 || messages[lastIdx].role !== "assistant") return [];
    let userIdx = -1;
    for (let i = lastIdx - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx === -1) return [];
    return producedFiles(messages, userIdx);
  }, [messages, running]);
  // PR number for the header chip, parsed from the stored URL (…/pull/42).
  const prNum = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  // The still-unanswered question, if any — drives the composer takeover
  // (AskPanel replaces the textarea) and hides the "thinking" dots, since the
  // agent is parked on the user, not working. Derived straight from message
  // state (not local component state), so it survives pane tab switches.
  const pendingAsk = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "tool") continue;
      try {
        const d = JSON.parse(m.content) as ToolData;
        if (d.ask && !d.ask.answers) return { toolId: m.toolId, data: d };
      } catch { /* not a tool-data payload */ }
    }
    return null;
  }, [messages]);
  const awaitingAnswer = !!pendingAsk;
  useEffect(() => { if (!awaitingAnswer) setChatAboutIt(false); }, [awaitingAnswer]);
  const submitAskAnswer = useCallback((answers: AskAnswers) => {
    if (!pendingAsk) return Promise.resolve();
    return onAnswer(pendingAsk.data.ask?.id || pendingAsk.toolId || "", pendingAsk.data.ask?.questions ?? [], answers);
  }, [pendingAsk, onAnswer]);
  // The header chip and thinking-bubble clock share one anchor + tick: the
  // persisted turn_started_at (Package A), falling back to the last real
  // (non-queued) user message's createdAt for older rows that predate it.
  // Anchored math, not mount time — a reload mid-turn shows the correct
  // elapsed immediately instead of restarting from 0.
  const turnAnchor = useMemo(() => {
    if (task.turn_started_at) return task.turn_started_at;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "user" && m.createdAt) return m.createdAt;
    }
    return null;
  }, [task.turn_started_at, messages]);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || awaitingAnswer || !turnAnchor) return;
    setClockNow(Date.now());
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, awaitingAnswer, turnAnchor]);
  const showTurnClock = running && !awaitingAnswer && !!turnAnchor && turnClockVisible(turnAnchor, clockNow);
  const turnClockText = turnAnchor ? elapsed(turnAnchor, clockNow) : "";

  // Auto-scroll only while the user is parked at the bottom. If they scroll up to
  // read earlier output, we leave their position alone even as new messages stream
  // in, and surface a "jump to bottom" button instead.
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinned.current = bottom;
    setAtBottom(bottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinned.current = true;
    setAtBottom(true);
  }, []);

  // Jump between the user's own messages in the transcript. dir < 0 goes to the
  // previous one above the current scroll position, dir > 0 to the next below it;
  // queued (not-yet-sent) bubbles are excluded so nav only lands on real turns.
  const scrollToUserMsg = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = Array.from(el.querySelectorAll<HTMLElement>(".msg.user:not(.queued)"))
      .map((n) => n.getBoundingClientRect().top - base + el.scrollTop);
    if (!tops.length) return;
    const cur = el.scrollTop;
    const eps = 8;
    let target: number;
    if (dir < 0) {
      const prev = tops.filter((t) => t < cur - eps);
      target = prev.length ? prev[prev.length - 1] : tops[0];
    } else {
      const next = tops.filter((t) => t > cur + eps);
      target = next.length ? next[0] : tops[tops.length - 1];
    }
    el.scrollTo({ top: Math.max(0, target - 12), behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, running]);

  // Switching tasks (or in/out of chat view) always jumps to the latest.
  useEffect(() => {
    pinned.current = true;
    setAtBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [task.id, view]);

  const chatPane = (
    <>
      <div className="transcript-wrap">
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="tw">
          {transcriptLoading && messages.length === 0 && (
            // Snapshot hasn't streamed in yet — sketch a user turn and an agent
            // reply so opening a started task never flashes an empty chat.
            <div aria-hidden>
              <div className="session-label"><span className="ln" />Loading session<span className="ln" /></div>
              <div className="msg user" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={34} h={9} /></div>
                <div className="msg-body"><Skel w="72%" h={12} /><Skel w="46%" h={12} style={{ marginTop: 9 }} /></div>
              </div>
              <div className="msg" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={70} h={9} /></div>
                <Skel w="90%" h={11} />
                <Skel w="83%" h={11} style={{ marginTop: 8 }} />
                <Skel w="58%" h={11} style={{ marginTop: 8 }} />
                <Skel w="100%" h={34} r="var(--r)" style={{ marginTop: 12 }} />
              </div>
            </div>
          )}
          {sessions.map((s, si) => (
            <div key={s.n}>
              {si > 0 && s.summaryBefore && <SessionBreak summary={s.summaryBefore} />}
              <div className="session-label"><span className="ln" />Session {s.n}{si === sessions.length - 1 ? " · current" : ""}<span className="ln" /></div>
              {s.messages.map((m, mi) => {
                // Tool activity can precede the first prose reply. Show one
                // response header there, then collapse later assistant chunks.
                const hideWho =
                  m.role === "assistant" &&
                  !isFirstAssistantReply(s.messages, mi);
                // Tool noise control: every tool call renders as its one-line
                // header only, Claude Code style - the conversation is prose,
                // the machinery is opt-in via the twirl. Errors still surface
                // their output automatically (see ToolView).
                const condensed = true;
                return <MessageView key={m.id} m={m} initial={mi === 0 && m.role === "user"} hideWho={hideWho} condensed={condensed} running={running} agent={task.agent} agentLabel={agentLabel(agents, task.agent)} onClear={stableClear} onReconnect={stableReconnect} />;
              })}
            </div>
          ))}
          {running && !awaitingAnswer && (
            <div className="msg assistant"><div className="who"><Avatar who="cc" agent={task.agent} /> Agent</div><div className="msg-body"><span className="typing"><i /><i /><i /></span>{showTurnClock && <span className="turn-clock">{turnClockText}</span>}</div></div>
          )}
          {!running && <ProducedFilesFooter files={lastRunFiles} />}
        </div>
      </div>
      <div className="msg-nav">
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(-1)} title="Previous message" aria-label="Scroll to previous message">
          {Icon.chevUp()}
        </button>
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(1)} title="Next message" aria-label="Scroll to next message">
          {Icon.chevDown()}
        </button>
        {!atBottom && (
          <button className="msg-nav-btn" onClick={() => scrollToBottom()} title="Jump to latest" aria-label="Jump to latest">
            {Icon.toBottom()}
          </button>
        )}
      </div>
      </div>
      {/* Queue dock (E1): follow-ups queued mid-turn, in a strip between the
          transcript and the composer — replaces the old pinned queued bubbles
          entirely. Cancel calls the same dequeue path (stableCancelQueued);
          Edit cancels the row and seeds the composer's live draft. */}
      <QueueDock
        queued={messages.filter((m) => m.role === "queued")}
        onCancel={(id) => stableCancelQueued(id)}
        onEdit={(id, text) => { stableCancelQueued(id); setDraftSeed({ text, key: Date.now() }); }}
      />
      {/* Composer takeover: while a question is pending, the input area is the
          AskPanel (chips/options/submit), not the textarea — the decision
          lives where the hands are. "Chat about it" swaps back to a normal
          textarea in "answering by chat" mode (a dismissible strip says so);
          the typed message submits through the same onAnswer path as a
          free-text "Other". Derived from pendingAsk/chatAboutIt (task/message
          state), so it survives pane tab switches, not remounts. */}
      {pendingAsk && !chatAboutIt ? (
        <AskPanel
          data={pendingAsk.data}
          agentLabel={agentLabel(agents, task.agent)}
          onAnswer={submitAskAnswer}
          onChatAboutIt={() => setChatAboutIt(true)}
        />
      ) : (
        <>
          {pendingAsk && chatAboutIt && (
            <div className="answering-strip">
              <span className="answering-strip-label">
                Answering: {pendingAsk.data.ask?.questions?.[0]?.header || pendingAsk.data.ask?.questions?.[0]?.question || "your question"}
              </span>
              <button className="answering-strip-x" onClick={() => setChatAboutIt(false)} aria-label="Back to the question panel" title="Back to the question panel">
                {Icon.x()}
              </button>
            </div>
          )}
          {/* Enabled whenever a transcript exists — including the just-cleared
              state (started=0, messages kept), where the typed message becomes the
              fresh generation's opening prompt. */}
          <Composer
            task={task} agentLabel={agentLabel(agents, task.agent)} disabled={!hasSession} running={running}
            models={models.filter((m) => m.value !== null).map((m) => ({ value: m.value as string, label: m.label }))}
            onSend={(text) => {
              if (pendingAsk && chatAboutIt) {
                const qs = pendingAsk.data.ask?.questions ?? [];
                setChatAboutIt(false);
                void submitAskAnswer(qs.map(() => [text]));
                return;
              }
              onSend(text);
            }}
            onStop={onStop} onClear={onClear} onHandoff={(m) => onHandoffModel?.(m)}
            seedDraft={draftSeed}
          />
        </>
      )}
    </>
  );

  return (
      <div className="session">
        <div className="sess-head">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to tasks" aria-label="Back to tasks">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          <div className="sh-main">
            <div className="crumb">
              <span className="pic" style={{ width: 16, height: 16, borderRadius: 5, background: project.color, display: "grid", placeItems: "center", color: "#fff", fontSize: 9, fontWeight: 700 }}>{project.name[0]}</span>
              {project.name} <span className="sep">/</span> task
            </div>
            <div className="sh-title">{task.title}</div>
          </div>
          <div className="sh-tools">
            {showTurnClock && <span className="turn-clock turn-clock-chip" title="Time since this turn started">{turnClockText}</span>}
            <WorkstreamTaskControls taskId={task.id} />
            {task.pr_url && (
              <a className="pr-chip" href={task.pr_url} target="_blank" rel="noreferrer" title={`Open this task's pull request — ${task.pr_url}`}>
                {Icon.github()} PR{prNum ? ` #${prNum}` : ""} {Icon.external()}
              </a>
            )}
            {(task.cost_usd > 0 || task.total_tokens > 0) && (
              <span className="usage-chip" title={usageTooltip(usage, task.cost_usd, cost)}>
                {fmtTokens(usage.fresh)} tok
                {usage.cacheRead > 0 && <> <span className="usage-dot">·</span> <span className="usage-cached">{fmtTokens(usage.cacheRead)} cached</span></>}
                {cost.show && <> <span className="usage-dot">·</span> {cost.approx && "~"}{fmtCost(task.cost_usd)}</>}
              </span>
            )}
            {mobile && hasSession && (
              <div className="viewseg">
                <button className={`viewseg-btn ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>Chat</button>
                <button className={`viewseg-btn ${view === "changes" ? "on" : ""}`} onClick={() => setView("changes")}>Changes</button>
              </div>
            )}
            {/* AGENT PICKER - head of the agent → model → thinking chain. The two
                chips after it re-derive from this task's agent capabilities, so
                switching here repopulates both with no per-agent UI logic.
                Hidden when only one driver is registered (nothing to choose). */}
            {multiAgent && (
              <div style={{ position: "relative" }}>
                <button
                  className="status-ctl"
                  title={`Which agent runs this task${running ? " - finish or stop the turn to change it" : ""}`}
                  disabled={running}
                  onClick={(e) => { e.stopPropagation(); setAgentOpen((o) => !o); setModelOpen(false); setStatusOpen(false); setPriOpen(false); setSettingsOpen(false); }}
                >
                  {Icon.bolt()}
                  <span className="cv">{agentLabel(agents, task.agent)}</span>
                  {Icon.chevDown()}
                </button>
                {agentOpen && (
                  <Popover onClose={() => { setAgentOpen(false); setArmedHandoff(null); }}>
                    <div className="pop-sec">Agent</div>
                    {agents.agents.map((a) => {
                      const current = a.id === task.agent;
                      // Three different actions wear the same row, because from
                      // the user's side they're one question ("run this on what?"):
                      //   connected + no session → straight column write
                      //   connected + session    → /clear handoff, arm-then-confirm
                      //                            (it spends a summarization turn)
                      //   not connected          → deep-link to Settings → Agents
                      const armed = armedHandoff === a.id;
                      const sub = current
                        ? "running this task"
                        : !a.authenticated
                          ? "not connected - set it up"
                          : hasSession
                            ? "hand off: saves a summary, same worktree, fresh context"
                            : "switch now - nothing has run yet";
                      return (
                        <div
                          key={a.id}
                          className="pop-item"
                          style={!current && !a.authenticated ? { opacity: 0.65 } : undefined}
                          onClick={() => {
                            if (current) { setAgentOpen(false); return; }
                            if (!a.authenticated) { setAgentOpen(false); onReconnect?.(); return; }
                            if (!hasSession) { setAgentOpen(false); onSetAgent?.(a.id); return; }
                            if (armed) { setArmedHandoff(null); setAgentOpen(false); onHandoff?.(a.id); }
                            else setArmedHandoff(a.id);
                          }}
                        >
                          <div>
                            <div>{armed ? `Confirm: hand off to ${a.label}` : a.label}</div>
                            <div className="pi-sub">{armed ? "this ends the current session" : sub}</div>
                          </div>
                          {current && <span className="pi-check">{Icon.check()}</span>}
                        </div>
                      );
                    })}
                  </Popover>
                )}
              </div>
            )}
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title={`Model this task's ${agentLabel(agents, task.agent)} session uses`} onClick={(e) => { e.stopPropagation(); setModelOpen((o) => !o); setStatusOpen(false); setPriOpen(false); setSettingsOpen(false); setAgentOpen(false); }}>
                {Icon.spark()}
                <span className="cv">{models.find((m) => m.value === task.model)?.label ?? "Default"}</span>
                {task.resolved_model && <span className="model-badge" title={`Last ran on ${task.resolved_model}`}>{modelLabel(task.resolved_model, caps)}</span>}
                {Icon.chevDown()}
              </button>
              {modelOpen && (
                <Popover onClose={() => setModelOpen(false)}>
                  {caps?.managedCatalogPath && (
                    <>
                      <div className="pop-sec">Vetted models</div>
                      <button
                        type="button"
                        className="pop-item"
                        onClick={() => void refreshLiteLLMModels()}
                        disabled={modelRefreshing}
                      >
                        {modelRefreshing ? "Refreshing…" : "Refresh vetted models"}
                      </button>
                    </>
                  )}
                  {models.map((m, i) => (
                    <Fragment key={m.label}>
                      {/* Section header whenever the group changes — Claude Code's
                          list runs to a dozen-plus pins, so it needs the structure. */}
                      {m.group && m.group !== models[i - 1]?.group && <div className="pop-sec">{m.group}</div>}
                      <div className="pop-item" onClick={() => { onSetModel(m.value); setModelOpen(false); }}>
                        <div><div>{m.label}</div><div className="pi-sub">{m.sub}</div></div>
                        {(task.model ?? null) === m.value && <span className="pi-check">{Icon.check()}</span>}
                      </div>
                    </Fragment>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title="Reasoning level & permission mode for this task" onClick={(e) => { e.stopPropagation(); setSettingsOpen((o) => !o); setModelOpen(false); setStatusOpen(false); setPriOpen(false); setAgentOpen(false); }}>
                {Icon.gear()}
                <span className="cv">{reasoningOpts.find((r) => r.value === task.reasoning)?.label ?? "Default"}</span>
                {Icon.chevDown()}
              </button>
              {settingsOpen && (
                <Popover onClose={() => setSettingsOpen(false)}>
                  <div className="pop-sec">Reasoning</div>
                  {reasoningOpts.map((r) => (
                    <div key={r.label} className="pop-item" onClick={() => { onSetReasoning(r.value); setSettingsOpen(false); }}>
                      <div><div>{r.label}</div><div className="pi-sub">{r.sub}</div></div>
                      {(task.reasoning ?? null) === r.value && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                  <div className="divider" />
                  <div className="pop-sec">Permission</div>
                  {permissionOpts.map((p) => (
                    <div key={p.label} className="pop-item" onClick={() => { onSetPermission(p.value); setSettingsOpen(false); }}>
                      <div><div>{p.label}</div><div className="pi-sub">{p.sub}</div></div>
                      {(task.permission_mode ?? null) === p.value && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" onClick={(e) => { e.stopPropagation(); setPriOpen((o) => !o); setStatusOpen(false); setModelOpen(false); setSettingsOpen(false); setAgentOpen(false); }}>
                {Icon.flag()} <span className="cv">{PLABEL[task.priority]}</span>
              </button>
              {priOpen && (
                <Popover onClose={() => setPriOpen(false)}>
                  {PRIORITIES.map((p) => (
                    <div key={p} className="pop-item" onClick={() => { onSetPriority(p); setPriOpen(false); }}>
                      <span className={`pri ${p}`}>{PLABEL[p].toUpperCase()}</span>
                      {task.priority === p && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className={`status-ctl ${awaiting ? "awaiting" : ""}`} onClick={(e) => { e.stopPropagation(); setStatusOpen((o) => !o); setPriOpen(false); setModelOpen(false); setSettingsOpen(false); setAgentOpen(false); }}>
                <StatusDot status={task.status} running={running} awaiting={awaiting} />
                <span className="cv">{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
                {Icon.chevDown()}
              </button>
              {statusOpen && (
                <Popover onClose={() => setStatusOpen(false)}>
                  {STATUSES.map((s) => (
                    <div key={s} className="pop-item" onClick={() => {
                      // Marking done is the moment the "why" is freshest —
                      // detour through the optional note prompt first.
                      if (s === "done" && task.status !== "done") setDoneNoteOpen(true);
                      else onSetStatus(s);
                      setStatusOpen(false);
                    }}>
                      <StatusDot status={s} />
                      <div><div>{SLABEL[s]}</div><div className="pi-sub">{SSUB[s]}</div></div>
                      {task.status === s && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
              {doneNoteOpen && (
                <DoneNoteModal
                  onClose={() => setDoneNoteOpen(false)}
                  onDone={async (note) => {
                    if (note) {
                      // Note first, then the status flip: if the save fails the
                      // modal stays up and nothing was half-applied.
                      await jsend(`/api/tasks/${task.id}/notes`, "POST", { content: note });
                    }
                    await onSetStatus("done");
                    setDoneNoteOpen(false);
                  }}
                />
              )}
            </div>
            {!mobile && onToggleFocus && (
              <button
                className={`btn btn-line btn-sm${focused ? " btn-accent" : ""}`}
                title={focused ? "Exit focus mode (Esc)" : "Focus mode: hide the projects and tasks columns so this session fills the screen"}
                onClick={onToggleFocus}
              >
                {focused ? Icon.shrink() : Icon.expand()} {focused ? "Exit focus" : "Focus"}
              </button>
            )}
            {/* Renew is a real mid-turn capability (tests/clearMidTurn.test.ts pins
                it) — rendered and enabled whenever a session exists, suppressed
                (not disabled) otherwise. Same rule everywhere Renew appears:
                Composer's foot control and SessionRail's Clear context button. */}
            {task.started === 1 && (
              <button className="btn btn-line btn-sm" title="Renew: summarize this session and continue in a fresh context window - the transcript is kept, nothing is erased" onClick={onClear}>{Icon.clear()} Renew</button>
            )}
          </div>
        </div>

        {hasSession && (
          <SyncBanner taskId={task.id} running={running} onResolveWithAI={onResolveWithAI} onSwitchToChat={() => setView("chat")} />
        )}

        {!hasSession ? (
          <TaskHero task={task} project={project} agents={agents} onStart={onStart} onEdit={onEdit} running={running} blockedBy={blockedBy} agentReady={launchModelReady(task, agents)} />
        ) : !mobile ? (
          // Desktop: transcript beside the DIFF / PREVIEW / CONTEXT rail. The
          // zero-width seam between them holds the drag handle (a 0px grid track),
          // so the rail can be resized just like the projects/tasks columns.
          // Collapsed → the rail is swapped for a slim spine that restores it,
          // handing the full width to the transcript (mirrors the side columns).
          railCollapsed ? (
            <div className="sess-split" style={{ gridTemplateColumns: "minmax(0,1fr) 30px" }}>
              <div className="sess-main">{chatPane}</div>
              <ColRail label="Diff & Context" right onExpand={onRailExpand} />
            </div>
          ) : (
            <div className="sess-split" style={{ gridTemplateColumns: `minmax(0,1fr) 0px ${railW}px` }}>
              <div className="sess-main">{chatPane}</div>
              <ColResize
                side="right" min={RAIL_W.min} max={RAIL_W.max}
                onWidth={onRailWidth} onReset={onRailReset}
              />
              <SessionRail
                project={project} task={task} sessions={sessions} running={running}
                onResolveWithAI={onResolveWithAI} onMerged={onMerged} onPrCreated={onPrCreated} onClear={onClear} onCollapse={onRailCollapse} onSwitchToChat={() => { /* desktop transcript is always visible */ }}
              />
            </div>
          )
        ) : view === "changes" ? (
          <TaskChanges taskId={task.id} running={running} prUrl={task.pr_url} onMerged={onMerged} onPrCreated={onPrCreated} onResolveWithAI={async (id) => {
            const res = await onResolveWithAI(id);
            // Resolution turn was kicked off (conflicts, not a clean merge) —
            // jump back to Chat so the user sees the message stream in.
            if (res.ok && !res.merged) setView("chat");
            return res;
          }} />
        ) : (
          chatPane
        )}
      </div>
  );
}
