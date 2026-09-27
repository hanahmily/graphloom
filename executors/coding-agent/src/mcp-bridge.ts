import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CodingTool } from "./harness.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 32_000;

export interface ToolBridge {
  /** Streamable-HTTP MCP endpoint on the loopback interface. */
  url: string;
  /** Bearer token the agent must present; fresh per bridge. */
  token: string;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A minimal MCP server (streamable HTTP, JSON responses) that exposes graph
 * tools to an external agent process. Each `tools/call` goes to the tool's
 * controller-mediated `call`, and the recorded result is returned as text.
 */
export async function startToolBridge(tools: CodingTool[], callId: () => string): Promise<ToolBridge> {
  const token = randomBytes(24).toString("hex");
  const byName = new Map(tools.map((t) => [t.name, t]));
  // The controller takes one tool call at a time, but the agent may send several at once.
  let pending: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(call: () => Promise<T>): Promise<T> => {
    const next = pending.then(call, call);
    pending = next;
    return next;
  };

  async function handle(req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "graphloom", version: "1" },
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? `GraphLoom ${t.effect} tool ${t.name}. The controller records each call.`,
            inputSchema: { type: "object", additionalProperties: true },
          })),
        };
      case "tools/call": {
        const name = req.params?.name;
        const tool = typeof name === "string" ? byName.get(name) : undefined;
        if (!tool) throw Object.assign(new Error(`unknown tool ${String(name)}`), { code: -32602 });
        const result = await oneAtATime(() => tool.call(callId(), req.params?.arguments ?? {}));
        const text = JSON.stringify(result);
        return {
          content: [{ type: "text", text: text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…` }],
          isError: result.status !== "ok",
        };
      }
      default:
        throw Object.assign(new Error(`method not found: ${String(req.method)}`), { code: -32601 });
    }
  }

  async function respond(req: JsonRpcRequest): Promise<unknown> {
    try {
      return { jsonrpc: "2.0", id: req.id ?? null, result: await handle(req) };
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -32603;
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const batch = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
    const requests = batch.filter((r) => r !== null && typeof r === "object" && r.id !== undefined && r.method !== undefined);
    if (requests.length === 0) {
      response.writeHead(202).end();
      return;
    }
    const replies = await Promise.all(requests.map(respond));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
