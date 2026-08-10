import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  APPROVED_MODEL,
  assertCompatibilityResult,
  assertKimiOnlyEvidence,
  buildClaudeArgs,
  buildClaudeEnv,
  generationCoverage,
  keyUsageDelta,
  parseClaudeVersion,
  parseClaudeEvents,
  runClaudeProcess,
} from "./runner.mjs";

test("pins every Claude Code model role to the approved Kimi K3 model", () => {
  const env = buildClaudeEnv({
    baseEnv: {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "must-not-survive",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://forbidden.example",
      ANTHROPIC_VERTEX_BASE_URL: "https://forbidden.example",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://forbidden.example",
    },
    secret: "dedicated-secret",
    configDir: "/tmp/isolated-claude-config",
  });

  assert.equal(APPROVED_MODEL, "moonshotai/kimi-k3");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dedicated-secret");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_MODEL, APPROVED_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, APPROVED_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, APPROVED_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, APPROVED_MODEL);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, APPROVED_MODEL);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/isolated-claude-config");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  for (const forbidden of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
  ]) {
    assert.equal(forbidden in env, false);
  }
});

test("uses safe isolated Claude Code flags without a fallback model", () => {
  const args = buildClaudeArgs("Read the fixture", { maxBudgetUsd: 2 });

  assert.deepEqual(args.slice(0, 5), [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--safe-mode",
  ]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes(APPROVED_MODEL));
  assert.ok(args.includes("--max-budget-usd"));
  assert.ok(args.includes("2"));
  assert.ok(!args.includes("--fallback-model"));
  assert.equal(args.at(-1), "Read the fixture");
});

test("summarizes Claude stream events, tools, usage, session, and request IDs", () => {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "session-1",
      model: "moonshotai/kimi-k3",
    },
    {
      type: "assistant",
      message: {
        id: "gen-approved-1",
        model: "moonshotai/kimi-k3-20260715",
        usage: {
          input_tokens: 120,
          output_tokens: 12,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 3,
        },
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "facts.txt" } },
          { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "shasum facts.txt" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "fixture", is_error: false }],
      },
    },
    {
      type: "assistant",
      message: {
        id: "gen-approved-2",
        model: "moonshotai/kimi-k3-20260715",
        usage: { input_tokens: 20, output_tokens: 7 },
        content: [{ type: "text", text: "Final answer." }],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "session-1",
      result: "Final answer.",
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 300,
        output_tokens: 30,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 4,
      },
      modelUsage: {
        "moonshotai/kimi-k3": {
          inputTokens: 300,
          outputTokens: 30,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 4,
          canonicalModel: "moonshotai/kimi-k3",
        },
      },
    },
  ];

  const summary = parseClaudeEvents(events);

  assert.equal(summary.sessionId, "session-1");
  assert.equal(summary.finalResponse, "Final answer.");
  assert.deepEqual(summary.models, [
    "moonshotai/kimi-k3",
    "moonshotai/kimi-k3-20260715",
  ]);
  assert.deepEqual(summary.generationIds, ["gen-approved-1", "gen-approved-2"]);
  assert.equal(summary.modelCalls, 2);
  assert.equal(summary.toolCalls, 2);
  assert.deepEqual(summary.toolNames, ["Read", "Bash"]);
  assert.equal(summary.toolErrors, 0);
  assert.deepEqual(summary.usage, {
    input: 300,
    output: 30,
    cacheRead: 80,
    cacheWrite: 4,
    total: 414,
  });
  assert.equal(summary.reportedCost, 0.0123);
});

test("counts errored tool results and rejects malformed stream lines", () => {
  const summary = parseClaudeEvents([
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "failure", is_error: true }],
      },
    },
  ]);
  assert.equal(summary.toolErrors, 1);

  assert.throws(() => parseClaudeEvents('{"type":"result"}\nnot-json\n'), /malformed Claude JSONL/);
});

test("accepts exact or dated Kimi K3 and rejects aliases or suffixed fallbacks", () => {
  assert.doesNotThrow(() =>
    assertKimiOnlyEvidence(["moonshotai/kimi-k3", "moonshotai/kimi-k3-20260715"]),
  );
  assert.throws(() => assertKimiOnlyEvidence([]), /missing model evidence/);
  assert.throws(() => assertKimiOnlyEvidence(["openai/gpt-5"]), /forbidden model/);
  assert.throws(() => assertKimiOnlyEvidence(["anthropic/claude-sonnet-4"]), /forbidden model/);
  assert.throws(
    () => assertKimiOnlyEvidence(["moonshotai/kimi-k3-openai-fallback"]),
    /forbidden model/,
  );
});

