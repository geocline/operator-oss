import type {
  LiteLLMAdmissionEvidence,
  LiteLLMAdmissionStatus,
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

const cleanHarness = (value: unknown): LiteLLMHarness | null =>
  value === "codex" || value === "claude" || value === "prime" ? value : null;

const cleanAdmissionStatus = (value: unknown): LiteLLMAdmissionStatus | null =>
  value === "passed" || value === "failed" ? value : null;

const isIsoTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function parseAdmissions(
  value: unknown,
  modelName: string,
): { admissions: LiteLLMAdmissionEvidence[]; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      admissions: [],
      errors: ["operator.admissions must be an array of harness admission records"],
    };
  }

  const admissions: LiteLLMAdmissionEvidence[] = [];
  const errors: string[] = [];
  const seenHarnesses = new Set<LiteLLMHarness>();

  value.forEach((candidate, index) => {
    const prefix = `operator.admissions[${index}]`;
    const entry = record(candidate);
    if (!entry) {
      errors.push(`${prefix} must be a harness admission record`);
      return;
    }

    const harness = cleanHarness(entry.harness);
    if (!harness) {
      errors.push(`${prefix}.harness must be codex, claude, or prime`);
      return;
    }
    if (seenHarnesses.has(harness)) {
      errors.push(`operator.admissions must not repeat harness ${harness}`);
      return;
    }
    seenHarnesses.add(harness);

    const status = cleanAdmissionStatus(entry.status);
    if (!status) {
      errors.push(`${prefix}.status must be passed or failed`);
      return;
    }
    const harnessVersion = cleanString(entry.harness_version);
    if (!harnessVersion) {
      errors.push(`${prefix}.harness_version must be nonempty`);
      return;
    }
    const testRevision = cleanString(entry.test_revision);
    if (!testRevision) {
      errors.push(`${prefix}.test_revision must be nonempty`);
      return;
    }
    const testedAt = cleanString(entry.tested_at);
    if (!testedAt || !isIsoTimestamp(testedAt)) {
      errors.push(`${prefix}.tested_at must be an ISO-8601 timestamp`);
      return;
    }
    const requestedAlias = cleanString(entry.requested_alias);
    if (requestedAlias !== modelName) {
      errors.push(`${prefix}.requested_alias must equal model_name`);
      return;
    }
    const resolvedModel = cleanString(entry.resolved_model);
    if (!resolvedModel) {
      errors.push(`${prefix}.resolved_model must be nonempty`);
      return;
    }

    admissions.push({
      harness,
      status,
      harnessVersion,
      testRevision,
      testedAt,
      requestedAlias,
      resolvedModel,
    });
  });

  return { admissions, errors };
}

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
    if (!label) {
      errors.push({ model: value, error: "operator.label must be nonempty" });
      continue;
    }

    const parsedAdmissions = parseAdmissions(operator.admissions, value);
    errors.push(...parsedAdmissions.errors.map((error) => ({ model: value, error })));
    const harnesses = parsedAdmissions.admissions
      .filter((admission) => admission.status === "passed")
      .map((admission) => admission.harness);
    // A model with valid evidence but no passing harness pair stays invisible.
    // Failed admission is a result, not a catalog parse error.
    if (!harnesses.length) continue;

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
      admissions: parsedAdmissions.admissions,
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
