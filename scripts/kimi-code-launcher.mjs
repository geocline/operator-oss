#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const CREDENTIAL_NAME =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i;
const ALLOWED_CREDENTIALS = new Set(["KIMI_API_KEY"]);
const NON_SECRET_TOKEN_CONTROLS = new Set([
  "KIMI_MODEL_MAX_COMPLETION_TOKENS",
]);
const isCredentialName = (key) =>
  CREDENTIAL_NAME.test(key) && !NON_SECRET_TOKEN_CONTROLS.has(key);
const realCli = process.env.ORCH_KIMI_REAL_CLI;
const settlementFile = process.env.ORCH_KIMI_SETTLEMENT_FILE;
const inlineConfig = process.env.ORCH_KIMI_INLINE_CONFIG;
const termGraceMs = Number(process.env.ORCH_KIMI_TERM_GRACE_MS || 1_000);

if (!realCli || !settlementFile || !inlineConfig) {
  process.stderr.write("Operator Kimi launcher configuration is incomplete.\n");
  process.exit(64);
}

const cleanEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (isCredentialName(key) && !ALLOWED_CREDENTIALS.has(key)) continue;
  if (key.startsWith("ORCH_KIMI_")) continue;
  cleanEnv[key] = value;
}

let finalizing = false;
let observed = [];
let treeMonitor = null;
const operatorPid = process.ppid;
function writeSettlement(status, survivors = [], detail, cliPid = null) {
  if (
    status === "running"
    && process.env.NODE_ENV === "test"
    && process.env.ORCH_KIMI_TEST_FAIL_RUNNING_SETTLEMENT === "1"
  ) {
    throw new Error("simulated running settlement write failure");
  }
  const next = `${settlementFile}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify({
    schema_version: 1,
    launcher_pid: process.pid,
    cli_pid: cliPid,
    status,
    survivors,
    child_environment: {
      credential_keys: Object.keys(cleanEnv)
        .filter((key) => isCredentialName(key))
        .sort(),
      home_is_task_home:
        typeof process.env.ORCH_KIMI_TASK_HOME === "string"
        && cleanEnv.HOME === process.env.ORCH_KIMI_TASK_HOME
        && cleanEnv.KIMI_SHARE_DIR === process.env.ORCH_KIMI_TASK_HOME,
    },
    ...(detail ? { detail } : {}),
  })}\n`, { mode: 0o600 });
  renameSync(next, settlementFile);
}

try {
  writeSettlement("starting");
} catch (error) {
  process.stderr.write(
    `Operator Kimi settlement initialization failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(73);
}

const child = spawn(realCli, [...process.argv.slice(2), "--config", inlineConfig], {
  cwd: process.cwd(),
  env: cleanEnv,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

function processSnapshot() {
  const root = child.pid;
  if (!root || process.platform === "win32") return root ? [root] : [];
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
    });
    const children = new Map();
    const byGroup = new Map();
    for (const line of rows.trim().split("\n")) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
      if (Number.isInteger(pgid)) {
        if (!byGroup.has(pgid)) byGroup.set(pgid, []);
        byGroup.get(pgid).push(pid);
      }
    }
    const found = new Set([root, ...(byGroup.get(root) ?? [])]);
    const queue = [...found];
    while (queue.length) {
      for (const descendant of children.get(queue.shift()) ?? []) {
        if (!found.has(descendant)) {
          found.add(descendant);
          queue.push(descendant);
        }
      }
    }
    return [...found];
  } catch {
    return [root];
  }
}

function alive(pids) {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

function signalTree(pids, signal) {
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }
  const groups = new Set();
  for (const pid of pids) {
    try {
      const pgid = Number(execFileSync(
        "ps",
        ["-o", "pgid=", "-p", String(pid)],
        { encoding: "utf8" },
      ).trim());
      if (Number.isInteger(pgid) && pgid > 1) groups.add(pgid);
    } catch {
      // Already gone.
    }
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Already gone.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finalize(reason, exitCode = 0) {
  if (finalizing) return;
  finalizing = true;
  if (treeMonitor) clearInterval(treeMonitor);
  observed = [...new Set([...observed, ...processSnapshot()])];
  signalTree(observed, "SIGTERM");
  await delay(termGraceMs);
  observed = [...new Set([...observed, ...processSnapshot()])];
  if (alive(observed).length) {
    signalTree(observed, "SIGKILL");
    await delay(Math.min(termGraceMs, 1_000));
  }
  const survivors = alive(observed);
  if (survivors.length) {
    writeSettlement(
      "failed",
      survivors,
      `${reason}: process tree survived`,
      child.pid ?? null,
    );
    process.exit(70);
  }
  writeSettlement(exitCode === 0 ? "settled" : "failed", [], reason, child.pid ?? null);
  process.exit(exitCode);
}

treeMonitor = setInterval(() => {
  observed = [...new Set([...observed, ...processSnapshot()])];
  try {
    process.kill(operatorPid, 0);
  } catch {
    void finalize("Operator parent process exited");
  }
}, 100);

try {
  writeSettlement("running", [], undefined, child.pid ?? null);
} catch (error) {
  void finalize(
    `initial settlement evidence write failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    74,
  );
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    void finalize(`launcher received ${signal}`);
  });
}

child.once("error", (error) => {
  writeSettlement("failed", [], `spawn failed: ${error.message}`, child.pid ?? null);
  process.exit(71);
});
child.once("exit", (code, signal) => {
  void finalize(
    `CLI exited${signal ? ` via ${signal}` : ` with code ${code ?? "unknown"}`}`,
    code ?? (signal ? 1 : 0),
  );
});