test("requires a successful deterministic tool compatibility result", () => {
  const expectedHash = "abc123";
  assert.doesNotThrow(() =>
    assertCompatibilityResult(
      {
        finalResponse: `fixture-content ${expectedHash}`,
        toolCalls: 2,
        toolErrors: 0,
        toolNames: ["Read", "Bash"],
        models: ["moonshotai/kimi-k3"],
      },
      { expectedContent: "fixture-content", expectedHash },
    ),
  );
  assert.throws(
    () =>
      assertCompatibilityResult(
        {
          finalResponse: `fixture-content ${expectedHash}`,
          toolCalls: 0,
          toolErrors: 0,
          toolNames: [],
          models: ["moonshotai/kimi-k3"],
        },
        { expectedContent: "fixture-content", expectedHash },
      ),
    /did not use a tool/,
  );
  assert.throws(
    () =>
      assertCompatibilityResult(
        {
          finalResponse: "wrong",
          toolCalls: 2,
          toolErrors: 0,
          toolNames: ["Read", "Bash"],
          models: ["moonshotai/kimi-k3"],
        },
        { expectedContent: "fixture-content", expectedHash },
      ),
    /incorrect compatibility answer/,
  );
  assert.throws(
    () =>
      assertCompatibilityResult(
        {
          finalResponse: `fixture-content ${expectedHash}`,
          toolCalls: 1,
          toolErrors: 0,
          toolNames: ["Read"],
          models: ["moonshotai/kimi-k3"],
        },
        { expectedContent: "fixture-content", expectedHash },
      ),
    /missing required Read and Bash tools/,
  );
});

test("calculates dedicated-key spend and parses the Claude Code version", () => {
  assert.equal(keyUsageDelta({ usage: 1.25 }, { usage: 1.375 }), 0.125);
  assert.equal(parseClaudeVersion({ status: 0, stdout: "2.1.220 (Claude Code)\n", stderr: "" }), "2.1.220");
  assert.throws(
    () => parseClaudeVersion({ status: 1, stdout: "", stderr: "failure" }),
    /Claude Code version/,
  );
});

test("accepts dedicated-key cost that covers visible generation cost and reports overhead", () => {
  assert.deepEqual(generationCoverage({ keyDelta: 0.0708084, generationCost: 0.0681144 }), {
    covered: true,
    fullyAttributed: false,
    unlinkedOverhead: 0.002694,
  });
  assert.deepEqual(generationCoverage({ keyDelta: 0.0681144, generationCost: 0.0681144 }), {
    covered: true,
    fullyAttributed: true,
    unlinkedOverhead: 0,
  });
  assert.deepEqual(generationCoverage({ keyDelta: 0.05, generationCost: 0.0681144 }), {
    covered: false,
    fullyAttributed: false,
    unlinkedOverhead: -0.0181144,
  });
});

test("runs a detached JSONL process and persists redacted artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-runner-test-"));
  try {
    const script = join(root, "fake-claude.mjs");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"s1",model:"moonshotai/kimi-k3"})+"\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done",total_cost_usd:0.01})+"\\n");',
        'process.stderr.write("diagnostic "+["sk","or","v1","abcdefghijklmnopqrstuvwxyz123456"].join("-")+"\\n");',
      ].join("\n"),
    );
    chmodSync(script, 0o700);

    const result = await runClaudeProcess({
      executable: process.execPath,
      args: [script],
      cwd: root,
      runDir: root,
      env: process.env,
      timeoutMs: 5_000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.summary.sessionId, "s1");
    assert.equal(result.summary.finalResponse, "done");
    assert.match(readFileSync(join(root, "stderr.txt"), "utf8"), /\[REDACTED_OPENROUTER_KEY\]/);
    assert.doesNotMatch(readFileSync(join(root, "stderr.txt"), "utf8"), /sk-or-v1-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminates a timed-out process before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-runner-timeout-"));
  try {
    const script = join(root, "hanging-claude.mjs");
    writeFileSync(script, 'setInterval(() => process.stdout.write("{}\\n"), 25);');

    const result = await runClaudeProcess({
      executable: process.execPath,
      args: [script],
      cwd: root,
      runDir: root,
      env: process.env,
      timeoutMs: 100,
    });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.signal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminates an output-overflow process before rejecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-runner-overflow-"));
  try {
    const script = join(root, "overflow-claude.mjs");
    const pidPath = join(root, "pid.txt");
    writeFileSync(
      script,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        'process.stdout.write("x".repeat(1024));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    await assert.rejects(
      async () =>
        runClaudeProcess({
          executable: process.execPath,
          args: [script],
          cwd: root,
          runDir: root,
          env: process.env,
          timeoutMs: 5_000,
          maxCaptureBytes: 100,
        }),
      (error) => {
        assert.match(error.message, /capture limit/);
        assert.ok(error.processResult?.summary);
        return true;
      },
    );
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains tolerant paid evidence when strict JSONL parsing fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-runner-malformed-"));
  try {
    const script = join(root, "malformed-claude.mjs");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"assistant",message:{id:"gen-paid-1",model:"moonshotai/kimi-k3",content:[]}})+"\\n");',
        'process.stdout.write("not-json\\n");',
      ].join("\n"),
    );
    await assert.rejects(
      () =>
        runClaudeProcess({
          executable: process.execPath,
          args: [script],
          cwd: root,
          runDir: root,
          env: process.env,
          timeoutMs: 5_000,
        }),
      (error) => {
        assert.match(error.message, /malformed Claude JSONL/);
        assert.deepEqual(error.processResult?.summary?.generationIds, ["gen-paid-1"]);
        assert.deepEqual(error.processResult?.summary?.models, ["moonshotai/kimi-k3"]);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
