import { NextResponse } from "next/server";
import { listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { getSetting } from "@/lib/store";
import { getAgentConnection, getAgentAuthBroken } from "@/lib/agents/connections";
import { hydrateLiteLLMCatalog } from "@/lib/agents/litellm/catalog-store";
import type { AgentDriver } from "@/lib/agents/types";

export const dynamic = "force-dynamic";

// Every registered agent driver's capability descriptor + its persisted
// connection state, so the client can render the model/reasoning/permission
// pickers, gate per-agent features (asks, cost display), and gray out / show a
// "Connect" CTA for agents that aren't wired up yet — all from data, with no
// hardcoded per-agent lists in the UI. Connection state is read from the
// settings record (lib/agents/connections.ts), written on a successful login /
// verify / api-key save, rather than shelling out to every agent's CLI on each
// page load. `authenticated` mirrors `connected` for the run-control pickers.
export async function GET() {
  hydrateLiteLLMCatalog();
  const drivers = listDrivers();
  const byId = new Map(drivers.map((driver) => [driver.id, driver]));
  const publicDrivers = drivers.filter((driver) => driver.id !== "litellm-codex" && driver.id !== "litellm-claude");

  const publicDescriptor = (driver: AgentDriver) => {
    const gatewayId = driver.id === "claude"
      ? "litellm-claude"
      : driver.id === "codex"
        ? "litellm-codex"
        : null;
    const gateway = gatewayId ? byId.get(gatewayId) : null;
    const conn = getAgentConnection(driver.id);
    const managed = driver.capabilities.connectionStyle === "managed_endpoint";
    const managedConnected = managed && driver.capabilities.models.length > 0;
    const keyed = !!driver.apiKey?.has();
    const nativeConnected = managedConnected || keyed || !!conn;
    const gatewayModels = gateway?.capabilities.models.map((model) => ({
      ...model,
      driverId: gateway.id,
      authenticated: true,
      permissionValues: gateway.capabilities.permissionModes.map((mode) => mode.value),
    })) ?? [];
    const capabilities = gateway
      ? {
          ...driver.capabilities,
          models: [
            ...driver.capabilities.models.map((model) => ({
              ...model,
              authenticated: nativeConnected,
            })),
            ...gatewayModels,
          ],
          managedCatalogPath: gateway.capabilities.managedCatalogPath,
        }
      : driver.capabilities;

    const gatewayConnected = gatewayModels.length > 0;
    return {
      id: driver.id,
      label: driver.label,
      capabilities,
      connected: managedConnected || gatewayConnected || keyed || !!conn,
      authenticated: managedConnected || gatewayConnected || keyed || !!conn,
      account: managedConnected
        ? { email: null, plan: "LiteLLM", method: "managed_endpoint" as const }
        : keyed
        ? { email: null, plan: "API", method: "api_key" as const }
        : conn
          ? { email: conn.email, plan: conn.plan, method: conn.method }
          : null,
      authBroken: getAgentAuthBroken(driver.id),
    };
  };

  return NextResponse.json({
    // The app-level default agent (Settings → Run defaults) is the client's
    // ultimate fallback when a project hasn't set its own; unset → the built-in.
    default: getSetting("default_agent") === "litellm-codex"
      ? "codex"
      : getSetting("default_agent") === "litellm-claude"
        ? "claude"
        : getSetting("default_agent") || DEFAULT_AGENT,
    agents: publicDrivers.map(publicDescriptor),
  });
}
