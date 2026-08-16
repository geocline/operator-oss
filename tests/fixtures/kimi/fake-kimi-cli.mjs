#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_KIMI_ARGS_FILE) {
  writeFileSync(
    process.env.FAKE_KIMI_ARGS_FILE,
    JSON.stringify(process.argv.slice(2)),
  );
}
if (process.env.FAKE_KIMI_ENV_FILE) {
  writeFileSync(process.env.FAKE_KIMI_ENV_FILE, JSON.stringify(process.env));
}
if (process.env.FAKE_KIMI_EXIT_IMMEDIATELY === "1") process.exit(0);

if (process.env.FAKE_KIMI_WORKER_FILE) {
  const worker = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
  ], {
    detached: process.env.FAKE_KIMI_WORKER_DETACHED === "1",
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_KIMI_WORKER_FILE, String(worker.pid));
}

process.on("SIGTERM", () => {});

if (process.env.FAKE_KIMI_PROTOCOL === "1") {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (!request.id) return;
    let result = {};
    if (request.method === "initialize") {
      result = {
        protocol_version: "1.7",
        server: { name: "fake-kimi", version: "1.0.0" },
        slash_commands: [],
      };
    } else if (request.method === "prompt") {
      result = { status: "finished", steps: 1 };
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result,
    })}\n`);
  });
}

setInterval(() => {}, 1_000);
