import { describe, expect, it } from "vitest";
import { producedFiles } from "@/app/orchestrator/format";
import type { Msg } from "@/app/orchestrator/types";
import type { DiffLine } from "@/lib/types";

const diff: DiffLine[] = [{ sign: "+", text: "x" }];

function toolMsg(id: string, detail: string, hasDiff = true): Msg {
  return {
    id,
    role: "tool",
    generation: 1,
    content: JSON.stringify(hasDiff ? { title: "✎ Edit", detail, diff } : { title: "📖 Read", detail }),
  };
}

describe("producedFiles()", () => {
  it("collects edit/write paths from tool calls after fromIndex", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "go", generation: 1 },
      toolMsg("t1", "/repo/a.ts"),
      toolMsg("t2", "/repo/b.ts"),
      { id: "a1", role: "assistant", content: "done", generation: 1 },
    ];
    const files = producedFiles(messages, 0);
    expect(files.map((f) => f.path)).toEqual(["/repo/b.ts", "/repo/a.ts"]);
    expect(files.map((f) => f.basename)).toEqual(["b.ts", "a.ts"]);
  });

  it("excludes read-only tool calls (no diff)", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "go", generation: 1 },
      toolMsg("t1", "/repo/a.ts", false), // Read: no diff
      { id: "a1", role: "assistant", content: "done", generation: 1 },
    ];
    expect(producedFiles(messages, 0)).toEqual([]);
  });

  it("never derives paths from assistant prose, only tool ToolData", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "go", generation: 1 },
      { id: "a1", role: "assistant", content: "I edited /repo/a.ts and /repo/b.ts", generation: 1 },
    ];
    expect(producedFiles(messages, 0)).toEqual([]);
  });

  it("dedupes a path touched more than once, keeping its most recent (last) position", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "go", generation: 1 },
      toolMsg("t1", "/repo/a.ts"),
      toolMsg("t2", "/repo/b.ts"),
      toolMsg("t3", "/repo/a.ts"),
      { id: "a1", role: "assistant", content: "done", generation: 1 },
    ];
    const files = producedFiles(messages, 0);
    // /repo/a.ts's last touch (index 3) is more recent than /repo/b.ts's (index 2).
    expect(files.map((f) => f.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("ignores everything at or before fromIndex", () => {
    const messages: Msg[] = [
      toolMsg("t0", "/repo/before.ts"),
      { id: "u1", role: "user", content: "go", generation: 1 },
      toolMsg("t1", "/repo/after.ts"),
    ];
    const files = producedFiles(messages, 1);
    expect(files.map((f) => f.path)).toEqual(["/repo/after.ts"]);
  });

  it("caps nothing itself - overflow/cap is the caller's (UI) job, not the pure helper's", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "go", generation: 1 },
      ...Array.from({ length: 9 }, (_, i) => toolMsg(`t${i}`, `/repo/f${i}.ts`)),
    ];
    expect(producedFiles(messages, 0)).toHaveLength(9);
  });
});
