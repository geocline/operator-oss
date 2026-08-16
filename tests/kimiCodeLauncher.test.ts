import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createSession } from "@moonshot-ai/kimi-agent-sdk";

const launcher = path.join(process.cwd(), "scripts", "kimi-code-launcher.mjs");
const fakeCli = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "kimi",
  "fake-kimi-cli.mjs",
);

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function launch(escapedWorker: boolean) {
  const id = `${process.pid}-${Date.now()}-${escapedWorker ? "escaped" : "group"}`;
  const envFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-env.json`);
  const argsFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-args.json`);
  const workerFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-worker`);
  const settlementFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-settlement.json`);
  const taskHome = path.join(process.env.ORCH_TEST_TMP!, `${id}-home`);
  const child = spawn(process.execPath, [launcher], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: taskHome,
      KIMI_CODE_HOME: taskHome,
      KIMI_SHARE_DIR: taskHome,
      GITHUB_TOKEN: "must-not-reach-kimi",
      OPENROUTER_API_KEY: "must-not-reach-kimi",
      NPM_TOKEN: "must-not-reach-kimi",
      KIMI_API_KEY: "operator-loopback-relay",
      KIMI_BASE_URL: "http://127.0.0.1:43210/v1",
      KIMI_MODEL_NAME: "operator.fixture",
      ORCH_KIMI_REAL_CLI: fakeCli,
      ORCH_KIMI_SETTLEMENT_FILE: settlementFile,
      ORCH_KIMI_TASK_HOME: taskHome,
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
      ORCH_KIMI_TERM_GRACE_MS: "100",
      FAKE_KIMI_ARGS_FILE: argsFile,
      FAKE_KIMI_ENV_FILE: envFile,
      FAKE_KIMI_WORKER_FILE: workerFile,
      FAKE_KIMI_WORKER_DETACHED: escapedWorker ? "1" : "0",
    },
    stdio: "ignore",
  });
  expect(await waitUntil(() => existsSync(envFile) && existsSync(workerFile))).toBe(true);
  const workerPid = Number(readFileSync(workerFile, "utf8"));
  return { child, argsFile, envFile, settlementFile, workerPid };
}

