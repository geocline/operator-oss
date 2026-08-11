import path from "node:path";
import { describe, expect, it } from "vitest";
import { LITELLM_CLAUDE_HOME } from "@/lib/config";
import { buildLiteLLMClaudeEnv } from "@/lib/agents/litellm-claude/driver";

describe("LiteLLM Claude Code routing", () => {
  it("uses an isolated task config, relay auth, and pins every background model to the admitted alias", () => {
    const env = buildLiteLLMClaudeEnv(
      "task-1",
      "operator.flex",
      "http://127.0.0.1:4567/v1",
      "child-token",
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "native-key",
        CLAUDE_CODE_OAUTH_TOKEN: "native-oauth",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_ACCESS_KEY_ID: "aws-key",
        OPENROUTER_API_KEY: "provider-key",
        OPENAI_API_KEY: "openai-key",
        GOOGLE_API_KEY: "google-key",
        MISTRAL_API_KEY: "mistral-key",
        AZURE_OPENAI_API_KEY: "azure-key",
        AWS_PROFILE: "prod",
        SOME_ACCESS_TOKEN: "other-token",
        HF_TOKEN: "hugging-face",
        HUGGINGFACEHUB_API_TOKEN: "hugging-face-hub",
        GITHUB_TOKEN: "github",
        NPM_TOKEN: "npm",
        PRIVATE_KEY: "private",
      },
    );

    expect(env).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4567",
      ANTHROPIC_AUTH_TOKEN: "child-token",
      CLAUDE_CONFIG_DIR: path.join(LITELLM_CLAUDE_HOME, "task-1"),
      ANTHROPIC_DEFAULT_FABLE_MODEL: "operator.flex",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "operator.flex",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "operator.flex",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "operator.flex",
      ANTHROPIC_SMALL_FAST_MODEL: "operator.flex",
      CLAUDE_CODE_SUBAGENT_MODEL: "operator.flex",
    });
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "MISTRAL_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "AWS_PROFILE",
      "SOME_ACCESS_TOKEN",
      "HF_TOKEN",
      "HUGGINGFACEHUB_API_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "PRIVATE_KEY",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });
});
