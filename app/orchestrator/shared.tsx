"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Priority, Status } from "@/lib/types";
import { Icon, AgentMark } from "../icons";
import { SCLS, SLABEL, AWAIT_LABEL } from "./types";
import type { RowStatus } from "./statusLadder";

// The one-dot status ladder (see statusLadder.ts): amber pulse for awaiting,
// blue pulse for running, green (no pulse) for unviewed, and an EMPTY but
// same-sized slot for idle so rows never reflow as their status changes.
// Distinct from StatusDot below (which keeps its own coral-for-awaiting
// language for the places that already use it) - this is the batch-one row
// ladder used by TasksColumn/TaskBoard/ProjectsColumn.
export function LadderDot({ status }: { status: RowStatus }) {
  return (
    <span className="dot-slot">
      {status.kind !== "none" && <span className={`ldot ${status.kind}`} />}
    </span>
  );
}

// ---- hover cards (batch two, Package D) ----
// The row ladder above shows exactly ONE dot by precedence (awaiting beats
// running beats unviewed) so a busy row doesn't turn into a wall of badges.
// The hover card is what makes that demotion safe: unlike rowStatus (which
// picks the single winner), this returns every status that's actually true,
// so a task that's both "awaiting" and would-be "running" shows both lines.
export type LadderEntry = Exclude<RowStatus, { kind: "none" }>;
export function ladderStatuses(
  task: { status: string; awaiting_input: number | boolean },
  opts: { running: boolean; unviewed: boolean },
): LadderEntry[] {
  const out: LadderEntry[] = [];
  const awaiting = task.status === "in_progress" && !!task.awaiting_input;
  if (awaiting) out.push({ kind: "awaiting", label: "Needs your input" });
  if (opts.running) out.push({ kind: "running", label: "Working" });
  if (opts.unviewed) out.push({ kind: "unviewed", label: "Finished while you were away" });
  return out;
}

// Timing for the hover card lives in one place so it's a single knob to tune
// and so tests can drive it with fake timers instead of relying on jsdom's
// nonexistent real `:hover`.
export const HOVER_OPEN_DELAY_MS = 350;
export const HOVER_CLOSE_GRACE_MS = 200;

// Open-state machine for a hover card: a short delay before opening (so a
// pointer passing over a row doesn't flash a card), and a short grace period
// before closing (so crossing the gap between the anchor and the portaled
// card itself doesn't dismiss it). `scheduleOpen`/`scheduleClose` are meant to
// be wired to BOTH the anchor's and the card's own mouse enter/leave — the
// card re-entering cancels the pending close exactly like the anchor does.
export function useHoverCard() {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpenTimer = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; } };
  const cancelCloseTimer = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };

  const scheduleOpen = () => {
    cancelCloseTimer();
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => { openTimer.current = null; setOpen(true); }, HOVER_OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    cancelOpenTimer();
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, HOVER_CLOSE_GRACE_MS);
  };
  const closeNow = () => { cancelOpenTimer(); cancelCloseTimer(); setOpen(false); };

  useEffect(() => () => { cancelOpenTimer(); cancelCloseTimer(); }, []);

  return { open, scheduleOpen, scheduleClose, closeNow };
}

// Pure selection guard: a click that's really the tail end of a text-selection
// drag inside the card must not fire the copy. No DOM in the test environment
// here (no jsdom), so this reads `window.getSelection` defensively and simply
// skips the check (never treats it as a selection) when there's no `window` -
// exercised directly by tests rather than through a live selection.
export function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return false;
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

// Pure copy action: writes `value` to the clipboard and calls `onCopied` ONLY
// once that write actually resolves (never optimistically) - the caller uses
// this to gate the transient "Copied" state. Guards for both a mid-drag text
// selection (must not hijack it into a copy) and an environment without a
// Clipboard API (fails silent, no state change), per spec.
export function copyPrimaryValue(value: string | undefined, onCopied: () => void): void {
  if (!value) return;
  if (hasActiveTextSelection()) return;
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) return;
  clipboard.writeText(value).then(onCopied).catch(() => {});
}

// The card's inner markup - deliberately DOM-portal-free so it can be rendered
// (and asserted on) directly by react-test-renderer without a real `document`.
// `HoverCard` below wraps this in `createPortal(..., document.body)`.
export function HoverCardContent({ content, copied }: { content: React.ReactNode; copied: boolean }) {
  return (
    <div className="hovercard-body">
      {content}
      {copied && <span className="hovercard-copied">Copied</span>}
    </div>
  );
}

// A rich detail card that opens on hover of `anchorRef`'s element, portaled to
// document.body (so it's never clipped by an ancestor's overflow — same
// reasoning as Popover above). Positioned `fixed` from the anchor's measured
// rect, flipping above the anchor if it would overflow the viewport bottom.
// Clicking it copies `copyValue` to the clipboard; the "Copied" state only
// appears after that write resolves (see copyPrimaryValue). Presentational
// only — it does not trap focus or intercept Tab.
export function HoverCard({ open, anchorRef, content, copyValue, onEnter, onLeave, onClose }: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  content: React.ReactNode;
  copyValue?: string;
  onEnter?: () => void;
  onLeave?: () => void;
  onClose?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const r = anchor.getBoundingClientRect();
    const cw = card.offsetWidth || 260;
    const ch = card.offsetHeight || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(r.left, vw - cw - 8));
    let top = r.bottom + 6;
    if (top + ch > vh - 8) top = Math.max(8, r.top - ch - 6); // flip above if it'd overflow the bottom
    setPos({ top, left });
  }, [open, anchorRef]);

  // Escape and scroll (of anything outside the card) both dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    const onScroll = (e: Event) => { if (!cardRef.current?.contains(e.target as Node)) onClose?.(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); };
  }, [open, onClose]);

  useEffect(() => { if (!open) setCopied(false); }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={cardRef}
      className="hovercard"
      style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() => copyPrimaryValue(copyValue, () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })}
    >
      <HoverCardContent content={content} copied={copied} />
    </div>,
    document.body,
  );
}

