import { describe, expect, it } from "vitest";
import { groupTranscript, workLabel } from "@/app/orchestrator/workGroups";
import type { Msg } from "@/app/orchestrator/types";

let n = 0;
const msg = (role: Msg["role"], content = "x", createdAt?: number): Msg => ({ id: `m${++n}`, role, content, generation: 1, createdAt });
const tool = (title: string, extra: Record<string, unknown> = {}, at?: number) => msg("tool", JSON.stringify({ title, result: "ok", ...extra }), at);
const shape = (items: ReturnType<typeof groupTranscript>) =>
  items.map((it) => (it.kind === "work" ? `work(${it.items.length},${it.live ? "live" : "done"})` : it.m.role));

describe("groupTranscript", () => {
  it("folds a finished turn's tools and chatter into one row, keeping the answer", () => {
    const t = [msg("user"), msg("assistant", "looking", 1000), tool("a"), msg("assistant", "oops, retrying"), tool("b", { isError: true }), tool("c"), msg("assistant", "answer", 61000)];
    const out = groupTranscript(t, false);
    expect(shape(out)).toEqual(["user", "work(5,done)", "assistant"]);
    const g = out[1];
    if (g.kind !== "work") throw new Error();
    expect(g.steps).toBe(3);
    expect(g.failed).toBe(1);
    expect(workLabel(g)).toBe("Worked for 1m 0s · 3 steps");
    const answer = out[2];
    expect(answer.kind === "msg" && !answer.hideWho).toBe(true);
  });

  it("leaves a lone tool call and prose-only turns alone", () => {
    expect(shape(groupTranscript([msg("user"), tool("a"), msg("assistant")], false))).toEqual(["user", "tool", "assistant"]);
    expect(shape(groupTranscript([msg("user"), msg("assistant"), msg("assistant")], false))).toEqual(["user", "assistant", "assistant"]);
  });

  it("keeps ask cards and system notices inline, splitting the fold", () => {
    const t = [msg("user"), tool("a"), tool("b"), tool("ask", { ask: { id: "q", questions: [] } }), msg("system", "⚠ hi"), tool("c"), msg("assistant")];
    expect(shape(groupTranscript(t, false))).toEqual(["user", "work(2,done)", "tool", "system", "tool", "assistant"]);
  });

  it("puts everything in the live turn into one Working row, only in the last turn", () => {
    const t = [msg("user"), tool("a"), tool("b"), msg("assistant"), msg("user"), msg("assistant", "thinking"), tool("c")];
    const out = groupTranscript(t, true);
    expect(shape(out)).toEqual(["user", "work(2,done)", "assistant", "user", "work(2,live)"]);
    const live = out[4];
    if (live.kind !== "work") throw new Error();
    expect(workLabel(live)).toBe("Working · 1 step");
  });

  it("keeps a stable row id as a live stretch grows", () => {
    const base = [msg("user"), tool("a")];
    const a = groupTranscript(base, true)[1];
    const b = groupTranscript([...base, tool("b"), msg("assistant")], false)[1];
    expect(a.kind === "work" && b.kind === "work" && a.id === b.id).toBe(true);
  });
});
