import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createLiteLLMRelay, type LiteLLMRelay } from "@/lib/agents/litellm/relay";

const listen = (server: http.Server) => new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  });
});

describe("LiteLLM credential relay", () => {
  let relay: LiteLLMRelay | null = null;
  let upstream: http.Server | null = null;

  afterEach(async () => {
    await relay?.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    relay = null;
    upstream = null;
  });

  it("forwards requests with the real gateway credential while accepting a harmless child token", async () => {
    let authorization = "";
    let requestPath = "";
    let body = "";
    upstream = http.createServer((req, res) => {
      authorization = String(req.headers.authorization || "");
      requestPath = req.url || "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    const port = await listen(upstream);
    relay = await createLiteLLMRelay({
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      gatewayToken: "real-gateway-secret",
    });

    const response = await fetch(`${relay.baseUrl}/responses?mode=test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relay.childApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "operator.frontier" }),
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(authorization).toBe("Bearer real-gateway-secret");
    expect(requestPath).toBe("/v1/responses?mode=test");
    expect(JSON.parse(body)).toEqual({ model: "operator.frontier" });
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(relay.childApiKey).toBe("operator-loopback-relay");
  });

  it("rejects non-v1 paths and redacts upstream bodies on failure", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"secret":"provider detail"}');
    });
    const port = await listen(upstream);
    relay = await createLiteLLMRelay({
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      gatewayToken: "real-gateway-secret",
    });

    expect((await fetch(relay.baseUrl.replace(/\/v1$/, "/admin"))).status).toBe(404);
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"secret":"provider detail"}');
  });

  it("proxies Responses WebSocket upgrades with the real gateway credential", async () => {
    let authorization = "";
    let requestPath = "";
    const upstreamSockets = new WebSocketServer({ noServer: true });
    upstream = http.createServer();
    upstream.on("upgrade", (request, socket, head) => {
      authorization = String(request.headers.authorization || "");
      requestPath = request.url || "";
      upstreamSockets.handleUpgrade(request, socket, head, (websocket) => {
        websocket.on("message", (data) => websocket.send(`upstream:${data.toString()}`));
      });
    });
    const port = await listen(upstream);
    relay = await createLiteLLMRelay({
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      gatewayToken: "real-gateway-secret",
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket relay timed out")), 2_000);
      const websocket = new WebSocket(
        `${relay!.baseUrl.replace(/^http/, "ws")}/responses?mode=test`,
        { headers: { Authorization: `Bearer ${relay!.childApiKey}` } },
      );
      websocket.once("open", () => websocket.send("ping"));
      websocket.once("message", (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
        websocket.close();
      });
      websocket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(reply).toBe("upstream:ping");
    expect(authorization).toBe("Bearer real-gateway-secret");
    expect(requestPath).toBe("/v1/responses?mode=test");
    upstreamSockets.close();
  });
});
