import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { refreshLiteLLMCatalog } from "@/lib/agents/litellm/catalog-store";

export const dynamic = "force-dynamic";

// The generic "refresh this driver's managed model catalog" endpoint - the
// driver-agnostic replacement for the litellm-codex-only refresh route.
// Resolves strictly (unknown id -> 404, never falls back to the default
// agent) and requires the managed-endpoint login style before touching the
// shared LiteLLM catalog, so a request against e.g. "claude" fails loudly
// instead of silently refreshing the wrong thing.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) {
    return NextResponse.json({ error: `unknown agent "${id}"` }, { status: 404 });
  }
  if (driver.capabilities.loginStyle !== "managed_endpoint") {
    return NextResponse.json(
      { error: `agent "${id}" has no managed model catalog to refresh` },
      { status: 400 },
    );
  }
  try {
    const snapshot = await refreshLiteLLMCatalog();
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "LiteLLM refresh failed" },
      { status: 502 },
    );
  }
}
