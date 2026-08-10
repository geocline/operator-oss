import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_PROVIDER = "operator-openrouter-kimi-only";
export const EXPECTED_MODEL = "moonshotai/kimi-k3";

const KEYCHAIN_ACCOUNT = "geo";
const KEYCHAIN_SERVICE = "operator-harness-eval-openrouter-prime";
const SECRET_PATTERN = /sk-or-v1-[A-Za-z0-9_-]{20,}/g;
const DEFAULT_TIMEOUT_MS = 120_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = join(SCRIPT_DIR, "fixture");

function replaceSecrets(value) {
  return value.replace(SECRET_PATTERN, "[REDACTED_OPENROUTER_KEY]");
}

export function redactSecrets(value) {
  if (typeof value === "string") return replaceSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecrets(child)]));
  }
  return value;
}

export function assertModelIdentity(messageOrModel) {
  const provider = messageOrModel?.provider;
  const model = messageOrModel?.model ?? messageOrModel?.id;
  if (provider !== EXPECTED_PROVIDER) {
    throw new Error(`provider mismatch: expected ${EXPECTED_PROVIDER}, received ${provider ?? "missing"}`);
  }
  if (model !== EXPECTED_MODEL) {
    throw new Error(`model mismatch: expected ${EXPECTED_MODEL}, received ${model ?? "missing"}`);
  }
}

export function assertGenerationIdentity(generation) {
  const model = generation?.model;
  const exactDeploymentPattern = /^moonshotai\/kimi-k3(?:-\d{8})?$/;
  if (typeof model !== "string" || !exactDeploymentPattern.test(model)) {
    throw new Error(`generation model mismatch: expected ${EXPECTED_MODEL}, received ${model ?? "missing"}`);
  }
  if (typeof generation?.id !== "string" || !generation.id.startsWith("gen-")) {
    throw new Error("OpenRouter generation is missing a valid generation ID");
  }
}

export function usageCounterSettled(beforeUsage, afterUsage, expectedDelta, tolerance = 1e-7) {
  if (![beforeUsage, afterUsage, expectedDelta].every(Number.isFinite)) return false;
  return Math.abs(afterUsage - beforeUsage - expectedDelta) <= tolerance;
}

export function parsePrimeAgentVersion(result) {
  const version = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  if (result?.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("unable to read Prime Agent version");
  }
  return version;
}

export function assertAbortEvidence(events) {
  const assistantAbort = events.some(
    (event) =>
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      ["aborted", "error"].includes(event.message.stopReason),
  );
  const toolAbort = events.some(
    (event) =>
      event.type === "tool_execution_end" &&
      event.isError === true &&
      /abort/i.test(JSON.stringify(event.result ?? "")),
  );
  if (!assistantAbort && !toolAbort) {
    throw new Error("abort evidence is missing an aborted/error terminal event");
  }
}

export function generationIdsFromEvents(events) {
  return [
    ...new Set(
      events
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message.responseId)
        .filter((responseId) => typeof responseId === "string" && responseId.startsWith("gen-")),
    ),
  ];
}

export function attributionFromGenerations(generations) {
  return {
    generationCost: Number(
      generations.reduce((total, generation) => total + Number(generation.totalCost ?? 0), 0).toFixed(12),
    ),
    generationIds: generations.map((generation) => generation.id),
    upstreamProviders: [...new Set(generations.map((generation) => generation.providerName).filter(Boolean))],
  };
}

export async function stopBeforeAttribution(clients, collectAttribution) {
  for (const client of clients.filter(Boolean)) {
    await client.forceStop();
  }
  return collectAttribution();
}

export function resolveSessionFile(state) {
  if (typeof state?.sessionFile !== "string" || state.sessionFile.length === 0) {
    throw new Error("Prime Agent RPC state did not expose a persisted session file");
  }
  return state.sessionFile;
}

function usageFromMessage(message) {
  if (!message.usage) throw new Error("assistant message is missing usage");
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = message.usage;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: message.usage.cost?.total ?? 0,
  };
}

