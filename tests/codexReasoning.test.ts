import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { EFFORT } from "@/lib/agents/codex/driver";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";

// Pins the reasoning-preset → model_reasoning_effort mapping. Every current
// codex model supports exactly low|medium|high|xhigh; "minimal" still exists
// in the SDK's ModelReasoningEffort type but the API rejects the whole turn
// with a 400 (verified live on codex-cli 0.142.5), so it must never be sent.
describe("codex reasoning-effort mapping", () => {
  it("only sends levels every codex model supports (never 'minimal')", () => {
    const supported = new Set(["low", "medium", "high", "xhigh"]);
    for (const [preset, effort] of Object.entries(EFFORT)) {
      expect(supported.has(effort), `${preset} → ${effort}`).toBe(true);
    }
  });

  it("maps the shared presets onto the full codex scale, medium included", () => {
    expect(EFFORT).toEqual({ off: "low", think: "medium", think_hard: "high", ultrathink: "xhigh" });
  });

  it("declares a mapping for every reasoning option the picker offers", () => {
    for (const opt of CODEX_CAPABILITIES.reasoningOptions) {
      expect(EFFORT[opt.value], opt.value).toBeDefined();
    }
  });
});

describe("codex orchestrator MCP approvals", () => {
  it("pre-approves only linked workstream writes for non-interactive turns", async () => {
    const source = await readFile(
      new URL("../lib/agents/codex/driver.ts", import.meta.url),
      "utf8",
    );
    const approvals = source.match(
      /tools:\s*\{([\s\S]*?)\n\s{8}\},\n\s{8}env:/,
    )?.[1] ?? "";

    expect(approvals).toContain(
      'publish_workstream_update: { approval_mode: "approve" }',
    );
    expect(approvals).toContain(
      'propose_card_change: { approval_mode: "approve" }',
    );
    expect(approvals).not.toMatch(
      /\b(?:suggest_task|expose_service|ask_user)\b/,
    );
  });
});
