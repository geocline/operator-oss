import fs from "node:fs";
import path from "node:path";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { QueueDock } from "@/app/orchestrator/SessionView";
import type { Msg } from "@/app/orchestrator/types";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function queuedMsg(id: string, text: string): Msg {
  return { id, role: "queued", content: text, generation: 1 };
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

// Package E1: the queue dock replaces the old pinned `.msg.user.queued`
// transcript bubbles - one message = a compact row, 2+ collapse behind an
// expand toggle, cancel/edit preserve the exact caller-provided handlers
// (SessionView wires cancel straight to the same dequeue path the old
// `.queued-x` used, and edit to cancel-then-seed-the-draft - see
// SessionView.tsx's onEdit wiring, pinned by source-text below).
describe("QueueDock", () => {
  it("renders nothing at zero (suppressed, not disabled)", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, { queued: [], onCancel: vi.fn(), onEdit: vi.fn() }));
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("one pending message renders as a single compact row, no expand toggle", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, {
        queued: [queuedMsg("p1", "first follow-up")],
        onCancel: vi.fn(),
        onEdit: vi.fn(),
      }));
    });
    expect(renderer.root.findAllByProps({ className: "dock-row" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: "dock-summary" })).toHaveLength(0);
    expect(textOf(renderer.root.findByProps({ className: "dock-row-text" }))).toBe("first follow-up");
  });

  it("three or more collapse to a count behind an aria-expanded toggle, and expand reveals every row", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, {
        queued: [queuedMsg("p1", "a"), queuedMsg("p2", "b"), queuedMsg("p3", "c")],
        onCancel: vi.fn(),
        onEdit: vi.fn(),
      }));
    });
    const summary = renderer.root.findByProps({ className: "dock-summary" });
    expect(summary.props["aria-expanded"]).toBe(false);
    expect(textOf(summary)).toContain("3 queued messages");
    expect(renderer.root.findAllByProps({ className: "dock-row" })).toHaveLength(0);

    act(() => { summary.props.onClick(); });
    expect(renderer.root.findByProps({ className: "dock-summary" }).props["aria-expanded"]).toBe(true);
    expect(renderer.root.findAllByProps({ className: "dock-row" })).toHaveLength(3);
  });

  it("cancel calls the dequeue handler with the row's message id - the exact call SessionView forwards to the same API path the old .queued-x used", () => {
    const onCancel = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, {
        queued: [queuedMsg("p1", "first")],
        onCancel,
        onEdit: vi.fn(),
      }));
    });
    act(() => { renderer.root.findByProps({ className: "dock-row-x queued-x" }).props.onClick(); });
    expect(onCancel).toHaveBeenCalledWith("p1");
  });

  it("edit hands the row's id and text up to the caller (SessionView cancels, then seeds the composer draft)", () => {
    const onEdit = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, {
        queued: [queuedMsg("p1", "edit me")],
        onCancel: vi.fn(),
        onEdit,
      }));
    });
    act(() => { renderer.root.findByProps({ className: "dock-row-edit" }).props.onClick(); });
    expect(onEdit).toHaveBeenCalledWith("p1", "edit me");
  });

  it("resets to collapsed once the queue empties, so the next queue of 2+ starts collapsed again", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(QueueDock, {
        queued: [queuedMsg("p1", "a"), queuedMsg("p2", "b")],
        onCancel: vi.fn(),
        onEdit: vi.fn(),
      }));
    });
    act(() => { renderer.root.findByProps({ className: "dock-summary" }).props.onClick(); });
    expect(renderer.root.findByProps({ className: "dock-summary" }).props["aria-expanded"]).toBe(true);

    act(() => {
      renderer.update(React.createElement(QueueDock, { queued: [], onCancel: vi.fn(), onEdit: vi.fn() }));
    });
    expect(renderer.toJSON()).toBeNull();

    act(() => {
      renderer.update(React.createElement(QueueDock, {
        queued: [queuedMsg("p3", "a"), queuedMsg("p4", "b")],
        onCancel: vi.fn(),
        onEdit: vi.fn(),
      }));
    });
    expect(renderer.root.findByProps({ className: "dock-summary" }).props["aria-expanded"]).toBe(false);
  });

  it("the expanded list is a bounded, scrollable region (not an unbounded page-growing list)", () => {
    const css = source("app/globals.css");
    expect(css).toContain(".dock-list{max-height:180px;overflow-y:auto;");
  });
});

// SessionView wiring: the dock lives between the transcript and the composer,
// the transcript itself renders no queued bubbles anymore, and Edit's
// cancel-then-seed-the-draft goes through a prop into Composer (seedDraft),
// not a localStorage write - Composer only reads localStorage on mount/task
// switch, so a write wouldn't reach an already-mounted Composer while the
// user keeps working the same task.
describe("QueueDock wiring in SessionView / Transcript / Composer", () => {
  it("SessionView renders the dock between the transcript and the composer, cancel forwarded to stableCancelQueued unchanged", () => {
    const view = source("app/orchestrator/SessionView.tsx");
    expect(view).toContain("<QueueDock");
    expect(view).toContain("queued={messages.filter((m) => m.role === \"queued\")}");
    expect(view).toContain('onCancel={(id) => stableCancelQueued(id)}');
    expect(view).toContain("setDraftSeed({ text, key: Date.now() })");
    expect(view).toContain("seedDraft={draftSeed}");
  });

  it("Transcript no longer renders queued bubbles - the dock owns that role now", () => {
    const transcript = source("app/orchestrator/Transcript.tsx");
    expect(transcript).toContain('if (m.role === "queued") return null;');
    expect(transcript).not.toContain("msg user queued");
    expect(transcript).not.toContain("queued-x");
  });

  it("Composer applies an edited queue row via a seedDraft prop, not a localStorage write", () => {
    const composer = source("app/orchestrator/Composer.tsx");
    expect(composer).toContain("seedDraft?:");
    expect(composer).toContain("if (!seedDraft) return;");
    expect(composer).toContain("setVal(seedDraft.text);");
  });
});