export function summarizeEvents(events, { allowToolErrors = false } = {}) {
  const finalAssistantMessages = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);

  for (const message of finalAssistantMessages) assertModelIdentity(message);

  const usage = finalAssistantMessages.reduce(
    (total, message) => {
      const current = usageFromMessage(message);
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost"]) {
        total[key] += current[key];
      }
      return total;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  );

  const toolEnds = events.filter((event) => event.type === "tool_execution_end");
  const failedTool = toolEnds.find((event) => event.isError);
  if (failedTool && !allowToolErrors) {
    throw new Error(`tool execution failed: ${failedTool.toolName ?? "unknown"}`);
  }

  return {
    usage,
    modelCalls: finalAssistantMessages.length,
    toolCalls: events.filter((event) => event.type === "tool_execution_start").length,
    successfulIpynbCalls: toolEnds.filter(
      (event) => event.toolName === "ipython" && event.isError === false,
    ).length,
    toolErrors: toolEnds.filter((event) => event.isError).length,
  };
}

export function assistantText(events) {
  const messages = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const last = messages.at(-1);
  if (!last) throw new Error("prompt completed without a final assistant message");
  assertModelIdentity(last);
  return (last.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function getPrimeOpenRouterKey() {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`unable to retrieve dedicated Prime OpenRouter key from Keychain (status ${result.status})`);
  }
  const secret = result.stdout.trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secret)) {
    throw new Error("Keychain item is not a recognized OpenRouter key");
  }
  return secret;
}

export async function snapshotOpenRouterKey(secret) {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter key metadata request failed with HTTP ${response.status}`);
  const body = await response.json();
  const data = body.data ?? body;
  return redactSecrets({
    label: data.label,
    limit: data.limit,
    limitRemaining: data.limit_remaining,
    usage: data.usage,
    usageDaily: data.usage_daily,
    usageWeekly: data.usage_weekly,
    usageMonthly: data.usage_monthly,
    isFreeTier: data.is_free_tier,
  });
}

export function shouldRetryGenerationMetadata(status, attempt, maxAttempts = 20) {
  return status === 404 && attempt < maxAttempts - 1;
}

async function openRouterGeneration(secret, generationId, { enforceIdentity = true } = {}) {
  const url = new URL("https://openrouter.ai/api/v1/generation");
  url.searchParams.set("id", generationId);
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) break;
    if (!shouldRetryGenerationMetadata(response.status, attempt)) {
      throw new Error(`OpenRouter generation request failed with HTTP ${response.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  if (!response?.ok) throw new Error("OpenRouter generation request did not complete");
  const body = await response.json();
  const data = body.data ?? body;
  const generation = redactSecrets({
    id: data.id,
    model: data.model,
    providerName: data.provider_name,
    totalCost: data.total_cost,
    promptTokens: data.tokens_prompt,
    completionTokens: data.tokens_completion,
    nativePromptTokens: data.native_tokens_prompt,
    nativeCompletionTokens: data.native_tokens_completion,
    nativeReasoningTokens: data.native_tokens_reasoning,
    cacheDiscount: data.cache_discount,
    latencyMs: data.latency,
    generationTimeMs: data.generation_time,
  });
  if (enforceIdentity) assertGenerationIdentity({ id: generation.id, model: generation.model });
  return generation;
}

async function reconciledKeySnapshot(secret, beforeUsage, expectedDelta) {
  let snapshot;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    snapshot = await snapshotOpenRouterKey(secret);
    if (usageCounterSettled(beforeUsage, keyUsage(snapshot), expectedDelta)) return snapshot;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(
    `OpenRouter key counter did not reconcile to the generation cost within 20 seconds`,
  );
}

function recordedEvents(runDir) {
  const path = join(runDir, "events.jsonl");
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return [];
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function collectRunAttribution(secret, runDir, before, { enforceIdentity = true } = {}) {
  const events = recordedEvents(runDir);
  const generationIds = generationIdsFromEvents(events);
  const generations = [];
  for (const generationId of generationIds) {
    generations.push(await openRouterGeneration(secret, generationId, { enforceIdentity }));
  }
  const generationAttribution = attributionFromGenerations(generations);
  writeJson(join(runDir, "openrouter-generations.json"), generations);

  const beforeUsage = keyUsage(before);
  const after =
    beforeUsage !== null && generationAttribution.generationCost > 0
      ? await reconciledKeySnapshot(secret, beforeUsage, generationAttribution.generationCost)
      : await snapshotOpenRouterKey(secret);
  writeJson(join(runDir, "openrouter-after.json"), after);
  const afterUsage = keyUsage(after);

  return {
    events,
    generations,
    beforeUsage,
    afterUsage,
    openRouterSpendDelta:
      beforeUsage === null || afterUsage === null
        ? null
        : Number((afterUsage - beforeUsage).toFixed(12)),
    ...generationAttribution,
  };
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, { mode: 0o600 });
}

function makeRunDirectory(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(root, stamp);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "config"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  cpSync(FIXTURE_SOURCE, join(runDir, "fixture"), { recursive: true });
  return runDir;
}

export function configurePrimeRun(runDir) {
  const configDir = join(runDir, "config");
  const models = {
    providers: {
      [EXPECTED_PROVIDER]: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        apiKey: "OPENROUTER_API_KEY",
        authHeader: true,
        compat: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: EXPECTED_MODEL,
            name: "Kimi K3 — controlled harness evaluation",
            reasoning: true,
            thinkingLevelMap: { off: null },
            input: ["text", "image"],
            contextWindow: 1_048_576,
            maxTokens: 32_768,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
          },
        ],
      },
    },
  };
  const settings = {
    defaultProvider: EXPECTED_PROVIDER,
    defaultModel: EXPECTED_MODEL,
    defaultThinkingLevel: "high",
    telemetry: { enabled: false },
    autoRefine: { enabled: false, compact: false },
  };
  writeJson(join(configDir, "models.json"), models);
  writeJson(join(configDir, "settings.json"), settings);
  return configDir;
}

