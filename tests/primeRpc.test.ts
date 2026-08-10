import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { startPrimeRpc, type PrimeRpcClient, type PrimeRpcEvent } from "@/lib/agents/prime/rpc";

const FAKE = path.join(__dirname, "fixtures", "prime", "fake-prime-agent.mjs");
const SUCCESS_EVENTS = path.join(__dirname, "fixtures", "prime", "events-success.jsonl");
const ABORT_EVENTS = path.join(__dirname, "fixtures", "prime", "events-abort.jsonl");

const clients: PrimeRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
});

function launch(env: Record<string, string> = {}, options: {
  args?: string[];
  signal?: AbortSignal;
  onEvent?: (event: PrimeRpcEvent) => void;
} = {}) {
  const events: PrimeRpcEvent[] = [];
  const client = startPrimeRpc({
    executable: process.execPath,
    args: [FAKE, ...(options.args ?? [])],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    signal: options.signal,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  clients.push(client);
  return { client, events };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
};

describe("Prime RPC client", () => {
  it("starts, answers get_state and get_session_stats, and streams prompt events", async () => {
    const { client, events } = launch({ FAKE_PRIME_EVENTS: SUCCESS_EVENTS });
    const state = await client.request("get_state");
    expect(state.data).toEqual(expect.objectContaining({
      sessionFile: "/tmp/fake-prime/session.jsonl",
      model: { provider: "operator-litellm", model: "operator.kimi-k3" },
    }));

    await client.request("prompt", { message: "hi" });
    await client.waitForEvent((e) => e.type === "agent_end");
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types[types.length - 1]).toBe("agent_end");

    const stats = await client.request("get_session_stats");
    expect(stats.data?.usage).toEqual(expect.objectContaining({ input: 120, output: 45 }));
    await client.stop();
  });

  it("passes resume arguments through and reports the resumed session", async () => {
    const { client } = launch({}, { args: ["--resume", "/tmp/prior-session.jsonl"] });
    const start = await client.waitForEvent((e) => e.type === "agent_start");
    expect(start).toEqual(expect.objectContaining({
      resumed: true,
      resumePath: "/tmp/prior-session.jsonl",
    }));
    await client.stop();
  });

  it("correlates concurrent out-of-order responses by request id", async () => {
    const { client } = launch();
    const slow = client.request("echo", { payload: "slow", delayMs: 120 });
    const fast = client.request("echo", { payload: "fast", delayMs: 0 });
    const [slowRes, fastRes] = await Promise.all([slow, fast]);
    expect(slowRes.data?.payload).toBe("slow");
    expect(fastRes.data?.payload).toBe("fast");
  });

  it("rejects unsuccessful responses with the reported error", async () => {
    const { client } = launch();
    await expect(client.request("fail")).rejects.toThrow(/scripted failure/);
  });

  it("fails pending requests on malformed stdout and settles the process", async () => {
    const { client } = launch({ FAKE_PRIME_MALFORMED: "1", FAKE_PRIME_EVENTS: SUCCESS_EVENTS });
    await client.request("get_state");
    await expect(client.request("prompt", { message: "hi" })).rejects.toThrow(/non-JSON|malformed/i);
    await client.settled;
    expect(client.exited).toBe(true);
  });

  it("rejects pending requests with the stderr tail on nonzero exit", async () => {
    const { client } = launch({ FAKE_PRIME_EXIT_NONZERO: "1" });
    await expect(client.request("get_state")).rejects.toThrow(/bad config/);
    const exit = await client.settled;
    expect(exit.code).toBe(3);
  });

  it("times out requests that never receive a response", async () => {
    const { client } = launch({ FAKE_PRIME_NO_RESPONSE: "1" });
    await expect(
      client.request("prompt", { message: "hi" }, { timeoutMs: 150 }),
    ).rejects.toThrow(/timed out/i);
    await client.stop();
    expect(client.exited).toBe(true);
  });

  it("aborts via RPC and kills the whole process group including workers", async () => {
    const { client } = launch({
      FAKE_PRIME_SPAWN_WORKER: "1",
      FAKE_PRIME_EVENTS: ABORT_EVENTS,
    });
    const worker = await client.waitForEvent((e) => e.type === "worker_started");
    const workerPid = worker.pid as number;
    expect(pidAlive(workerPid)).toBe(true);

    await client.request("prompt", { message: "sleep forever" });
    await client.waitForEvent((e) => e.type === "tool_execution_start");

    const controller = new AbortController();
    const stopPromise = client.stop({ signalReason: "user abort" });
    controller.abort();
    await stopPromise;

    expect(client.exited).toBe(true);
    expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
    const terminal = client.recentEvents().find(
      (e) => e.type === "message_end" &&
        (e.message as { stopReason?: string } | undefined)?.stopReason === "aborted",
    );
    expect(terminal).toBeTruthy();
  });

  it("stops the process group when an external AbortSignal fires mid-turn", async () => {
    const controller = new AbortController();
    const { client } = launch(
      { FAKE_PRIME_SPAWN_WORKER: "1", FAKE_PRIME_EVENTS: ABORT_EVENTS },
      { signal: controller.signal },
    );
    const worker = await client.waitForEvent((e) => e.type === "worker_started");
    const workerPid = worker.pid as number;
    await client.request("prompt", { message: "sleep forever" });
    await client.waitForEvent((e) => e.type === "tool_execution_start");

    controller.abort();
    await client.settled;
    expect(client.exited).toBe(true);
    expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
  });

  it("kills a worker that escaped into its own process group (npm wrapper shape)", async () => {
    const { client } = launch({ FAKE_PRIME_WORKER_DETACHED: "1", FAKE_PRIME_EVENTS: SUCCESS_EVENTS });
    const worker = await client.waitForEvent((e) => e.type === "worker_started");
    const workerPid = worker.pid as number;
    expect(pidAlive(workerPid)).toBe(true);
    await client.request("prompt", { message: "hi" });
    await client.waitForEvent((e) => e.type === "agent_end");
    await client.stop();
    expect(client.exited).toBe(true);
    expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
  });

  it("escalates to SIGKILL when the child ignores everything after timeout", async () => {
    const { client } = launch({ FAKE_PRIME_NO_RESPONSE: "1", FAKE_PRIME_SPAWN_WORKER: "1" });
    const worker = await client.waitForEvent((e) => e.type === "worker_started");
    const workerPid = worker.pid as number;
    await client.stop();
    expect(client.exited).toBe(true);
    expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
  });
});
