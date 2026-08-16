import { LITELLM_API_KEY, LITELLM_BASE_URL } from "../../config";
import { getSetting, setSetting } from "../../store";
import {
  getLiteLLMCatalog,
  parseLiteLLMModelInfo,
  replaceLiteLLMCatalog,
} from "./catalog";
import type { LiteLLMAdmissionEvidence, LiteLLMCatalogSnapshot, LiteLLMModel } from "./types";

const SETTING_KEY = "agent_model_catalog:litellm-codex";

function isSnapshot(value: unknown): value is LiteLLMCatalogSnapshot {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LiteLLMCatalogSnapshot>;
  return Array.isArray(row.models) && Array.isArray(row.errors);
}

// Re-apply the catalog's own rules to a snapshot restored from disk, so a cache
// written by a different build can never smuggle in a harness pairing the
// current rules would reject. A snapshot with NO admissions array predates the
// evidence format (or came from a gateway speaking the plain `harnesses`
// dialect); it keeps its declared harnesses, flagged unvetted, exactly as a
// fresh parse of that same config would.
function admittedSnapshot(value: LiteLLMCatalogSnapshot): LiteLLMCatalogSnapshot {
  const models = value.models.flatMap((model): LiteLLMModel[] => {
    // Missing OR empty: an older build persisted the legacy path as an empty
    // array, and treating that as "evidence exists, none passed" is what emptied
    // the picker on upgrade.
    if (!Array.isArray(model.admissions) || model.admissions.length === 0) {
      const harnesses = (model.harnesses ?? []).filter(
        (harness) =>
          harness === "claude"
          || harness === "codex"
          || harness === "prime",
      );
      return harnesses.length ? [{ ...model, harnesses, unvetted: true }] : [];
    }
    const admissions = model.admissions.filter((entry): entry is LiteLLMAdmissionEvidence =>
      !!entry
      && (
        entry.harness === "claude"
        || entry.harness === "codex"
        || entry.harness === "prime"
        || entry.harness === "kimi-code"
      )
      && (entry.status === "passed" || entry.status === "failed")
      && typeof entry.harnessVersion === "string"
      && !!entry.harnessVersion
      && typeof entry.testRevision === "string"
      && !!entry.testRevision
      && typeof entry.testedAt === "string"
      && Number.isFinite(Date.parse(entry.testedAt))
      && entry.requestedAlias === model.value
      && typeof entry.resolvedModel === "string"
      && !!entry.resolvedModel
    );
    const harnesses = [...new Set(
      admissions.filter((entry) => entry.status === "passed").map((entry) => entry.harness),
    )];
    // Evidence present: it decides, and the unvetted flag never survives.
    return harnesses.length ? [{ ...model, admissions, harnesses, unvetted: false }] : [];
  });
  return { ...value, models };
}

export function hydrateLiteLLMCatalog(): LiteLLMCatalogSnapshot {
  const saved = getSetting(SETTING_KEY);
  if (!saved) return getLiteLLMCatalog();
  try {
    const parsed: unknown = JSON.parse(saved);
    if (isSnapshot(parsed)) replaceLiteLLMCatalog(admittedSnapshot(parsed));
  } catch {
    // A corrupt cache must not prevent Operator from loading.
  }
  return getLiteLLMCatalog();
}

function markStale(error: string): void {
  const previous = getLiteLLMCatalog();
  const stale = { ...previous, stale: true, error };
  replaceLiteLLMCatalog(stale);
  if (previous.models.length) setSetting(SETTING_KEY, JSON.stringify(stale));
}

export async function refreshLiteLLMCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<LiteLLMCatalogSnapshot> {
  const infoUrl = `${LITELLM_BASE_URL.replace(/\/v1$/, "")}/model/info`;
  let response: Response;
  try {
    response = await fetchImpl(infoUrl, {
      headers: { Authorization: `Bearer ${LITELLM_API_KEY}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    markStale("LiteLLM gateway is unavailable");
    throw new Error("LiteLLM gateway is unavailable");
  }

  if (!response.ok) {
    const error = `LiteLLM model refresh failed with HTTP ${response.status}`;
    markStale(error);
    throw new Error(error);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    markStale("LiteLLM returned invalid JSON");
    throw new Error("LiteLLM returned invalid JSON");
  }

  const parsed = parseLiteLLMModelInfo(raw);
  if (!parsed.models.length) {
    const error = "LiteLLM returned no valid Operator-tagged models";
    markStale(error);
    throw new Error(error);
  }

  const snapshot: LiteLLMCatalogSnapshot = {
    ...parsed,
    refreshedAt: new Date().toISOString(),
    stale: false,
    error: null,
  };
  replaceLiteLLMCatalog(snapshot);
  setSetting(SETTING_KEY, JSON.stringify(snapshot));
  return getLiteLLMCatalog();
}