function directoryDigest(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else files.push([path.slice(root.length + 1), createHash("sha256").update(readFileSync(path)).digest("hex")]);
    }
  };
  visit(root);
  return files;
}

export class RpcClient {
  constructor({ runDir, configDir, secret, resumePath, cwd = join(runDir, "fixture"), loadContextFiles = false }) {
    this.runDir = runDir;
    this.events = [];
    this.waiters = new Set();
    this.responses = new Map();
    this.sequence = 0;
    this.stdoutBuffer = "";
    this.eventsPath = join(runDir, "events.jsonl");
    this.stderrPath = join(runDir, "stderr.log");

    const args = [
      "--mode",
      "rpc",
      "--offline",
      "--provider",
      EXPECTED_PROVIDER,
      "--model",
      EXPECTED_MODEL,
      "--thinking",
      "high",
      "--session-dir",
      join(runDir, "sessions"),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ];
    if (!loadContextFiles) args.push("--no-context-files");
    if (resumePath) args.push("--resume", resumePath);

    this.child = spawn("prime-agent", args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENROUTER_API_KEY: secret,
        PRIME_AGENT_CODING_AGENT_DIR: configDir,
        PRIME_AGENT_SESSION_DIR: join(runDir, "sessions"),
        PRIME_AGENT_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      appendFileSync(this.stderrPath, replaceSecrets(chunk));
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const lineEnd = this.stdoutBuffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = this.stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`Prime RPC emitted non-JSON stdout: ${replaceSecrets(line).slice(0, 300)}`);
      }
      const safeEvent = redactSecrets(event);
      this.events.push(safeEvent);
      appendFileSync(this.eventsPath, `${JSON.stringify(safeEvent)}\n`, { mode: 0o600 });
      if (safeEvent.type === "response" && safeEvent.id) {
        const pending = this.responses.get(safeEvent.id);
        if (pending) {
          this.responses.delete(safeEvent.id);
          pending.resolve(safeEvent);
        }
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(safeEvent, this.events.length - 1)) {
          this.waiters.delete(waiter);
          waiter.resolve({ event: safeEvent, index: this.events.length - 1 });
        }
      }
    }
  }

  waitFor(predicate, { after = -1, timeoutMs = DEFAULT_TIMEOUT_MS, label = "event" } = {}) {
    for (let index = after + 1; index < this.events.length; index += 1) {
      if (predicate(this.events[index], index)) return Promise.resolve({ event: this.events[index], index });
    }
    return new Promise((resolveWait, reject) => {
      const waiter = {
        predicate: (event, index) => index > after && predicate(event, index),
        resolve: (value) => {
          clearTimeout(timer);
          resolveWait(value);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async command(type, fields = {}, timeoutMs = 30_000) {
    const id = `cmd-${++this.sequence}`;
    const responsePromise = new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`timed out waiting for RPC response to ${type}`));
      }, timeoutMs);
      this.responses.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolveResponse(response);
        },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await responsePromise;
    if (!response.success) throw new Error(`RPC ${type} failed: ${response.error ?? "unknown error"}`);
    return response;
  }

  async prompt(message, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const cursor = this.events.length - 1;
    await this.command("prompt", { message });
    await this.waitFor((event) => event.type === "agent_end", {
      after: cursor,
      timeoutMs,
      label: "agent_end",
    });
    return this.events.slice(cursor + 1);
  }

  async close() {
    if (this.child.exitCode !== null) return this.exitPromise;
    this.child.stdin.end();
    const naturalExit = await Promise.race([
      this.exitPromise,
      new Promise((resolveWait) => setTimeout(() => resolveWait(null), 10_000)),
    ]);
    if (naturalExit) return naturalExit;
    try {
      process.kill(-this.child.pid, "SIGTERM");
    } catch {}
    return this.exitPromise;
  }

  async forceStop() {
    if (this.child.exitCode === null) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([this.exitPromise, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (this.child.exitCode === null) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {}
      await Promise.race([this.exitPromise, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    }
  }
}

function exactToolAnswer(text, expectedHash) {
  const expected = [
    "HARNESS=prime-agent",
    `CONTROL_MODEL=${EXPECTED_MODEL}`,
    "VALUES_SUM=31",
    `SHA256=${expectedHash}`,
  ].join("\n");
  if (text !== expected) {
    throw new Error(`tool gate answer mismatch\nexpected:\n${expected}\nreceived:\n${text}`);
  }
}

function keyUsage(snapshot) {
  const value = Number(snapshot.usage);
  return Number.isFinite(value) ? value : null;
}

export async function runCompatibility({ outputRoot = join(SCRIPT_DIR, "runs") } = {}) {
  const startedAt = Date.now();
  const secret = getPrimeOpenRouterKey();
  const runDir = makeRunDirectory(resolve(outputRoot));
  const configDir = configurePrimeRun(runDir);
  const fixtureDir = join(runDir, "fixture");
  const fixtureBefore = directoryDigest(fixtureDir);
  const expectedHash = createHash("sha256").update(readFileSync(join(fixtureDir, "facts.txt"))).digest("hex");
  const before = await snapshotOpenRouterKey(secret);
  writeJson(join(runDir, "openrouter-before.json"), before);

  const gates = {};
  let firstClient;
  let resumedClient;
  try {
    firstClient = new RpcClient({ runDir, configDir, secret });
    const initialState = (await firstClient.command("get_state")).data;
    assertModelIdentity(initialState.model);
    const sessionFile = resolveSessionFile(initialState);

    const identityEvents = await firstClient.prompt(
      "Compatibility gate 1. Reply with exactly PRIME-KIMI-OK and nothing else.",
    );
    const identitySummary = summarizeEvents(identityEvents);
    const identityText = assistantText(identityEvents);
    if (identityText !== "PRIME-KIMI-OK") {
      throw new Error(`identity gate answer mismatch: ${identityText}`);
    }
    gates.identity = { pass: true, response: identityText, ...identitySummary };

    const toolEvents = await firstClient.prompt(
      "Compatibility gate 2. This fixture is read-only: do not modify any file. Use your built-in Python/IPython tool to list this directory, read facts.txt, calculate the sum of VALUES, and calculate the SHA-256 of facts.txt. Reply with exactly four lines: HARNESS, CONTROL_MODEL, VALUES_SUM, SHA256.",
    );
    const toolSummary = summarizeEvents(toolEvents);
    if (toolSummary.successfulIpynbCalls < 1) throw new Error("tool gate did not complete an IPython call");
    const toolText = assistantText(toolEvents);
    exactToolAnswer(toolText, expectedHash);
    const fixtureAfterTool = directoryDigest(fixtureDir);
    if (JSON.stringify(fixtureAfterTool) !== JSON.stringify(fixtureBefore)) {
      throw new Error("tool gate modified the read-only fixture");
    }
    gates.tool = { pass: true, response: toolText, ...toolSummary };

    const abortCursor = firstClient.events.length - 1;
    await firstClient.command("prompt", {
      message:
        "Compatibility gate 3. Use the Python/IPython tool to run time.sleep(30), then reply SLEEP-FINISHED.",
    });
    await firstClient.waitFor(
      (event) => event.type === "tool_execution_start" && event.toolName === "ipython",
      { after: abortCursor, timeoutMs: 90_000, label: "abort-gate IPython start" },
    );
    const abortResponse = await firstClient.command("abort");
    await firstClient.waitFor((event) => event.type === "agent_end", {
      after: abortCursor,
      timeoutMs: 30_000,
      label: "aborted agent_end",
    });
    const abortEvents = firstClient.events.slice(abortCursor + 1);
    if (assistantText(abortEvents).includes("SLEEP-FINISHED")) {
      throw new Error("abort gate completed the operation instead of stopping it");
    }
    assertAbortEvidence(abortEvents);
    const postAbortState = (await firstClient.command("get_state")).data;
    if (postAbortState.isStreaming) throw new Error("Prime Agent remained busy after abort");
    gates.abort = {
      pass: true,
      rpcAccepted: abortResponse.success,
      terminalStopReasons: abortEvents
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message.stopReason),
      ...summarizeEvents(abortEvents, { allowToolErrors: true }),
    };

    const firstStats = (await firstClient.command("get_session_stats")).data;
    const firstState = (await firstClient.command("get_state")).data;
    await firstClient.close();
    firstClient = undefined;

    resumedClient = new RpcClient({ runDir, configDir, secret, resumePath: sessionFile });
    const resumedState = (await resumedClient.command("get_state")).data;
    assertModelIdentity(resumedState.model);
    if (resumedState.sessionId !== firstState.sessionId) {
      throw new Error(
        `resume session mismatch: expected ${firstState.sessionId}, received ${resumedState.sessionId}`,
      );
    }
    const resumeEvents = await resumedClient.prompt(
      "Compatibility gate 4. Without rereading facts.txt, reply with exactly CONTINUITY_NONCE=<the nonce you saw earlier>.",
    );
    const resumeSummary = summarizeEvents(resumeEvents);
    if (resumeSummary.toolCalls !== 0) throw new Error("resume gate reread the fixture with a tool");
    const resumeText = assistantText(resumeEvents);
    if (resumeText !== "CONTINUITY_NONCE=CEDAR-7391") {
      throw new Error(`resume gate answer mismatch: ${resumeText}`);
    }
    gates.resume = {
      pass: true,
      response: resumeText,
      sameSessionId: true,
      ...resumeSummary,
    };

    const finalStats = (await resumedClient.command("get_session_stats")).data;
    const exportPath = join(runDir, "session.html");
    await resumedClient.command("export_html", { outputPath: exportPath });
    await resumedClient.close();
    resumedClient = undefined;

    const attribution = await collectRunAttribution(secret, runDir, before);
    const allEvents = attribution.events;
    const allSummary = summarizeEvents(allEvents, { allowToolErrors: true });
    if (Math.abs(attribution.generationCost - allSummary.usage.cost) > 1e-7) {
      throw new Error(
        `Prime/OpenRouter generation cost mismatch: Prime ${allSummary.usage.cost}, OpenRouter ${attribution.generationCost}`,
      );
    }
    const versionResult = spawnSync("prime-agent", ["--version"], { encoding: "utf8" });
    const summary = {
      status: "pass",
      harness: "Prime Agent",
      primeAgentVersion: parsePrimeAgentVersion(versionResult),
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      sessionId: finalStats.sessionId,
      gates,
      usage: {
        harness: finalStats.tokens,
        harnessCost: finalStats.cost,
        openRouterKeyUsageBefore: attribution.beforeUsage,
        openRouterKeyUsageAfter: attribution.afterUsage,
        openRouterSpendDelta: attribution.openRouterSpendDelta,
        openRouterGenerationCost: attribution.generationCost,
        generationIds: attribution.generationIds,
        upstreamProviders: attribution.upstreamProviders,
        eventSummary: allSummary,
      },
      firstRpcStats: firstStats,
      finalRpcStats: finalStats,
      fixtureSha256: expectedHash,
      fixtureUnchanged: JSON.stringify(directoryDigest(fixtureDir)) === JSON.stringify(fixtureBefore),
      artifacts: {
        runDir,
        events: join(runDir, "events.jsonl"),
        stderr: join(runDir, "stderr.log"),
        sessionHtml: exportPath,
      },
    };
    writeJson(join(runDir, "summary.json"), summary);
    chmodSync(join(runDir, "summary.json"), 0o600);
    return summary;
  } catch (error) {
    let attribution;
    let attributionError;
    const clientsToStop = [firstClient, resumedClient].filter(Boolean);
    firstClient = undefined;
    resumedClient = undefined;
    try {
      attribution = await stopBeforeAttribution(clientsToStop, () =>
        collectRunAttribution(secret, runDir, before, { enforceIdentity: false }),
      );
    } catch (collectionError) {
      attributionError = replaceSecrets(
        collectionError instanceof Error ? collectionError.message : String(collectionError),
      );
      try {
        const after = await snapshotOpenRouterKey(secret);
        writeJson(join(runDir, "openrouter-after.json"), after);
        const beforeUsage = keyUsage(before);
        const afterUsage = keyUsage(after);
        attribution = {
          beforeUsage,
          afterUsage,
          openRouterSpendDelta:
            beforeUsage === null || afterUsage === null
              ? null
              : Number((afterUsage - beforeUsage).toFixed(12)),
          generationCost: null,
          generationIds: generationIdsFromEvents(recordedEvents(runDir)),
          upstreamProviders: [],
        };
      } catch (snapshotError) {
        attributionError = `${attributionError ?? ""}; ${
          snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
        }`.replace(/^; /, "");
      }
    }
    const failure = {
      status: "fail",
      harness: "Prime Agent",
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - startedAt,
      error: replaceSecrets(error instanceof Error ? error.stack ?? error.message : String(error)),
      gates,
      usage: attribution
        ? {
            openRouterKeyUsageBefore: attribution.beforeUsage,
            openRouterKeyUsageAfter: attribution.afterUsage,
            openRouterSpendDelta: attribution.openRouterSpendDelta,
            openRouterGenerationCost: attribution.generationCost,
            generationIds: attribution.generationIds,
            upstreamProviders: attribution.upstreamProviders,
          }
        : null,
      attributionError,
      artifacts: { runDir },
    };
    writeJson(join(runDir, "summary.json"), failure);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runDir });
  } finally {
    await firstClient?.forceStop();
    await resumedClient?.forceStop();
  }
}

async function main() {
  const result = await runCompatibility();
  process.stdout.write(
    `${JSON.stringify({
      status: result.status,
      model: result.model,
      wallTimeMs: result.wallTimeMs,
      openRouterSpendDelta: result.usage.openRouterSpendDelta,
      runDir: result.artifacts.runDir,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${replaceSecrets(error.stack ?? String(error))}\n`);
    process.exitCode = 1;
  });
}
