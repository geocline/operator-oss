import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { LITELLM_PRIME_HOME } from "@/lib/config";
import { parseLiteLLMModelInfo, replaceLiteLLMCatalog } from "@/lib/agents/litellm/catalog";
import { createLiteLLMRelay } from "@/lib/agents/litellm/relay";
import { createProject, createTask, getTask, getTaskUsage, listMessages, updateTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { ensureWorktree } from "@/lib/git";
import { abortTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { makeRepo } from "./helpers";
import type { TaskStreamEvent } from "@/lib/types";

/**
 * LIVE acceptance for the litellm-prime driver: one real Kimi task through the
 * real runner, resumed once and aborted once, against the local LiteLLM
 * gateway. Spends real provider money — never runs in CI. Opt in with:
 *
 *   PRIME_ACCEPTANCE=1 npx vitest run tests/primeAcceptance.live.test.ts
 *
 * Requires: the LiteLLM proxy live on 127.0.0.1:4000 with the prime-tagged
 * Kimi alias, prime-agent 0.7.1 on PATH (or PRIME_CLI_PATH), and the gateway
 * master key in ~/.litellm/.env. Writes a sanitized artifact to
 * docs/evaluations/.
 */
const LIVE = process.env.PRIME_ACCEPTANCE === "1";
const REAL_GATEWAY = "http://127.0.0.1:4000/v1";

const liveDescribe = LIVE ? describe : describe.skip;

function gatewayKey(): string {
  const env = readFileSync(path.join(process.env.HOME!, ".litellm", ".env"), "utf8");
  const match = env.match(/^LITELLM_MASTER_KEY=(.+)$/m);
  if (!match) throw new Error("LITELLM_MASTER_KEY not found");
  return match[1].trim().replace(/^"|"$/g, "");
}

function collect(taskId: string) {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") {
      unsub();
      resolve();
    }
  });
  return { events, done };
}

