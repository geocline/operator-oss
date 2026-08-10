/* Operator tool extension for Prime Agent.
 *
 * The Claude driver mounts the orchestrator tools as an in-process SDK MCP
 * server and the Codex driver spawns the stdio MCP bridge (scripts/orch-mcp.mjs).
 * Prime has neither surface: it loads extensions that call pi.registerTool().
 * This file is that third surface — a thin proxy that POSTs every tool call to
 * the app's internal endpoints (app/api/internal/agent-tools/*), which run the
 * SAME shared logic (lib/agentTools.ts) the other two bridges call.
 *
 * Per-turn wiring comes from env, injected by the Prime driver at spawn:
 *   ORCH_TASK_ID     the task this turn belongs to
 *   ORCH_PROJECT_ID  the owning project (tasks/services are created under it)
 *   ORCH_BASE_URL    the app's loopback origin (e.g. http://127.0.0.1:3000)
 *   SERVICE_TOKEN    the per-instance secret the internal endpoints require
 * It must NEVER receive LiteLLM or provider credentials — the Prime driver's
 * child env strips them (lib/agents/prime/policy.ts), and nothing in this file
 * may read or log any other secret.
 *
 * Tool names / descriptions / param docs come from lib/agentToolDefs.mjs so
 * the three surfaces never drift. Prime loads this TS source directly (jiti)
 * and virtualizes `@sinclair/typebox`; in this repo the same import resolves
 * to a devDependency so the contract tests can execute the handlers.
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import {
  SUGGEST_TASK,
  SUGGEST_TASK_DEPS_ENABLED,
  EXPOSE_SERVICE,
  PUBLISH_ARTIFACT,
  ASK_USER,
  PUBLISH_WORKSTREAM_UPDATE,
  PROPOSE_CARD_CHANGE,
} from "../lib/agentToolDefs.mjs";

// Minimal structural slice of Prime's extension surface — enough for
// registerTool() without depending on the prime-agent package at build time.
interface PrimeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
}

export interface PrimeRegisteredTool<TParams extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams> | Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<PrimeToolResult>;
}

export interface PrimeExtensionApi {
  registerTool(tool: PrimeRegisteredTool): void;
}

const text = (value: string): PrimeToolResult => ({
  content: [{ type: "text", text: value }],
  details: {},
});

export default function operatorExtension(pi: PrimeExtensionApi): void {
  const TASK_ID = process.env.ORCH_TASK_ID || "";
  const PROJECT_ID = process.env.ORCH_PROJECT_ID || "";
  const BASE_URL = (process.env.ORCH_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  // SERVICE_TOKEN travels in every tool call; it may only ever go to the
  // local Operator process. A misconfigured (or injected) non-loopback base
  // URL must fail closed rather than exfiltrate the instance secret.
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  {
    const host = new URL(BASE_URL).hostname;
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`ORCH_BASE_URL must be a loopback origin; got host "${host}"`);
    }
  }
  const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";
  const ASK_POLL_MS = Number(process.env.ORCH_ASK_POLL_MS || 1500);

  // Titles created this turn → their task ids, so `blocked_by` could reference
  // an earlier suggestion by title (mirrors both other bridges). One extension
  // instance lives exactly one Prime process, so the map is turn-scoped.
  const createdByTitle = new Map<string, string>();

  /** POST a tool call to an internal endpoint; return its JSON (thrown on error). */
  async function callInternal(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/internal/agent-tools/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
        body: JSON.stringify({ projectId: PROJECT_ID, taskId: TASK_ID, ...payload }),
      });
    } catch (e) {
      throw new Error(`orchestrator unreachable at ${BASE_URL}: ${(e as Error)?.message || e}`);
    }
    let data: Record<string, any> | null = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body (e.g. a 403 text) — handled below */
    }
    if (!res.ok) throw new Error((data && data.error) || `orchestrator returned ${res.status}`);
    return data ?? {};
  }

  pi.registerTool({
    name: EXPOSE_SERVICE.name,
    label: "Expose service",
    description: EXPOSE_SERVICE.description,
    parameters: Type.Object({
      name: Type.String({ description: EXPOSE_SERVICE.params.name }),
      port: Type.Integer({ minimum: 1, description: EXPOSE_SERVICE.params.port }),
    }),
    async execute(_id, params) {
      const { name, port } = params as { name: string; port: number };
      const data = await callInternal("expose-service", { name, port });
      return text(data.text);
    },
  });

  pi.registerTool({
    name: SUGGEST_TASK.name,
    label: "Suggest task",
    description: SUGGEST_TASK.description,
    parameters: Type.Object({
      title: Type.String({ description: SUGGEST_TASK.params.title }),
      description: Type.String({ description: SUGGEST_TASK.params.description }),
      priority: Type.Optional(
        Type.Union(SUGGEST_TASK.priorities.map((p: string) => Type.Literal(p)), {
          description: SUGGEST_TASK.params.priority,
          default: SUGGEST_TASK.defaultPriority,
        }),
      ),
      ...(SUGGEST_TASK_DEPS_ENABLED
        ? { blocked_by: Type.Optional(Type.Array(Type.String(), { description: SUGGEST_TASK.params.blocked_by })) }
        : {}),
    }),
    async execute(_id, params) {
      const { title, description, priority, blocked_by } = params as {
        title: string;
        description: string;
        priority?: string;
        blocked_by?: string[];
      };
      // Resolve refs (id passes through; a title from earlier this turn → its
      // id). With dependencies disabled nothing is ever sent.
      const deps = SUGGEST_TASK_DEPS_ENABLED
        ? (blocked_by ?? []).map((ref) => createdByTitle.get(ref) ?? ref)
        : [];
      const data = await callInternal("suggest-task", {
        title,
        description,
        priority: priority ?? SUGGEST_TASK.defaultPriority,
        blocked_by: deps,
      });
      if (data.id) createdByTitle.set(title, data.id);
      return text(data.text);
    },
  });

  pi.registerTool({
    name: PUBLISH_ARTIFACT.name,
    label: "Publish artifact",
    description: PUBLISH_ARTIFACT.description,
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: PUBLISH_ARTIFACT.params.path }),
      title: Type.Optional(Type.String({ description: PUBLISH_ARTIFACT.params.title })),
    }),
    async execute(_id, params) {
      const { path, title } = params as { path: string; title?: string };
      const data = await callInternal("publish-artifact", {
        path,
        ...(title ? { title } : {}),
      });
      return text(data.text);
    },
  });

  pi.registerTool({
    name: ASK_USER.name,
    label: "Ask the user",
    description: ASK_USER.description,
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "The full question to ask the user." }),
          header: Type.Optional(Type.String({ maxLength: 24, description: "Short chip label for the question." })),
          multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing more than one option." })),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.Optional(Type.String()),
            }),
            { minItems: 1, maxItems: 8, description: "2-4 choices work best. The user can always type a free-text answer too." },
          ),
        }),
        { minItems: 1, maxItems: 4, description: ASK_USER.params.questions },
      ),
    }),
    async execute(_id, params, signal) {
      // Start the ask (persists + publishes the interactive card), then poll
      // for the outcome. Polling instead of one held request: the user may
      // take hours, and the ask survives page reloads server-side.
      const { questions } = params as { questions: unknown };
      const { askId } = await callInternal("ask-user", { questions });
      const deadline = Date.now() + 24 * 60 * 60 * 1000; // mirror the other bridges' ~1-day cap
      for (;;) {
        if (signal?.aborted) throw new Error("ask_user aborted");
        await new Promise((r) => setTimeout(r, ASK_POLL_MS));
        const r = await callInternal("ask-user/wait", { askId });
        if (r.status === "done") return text(r.text);
        if (Date.now() > deadline) {
          return text("The user did not answer the question. Proceed with your best judgment.");
        }
      }
    },
  });

  pi.registerTool({
    name: PUBLISH_WORKSTREAM_UPDATE.name,
    label: "Publish workstream update",
    description: PUBLISH_WORKSTREAM_UPDATE.description,
    parameters: Type.Object({
      body: Type.String({ minLength: 1, maxLength: 20_000, description: PUBLISH_WORKSTREAM_UPDATE.params.body }),
      files: Type.Optional(
        Type.Array(Type.String(), { maxItems: 5, description: PUBLISH_WORKSTREAM_UPDATE.params.files }),
      ),
    }),
    async execute(_id, params) {
      const { body, files } = params as { body: string; files?: string[] };
      const data = await callInternal("publish-workstream-update", {
        body,
        ...(files ? { files } : {}),
      });
      return text(data.text);
    },
  });

  pi.registerTool({
    name: PROPOSE_CARD_CHANGE.name,
    label: "Propose card change",
    description: PROPOSE_CARD_CHANGE.description,
    parameters: Type.Object({
      kind: Type.Union(PROPOSE_CARD_CHANGE.kinds.map((k: string) => Type.Literal(k)), {
        description: PROPOSE_CARD_CHANGE.params.kind,
      }),
      value: Type.Record(Type.String(), Type.Unknown(), {
        description: PROPOSE_CARD_CHANGE.params.value,
      }),
    }),
    async execute(_id, params) {
      const { kind, value } = params as { kind: string; value: Record<string, unknown> };
      const data = await callInternal("propose-card-change", { kind, value });
      return text(data.text);
    },
  });
}
