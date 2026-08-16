import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { startDshRpc, type DshNotification, type DshRpcClient } from "@/lib/agents/dsh/rpc";

const FAKE = path.join(__dirname, "fixtures", "dsh", "fake-dsh.mjs");
const SUCCESS_EVENTS = path.join(__dirname, "fixtures", "dsh", "events-driver-success.jsonl");

const clients: DshRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
});

function launch(env: Record<string, string> = {}, onNotification?: (n: DshNotification) => void) {
  const notifications: DshNotification[] = [];
  const client = startDshRpc({
    executable: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    onNotification: (n) => {
      notifications.push(n);
      onNotification?.(n);
    },
  });
  clients.push(client);
  return { client, notifications };
}

describe("DshRpcClient", () => {
  it("completes a real JSON-RPC 2.0 initialize request/response round trip", async () => {
    const { client } = launch();
    const result = await client.request("initialize", { cwd: "/tmp", provider: "deepseek-official", model: "deepseek-chat" });
    expect(result).toEqual({ serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } });
  });

  it("routes id-less method frames as notifications, not responses", async () => {
    const { client, notifications } = launch({ FAKE_DSH_EVENTS: SUCCESS_EVENTS });
    await client.request("initialize", { cwd: "/tmp", provider: "deepseek-official", model: "deepseek-chat" });
    await client.request("session/prompt", { sessionId: "s1", contentBlocks: [{ type: "text", text: "hi" }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications.some((n) => n.method === "session.event")).toBe(true);
    const turnEnd = notifications.find(
      (n) => (n.params.event as { type?: string } | undefined)?.type === "turn/end",
    );
    expect(turnEnd).toBeTruthy();
  });

  it("rejects the pending request when the child exits before responding", async () => {
    const { client } = launch({ FAKE_DSH_EXIT_NONZERO: "1" });
    await expect(client.request("initialize", {})).rejects.toThrow();
  });

  it("fails the pending request with a diagnostic message on malformed (non-JSON) stdout", async () => {
    const { client } = launch({ FAKE_DSH_MALFORMED: "1" });
    await expect(client.request("initialize", {})).rejects.toThrow(/malformed protocol/);
  });

  it("stop() settles the process without a polite RPC abort (the protocol has none)", async () => {
    const { client } = launch({ FAKE_DSH_EVENTS: SUCCESS_EVENTS });
    await client.request("initialize", { cwd: "/tmp", provider: "deepseek-official", model: "deepseek-chat" });
    const pid = client.pid;
    expect(pid).toBeTruthy();
    const exit = await client.stop();
    expect(exit).toBeTruthy();
    expect(client.exited).toBe(true);
  });
});
