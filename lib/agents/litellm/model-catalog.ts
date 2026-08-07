import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LiteLLMModel } from "./types";

const CATALOG_FILENAME = "operator-model-catalog.json";
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const titleCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Codex needs local metadata for aliases that are not in OpenAI's built-in
 * model catalog. This catalog contains capabilities only; gateway credentials
 * remain in the loopback relay and LiteLLM.
 */
export function writeLiteLLMModelCatalog(home: string, models: LiteLLMModel[]): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const catalogPath = path.join(home, CATALOG_FILENAME);
  const temporaryPath = `${catalogPath}.${process.pid}.tmp`;
  const entries = models
    .filter((model) => model.harnesses.includes("codex"))
    .map((model) => {
      const contextWindow = model.contextWindow ?? 128_000;
      const supportedReasoningLevels = model.reasoningOptions
        .filter((effort) => REASONING_EFFORTS.has(effort))
        .map((effort) => ({
          effort,
          description: `${titleCase(effort)} reasoning effort`,
        }));
      return {
        slug: model.value,
        display_name: model.label,
        name: model.value,
        model: model.value,
        provider: "openai",
        context_window: contextWindow,
        truncation_policy: { mode: "tokens", limit: contextWindow },
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: model.sortOrder,
        base_instructions: "You are a coding agent.",
        supports_tools: true,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        supports_reasoning_summaries: supportedReasoningLevels.length > 0,
        support_verbosity: false,
        supported_reasoning_levels: supportedReasoningLevels,
      };
    });

  writeFileSync(temporaryPath, `${JSON.stringify({ models: entries }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, catalogPath);
  chmodSync(catalogPath, 0o600);
  return catalogPath;
}
