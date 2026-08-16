import { describe, expect, it } from "vitest";
import { assertDshModelAllowed, buildDshHarnessEnv } from "@/lib/agents/dsh/policy";

describe("assertDshModelAllowed", () => {
  it("allows a DeepSeek-family alias", () => {
    expect(() => assertDshModelAllowed("operator.deepseek-v4")).not.toThrow();
    expect(() => assertDshModelAllowed("deepseek-chat")).not.toThrow();
  });

  it("rejects an empty/missing model", () => {
    expect(() => assertDshModelAllowed(null)).toThrow(/explicit model/);
    expect(() => assertDshModelAllowed("")).toThrow(/explicit model/);
  });

  it("rejects a subscription-only family even if somehow passed in", () => {
    expect(() => assertDshModelAllowed("claude-sonnet-4")).toThrow(/subscription-only/);
    expect(() => assertDshModelAllowed("gpt-5")).toThrow(/subscription-only/);
  });

  it("rejects a non-DeepSeek alias", () => {
    expect(() => assertDshModelAllowed("operator.mystery")).toThrow(/DeepSeek-family/);
  });
});

describe("buildDshHarnessEnv", () => {
  it("strips provider/gateway credentials, never leaking them to the child", () => {
    const env = buildDshHarnessEnv("task-1", {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-openai-secret",
      DEEPSEEK_API_KEY: "sk-deepseek-secret",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      LITELLM_API_KEY: "sk-litellm-secret",
      MY_RANDOM_SECRET_TOKEN: "leak-me-not",
    });
    expect(env.PATH).toBe("/usr/bin");
    for (const key of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "LITELLM_API_KEY", "MY_RANDOM_SECRET_TOKEN"]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("strips ambient credential-shaped names, not just known provider keys", () => {
    // The Aug 14 admission security review found Prime's scrub only removed
    // provider API keys; dsh uses the kimi-code launcher's broad name pattern
    // so ambient credentials under ANY name never reach the child.
    const env = buildDshHarnessEnv("task-1", {
      PATH: "/usr/bin",
      HOME: "/Users/geo",
      GITHUB_TOKEN: "ghp-secret",
      NPM_TOKEN: "npm-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      SESSION_COOKIE: "cookie-secret",
      DB_PASSWORD: "pw-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/geo");
    for (const key of [
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "SESSION_COOKIE",
      "DB_PASSWORD",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "SSH_AUTH_SOCK",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});
