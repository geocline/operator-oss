// The internal one-shot jobs (recap, /clear handoff note, "Refresh with AI"
// context draft) run outside the main chat, so the user never picks a model for
// them. Left unset they'd inherit the CLI default (Opus on a typical Claude
// login) for work that doesn't need it — these tests pin the tiering configured
// in lib/config.ts, and that an empty override still means "inherit".

import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

const captures = vi.hoisted(() => ({
  claude: [] as Record<string, unknown>[],
  codex: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    captures.claude.push(options);
    return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
    })();
  },
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
}));

vi.mock("@openai/codex-sdk", () => {
  class Thread {
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", text: "ok" } };
        })(),
      };
    }
  }
  class Codex {
    startThread(options: Record<string, unknown>) {
      captures.codex.push(options);
      return new Thread();
    }
  }
  return { Codex };
});

const project = { id: "p1", name: "Demo", repo_path: "", context: "" } as unknown as Project;

describe("one-shot model tiering", () => {
  it("runs the Claude one-shots on the cheap tiers, not the chat default", async () => {
    const { claudeDriver } = await import("@/lib/agents/claude/driver");
    captures.claude.length = 0;

    await claudeDriver.summarizeProjectRecap!(project, "digest");
    await claudeDriver.summarizeTranscript!("transcript", project);
    await claudeDriver.draftProjectContext!(project, "digest");

    // Recap is throwaway; the handoff note and the context draft are durable
    // (they seed the next session), so they sit one tier up.
    expect(captures.claude.map((o) => o.model)).toEqual(["haiku", "sonnet", "sonnet"]);
  });

  it("runs the Codex one-shots on the efficient model", async () => {
    const { codexDriver } = await import("@/lib/agents/codex/driver");
    captures.codex.length = 0;

    await codexDriver.summarizeProjectRecap!(project, "digest");
    await codexDriver.summarizeTranscript!("transcript", project);

    expect(captures.codex.map((o) => o.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]);
  });

  it("treats an empty override as inherit-the-CLI-default", async () => {
    vi.resetModules();
    vi.stubEnv("ORCH_CLAUDE_RECAP_MODEL", "");
    try {
      const { claudeDriver } = await import("@/lib/agents/claude/driver");
      captures.claude.length = 0;
      await claudeDriver.summarizeProjectRecap!(project, "digest");
      expect(captures.claude[0]).not.toHaveProperty("model");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
