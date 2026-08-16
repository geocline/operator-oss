import fs from "node:fs";
import path from "node:path";
import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHoverCard,
  HoverCardContent,
  hasActiveTextSelection,
  copyPrimaryValue,
  ladderStatuses,
  HOVER_OPEN_DELAY_MS,
  HOVER_CLOSE_GRACE_MS,
} from "@/app/orchestrator/shared";

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

// A minimal test harness: calls the hook every render and hands the latest
// state/handlers out to the test via `capture` so assertions can drive
// scheduleOpen/scheduleClose/closeNow directly, without real DOM hover
// events (there is no jsdom in this repo — this is the "prop/handler you can
// invoke in tests" the spec calls for).
function makeHarness(capture: (state: ReturnType<typeof useHoverCard>) => void) {
  return function Harness() {
    const state = useHoverCard();
    capture(state);
    return null;
  };
}

describe("useHoverCard (D1 timing helper)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not open immediately on scheduleOpen — it waits the full open delay", () => {
    let latest!: ReturnType<typeof useHoverCard>;
    const Harness = makeHarness((s) => { latest = s; });
    act(() => { create(React.createElement(Harness)); });

    act(() => { latest.scheduleOpen(); });
    expect(latest.open).toBe(false);

    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 1); });
    expect(latest.open).toBe(false);

    act(() => { vi.advanceTimersByTime(1); });
    expect(latest.open).toBe(true);
  });

  it("scheduleClose closes after the grace period once open", () => {
    let latest!: ReturnType<typeof useHoverCard>;
    const Harness = makeHarness((s) => { latest = s; });
    act(() => { create(React.createElement(Harness)); });

    act(() => { latest.scheduleOpen(); vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS); });
    expect(latest.open).toBe(true);

    act(() => { latest.scheduleClose(); vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS); });
    expect(latest.open).toBe(false);
  });

  it("re-entering before the close grace elapses (the anchor-to-card pointer gap) cancels the pending close", () => {
    let latest!: ReturnType<typeof useHoverCard>;
    const Harness = makeHarness((s) => { latest = s; });
    act(() => { create(React.createElement(Harness)); });

    act(() => { latest.scheduleOpen(); vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS); });
    expect(latest.open).toBe(true);

    act(() => { latest.scheduleClose(); vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS - 1); });
    expect(latest.open).toBe(true); // grace not elapsed yet

    act(() => { latest.scheduleOpen(); }); // pointer landed on the card itself
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS + 50); });
    expect(latest.open).toBe(true); // never closed
  });

  it("closeNow closes immediately and cancels any pending open/close timers", () => {
    let latest!: ReturnType<typeof useHoverCard>;
    const Harness = makeHarness((s) => { latest = s; });
    act(() => { create(React.createElement(Harness)); });

    act(() => { latest.scheduleOpen(); vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS); });
    expect(latest.open).toBe(true);

    act(() => { latest.closeNow(); });
    expect(latest.open).toBe(false);

    // A stray pending timer firing afterward must not reopen it.
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + HOVER_CLOSE_GRACE_MS); });
    expect(latest.open).toBe(false);
  });
});

describe("HoverCardContent (the portal-free, testable half of HoverCard)", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  it("renders the given content", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(HoverCardContent, {
          content: React.createElement("div", { className: "hc-title" }, "My Task"),
          copied: false,
        }),
      );
    });
    const title = renderer.root.findByProps({ className: "hc-title" });
    expect(title.children.join("")).toBe("My Task");
  });

  it("does not show the Copied state until copied is true", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(HoverCardContent, { content: "x", copied: false }));
    });
    expect(renderer.root.findAllByProps({ className: "hovercard-copied" })).toHaveLength(0);
  });

  it("shows the Copied state once copied is true", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(HoverCardContent, { content: "x", copied: true }));
    });
    expect(renderer.root.findAllByProps({ className: "hovercard-copied" })).toHaveLength(1);
  });
});

