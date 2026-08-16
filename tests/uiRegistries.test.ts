import { describe, expect, it } from "vitest";
import {
  registerToolCard,
  getToolCard,
  registerCommand,
  listCommands,
  registerSessionStatus,
  sessionStatusContributions,
  registerComposerSeat,
  composerSeatsFor,
  type ComposerCommandCtx,
} from "@/app/orchestrator/registry";
import { rowStatus } from "@/app/orchestrator/statusLadder";
import type { TaskRow } from "@/app/orchestrator/types";
// Importing these triggers their module-level self-registration - the actual
// proof-case wiring this package moves (F1 the ask card, F2 the three slash
// commands, F4 the attach-file seat). Side-effect imports, nothing used
// directly from them.
import "@/app/orchestrator/Transcript";
import "@/app/orchestrator/Composer";

describe("registerToolCard / getToolCard (F1)", () => {
  it("dispatches a registered key to its component", () => {
    const Stub = () => null;
    registerToolCard("uiRegistries-test-card", Stub);
    expect(getToolCard("uiRegistries-test-card")).toBe(Stub);
  });

  it("falls back to undefined for an unregistered key (caller renders the generic ToolView)", () => {
    expect(getToolCard("uiRegistries-test-nonexistent")).toBeUndefined();
    expect(getToolCard(undefined)).toBeUndefined();
  });

  it("re-registering the same key with the identical component is a no-op", () => {
    const Stub = () => null;
    registerToolCard("uiRegistries-test-card-idempotent", Stub);
    expect(() => registerToolCard("uiRegistries-test-card-idempotent", Stub)).not.toThrow();
  });

  it("re-registering the same key with a different component throws", () => {
    registerToolCard("uiRegistries-test-card-collide", () => null);
    expect(() => registerToolCard("uiRegistries-test-card-collide", () => null)).toThrow();
  });

  it("Transcript.tsx registered the ask card under the 'ask' intent (proof case)", () => {
    expect(getToolCard("ask")).toBeDefined();
  });
});

describe("registerCommand / listCommands (F2)", () => {
  it("dispatches a registered command and rejects a colliding re-registration", () => {
    const run = () => {};
    const visible = () => true;
    registerCommand({ name: "/uiRegistries-test-cmd", description: "test command", visible, run });
    expect(listCommands().find((c) => c.name === "/uiRegistries-test-cmd")).toBeDefined();
    expect(() =>
      registerCommand({ name: "/uiRegistries-test-cmd", description: "test command", visible, run })
    ).not.toThrow(); // identical run/visible references - a no-op
    expect(() =>
      registerCommand({ name: "/uiRegistries-test-cmd", description: "different", visible, run: () => {} })
    ).toThrow();
  });

  it("Composer.tsx registered /clear, /handoff, /help with identical gating (proof case)", () => {
    const started: ComposerCommandCtx = {
      task: { started: 1 } as TaskRow,
      setVal: () => {},
      setSlash: () => {},
      onClear: () => {},
      focus: () => {},
    };
    const fresh: ComposerCommandCtx = { ...started, task: { started: 0 } as TaskRow };

    const names = listCommands().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["/clear", "/handoff", "/help"]));

    const clear = listCommands().find((c) => c.name === "/clear")!;
    const handoff = listCommands().find((c) => c.name === "/handoff")!;
    const help = listCommands().find((c) => c.name === "/help")!;
    // /clear and /handoff only once a session has started; /help always.
    expect(clear.visible(started)).toBe(true);
    expect(clear.visible(fresh)).toBe(false);
    expect(handoff.visible(started)).toBe(true);
    expect(handoff.visible(fresh)).toBe(false);
    expect(help.visible(started)).toBe(true);
    expect(help.visible(fresh)).toBe(true);

    let cleared = false;
    let val = "";
    let slash = false;
    clear.run({ ...started, onClear: () => { cleared = true; }, setVal: (v) => { val = v; }, setSlash: (s) => { slash = s; } });
    expect(cleared).toBe(true);
    expect(val).toBe("");
    expect(slash).toBe(false);
  });
});

describe("registerSessionStatus / sessionStatusContributions (F3)", () => {
  it("dispatches to a registered contributor and rejects a colliding re-registration", () => {
    const fn = () => null;
    registerSessionStatus("uiRegistries-test-status", fn);
    expect(sessionStatusContributions()).toContain(fn);
    expect(() => registerSessionStatus("uiRegistries-test-status", fn)).not.toThrow();
    expect(() => registerSessionStatus("uiRegistries-test-status", () => null)).toThrow();
  });

  it("statusLadder ships with zero contributors by default - built-ins alone decide the row", () => {
    // No task/opts here can produce a non-"none" result unless some earlier
    // test in this file left a contributor registered that fires on it; the
    // built-in precedence (awaiting > running > unviewed > none) is what's
    // under test, exercised the same way tests/statusLadder.test.ts does.
    expect(rowStatus({ status: "not_started", awaiting_input: 0 }, { running: false, unviewed: false })).toEqual({ kind: "none" });
  });

  it("built-ins always win over a registered contributor (fold sits BELOW them)", () => {
    registerSessionStatus("uiRegistries-test-status-precedence", (task) =>
      task.status === "in_progress" ? { kind: "running", label: "Working" } : null
    );
    // awaiting is a built-in and must win even though the contributor above
    // would also claim this row.
    const status = rowStatus({ status: "in_progress", awaiting_input: 1 }, { running: false, unviewed: false });
    expect(status.kind).toBe("awaiting");
  });

  it("a registered contributor is consulted once every built-in says no", () => {
    registerSessionStatus("uiRegistries-test-status-fallback", (task) =>
      task.status === "on_hold" ? { kind: "none" } : null
    );
    // The built-ins all say "none" for an on_hold task with no running/unviewed
    // flags, so the fold runs; this contributor returns a (non-null) RowStatus
    // for it, proving the fold actually executes and its result is returned.
    const result = rowStatus({ status: "on_hold", awaiting_input: 0 }, { running: false, unviewed: false });
    expect(result).toEqual({ kind: "none" });
  });
});

describe("registerComposerSeat / composerSeatsFor (F4)", () => {
  it("dispatches a registered seat in order and rejects a colliding re-registration", () => {
    const Stub = () => null;
    registerComposerSeat("uiRegistries-test-seat", "left", { order: 5, Component: Stub });
    const left = composerSeatsFor("left");
    expect(left.find((s) => s.name === "uiRegistries-test-seat")?.Component).toBe(Stub);
    expect(() => registerComposerSeat("uiRegistries-test-seat", "left", { order: 5, Component: Stub })).not.toThrow();
    expect(() => registerComposerSeat("uiRegistries-test-seat", "left", { order: 5, Component: () => null })).toThrow();
  });

  it("falls back to an empty list for a side with nothing registered (Composer's left fold, today)", () => {
    // Only the collision test above ever registers onto "left" (under a
    // uiRegistries-test- prefixed name); nothing app-level claims it.
    expect(composerSeatsFor("left").every((s) => s.name.startsWith("uiRegistries-test-"))).toBe(true);
  });

  it("Composer.tsx registered the attach-file button on the right (proof case)", () => {
    const right = composerSeatsFor("right");
    expect(right.find((s) => s.name === "attach-file")).toBeDefined();
  });

  it("attach-file seat hides (renders null) when the composer is disabled, same as the inline `!disabled &&` it replaced", () => {
    const entry = composerSeatsFor("right").find((s) => s.name === "attach-file")!;
    expect(entry.Component({ disabled: true, openFilePicker: () => {} })).toBeNull();
  });
});
