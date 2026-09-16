// The model badge exists to answer one question: which model did this turn
// actually run on? Family aliases move — "opus" resolved to claude-opus-4-8
// before it resolved to claude-opus-5 — so a badge that reads just "Opus" is
// worse than no badge. These pin the version (and the 1M variant) surviving.
import { describe, it, expect } from "vitest";
import { modelLabel, contextWindowOf } from "@/app/orchestrator/format";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";

const claude = CLAUDE_CAPABILITIES;

describe("modelLabel", () => {
  it("keeps the version, so Opus 5 never reads as bare Opus", () => {
    expect(modelLabel("claude-opus-5", claude)).toBe("Opus 5");
    expect(modelLabel("claude-opus-4-8", claude)).toBe("Opus 4.8");
    expect(modelLabel("claude-opus-4-8-20251101", claude)).toBe("Opus 4.8");
    expect(modelLabel("claude-sonnet-5", claude)).toBe("Sonnet 5");
    expect(modelLabel("claude-fable-5", claude)).toBe("Fable 5");
    expect(modelLabel("claude-haiku-4-5", claude)).toBe("Haiku 4.5");
  });

  it("marks the 1M-context variant as a distinct run mode", () => {
    expect(modelLabel("claude-opus-5[1m]", claude)).toBe("Opus 5 (1M)");
    expect(modelLabel("claude-sonnet-4-6[1m]", claude)).toBe("Sonnet 4.6 (1M)");
  });

  it("falls back to capability labels for ids with no version shape", () => {
    expect(modelLabel("gpt-6-astra", CODEX_CAPABILITIES)).toBe("GPT-6 Astra");
    expect(modelLabel("gpt-5.5", CODEX_CAPABILITIES)).toBe("GPT-5.5");
    expect(modelLabel("gpt-5.3-codex-spark", CODEX_CAPABILITIES)).toBe("GPT-5.3 Codex Spark");
    // A value that is a prefix of another ("x" vs "x-mini") - longest-first
    // matching must not let the shorter value shadow the more specific one.
    const caps = {
      ...CODEX_CAPABILITIES,
      models: [
        { value: "gpt-x", label: "GPT-X", sub: "", contextWindow: 1, group: "g" },
        { value: "gpt-x-mini", label: "GPT-X Mini", sub: "", contextWindow: 1, group: "g" },
      ],
    };
    expect(modelLabel("gpt-x-mini", caps)).toBe("GPT-X Mini");
    // Retired ids (no longer in the catalog) degrade to the raw id, never a
    // wrong label from a neighbouring entry.
    expect(modelLabel("gpt-5.4-mini", CODEX_CAPABILITIES)).toBe("gpt-5.4-mini");
  });

  it("degrades to the family, then the raw id", () => {
    expect(modelLabel("claude-opus-latest", claude)).toBe("Opus");
    expect(modelLabel("some-unknown-model")).toBe("some-unknown-model");
    expect(modelLabel(null)).toBe("");
  });
});

describe("claude model list", () => {
  it("offers unique values and labels (the picker keys on label)", () => {
    expect(new Set(claude.models.map((m) => m.value)).size).toBe(claude.models.length);
    expect(new Set(claude.models.map((m) => m.label)).size).toBe(claude.models.length);
  });

  it("groups options contiguously so one header renders per section", () => {
    const seen: string[] = [];
    for (const m of claude.models) {
      const g = m.group ?? "";
      if (seen[seen.length - 1] !== g) {
        expect(seen).not.toContain(g); // a group must not resume after another
        seen.push(g);
      }
    }
    expect(seen.length).toBeGreaterThan(1);
  });

  it("sizes the context gauge per selected variant, not per family", () => {
    expect(contextWindowOf("opus", claude)).toBe(200_000);
    expect(contextWindowOf("opus[1m]", claude)).toBe(1_000_000);
    expect(contextWindowOf("fable", claude)).toBe(1_000_000);
  });
});

describe("codex model list", () => {
  it("offers GPT-6 Astra then the GPT-5.6 family first, in catalog priority order", () => {
    expect(CODEX_CAPABILITIES.models.slice(0, 4).map((m) => m.value)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("uses the window codex actually runs (272k), not the API maximum", () => {
    for (const model of CODEX_CAPABILITIES.models.filter((m) => /^gpt-(6|5\.6)-/.test(m.value))) {
      expect(model.contextWindow).toBe(272_000);
    }
  });

  it("no longer offers models the catalog retired", () => {
    const values = CODEX_CAPABILITIES.models.map((m) => m.value);
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"]) {
      expect(values).not.toContain(retired);
    }
  });
});
