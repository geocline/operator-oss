import type {
  LiteLLMAdmissionEvidence,
  LiteLLMAdmissionStatus,
  LiteLLMCatalogSnapshot,
  LiteLLMHarness,
  LiteLLMModel,
  LiteLLMParseResult,
} from "./types";
import { isSubscriptionOnlyModelId } from "./family";

const EMPTY: LiteLLMCatalogSnapshot = {
  models: [],
  errors: [],
  refreshedAt: null,
  stale: false,
  error: null,
};

const state = globalThis as typeof globalThis & {
  __operatorLiteLLMCatalog?: LiteLLMCatalogSnapshot;
  __operatorLiveAdmissionCandidate?: {
    alias: string;
    harness: LiteLLMHarness;
  };
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const cleanString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const cleanHarness = (value: unknown): LiteLLMHarness | null =>
  value === "codex"
  || value === "claude"
  || value === "prime"
  || value === "kimi-code"
  || value === "dsh"
    ? value
    : null;

const cleanAdmissionStatus = (value: unknown): LiteLLMAdmissionStatus | null =>
  value === "passed" || value === "failed" ? value : null;

const isIsoTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function parseAdmissions(
  value: unknown,
  modelName: string,
): { admissions: LiteLLMAdmissionEvidence[]; errors: string[] } {
  // Absence is handled by the caller (the model falls back to its declared
  // `harnesses` list). Reaching here with a non-array means the key IS present
  // and malformed, which is a real config error worth reporting.
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
      errors.push(`${prefix}.harness must be codex, claude, prime, kimi-code, or dsh`);
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
  // Parallel to `models` — the gateway's own resolved backing model for each
  // entry (litellm_params.model, e.g. "openrouter/moonshotai/kimi-k3"), used
  // only to collapse redundant aliases below. Never exposed on LiteLLMModel.
  const resolvedKeys: (string | null)[] = [];
  const errors: LiteLLMParseResult["errors"] = [];
  const seen = new Set<string>();

  for (const candidate of data) {
    const entry = record(candidate);
    const value = cleanString(entry?.model_name) ?? "(unknown)";
    const modelInfo = record(entry?.model_info);
    const operator = record(modelInfo?.operator);
    const litellmParams = record(entry?.litellm_params);
    const resolvedKey =
      cleanString(litellmParams?.model) ?? cleanString(modelInfo?.key);

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

    // Two dialects. With `operator.admissions` present, the harness list is
    // derived ONLY from records that passed: recorded evidence outranks any
    // claim, and a recorded failure keeps that pair out. Without it, the
    // gateway's plain `operator.harnesses` list is taken at face value and the
    // model is flagged unvetted - the app has no opinion on whether someone
    // tested it, and dropping the model instead (the previous behaviour) left a
    // local instance with an empty picker and an error telling it to refresh,
    // which re-read the same config and changed nothing.
    const declared = Array.isArray(operator.harnesses)
      ? operator.harnesses
          .map(cleanHarness)
          .filter(
            (h): h is Exclude<LiteLLMHarness, "kimi-code" | "dsh"> =>
              !!h && h !== "kimi-code" && h !== "dsh",
          )
      : [];
    const hasAdmissions = operator.admissions !== undefined;
    const parsedAdmissions = hasAdmissions
      ? parseAdmissions(operator.admissions, value)
      : { admissions: [] as LiteLLMAdmissionEvidence[], errors: [] as string[] };
    errors.push(...parsedAdmissions.errors.map((error) => ({ model: value, error })));
    const harnesses = hasAdmissions
      ? parsedAdmissions.admissions
          .filter((admission) => admission.status === "passed")
          .map((admission) => admission.harness)
      : [...new Set(declared)];
    // Nothing left to run this model on: every admission failed, or the config
    // named no harness at all. Not a parse error, just an invisible model.
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
      // The legacy path omits the key entirely rather than writing an empty
      // array: this snapshot gets persisted and re-read through
      // admittedSnapshot, and "admissions: []" there reads as "evidence exists
      // and nothing passed", which would drop the model on the next load.
      ...(hasAdmissions ? { admissions: parsedAdmissions.admissions } : { unvetted: true }),
      contextWindow,
      reasoningOptions,
      sortOrder,
    });
    resolvedKeys.push(resolvedKey);
  }

  // Collapse redundant aliases: the shared gateway also serves other apps'
  // task-scoped deployments (e.g. "task.tools.ceo"), and some of those happen
  // to carry the same operator.* coding tags as Operator's own canonical
  // "operator.*" alias for the identical backing model. Showing every alias
  // as its own picker entry reads as several different models when it is
  // really one model wearing several names - not a labeling bug, a
  // deduplication gap. Prefer the "operator."-prefixed alias (Operator's own
  // naming convention) as the canonical entry; a resolvedKey of null never
  // collapses (nothing to compare against).
  // Only collapse when the entries are actual duplicates - same label AND
  // same harness set - so two aliases of one physical model that are
  // deliberately scoped to different harnesses (or carry different
  // labels/descriptions) are both kept.
  const harnessSetKey = (m: LiteLLMModel) => [...m.harnesses].sort().join(",");
  const duplicateGroupKey = (m: LiteLLMModel, resolvedKey: string) =>
    `${resolvedKey} ${m.label} ${harnessSetKey(m)}`;

  const canonicalIndexByGroup = new Map<string, number>();
  for (let index = 0; index < models.length; index += 1) {
    const key = resolvedKeys[index];
    if (!key) continue;
    const group = duplicateGroupKey(models[index], key);
    const current = canonicalIndexByGroup.get(group);
    if (current === undefined) {
      canonicalIndexByGroup.set(group, index);
      continue;
    }
    const existing = models[current];
    const candidate = models[index];
    const candidateIsCanonicalAlias = candidate.value.startsWith("operator.");
    const existingIsCanonicalAlias = existing.value.startsWith("operator.");
    if (candidateIsCanonicalAlias && !existingIsCanonicalAlias) {
      canonicalIndexByGroup.set(group, index);
    }
  }
  const deduped = models.filter((model, index) => {
    const key = resolvedKeys[index];
    if (!key) return true;
    const group = duplicateGroupKey(model, key);
    return canonicalIndexByGroup.get(group) === index;
  });

  deduped.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  );
  return { models: deduped, errors };
}

