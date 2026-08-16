export type LiteLLMHarness = "codex" | "claude" | "prime" | "kimi-code" | "dsh";

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
   * Absent when the gateway declares plain `operator.harnesses` instead of
   * admission records - the older dialect, and the one a local single-user
   * setup normally speaks. Those models stay usable and are flagged `unvetted`
   * rather than dropped.
   */
  admissions?: LiteLLMAdmissionEvidence[];
  /**
   * True when `harnesses` came from the gateway's own declaration rather than
   * from a passing admission record. Nothing is claimed about testing, so the
   * picker says so instead of the app pretending either way.
   */
  unvetted?: boolean;
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
