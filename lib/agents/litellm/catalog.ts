import type {
  LiteLLMCatalogSnapshot,
  LiteLLMHarness,
  LiteLLMModel,
  LiteLLMParseResult,
} from "./types";

const EMPTY: LiteLLMCatalogSnapshot = {
  models: [],
  errors: [],
  refreshedAt: null,
  stale: false,
  error: null,
};

const state = globalThis as typeof globalThis & {
  __operatorLiteLLMCatalog?: LiteLLMCatalogSnapshot;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const cleanString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const cleanHarnesses = (value: unknown): LiteLLMHarness[] => {
  if (!Array.isArray(value)) return [];
  const found = value.filter(
    (x): x is LiteLLMHarness => x === "codex" || x === "claude" || x === "prime",
  );
  return [...new Set(found)];
};

export function parseLiteLLMModelInfo(raw: unknown): LiteLLMParseResult {
  const root = record(raw);
  const data = Array.isArray(root?.data) ? root.data : [];
  const models: LiteLLMModel[] = [];
  const errors: LiteLLMParseResult["errors"] = [];
  const seen = new Set<string>();

  for (const candidate of data) {
    const entry = record(candidate);
    const value = cleanString(entry?.model_name) ?? "(unknown)";
    const modelInfo = record(entry?.model_info);
    const operator = record(modelInfo?.operator);

    // Untagged/disabled entries are intentionally invisible, not errors.
    if (!operator || operator.enabled !== true) continue;
    if (operator.kind !== "coding") {
      if (operator.kind !== "image") errors.push({ model: value, error: "operator.kind must be coding" });
      continue;
    }

    const label = cleanString(operator.label);
    const harnesses = cleanHarnesses(operator.harnesses);
    if (!label) {
      errors.push({ model: value, error: "operator.label must be nonempty" });
      continue;
    }
    if (!harnesses.length) {
      errors.push({ model: value, error: "operator.harnesses must include codex, claude, or prime" });
      continue;
    }
    if (seen.has(value)) {
      errors.push({ model: value, error: "duplicate model_name" });
      continue;
    }

    const context = operator.context_window;
    const contextWindow =
      typeof context === "number" && Number.isInteger(context) && context > 0
        ? context
        : null;
    const sortOrder =
      typeof operator.sort_order === "number" && Number.isFinite(operator.sort_order)
        ? operator.sort_order
        : 100;
    const reasoningOptions = Array.isArray(operator.reasoning_options)
      ? operator.reasoning_options.filter((x): x is string => typeof x === "string" && !!x.trim())
      : [];

    seen.add(value);
    models.push({
      value,
      label,
      description: cleanString(operator.description) ?? "",
      kind: "coding",
      harnesses,
      contextWindow,
      reasoningOptions,
      sortOrder,
    });
  }

  models.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  );
  return { models, errors };
}

export function replaceLiteLLMCatalog(next: LiteLLMCatalogSnapshot): void {
  state.__operatorLiteLLMCatalog = structuredClone(next);
}

export function getLiteLLMCatalog(): LiteLLMCatalogSnapshot {
  return structuredClone(state.__operatorLiteLLMCatalog ?? EMPTY);
}

export function modelForHarness(value: string, harness: LiteLLMHarness): LiteLLMModel | null {
  return getLiteLLMCatalog().models.find((m) => m.value === value && m.harnesses.includes(harness)) ?? null;
}
