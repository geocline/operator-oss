import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LITELLM_PRIME_HOME } from "@/lib/config";
import {
  ensurePrimeTaskDirs,
  primeTaskPaths,
} from "@/lib/agents/prime/session-paths";
import {
  APPROVED_PRIME_MODEL,
  assertPrimeModelAllowed,
  buildPrimeHarnessEnv,
} from "@/lib/agents/prime/policy";

describe("Prime home configuration", () => {
  it("is absolute and isolated under litellm-prime", () => {
    expect(path.isAbsolute(LITELLM_PRIME_HOME)).toBe(true);
    expect(LITELLM_PRIME_HOME.endsWith(`${path.sep}litellm-prime`)).toBe(true);
    // tests/setup.ts pins the override; config must honor it.
    expect(LITELLM_PRIME_HOME).toBe(process.env.LITELLM_PRIME_HOME);
  });
});

describe("primeTaskPaths", () => {
  afterEach(() => {
    rmSync(LITELLM_PRIME_HOME, { recursive: true, force: true });
  });

  it("contains config and generation session dirs beneath the task home", () => {
    const p = primeTaskPaths("task-abc", 2);
    expect(p.taskHome).toBe(path.join(LITELLM_PRIME_HOME, "task-abc"));
    expect(p.configDir).toBe(path.join(LITELLM_PRIME_HOME, "task-abc", "config"));
    expect(p.sessionDir).toBe(
      path.join(LITELLM_PRIME_HOME, "task-abc", "sessions", "2"),
    );
  });

  it("rejects traversal, separators, empty ids, and bad generations", () => {
    expect(() => primeTaskPaths("..", 1)).toThrow();
    expect(() => primeTaskPaths("a/../b", 1)).toThrow();
    expect(() => primeTaskPaths("a/b", 1)).toThrow();
    expect(() => primeTaskPaths("a\\b", 1)).toThrow();
    expect(() => primeTaskPaths("", 1)).toThrow();
    expect(() => primeTaskPaths("   ", 1)).toThrow();
    expect(() => primeTaskPaths("task", -1)).toThrow();
    expect(() => primeTaskPaths("task", 1.5)).toThrow();
    expect(() => primeTaskPaths("task", Number.NaN)).toThrow();
  });

  it("creates 0700 directories on ensure", () => {
    const p = ensurePrimeTaskDirs("task-perms", 1);
    for (const dir of [p.taskHome, p.configDir, p.sessionDir]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });
});

describe("buildPrimeHarnessEnv", () => {
  it("strips every provider secret and keeps benign vars", () => {
    const env = buildPrimeHarnessEnv("task-1", {
      PATH: "/usr/bin",
      HOME: "/home/geo",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok-anthropic",
      OPENROUTER_API_KEY: "sk-or",
      OPENROUTER_OPERATOR_API_KEY: "sk-or-op",
      LITELLM_API_KEY: "sk-litellm",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/geo");
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "OPENROUTER_OPERATOR_API_KEY",
      "LITELLM_API_KEY",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(JSON.stringify(env)).not.toMatch(/sk-openai|sk-anthropic|tok-anthropic|sk-or|sk-litellm/);
  });

  it("strips credential-shaped names beyond the known six", () => {
    const env = buildPrimeHarnessEnv("task-1", {
      PATH: "/usr/bin",
      GOOGLE_API_KEY: "sk-google",
      MISTRAL_API_KEY: "sk-mistral",
      SOME_ACCESS_TOKEN: "tok",
      MY_APP_SECRET: "shh",
      GH_AUTH_TOKEN: "gho",
      SERVICE_TOKEN: "instance-token",
      FAKE_PRIME_EVENTS: "/tmp/events.jsonl",
    });
    for (const key of ["GOOGLE_API_KEY", "MISTRAL_API_KEY", "SOME_ACCESS_TOKEN", "MY_APP_SECRET", "GH_AUTH_TOKEN"]) {
      expect(env).not.toHaveProperty(key);
    }
    // The two secrets the child legitimately needs survive / are re-injected.
    expect(env.SERVICE_TOKEN).toBe("instance-token");
    expect(env.FAKE_PRIME_EVENTS).toBe("/tmp/events.jsonl");
  });
});

describe("Prime model policy", () => {
  it("accepts any exact alias that has already passed Prime catalog admission", () => {
    expect(APPROVED_PRIME_MODEL).toBe("operator.kimi-k3");
    expect(() => assertPrimeModelAllowed("operator.kimi-k3")).not.toThrow();
    expect(() => assertPrimeModelAllowed("operator.frontier")).not.toThrow();
    expect(() => assertPrimeModelAllowed("openai/gpt-5.5")).not.toThrow();
  });

  it("rejects absent and fallback-qualified values", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "  ",
      "operator.kimi-k3:fallback",
      "operator.kimi-k3/fallback",
    ]) {
      expect(() => assertPrimeModelAllowed(bad as string)).toThrow();
    }
  });
});
