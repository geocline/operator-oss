import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Smoke test for the portable stdio MCP bridge (scripts/orch-mcp.mjs). We stand
// up a tiny fake "app" HTTP server that records the internal calls the bridge
// makes and returns canned tool text, spawn the real bridge over stdio, and
// drive it with the MCP client SDK — the same protocol Codex speaks to it.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orch-mcp.mjs");

interface Received {
  path: string;
  token: string | undefined;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl: string;
const calls: Received[] = [];
let nextId = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url || "", token: req.headers["x-service-token"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/suggest-task")) {
        const id = `id-${nextId++}`;
        res.end(JSON.stringify({ ok: true, id, title: body.title, text: `Suggested "${body.title}" (id: ${id}).` }));
      } else if (req.url?.endsWith("/expose-service")) {
        const url = `http://localhost:${body.port}`;
        res.end(JSON.stringify({ ok: true, name: body.name, url, text: `Registered "${body.name}" at ${url}.` }));
      } else if (req.url?.endsWith("/publish-workstream-update")) {
        res.end(JSON.stringify({ ok: true, status: "delivered", text: "Update delivered." }));
      } else if (req.url?.endsWith("/propose-card-change")) {
        res.end(JSON.stringify({ ok: true, status: "delivered", text: "Proposal queued for review." }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connectBridge() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: {
      ORCH_TASK_ID: "task-xyz",
      ORCH_PROJECT_ID: "proj-abc",
      ORCH_BASE_URL: baseUrl,
      SERVICE_TOKEN: "smoke-token",
      PATH: process.env.PATH || "",
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe("orch-mcp stdio bridge", () => {
  it("exposes the portable workstream tools over stdio without identity parameters", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "ask_user",
        "expose_service",
        "propose_card_change",
        "publish_workstream_update",
        "suggest_task",
      ]);
      // Descriptions come from the shared defs — sanity check they're populated.
      expect(tools.find((t) => t.name === "suggest_task")?.description).toContain("Suggested tray");
      const forbidden = [
        "author",
        "agent",
        "session",
        "source",
        "card_id",
        "cardId",
        "workstream_id",
        "workstreamId",
      ];
      for (const name of ["publish_workstream_update", "propose_card_change"]) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
          properties?: Record<string, unknown>;
        };
        expect(schema?.properties).toBeTruthy();
        expect(Object.keys(schema.properties ?? {})).not.toEqual(
          expect.arrayContaining(forbidden),
        );
      }
    } finally {
      await close();
    }
  });

  it("proxies suggest_task with project/task/token and resolves title refs", async () => {
    calls.length = 0;
    nextId = 0;
    const { client, close } = await connectBridge();
    try {
      const r1 = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "First", description: "do first", priority: "hi" },
      })) as { content: { type: string; text: string }[] };
      expect(r1.content[0].text).toContain("id-0");

      // Reference the first task BY TITLE — the bridge should resolve it to id-0.
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Second", description: "do second", blocked_by: ["First"] },
      });

      const first = calls.find((c) => c.body.title === "First")!;
      expect(first.path).toBe("/api/internal/agent-tools/suggest-task");
      expect(first.token).toBe("smoke-token");
      expect(first.body).toMatchObject({ projectId: "proj-abc", taskId: "task-xyz", priority: "hi" });

      const second = calls.find((c) => c.body.title === "Second")!;
      expect(second.body.blocked_by).toEqual(["id-0"]);
    } finally {
      await close();
    }
  });

  it("proxies expose_service and returns the URL text", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({
        name: "expose_service",
        arguments: { name: "dev", port: 4300 },
      })) as { content: { type: string; text: string }[] };
      expect(res.content[0].text).toContain("http://localhost:4300");
      const call = calls.find((c) => c.path.endsWith("/expose-service"))!;
      expect(call.body).toMatchObject({ projectId: "proj-abc", name: "dev", port: 4300 });
      expect(call.token).toBe("smoke-token");
    } finally {
      await close();
    }
  });

  it("proxies a workstream update using only the bridge-injected task and project scope", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({
        name: "publish_workstream_update",
        arguments: {
          body: "The review is complete and the revised summary is ready.",
          files: ["deliverables/revised-summary.pdf"],
        },
      })) as { content: { type: string; text: string }[] };
      expect(res.content[0].text).toBe("Update delivered.");
      const call = calls.find((item) =>
        item.path.endsWith("/publish-workstream-update"),
      )!;
      expect(call.token).toBe("smoke-token");
      expect(call.body).toEqual({
        projectId: "proj-abc",
        taskId: "task-xyz",
        body: "The review is complete and the revised summary is ready.",
        files: ["deliverables/revised-summary.pdf"],
      });
      expect(JSON.stringify(call.body)).not.toContain("author");
      expect(JSON.stringify(call.body)).not.toContain("workstream");
    } finally {
      await close();
    }
  });

  it("proxies an allowlisted card proposal without accepting a target identity", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({
        name: "propose_card_change",
        arguments: {
          kind: "card_update",
          value: { due_date: "2026-08-20", priority: true },
        },
      })) as { content: { type: string; text: string }[] };
      expect(res.content[0].text).toBe("Proposal queued for review.");
      const call = calls.find((item) =>
        item.path.endsWith("/propose-card-change"),
      )!;
      expect(call.body).toEqual({
        projectId: "proj-abc",
        taskId: "task-xyz",
        kind: "card_update",
        value: { due_date: "2026-08-20", priority: true },
      });
    } finally {
      await close();
    }
  });
});