liveDescribe("Prime Kimi live acceptance", () => {
  it("runs, resumes, and aborts one real Kimi task with settled processes", { timeout: 600_000 }, async () => {
    const key = gatewayKey();
    // Point the shared relay singleton at the REAL gateway with the REAL key
    // (tests/setup.ts pins env to hermetic test values, so inject directly).
    const relayGlobal = globalThis as typeof globalThis & { __operatorLiteLLMRelay?: unknown };
    relayGlobal.__operatorLiteLLMRelay = createLiteLLMRelay({
      upstreamBaseUrl: REAL_GATEWAY,
      gatewayToken: key,
    });

    // Live catalog snapshot (sanitized parse, same code path as refresh).
    const info = await (await fetch("http://127.0.0.1:4000/model/info", {
      headers: { Authorization: `Bearer ${key}` },
    })).json();
    const parsed = parseLiteLLMModelInfo(info);
    replaceLiteLLMCatalog({ ...parsed, refreshedAt: new Date().toISOString(), stale: false });
    expect(parsed.models.some((m) => m.value === "operator.kimi-k3" && m.harnesses.includes("prime"))).toBe(true);

    process.env.PRIME_CLI_PATH = process.env.PRIME_CLI_PATH || "/opt/homebrew/bin/prime-agent";

    // Disposable fixture repo + real worktree + prime task.
    const repo = await makeRepo();
    const project = createProject({ name: "PrimeAcceptance", repo_path: repo });
    const task = createTask({ project_id: project.id, title: "Acceptance", description: "" });
    const wt = await ensureWorktree(repo, task.id);
    updateTask(task.id, {
      agent: "litellm-prime",
      model: "operator.kimi-k3",
      worktree_path: wt!.path,
      work_branch: wt!.branch,
    });

    // ---- Turn 1: fresh session, real edit ----
    const t1 = collect(task.id);
    await startResumeTurn(getTask(task.id)!, { ...project },
      "Create a file named acceptance.txt containing exactly the single line PRIME-ACCEPTANCE-OK (no other changes). Then reply DONE.");
    await t1.done;
    const afterT1 = getTask(task.id)!;
    expect(afterT1.session_id).toBeTruthy();
    expect(t1.events.some((e) => e.type === "error")).toBe(false);
    expect(readFileSync(path.join(wt!.path, "acceptance.txt"), "utf8").trim()).toBe("PRIME-ACCEPTANCE-OK");

    // ---- Turn 2: resume ----
    const t2 = collect(task.id);
    await startResumeTurn(getTask(task.id)!, { ...project },
      "Append a second line RESUMED-OK to acceptance.txt. Reply DONE.");
    await t2.done;
    expect(t2.events.some((e) => e.type === "error")).toBe(false);
    expect(readFileSync(path.join(wt!.path, "acceptance.txt"), "utf8")).toContain("RESUMED-OK");

    // ---- Turn 3: deliberate long tool, aborted ----
    const t3 = collect(task.id);
    const turn3 = startResumeTurn(getTask(task.id)!, { ...project },
      "First use your IPython tool to run exactly: import time; time.sleep(300). After the tool finishes, write a 3000-word essay about git worktrees, and end your reply with the exact token SLEEP-DONE.");
    // Abort as soon as the long tool starts, with a hard fallback so the
    // abort gate always fires even if the model skips the tool.
    let abortFired = false;
    const fire = () => {
      if (!abortFired) {
        abortFired = true;
        abortTurn(task.id);
      }
    };
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "tool") {
        fire();
        unsub();
      }
    });
    // Unconditional early abort: the gate must prove Stop preempts the turn
    // regardless of whether the model actually starts the long tool.
    const fallback = setTimeout(fire, 2_000);
    await turn3;
    await t3.done;
    clearTimeout(fallback);
    const transcript = listMessages(task.id);
    expect(transcript.some((m) => m.role === "assistant" && m.content.includes("SLEEP-DONE"))).toBe(false);

    // ---- Process settlement: no prime tree survives ----
    await new Promise((r) => setTimeout(r, 3_000));
    const survivors = (() => {
      try {
        return execSync("pgrep -lf 'prime-agent|ipykernel'", { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    expect(survivors).toBe("");

    // ---- Sanitized artifact ----
    const usage = getTaskUsage(task.id);
    const sessionFiles = readdirSync(path.join(LITELLM_PRIME_HOME, task.id, "sessions"), { recursive: true });
    const generationIds = new Set<string>();
    for (const file of sessionFiles as string[]) {
      const full = path.join(LITELLM_PRIME_HOME, task.id, "sessions", file);
      try {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/"responseId"\s*:\s*"(gen-[^"]+)"/g)) generationIds.add(m[1]);
      } catch {
        /* directories */
      }
    }
    const artifact = {
      date: new Date().toISOString(),
      driver: "litellm-prime",
      prime_version: execSync(`${process.env.PRIME_CLI_PATH} --version 2>&1`, { encoding: "utf8" }).trim(),
      alias: "operator.kimi-k3",
      pinned_physical_model: "openrouter/moonshotai/kimi-k3 (LiteLLM config, fallback-free, test-pinned)",
      turns: { fresh: true, resumed: true, aborted: true },
      usage,
      generation_ids: [...generationIds],
      session_id_sha256: afterT1.session_id
        ? execSync(`printf %s '${afterT1.session_id}' | shasum -a 256`, { encoding: "utf8" }).slice(0, 64)
        : null,
      process_settlement: "no prime-agent/ipykernel processes after abort",
    };
    const out = path.join(process.cwd(), "docs", "evaluations");
    if (!existsSync(out)) execSync(`mkdir -p '${out}'`);
    writeFileSync(path.join(out, "2026-08-10-prime-kimi-acceptance.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    expect(generationIds.size).toBeGreaterThan(0);
  });
});