export function replaceLiteLLMCatalog(next: LiteLLMCatalogSnapshot): void {
  state.__operatorLiteLLMCatalog = structuredClone(next);
}

export function getLiteLLMCatalog(): LiteLLMCatalogSnapshot {
  return structuredClone(state.__operatorLiteLLMCatalog ?? EMPTY);
}

export function modelForHarness(value: string, harness: LiteLLMHarness): LiteLLMModel | null {
  // Belt-and-suspenders on the subscription-only rule (see ./family.ts):
  // liteLLMCapabilities() already keeps these out of every picker, but a
  // hand-edited tasks.model row bypasses the picker entirely — reject it here
  // too, at the exact point every LiteLLM driver resolves its turn's model.
  if (isSubscriptionOnlyModelId(value)) return null;
  const model = getLiteLLMCatalog().models.find((candidate) => candidate.value === value);
  if (!model) return null;
  if (model.harnesses.includes(harness)) return model;
  const candidate = state.__operatorLiveAdmissionCandidate;
  return candidate?.alias === value && candidate.harness === harness
    ? model
    : null;
}

export function setLiveAdmissionCandidateForTest(
  alias: string,
  harness: LiteLLMHarness,
): void {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.MODEL_ADMISSION_LIVE !== "1"
  ) {
    throw new Error("Live admission candidate override requires test mode and explicit live opt-in");
  }
  state.__operatorLiveAdmissionCandidate = { alias, harness };
}

export function clearLiveAdmissionCandidateForTest(): void {
  delete state.__operatorLiveAdmissionCandidate;
}
