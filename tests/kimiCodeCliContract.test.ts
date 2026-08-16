import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import {
  assertCompatibleKimiWireCli,
  clearKimiWireCliCompatibilityCacheForTest,
} from "@/lib/agents/kimi-code/cli-contract";
import { kimiCodeDriver } from "@/lib/agents/kimi-code/driver";
import {
  parseLiteLLMModelInfo,
  replaceLiteLLMCatalog,
} from "@/lib/agents/litellm/catalog";
import {
  createProject,
  createTask,
  getTask,
  updateTask,
} from "@/lib/store";
import type { StreamEvent } from "@/lib/types";

function executable(name: string, body: string): string {
  const file = path.join(process.env.ORCH_TEST_TMP!, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o700);
  return file;
}

describe("Kimi Code CLI/SDK compatibility contract", () => {
  it("accepts only the exact Wire CLI with the arguments emitted by SDK 0.1.8", () => {
    const cli = executable(
      "compatible-kimi",
      'if [ "$1" = "--version" ]; then echo "kimi, version 1.49.0"; else echo "  --work-dir DIRECTORY"; echo "  --wire"; fi',
    );

    expect(() => assertCompatibleKimiWireCli(cli)).not.toThrow();
  });

  it("rejects the non-Wire npm Kimi Code CLI even when it is executable", () => {
    const cli = executable(
      "non-wire-kimi",
      'if [ "$1" = "--version" ]; then echo "0.36.0"; else echo "Usage: kimi"; fi',
    );

    expect(() => assertCompatibleKimiWireCli(cli)).toThrow(
      /requires official Kimi Wire CLI 1\.49\.0/i,
    );
  });

  it("rejects a nominal 1.49.0 binary that lacks either SDK-required flag", () => {
    clearKimiWireCliCompatibilityCacheForTest();
    const cli = executable(
      "incomplete-wire-kimi",
      'if [ "$1" = "--version" ]; then echo "kimi, version 1.49.0"; else echo "  --wire"; fi',
    );

    expect(() => assertCompatibleKimiWireCli(cli)).toThrow(/--work-dir/);
  });

  it("the configured real CLI satisfies the contract when explicitly supplied", () => {
    const configured = process.env.KIMI_WIRE_CLI_CONTRACT_PATH;
    if (!configured) return;

    expect(() => assertCompatibleKimiWireCli(configured)).not.toThrow();
  });

  it("routes the real Wire CLI through an exact local provider and settles", async () => {
    const configured = process.env.KIMI_WIRE_CLI_CONTRACT_PATH;
    if (!configured) return;
    const root = path.join(process.env.ORCH_TEST_TMP!, "real-wire-provider");
    const home = path.join(root, "home");
    mkdirSync(path.join(home, "skills"), { recursive: true });
    const seen: Array<{
      url: string | undefined;
      authorized: boolean;
      model: unknown;
      maxCompletionTokens: unknown;
    }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { model?: unknown };
        seen.push({
          url: request.url,
          authorized: typeof request.headers.authorization === "string",
          model: parsed.model,
          maxCompletionTokens: (
            parsed as { max_completion_tokens?: unknown }
          ).max_completion_tokens,
        });
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const base = {
          id: "chatcmpl-local-contract",
          object: "chat.completion.chunk",
          created: 1,
          model: "operator.local-contract",
        };
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "LOCAL_PROVIDER_OK" },
            finish_reason: null,
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local provider did not bind a TCP port");
    }
    const settlementFile = path.join(home, "settlement.json");
    const session = createSession({
      workDir: root,
      thinking: true,
      yoloMode: true,
      executable: path.join(
        process.cwd(),
        "scripts",
        "kimi-code-launcher.mjs",
      ),
      env: {
        HOME: home,
        KIMI_CODE_HOME: home,
        KIMI_SHARE_DIR: home,
        KIMI_DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        KIMI_MODEL_NAME: "operator.local-contract",
        KIMI_API_KEY: "dummy-loopback-only",
        KIMI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        KIMI_MODEL_MAX_CONTEXT_SIZE: "1048576",
        KIMI_MODEL_MAX_COMPLETION_TOKENS: "16384",
        KIMI_MODEL_CAPABILITIES: "thinking",
        ORCH_KIMI_REAL_CLI: configured,
        ORCH_KIMI_SETTLEMENT_FILE: settlementFile,
        ORCH_KIMI_TASK_HOME: home,
        ORCH_KIMI_INLINE_CONFIG: JSON.stringify({
          default_model: "operator-relay",
          models: {
            "operator-relay": {
              provider: "operator-relay",
              model: "operator-placeholder",
              max_context_size: 1_048_576,
              capabilities: ["thinking"],
            },
          },
          providers: {
            "operator-relay": {
              type: "kimi",
              base_url: "http://127.0.0.1:1/v1",
              api_key: "",
            },
          },
        }),
      },
      shareDir: home,
      skillsDir: path.join(home, "skills"),
      clientInfo: { name: "operator-contract-test", version: "1" },
    });
    let text = "";
    try {
      const turn = session.prompt("Reply with LOCAL_PROVIDER_OK.");
      for await (const event of turn) {
        if (
          event.type === "ContentPart"
          && typeof event.payload === "object"
          && event.payload !== null
          && "type" in event.payload
          && event.payload.type === "text"
          && "text" in event.payload
          && typeof event.payload.text === "string"
        ) {
          text += event.payload.text;
        }
      }
      expect(await turn.result).toMatchObject({ status: "finished" });
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(text).toBe("LOCAL_PROVIDER_OK");
    expect(seen).toEqual([{
      url: "/v1/chat/completions",
      authorized: true,
      model: "operator.local-contract",
      maxCompletionTokens: 16_384,
    }]);
    expect(JSON.parse(readFileSync(settlementFile, "utf8"))).toMatchObject({
      status: "settled",
      survivors: [],
      child_environment: {
        credential_keys: ["KIMI_API_KEY"],
        home_is_task_home: true,
      },
    });
  });

  it("runs the real Wire CLI through Operator's full Kimi driver contract", async () => {
    const configured = process.env.KIMI_WIRE_CLI_CONTRACT_PATH;
    if (!configured) return;
    const root = path.join(process.env.ORCH_TEST_TMP!, "real-wire-driver");
    mkdirSync(root, { recursive: true });
    const seen: Array<{
      url: string | undefined;
      authorized: boolean;
      model: unknown;
      maxCompletionTokens: unknown;
      requestText: string;
    }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { model?: unknown };
        seen.push({
          url: request.url,
          authorized: request.headers.authorization === "Bearer operator-loopback-relay",
          model: parsed.model,
          maxCompletionTokens: (
            parsed as { max_completion_tokens?: unknown }
          ).max_completion_tokens,
          requestText: JSON.stringify(parsed),
        });
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const base = {
          id: "chatcmpl-local-driver",
          object: "chat.completion.chunk",
          created: 1,
          model: "operator.kimi-k3",
        };
        const reply = seen.length === 1
          ? "LOCAL_DRIVER_OK"
          : "PLANTED_FACT_7391";
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: reply },
            finish_reason: null,
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local driver provider did not bind a TCP port");
    }

    replaceLiteLLMCatalog({
      ...parseLiteLLMModelInfo({
        data: [{
          model_name: "operator.kimi-k3",
          model_info: {
            operator: {
              enabled: true,
              label: "Kimi K3",
              kind: "coding",
              admissions: [{
                harness: "kimi-code",
                status: "passed",
                harness_version: "1.49.0",
                test_revision: "local-contract",
                tested_at: "2026-08-13T00:00:00.000Z",
                requested_alias: "operator.kimi-k3",
                resolved_model: "moonshotai/kimi-k3-20260715",
              }],
              context_window: 1_048_576,
              reasoning_options: ["high"],
            },
          },
        }],
      }),
      refreshedAt: "2026-08-13T00:00:00.000Z",
      stale: false,
      error: null,
    });

    const relayGlobal = globalThis as typeof globalThis & {
      __operatorLiteLLMRelay?: Promise<{
        baseUrl: string;
        childApiKey: "operator-loopback-relay";
        generationIds(): string[];
        close(): Promise<void>;
      }>;
    };
    const previousRelay = relayGlobal.__operatorLiteLLMRelay;
    const previousCli = process.env.KIMI_CODE_CLI_PATH;
    relayGlobal.__operatorLiteLLMRelay = Promise.resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      childApiKey: "operator-loopback-relay",
      generationIds: () => [],
      close: async () => undefined,
    });
    process.env.KIMI_CODE_CLI_PATH = configured;

    const project = createProject({
      name: "KimiRealDriver",
      repo_path: root,
    });
    const task = createTask({
      project_id: project.id,
      title: "Real driver contract",
      agent: "litellm-kimi-code",
    });
    updateTask(task.id, {
      model: "operator.kimi-k3",
      reasoning: "think_hard",
      permission_mode: "bypassPermissions",
      worktree_path: root,
    });
    const firstEvents: StreamEvent[] = [];
    const resumedEvents: StreamEvent[] = [];
    try {
      for await (const event of kimiCodeDriver.runTurn(
        getTask(task.id)!,
        project,
        "Reply with LOCAL_DRIVER_OK.",
      )) {
        firstEvents.push(event);
      }
      const sessionId = firstEvents.find(
        (event): event is Extract<StreamEvent, { type: "done" }> =>
          event.type === "done",
      )?.sessionId;
      expect(sessionId).toEqual(expect.any(String));
      updateTask(task.id, { session_id: sessionId });
      for await (const event of kimiCodeDriver.runTurn(
        getTask(task.id)!,
        project,
        "Recall the planted fact from the prior turn.",
      )) {
        resumedEvents.push(event);
      }
    } finally {
      if (previousRelay) relayGlobal.__operatorLiteLLMRelay = previousRelay;
      else delete relayGlobal.__operatorLiteLLMRelay;
      if (previousCli === undefined) delete process.env.KIMI_CODE_CLI_PATH;
      else process.env.KIMI_CODE_CLI_PATH = previousCli;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(firstEvents).toEqual(expect.arrayContaining([
      { type: "model", model: "operator.kimi-k3" },
      { type: "assistant", content: "LOCAL_DRIVER_OK" },
      { type: "done", sessionId: expect.any(String) },
    ]));
    expect(resumedEvents).toEqual(expect.arrayContaining([
      { type: "model", model: "operator.kimi-k3" },
      { type: "assistant", content: "PLANTED_FACT_7391" },
      { type: "done", sessionId: expect.any(String) },
    ]));
    expect([
      ...firstEvents,
      ...resumedEvents,
    ].some((event) => event.type === "error")).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen.map(({ requestText: _requestText, ...request }) => request))
      .toEqual([{
      url: "/v1/chat/completions",
      authorized: true,
      model: "operator.kimi-k3",
      maxCompletionTokens: 16_384,
    }, {
      url: "/v1/chat/completions",
      authorized: true,
      model: "operator.kimi-k3",
      maxCompletionTokens: 16_384,
    }]);
    expect(seen[1].requestText).toContain("LOCAL_DRIVER_OK");
    expect(seen[1].requestText).toContain(
      "Recall the planted fact from the prior turn.",
    );
  });
});