export function StatusDot({ status, running, awaiting, lg }: { status: Status; running?: boolean; awaiting?: boolean; lg?: boolean }) {
  // Signal language (mission-control): "needs your input" is an alert coral, a
  // *live* working session is blue (both pulse to draw the eye), and an idle
  // status falls back to its base color. Awaiting wins over running — a turn
  // parked on a question is technically live but it's really waiting on you.
  const cls = awaiting ? "c" : running ? "b" : SCLS[status];
  return (
    <span
      className={`sdot ${cls} ${lg ? "lg" : ""} ${awaiting || running ? "pulse" : ""}`}
      title={awaiting ? AWAIT_LABEL : running ? "Live" : SLABEL[status]}
    />
  );
}

export function PriPill({ p }: { p: Priority }) {
  const map: Record<Priority, string> = { hi: "HIGH", med: "MED", lo: "LOW" };
  return <span className={`pri ${p}`}>{map[p]}</span>;
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-bar">
      <span className="search-ic">{Icon.search()}</span>
      <input
        className="search-input" value={value} placeholder={placeholder} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }}
      />
      {value && <button className="search-clear" title="Clear search" onClick={() => onChange("")}>{Icon.x()}</button>}
    </div>
  );
}

// Chat avatar. The assistant side wears the brand mark of the agent the task
// actually runs on (Claude / Codex), so a transcript says at a glance who wrote
// it; an unknown or missing agent id falls back to the generic bolt.
export function Avatar({ who, agent }: { who: "user" | "cc"; agent?: string | null }) {
  if (who === "user") return <span className="av you">A</span>;
  const mark = agent ? AgentMark[agent] : undefined;
  return <span className={`av cc${mark ? ` ${agent}` : ""}`}>{mark ? mark() : Icon.bolt()}</span>;
}

// Which agent driver a task runs under (Claude Code / Codex …). Hidden when only
// one agent is available (nothing to disambiguate) so single-agent workspaces
// stay clutter-free. `multi` is passed by the caller from the agents bundle.
export function AgentBadge({ label, multi }: { label: string; multi: boolean }) {
  if (!multi) return null;
  return <span className="agent-badge" title={`Runs on ${label}`}>{label}</span>;
}

// ---- async-state primitives (pair with the .spinner/.load-note/.skel/.err-note
// styles in globals.css) — every panel that fetches uses these, so loading and
// error presentation stays uniform across the app. ----

export function Spinner({ size }: { size?: number }) {
  return <span className="spinner" role="status" aria-label="Loading" style={size ? { width: size, height: size } : undefined} />;
}

// Standard "we're fetching" line: spinner + quiet text. Replaces bare "Loading…".
export function LoadNote({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="load-note" style={style}><Spinner size={13} />{children}</div>;
}

// One shimmer bar. Compose a few for card/list/transcript skeletons.
export function Skel({ w, h = 10, r, style }: { w: number | string; h?: number; r?: number | string; style?: React.CSSProperties }) {
  return <span className="skel" aria-hidden style={{ width: w, height: h, ...(r !== undefined ? { borderRadius: r } : null), ...style }} />;
}

// Recoverable-error line: the message plus an inline Retry when the caller can
// simply refetch. Same warm-red voice as transcript system errors.
export function ErrNote({ children, onRetry, retryLabel = "Retry", style }: {
  children: React.ReactNode; onRetry?: () => void; retryLabel?: string; style?: React.CSSProperties;
}) {
  return (
    <div className="err-note" style={style}>
      <span className="err-msg">⚠ {children}</span>
      {onRetry && <button className="btn btn-line btn-sm" onClick={onRetry}>{Icon.restore()} {retryLabel}</button>}
    </div>
  );
}

// A dropdown menu anchored to its trigger. It renders into document.body via a
// portal and positions itself `fixed` from the trigger's measured rect, so it is
// never clipped or pushed off-screen by an ancestor's `overflow` — which is
// exactly what happened on mobile, where the trigger lives inside the
// horizontally-scrolling `.sh-tools` rail (the menu opened ~570px to the right of
// a 390px-wide screen and was unreachable). The trigger is found as the parent of
// an in-place marker span, so call sites don't need to pass a ref.
export function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = markerRef.current?.parentElement; // the position:relative wrapper ≈ the trigger
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Right-align under the trigger, then clamp into the viewport (both axes).
    const left = Math.max(8, Math.min(r.right - mw, vw - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4); // flip above if it'd overflow the bottom
    setPos({ top, left });
  }, []);

  // Close on any outside click (the trigger and menu stopPropagation), and on
  // scroll of an *ancestor* — a fixed menu doesn't follow a scrolling ancestor, so
  // dismiss instead. But scrolling inside the menu itself (a long, overflow-scroll
  // list) must NOT close it, so ignore scroll events originating within the menu.
  useEffect(() => {
    const close = () => onClose();
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", onScroll, true); };
  }, [onClose]);

  return (
    <>
      <span ref={markerRef} style={{ display: "none" }} />
      {createPortal(
        <div
          ref={menuRef}
          className="popover"
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, right: "auto", visibility: pos ? "visible" : "hidden" }}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
