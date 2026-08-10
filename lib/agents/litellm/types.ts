export type LiteLLMHarness = "codex" | "claude" | "prime";

export interface LiteLLMModel {
  value: string;
  label: string;
  description: string;
  harnesses: LiteLLMHarness[];
  kind: "coding";
  contextWindow: number | null;
  reasoningOptions: string[];
  sortOrder: number;
}

export interface LiteLLMCatalogError {
  model: string;
  error: string;
}

export interface LiteLLMParseResult {
  models: LiteLLMModel[];
  errors: LiteLLMCatalogError[];
}

export interface LiteLLMCatalogSnapshot extends LiteLLMParseResult {
  refreshedAt: string | null;
  stale: boolean;
  error?: string | null;
}
