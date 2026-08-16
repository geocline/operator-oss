// Subscription-only model families that must never be reachable over a
// LiteLLM/gateway route (Geo's hard rule). Anthropic and OpenAI models are
// billed through the user's own Claude/Codex subscription login; routing them
// through the LiteLLM relay instead would silently switch billing and bypass
// the connected-agent auth the rest of the app relies on.
//
// Shared by lib/agents/litellm/capabilities.ts (excludes them from every
// LiteLLM harness's model list) and lib/agents/litellm/catalog.ts's
// modelForHarness (belt-and-suspenders: a hand-edited tasks.model row can't
// route to them either, even if a misconfigured gateway catalog offers one).
// Kept in its own module (no imports) so both sides can depend on it without
// creating a cycle between capabilities.ts and catalog.ts.

const ANTHROPIC_FAMILY = /^(claude|anthropic\/)/i;
// "o[0-9]" (not "o[0-9]*") deliberately requires a digit right after the "o" -
// matches o1/o3-mini, not Prime's "operator.*" aliases.
const OPENAI_FAMILY = /^(gpt|o[0-9]|openai\/|codex)/i;

export function isSubscriptionOnlyModelId(id: string): boolean {
  const value = id.trim();
  if (!value) return false;
  return ANTHROPIC_FAMILY.test(value) || OPENAI_FAMILY.test(value);
}
