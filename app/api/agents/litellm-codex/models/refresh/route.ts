import { NextResponse } from "next/server";
import { refreshLiteLLMCatalog } from "@/lib/agents/litellm/catalog-store";

export const dynamic = "force-dynamic";

export async function POST() {
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
