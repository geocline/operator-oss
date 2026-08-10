import { POST as genericRefresh } from "../../../[id]/models/refresh/route";

export const dynamic = "force-dynamic";

// Compatibility wrapper: the original litellm-codex-only refresh URL, kept
// working for existing callers (AgentConnect.tsx, SessionView.tsx) while they
// migrate to the generic per-driver route. Delegates to the same handler.
export async function POST(req: Request) {
  return genericRefresh(req, { params: Promise.resolve({ id: "litellm-codex" }) });
}
