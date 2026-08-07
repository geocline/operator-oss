import http from "node:http";
import { LITELLM_API_KEY, LITELLM_BASE_URL } from "../../config";

export interface LiteLLMRelay {
  baseUrl: string;
  childApiKey: "operator-loopback-relay";
  close(): Promise<void>;
}

type RelayOptions = {
  upstreamBaseUrl: string;
  gatewayToken: string;
};

const CHILD_KEY = "operator-loopback-relay" as const;

export async function createLiteLLMRelay(options: RelayOptions): Promise<LiteLLMRelay> {
  const upstreamRoot = options.upstreamBaseUrl.replace(/\/v1\/?$/, "");
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
          response.write(value);
        }
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/json" });
      response.end('{"error":"LiteLLM gateway unavailable"}');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    childApiKey: CHILD_KEY,
    close: () => new Promise<void>((resolve, reject) => {
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
