import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { LITELLM_API_KEY, LITELLM_BASE_URL } from "../../config";

export interface LiteLLMRelay {
  baseUrl: string;
  childApiKey: "operator-loopback-relay";
  generationIds(): string[];
  close(): Promise<void>;
}

type RelayOptions = {
  upstreamBaseUrl: string;
  gatewayToken: string;
};

const CHILD_KEY = "operator-loopback-relay" as const;
const GENERATION_ID = /\bgen-[A-Za-z0-9_-]{8,}\b/g;

export async function createLiteLLMRelay(options: RelayOptions): Promise<LiteLLMRelay> {
  const upstreamRoot = options.upstreamBaseUrl.replace(/\/v1\/?$/, "");
  const upstreamWebSocketRoot = upstreamRoot
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  const websocketServer = new WebSocketServer({ noServer: true });
  const websocketPairs = new Set<[WebSocket, WebSocket]>();
  const generationIds = new Set<string>();
  let generationTail = "";
  const captureGenerationIds = (value: Uint8Array | string) => {
    const text = typeof value === "string"
      ? value
      : Buffer.from(value).toString("utf8");
    const searchable = `${generationTail}${text}`;
    for (const match of searchable.matchAll(GENERATION_ID)) {
      generationIds.add(match[0]);
    }
    generationTail = searchable.slice(-128);
  };
  const server = http.createServer(async (request, response) => {
    const requestPath = request.url || "/";
    if (!requestPath.startsWith("/v1/")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }

    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !["host", "authorization", "connection", "content-length"].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      headers.set("Authorization", `Bearer ${options.gatewayToken}`);

      const init: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(24 * 60 * 60 * 1000),
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request as unknown as BodyInit;
        init.duplex = "half";
      }

      const upstream = await fetch(`${upstreamRoot}${requestPath}`, init);
      const outgoing: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!["connection", "transfer-encoding", "content-length"].includes(name)) outgoing[name] = value;
      });
      response.writeHead(upstream.status, outgoing);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          captureGenerationIds(value);
          response.write(value);
        }
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/json" });
      response.end('{"error":"LiteLLM gateway unavailable"}');
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const requestPath = request.url || "/";
    if (!requestPath.startsWith("/v1/")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (client) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined
          && ![
            "host",
            "authorization",
            "connection",
            "upgrade",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
            "sec-websocket-protocol",
          ].includes(name)
        ) {
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
      }
      headers.Authorization = `Bearer ${options.gatewayToken}`;
      const requestedProtocols = String(request.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean);
      const upstream = new WebSocket(
        `${upstreamWebSocketRoot}${requestPath}`,
        requestedProtocols,
        { headers },
      );
      const pair: [WebSocket, WebSocket] = [client, upstream];
      websocketPairs.add(pair);
      const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

      client.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, isBinary });
      });
      upstream.on("open", () => {
        for (const message of pending) {
          upstream.send(message.data, { binary: message.isBinary });
        }
        pending.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        if (!isBinary) captureGenerationIds(data.toString());
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on("close", (code, reason) => {
        websocketPairs.delete(pair);
        if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      });
      upstream.on("close", (code, reason) => {
        websocketPairs.delete(pair);
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      });
      client.on("error", () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close(1011, "relay client error");
        else upstream.terminate();
      });
      upstream.on("error", () => {
        if (client.readyState === WebSocket.OPEN) client.close(1011, "gateway unavailable");
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    childApiKey: CHILD_KEY,
    generationIds: () => [...generationIds],
    close: () => new Promise<void>((resolve, reject) => {
      for (const [client, upstream] of websocketPairs) {
        client.terminate();
        upstream.terminate();
      }
      websocketPairs.clear();
      websocketServer.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const globalRelay = globalThis as typeof globalThis & {
  __operatorLiteLLMRelay?: Promise<LiteLLMRelay>;
};

export function getLiteLLMRelay(): Promise<LiteLLMRelay> {
  globalRelay.__operatorLiteLLMRelay ??= createLiteLLMRelay({
    upstreamBaseUrl: LITELLM_BASE_URL,
    gatewayToken: LITELLM_API_KEY,
  });
  return globalRelay.__operatorLiteLLMRelay;
}
