#!/usr/bin/env node
// Fake `dsh-jsonrpc-agent` used by tests/dshDriver.test.ts and
// tests/dshRpc.test.ts. Speaks the REAL wire protocol captured live against
// the packaged runtime binary (newline-delimited JSON-RPC 2.0: requests carry
// {jsonrpc,id,method,params}, responses {jsonrpc,id,result|error}, server
// notifications {jsonrpc,method,params} with no id) - see
// docs/superpowers/specs/2026-08-16-litellm-dsh-driver.md for the transcript
// this fixture was captured from. Scenario knobs come from FAKE_DSH_* env
// vars so the client under test runs unmodified (mirrors
// tests/fixtures/prime/fake-prime-agent.mjs).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, message, code = -32000) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

if (process.env.FAKE_DSH_ARGS_FILE) {
  writeFileSync(process.env.FAKE_DSH_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.FAKE_DSH_ENV_FILE) {
  writeFileSync(process.env.FAKE_DSH_ENV_FILE, JSON.stringify(process.env));
}

if (process.env.FAKE_DSH_EXIT_NONZERO === "1") {
  process.stderr.write("fake dsh boot failure: bad cordis config\n");
  process.exit(3);
}

const eventsFile = process.env.FAKE_DSH_EVENTS;
const scripted = eventsFile
  ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case "initialize": {
      if (process.env.FAKE_DSH_MALFORMED === "1") {
        process.stdout.write("this is not json\n");
        return;
      }
      respond(id, { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } });
      return;
    }
    case "session/prompt": {
      if (process.env.FAKE_DSH_NO_RESPONSE === "1") return;
      const sessionId = params.sessionId;
      if (process.env.FAKE_DSH_PROMPT_FILE) {
        appendFileSync(
          process.env.FAKE_DSH_PROMPT_FILE,
          `${JSON.stringify({ sessionId, text: params.contentBlocks?.[0]?.text ?? "" })}\n`,
        );
      }
      const messageId = "fake-message-id";
      respond(id, { messageId });
      streamScripted(sessionId);
      return;
    }
    case "shutdown": {
      respond(id, {});
      return;
    }
    default: {
      respondError(id, `unknown method ${method}`, -32601);
    }
  }
}

function streamScripted(sessionId) {
  let index = 0;
  const tick = setInterval(() => {
    if (process.env.FAKE_DSH_ABORT_AT_TOOL === "1" && index > 0) {
      // Simulated abort: the harness process is killed by the driver's
      // stop() before it ever emits turn/end - nothing more to send.
      clearInterval(tick);
      return;
    }
    if (index >= scripted.length) {
      clearInterval(tick);
      return;
    }
    notify("session.event", { sessionId, event: scripted[index++] });
  }, 5);
}
