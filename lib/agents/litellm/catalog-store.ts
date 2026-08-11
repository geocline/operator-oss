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

function admittedSnapshot(value: LiteLLMCatalogSnapshot): LiteLLMCatalogSnapshot {
  const models = value.models.flatMap((model): LiteLLMModel[] => {
    if (!Array.isArray(model.admissions)) return [];
    const admissions = model.admissions.filter((entry): entry is LiteLLMAdmissionEvidence =>
      !!entry
      && (entry.harness === "claude" || entry.harness === "codex" || entry.harness === "prime")
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
    return harnesses.length ? [{ ...model, admissions, harnesses }] : [];
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
