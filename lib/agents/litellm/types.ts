export type LiteLLMHarness = "codex" | "claude" | "prime";

export type LiteLLMAdmissionStatus = "passed" | "failed";

/**
 * Sanitized proof that one exact LiteLLM alias was exercised through one
 * harness. `harnesses` is derived from the records whose status is `passed`;
 * it is never trusted as catalog input.
 */
export interface LiteLLMAdmissionEvidence {
  harness: LiteLLMHarness;
  status: LiteLLMAdmissionStatus;
  harnessVersion: string;
  testRevision: string;
  testedAt: string;
  requestedAlias: string;
  resolvedModel: string;
}

export interface LiteLLMModel {
  value: string;
  label: string;
  description: string;
  harnesses: LiteLLMHarness[];
  /**
   * Optional only for legacy persisted snapshots and older in-process fixtures.
   * Fresh catalog input never receives this compatibility path: the parser
   * requires admission records and derives `harnesses` exclusively from them.
   */
  admissions?: LiteLLMAdmissionEvidence[];
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