describe("copyPrimaryValue (D1 click-to-copy contract)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the primary value to the clipboard, then calls onCopied ONLY after that write resolves", async () => {
    let resolveWrite!: () => void;
    const writeText = vi.fn(() => new Promise<void>((res) => { resolveWrite = res; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onCopied = vi.fn();

    copyPrimaryValue("Fix the thing", onCopied);

    expect(writeText).toHaveBeenCalledWith("Fix the thing");
    expect(onCopied).not.toHaveBeenCalled(); // not optimistic — the promise hasn't resolved yet

    resolveWrite();
    await Promise.resolve();
    await Promise.resolve();

    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no primary value", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    copyPrimaryValue(undefined, vi.fn());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("fails silent (no throw, no state change) in an environment without a Clipboard API", () => {
    vi.stubGlobal("navigator", {});
    const onCopied = vi.fn();
    expect(() => copyPrimaryValue("hello", onCopied)).not.toThrow();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("skips the copy when a text selection inside the card is active", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { getSelection: () => ({ toString: () => "some selected text" }) });
    copyPrimaryValue("hello", vi.fn());
    expect(writeText).not.toHaveBeenCalled();
    expect(hasActiveTextSelection()).toBe(true);
  });
});

describe("ladderStatuses (D2 demoted-statuses list)", () => {
  it("returns every applicable ladder status, not just the one the row's single dot shows", () => {
    const list = ladderStatuses({ status: "in_progress", awaiting_input: 1 }, { running: true, unviewed: true });
    expect(list.map((s) => s.kind)).toEqual(["awaiting", "running", "unviewed"]);
    expect(list.map((s) => s.label)).toEqual([
      "Needs your input",
      "Working",
      "Finished while you were away",
    ]);
  });

  it("returns an empty list for an idle task", () => {
    expect(ladderStatuses({ status: "not_started", awaiting_input: 0 }, { running: false, unviewed: false })).toEqual([]);
  });

  it("running alone (not awaiting, not unviewed) returns just the running entry", () => {
    const list = ladderStatuses({ status: "in_progress", awaiting_input: 0 }, { running: true, unviewed: false });
    expect(list).toEqual([{ kind: "running", label: "Working" }]);
  });
});

describe("source: hover card wiring in TasksColumn / ProjectsColumn (D2/D3)", () => {
  const sharedSrc = source("app/orchestrator/shared.tsx");
  const tasksSrc = source("app/orchestrator/TasksColumn.tsx");
  const projSrc = source("app/orchestrator/ProjectsColumn.tsx");

  it("TaskCard's hover card lists every ladder status with its own dot + label", () => {
    expect(tasksSrc).toContain("ladderStatuses(task, { running, unviewed: !!unviewed })");
    expect(tasksSrc).toContain("statuses.map((s) =>");
    expect(tasksSrc).toContain('<span className={`ldot ${s.kind}`} />');
  });

  it("TaskCard's hover card copies the task title, not some other field", () => {
    expect(tasksSrc).toContain("copyValue={task.title}");
  });

  it("TaskCard's hover card shows the full title and a relative time", () => {
    expect(tasksSrc).toContain('<div className="hc-title">{task.title}</div>');
    expect(tasksSrc).toContain("relTime(task.updated_at)");
  });

  it("ProjectsColumn's hover card copies the working directory path, not the project name", () => {
    expect(projSrc).toContain("copyValue={p.repo_path}");
  });

  it("ProjectsColumn's hover card shows the full project name, path, awaiting count and running count", () => {
    expect(projSrc).toContain('<div className="hc-title">{p.name}</div>');
    expect(projSrc).toContain('<div className="hc-path">{p.repo_path}</div>');
    expect(projSrc).toContain("{p.awaiting_count} waiting on you");
    expect(projSrc).toContain('{isRunning ? "1 task running" : "0 tasks running"}');
  });

  it("clicking the card copies via copyPrimaryValue and shows Copied only once that write resolves", () => {
    // The ordering contract lives in shared.tsx's copyPrimaryValue (pinned above
    // by the async test); here we just confirm HoverCard actually routes its
    // click through it rather than writing to the clipboard directly, and that
    // the "Copied" state is set from the onCopied callback (post-resolve).
    expect(sharedSrc).toContain("onClick={() => copyPrimaryValue(copyValue, () => {");
    expect(sharedSrc).toContain("clipboard.writeText(value).then(onCopied).catch(() => {});");
    expect(sharedSrc).not.toMatch(/setCopied\(true\)[^)]*navigator\.clipboard\.writeText/);
  });

  it("text selection inside the card is checked before any copy happens", () => {
    expect(sharedSrc).toContain("if (hasActiveTextSelection()) return;");
  });

  it("HoverCard does not trap focus or intercept Tab (presentational only)", () => {
    expect(sharedSrc).not.toContain("tabIndex");
    expect(sharedSrc).not.toContain("trapFocus");
  });
});
