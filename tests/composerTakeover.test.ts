import fs from "node:fs";
import path from "node:path";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AskPanel } from "@/app/orchestrator/Transcript";
import type { ToolData } from "@/lib/types";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const pendingAsk: ToolData = {
  title: "AskUserQuestion",
  ask: {
    id: "ask-1",
    questions: [
      { question: "Which budget?", header: "Budget", options: [{ label: "$5M" }, { label: "$10M" }] },
    ],
  },
};

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
  return root.findAll((n) => textOf(n) === text || n.children.includes(text))[0];
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const btn = root.findAllByType("button").find((b) => textOf(b).includes(text));
  if (!btn) throw new Error(`no button containing "${text}"`);
  return btn;
}

// Package C1: while a question is pending, the composer's input area is
// replaced by an AskPanel (chips/options/free-text/submit) instead of the
// plain textarea. These tests exercise AskPanel directly — the pure,
// fetch-free unit the takeover is built from — and lean on source-text
// assertions (the same pattern tests/workstreamSessionUi.test.ts and
// tests/worktreeClarityUi.test.ts already use for SessionView) to pin how
// SessionView wires it in, since SessionView itself pulls in fetch-backed
// children (WorkstreamTaskControls, SyncBanner) that aren't worth mocking
// just to re-prove logic AskPanel already covers in isolation.
describe("composer takeover for asks", () => {
  it("renders the question text", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(AskPanel, {
        data: pendingAsk,
        agentLabel: "Claude",
        onAnswer: vi.fn(async () => {}),
        onChatAboutIt: vi.fn(),
      }));
    });
    expect(findByText(renderer.root, "Which budget?")).toBeDefined();
    expect(findButton(renderer.root, "$5M")).toBeDefined();
  });

  it("shows a visible incomplete-reason instead of a silently disabled button", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(AskPanel, {
        data: pendingAsk,
        agentLabel: "Claude",
        onAnswer: vi.fn(async () => {}),
        onChatAboutIt: vi.fn(),
      }));
    });
    expect(findByText(renderer.root, "Answer question 1 to send")).toBeDefined();
    expect(findButton(renderer.root, "Send answer").props.disabled).toBe(true);
  });

  it("submits picked answers through onAnswer", async () => {
    const onAnswer = vi.fn(async () => {});
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(AskPanel, {
        data: pendingAsk,
        agentLabel: "Claude",
        onAnswer,
        onChatAboutIt: vi.fn(),
      }));
    });
    await act(async () => { findButton(renderer.root, "$5M").props.onClick(); });
    await act(async () => { await findButton(renderer.root, "Send answer").props.onClick(); });
    expect(onAnswer).toHaveBeenCalledWith([["$5M"]]);
  });

  it("offers a Chat about it escape hatch", async () => {
    const onChatAboutIt = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(AskPanel, {
        data: pendingAsk,
        agentLabel: "Claude",
        onAnswer: vi.fn(async () => {}),
        onChatAboutIt,
      }));
    });
    act(() => { findButton(renderer.root, "Chat about it").props.onClick(); });
    expect(onChatAboutIt).toHaveBeenCalledOnce();
  });

  it("SessionView swaps the composer for AskPanel, keyed off task/message state, and wires the Chat-about-it strip and free-text answer path", () => {
    const view = source("app/orchestrator/SessionView.tsx");
    // Derived from messages, not local ephemeral state — survives tab switches.
    expect(view).toContain("const pendingAsk = useMemo(");
    expect(view).toContain("pendingAsk && !chatAboutIt");
    expect(view).toContain("<AskPanel");
    expect(view).toContain("onAnswer={submitAskAnswer}");
    expect(view).toContain("onChatAboutIt={() => setChatAboutIt(true)}");
    // Chat-about-it mode: dismissible strip + textarea, submitting through the
    // same onAnswer path as a free-text "Other".
    expect(view).toContain("answering-strip");
    expect(view).toContain("Answering:");
    expect(view).toContain("setChatAboutIt(false)");
    expect(view).toContain("void submitAskAnswer(qs.map(() => [text]))");
    // Reset on task switch so the takeover can't leak across tasks.
    expect(view).toMatch(/useEffect\(\(\) => \{ setChatAboutIt\(false\); \}, \[task\.id\]\);/);
  });

  it("the transcript's pending ask card is non-interactive context, not a duplicate set of controls", () => {
    const transcript = source("app/orchestrator/Transcript.tsx");
    expect(transcript).toContain("ask-pending");
    expect(transcript).toContain("Answer below");
    // The answered-state summary is unchanged.
    expect(transcript).toContain("You answered");
    // The read-only card's own function signature takes no onAnswer - the
    // decision lives in AskPanel/the composer now.
    expect(transcript).toContain("function AskView({ data, agentLabel }: { data: ToolData; agentLabel: string })");
    expect(transcript).toContain("export function AskPanel({ data, agentLabel, onAnswer, onChatAboutIt }");
  });
});
