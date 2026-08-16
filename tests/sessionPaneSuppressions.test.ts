import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

// Package C3: "suppress, don't disable" applied to the last few session-pane
// controls. Same pattern as tests/worktreeClarityUi.test.ts — source-text
// assertions against the components rather than full renders, since several
// of them (SessionRail, WorktreePrune) are fetch-driven.
describe("session pane suppressions", () => {
  it("SessionRail's Open live control renders nothing without a URL, instead of a permanently-disabled button", () => {
    const rail = source("app/orchestrator/SessionRail.tsx");
    expect(rail).toContain(
      '{url && <a className="btn btn-line" href={url} target="_blank" rel="noopener noreferrer">{Icon.external()} Open live</a>}'
    );
    expect(rail).not.toContain('<button className="btn btn-line" disabled>{Icon.external()} Open live</button>');
  });

  it("unifies Renew on one rule across the header, Composer, and SessionRail: rendered+enabled only when task.started === 1", () => {
    const view = source("app/orchestrator/SessionView.tsx");
    const composer = source("app/orchestrator/Composer.tsx");
    const rail = source("app/orchestrator/SessionRail.tsx");

    // Header Renew.
    expect(view).toContain("{task.started === 1 && (");
    expect(view).toContain(
      '<button className="btn btn-line btn-sm" title="Renew: summarize this session and continue in a fresh context window - the transcript is kept, nothing is erased" onClick={onClear}>{Icon.clear()} Renew</button>'
    );
    expect(view).not.toContain("{hasSession && task.started === 1 && (");

    // Composer foot Renew.
    expect(composer).toContain("{task.started === 1 && (");
    expect(composer).toContain(
      '<button className="hint" style={{ cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); onClear(); }} title="Summarize and continue in a fresh context window (also: type /clear)">{Icon.clear()} Renew</button>'
    );

    // SessionRail's "Clear context now".
    expect(rail).toContain(
      '<button className="btn btn-line ctxw-clear" onClick={onClear}>{Icon.clear()} Clear context now</button>'
    );
    expect(rail).not.toContain('disabled={running || task.started !== 1}');

    // None of the three Renew controls gate on `running` anymore — Renew is a
    // supported mid-turn capability (tests/clearMidTurn.test.ts pins it).
    expect(view).not.toContain('onClick={onClear} disabled={running}');
    expect(composer).not.toMatch(/Renew[\s\S]{0,40}disabled=\{running\}/);
  });

  it("WorktreePrune no longer shows the not-built auto-prune checkbox", () => {
    const prune = source("app/orchestrator/WorktreePrune.tsx");
    expect(prune).not.toContain("Auto-prune");
    expect(prune).not.toContain("coming soon");
    expect(prune).not.toContain("Automatically prune worktrees merged more than 30 days ago");
  });

  it("the hero Start button's blocked/not-connected reason is a visible line, not just a title tooltip", () => {
    const view = source("app/orchestrator/SessionView.tsx");
    expect(view).toContain('<div className="start-reason">');
    expect(view).toContain("{(blocked || needsSetup || !agentReady) && (");
    // The button itself no longer carries the reason as a title.
    expect(view).not.toContain(
      'title={blocked ? `Blocked until done: ${blockedBy!.join(", ")}` : needsSetup ? "Review Harness, Model, and Thinking strength before starting" : !agentReady ? "Connect this task\'s harness before starting" : undefined}'
    );
  });
});
