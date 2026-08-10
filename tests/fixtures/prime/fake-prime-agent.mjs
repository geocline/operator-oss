#!/usr/bin/env node
// Fake `prime-agent --mode rpc` used by tests/primeRpc.test.ts. Speaks the
// same JSONL protocol as the real CLI: requests {id, type, ...} on stdin,
// {type: "response", id, success, data|error} replies plus streamed events on
// stdout. Scenario knobs come from FAKE_PRIME_* env vars so the client under
// test runs unmodified.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (process.env.FAKE_PRIME_EXIT_NONZERO === "1") {
  process.stderr.write("fake prime boot failure: bad config\n");
  process.exit(3);
}

if (process.env.FAKE_PRIME_SPAWN_WORKER === "1") {
  // A long-lived worker in the same process group. Tests use its PID to prove
  // group-wide cleanup, not just parent exit.
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  send({ type: "worker_started", pid: worker.pid });
}

const resumeIndex = process.argv.indexOf("--resume");
send({
  type: "agent_start",
  sessionFile: "/tmp/fake-prime/session.jsonl",
  resumed: resumeIndex !== -1,
  resumePath: resumeIndex !== -1 ? process.argv[resumeIndex + 1] : null,
});

const eventsFile = process.env.FAKE_PRIME_EVENTS;
const scripted = eventsFile
  ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

let streaming = false;
let abortRequested = false;

function streamScripted() {
  streaming = true;
  let index = 0;
  const tick = setInterval(() => {
    if (abortRequested) {
      clearInterval(tick);
      send({
        type: "message_end",
        message: { role: "assistant", stopReason: "aborted", content: [] },
      });
      send({ type: "agent_end" });
      streaming = false;
      return;
    }
    if (index >= scripted.length) {
      clearInterval(tick);
      send({ type: "agent_end" });
      streaming = false;
      return;
    }
    send(scripted[index++]);
  }, 5);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    handle(request);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(request) {
  const { id, type } = request;
  switch (type) {
    case "prompt": {
      if (process.env.FAKE_PRIME_NO_RESPONSE === "1") return;
      if (process.env.FAKE_PRIME_MALFORMED === "1") {
        process.stdout.write("this is not json\n");
        return;
      }
      send({ type: "response", id, success: true });
      streamScripted();
      return;
    }
    case "abort": {
      abortRequested = true;
      send({ type: "response", id, success: true });
      if (!streaming) {
        send({ type: "agent_end" });
      }
      return;
    }
    case "get_state": {
      send({
        type: "response",
        id,
        success: true,
        data: {
          model: { provider: "operator-litellm", model: "operator.kimi-k3" },
          sessionFile: "/tmp/fake-prime/session.jsonl",
          isStreaming: streaming,
        },
      });
      return;
    }
    case "get_session_stats": {
      send({
        type: "response",
        id,
        success: true,
        data: {
          usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 0, cost: { total: 0.0042 } },
        },
      });
      return;
    }
    case "echo": {
      setTimeout(() => {
        send({ type: "response", id, success: true, data: { payload: request.payload } });
      }, Number(request.delayMs ?? 0));
      return;
    }
    case "fail": {
      send({ type: "response", id, success: false, error: "scripted failure" });
      return;
    }
    default: {
      send({ type: "response", id, success: false, error: `unknown request type ${type}` });
    }
  }
}