describe("Kimi Code supervised launcher", () => {
  it("scrubs credentials reintroduced by the real SDK spawn and settles its worker", async () => {
    const id = `${process.pid}-${Date.now()}-sdk`;
    const envFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-env.json`);
    const argsFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-args.json`);
    const workerFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-worker`);
    const settlementFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-settlement.json`);
    const taskHome = path.join(process.env.ORCH_TEST_TMP!, `${id}-home`);
    const previous = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      NPM_TOKEN: process.env.NPM_TOKEN,
    };
    process.env.GITHUB_TOKEN = "ambient-must-not-reach-kimi";
    process.env.OPENROUTER_API_KEY = "ambient-must-not-reach-kimi";
    process.env.NPM_TOKEN = "ambient-must-not-reach-kimi";
    const session = createSession({
      workDir: process.env.ORCH_TEST_TMP!,
      executable: launcher,
      env: {
        HOME: taskHome,
        KIMI_CODE_HOME: taskHome,
        KIMI_SHARE_DIR: taskHome,
        KIMI_API_KEY: "operator-loopback-relay",
        KIMI_BASE_URL: "http://127.0.0.1:43210/v1",
        KIMI_MODEL_NAME: "operator.fixture",
        ORCH_KIMI_REAL_CLI: fakeCli,
        ORCH_KIMI_SETTLEMENT_FILE: settlementFile,
        ORCH_KIMI_TASK_HOME: taskHome,
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
        ORCH_KIMI_TERM_GRACE_MS: "100",
        FAKE_KIMI_PROTOCOL: "1",
        FAKE_KIMI_ARGS_FILE: argsFile,
        FAKE_KIMI_ENV_FILE: envFile,
        FAKE_KIMI_WORKER_FILE: workerFile,
        FAKE_KIMI_WORKER_DETACHED: "1",
      },
    });
    try {
      const turn = session.prompt("fixture");
      for await (const _event of turn) {
        // Fake wire fixture emits no events.
      }
      expect((await turn.result).status).toBe("finished");
      expect(await waitUntil(() => existsSync(envFile) && existsSync(workerFile))).toBe(true);
      const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
      expect(env.KIMI_API_KEY).toBe("operator-loopback-relay");
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
      expect(env).not.toHaveProperty("NPM_TOKEN");
      expect(env).not.toHaveProperty("ORCH_KIMI_INLINE_CONFIG");
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      const configIndex = args.indexOf("--config");
      expect(configIndex).toBeGreaterThanOrEqual(0);
      const inlineConfig = JSON.parse(args[configIndex + 1]) as {
        providers: Record<string, { api_key: string }>;
      };
      expect(inlineConfig.providers["operator-relay"].api_key).toBe("");
      expect(args.join(" ")).not.toContain("operator-loopback-relay");
      const workerPid = Number(readFileSync(workerFile, "utf8"));
      expect(pidAlive(workerPid)).toBe(true);
      await session.close();
      expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
      expect(JSON.parse(readFileSync(settlementFile, "utf8"))).toMatchObject({
        status: "settled",
        survivors: [],
        child_environment: {
          credential_keys: ["KIMI_API_KEY"],
          home_is_task_home: true,
        },
      });
    } finally {
      await session.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not spawn the detached CLI when settlement evidence cannot be initialized", async () => {
    const id = `${process.pid}-${Date.now()}-bad-settlement`;
    const settlementDirectory = path.join(process.env.ORCH_TEST_TMP!, `${id}-dir`);
    const envFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-env.json`);
    mkdirSync(settlementDirectory, { recursive: true });
    const child = spawn(process.execPath, [launcher], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORCH_KIMI_REAL_CLI: fakeCli,
        ORCH_KIMI_SETTLEMENT_FILE: settlementDirectory,
        FAKE_KIMI_ENV_FILE: envFile,
        FAKE_KIMI_EXIT_IMMEDIATELY: "1",
      },
      stdio: "ignore",
    });

    const exit = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );

    expect(exit).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(envFile)).toBe(false);
  });

  it("settles the spawned tree when the first post-spawn evidence write fails", async () => {
    const id = `${process.pid}-${Date.now()}-running-settlement-failure`;
    const envFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-env.json`);
    const workerFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-worker`);
    const settlementFile = path.join(process.env.ORCH_TEST_TMP!, `${id}-settlement.json`);
    const taskHome = path.join(process.env.ORCH_TEST_TMP!, `${id}-home`);
    const child = spawn(process.execPath, [launcher], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: taskHome,
        KIMI_CODE_HOME: taskHome,
        KIMI_SHARE_DIR: taskHome,
        KIMI_API_KEY: "operator-loopback-relay",
        ORCH_KIMI_REAL_CLI: fakeCli,
        ORCH_KIMI_SETTLEMENT_FILE: settlementFile,
        ORCH_KIMI_TASK_HOME: taskHome,
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
        ORCH_KIMI_TERM_GRACE_MS: "100",
        ORCH_KIMI_TEST_FAIL_RUNNING_SETTLEMENT: "1",
        FAKE_KIMI_ENV_FILE: envFile,
        FAKE_KIMI_WORKER_FILE: workerFile,
        FAKE_KIMI_WORKER_DETACHED: "1",
      },
      stdio: "ignore",
    });

    const exit = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );

    expect(exit).not.toBe(0);
    if (existsSync(workerFile)) {
      const workerPid = Number(readFileSync(workerFile, "utf8"));
      expect(await waitUntil(() => !pidAlive(workerPid))).toBe(true);
    }
    expect(JSON.parse(readFileSync(settlementFile, "utf8"))).toMatchObject({
      status: "failed",
      survivors: [],
      detail: expect.stringMatching(/evidence write failed/i),
    });
  });

  it("strips ambient credentials from the real CLI while preserving only the relay key", async () => {
    const run = await launch(false);
    try {
      const env = JSON.parse(readFileSync(run.envFile, "utf8")) as Record<string, string>;
      expect(env.KIMI_API_KEY).toBe("operator-loopback-relay");
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
      expect(env).not.toHaveProperty("NPM_TOKEN");
      expect(Object.keys(env).filter((key) =>
        /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i.test(key),
      )).toEqual(["KIMI_API_KEY"]);
    } finally {
      run.child.kill("SIGTERM");
      await new Promise((resolve) => run.child.once("exit", resolve));
    }
  });

  it.each([false, true])(
    "settles the real CLI and %s-group worker before reporting success",
    async (escapedWorker) => {
      const run = await launch(escapedWorker);
      expect(pidAlive(run.workerPid)).toBe(true);

      run.child.kill("SIGTERM");
      const exit = await new Promise<number | null>((resolve) =>
        run.child.once("exit", resolve),
      );

      expect(exit).toBe(0);
      expect(await waitUntil(() => !pidAlive(run.workerPid))).toBe(true);
      expect(JSON.parse(readFileSync(run.settlementFile, "utf8"))).toMatchObject({
        status: "settled",
        survivors: [],
        child_environment: {
          credential_keys: ["KIMI_API_KEY"],
          home_is_task_home: true,
        },
      });
    },
  );
});
