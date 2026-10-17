import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Content block types Pi's Anthropic-messages parser turns into message content. */
const KNOWN_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/** One provider request and the raw bytes of its response, as the supervisor saw them. */
export interface RawStreamRecord {
  at: string;
  seq: number;
  url: string;
  method: string;
  status: number;
  /** The request payload (model, messages, tools, thinking). Headers, which carry credentials, are never recorded. */
  request: unknown;
  /** `content_block` types the stream carried, in order. */
  blockTypes: string[];
  /** Block types Pi's parser does not turn into content: they are dropped from the message silently. */
  unknownBlockTypes: string[];
  /** `stop_reason` values the stream carried. */
  stopReasons: string[];
  /** The response body exactly as received (up to where reading failed, if it did). */
  body: string;
  /** Why reading the response stopped early, when it did; `body` then holds what arrived. */
  readError?: string;
}

/**
 * Record every provider request a Pi session makes, with its raw response,
 * as one JSON line per request in `<dir>/<sessionId>.raw.jsonl`. Opt-in
 * (`rawStreamCapture` in the supervisor config): it exists to show where a
 * model's output went when the recorded message does not contain it, which
 * Pi's own transcript cannot, since its parser silently skips content it does
 * not recognize. Request headers are never written.
 */
export function captureRawStream(session: AgentSession, dir: string): void {
  // pi-agent-core's Agent keeps the stream function it calls in `streamFunction`.
  const agent = (session as unknown as { agent: { streamFunction?: StreamFn } }).agent;
  const original = agent.streamFunction;
  if (typeof original !== "function") throw new Error("raw stream capture: this Pi version's agent has no streamFunction to wrap");
  const file = path.join(dir, `${session.sessionId}.raw.jsonl`);
  let seq = 0;
  const noted = new Set<string>();
  agent.streamFunction = (model, context, options) => {
    const api = (model as { api?: unknown } | undefined)?.api;
    if (typeof api !== "string" || !FETCH_CAPABLE_APIS.has(api)) {
      // Some Pi adapters (Google Generative AI, Google Vertex) reject a custom
      // fetch outright; capturing there would break the call itself. Leave
      // such requests untouched and say once that they are not captured.
      const key = String(api);
      if (!noted.has(key)) {
        noted.add(key);
        void writeLine(file, { at: new Date().toISOString(), note: `raw stream capture is not supported for api ${key}; its requests are not recorded` }).catch(() => undefined);
      }
      return original(model, context, options);
    }
    return original(model, context, {
      ...options,
      // Codex's adapter tries a WebSocket first and uses fetch only on its SSE
      // path; capture is a diagnostic mode, so it asks for SSE to be recorded.
      ...(SSE_ONLY_WHEN_CAPTURED.has(api) ? { transport: "sse" } : {}),
      fetch: capturingFetch(file, () => (seq += 1), options?.fetch),
    });
  };
}

/** APIs whose default transport bypasses fetch; capture selects their SSE transport. */
const SSE_ONLY_WHEN_CAPTURED: ReadonlySet<string> = new Set(["openai-codex-responses"]);

/**
 * Pi APIs whose adapters pass a per-request `fetch` through to their HTTP
 * client (checked against the pinned pi-ai: each reads `options.fetch`).
 * google-generative-ai and google-vertex read it only to throw.
 */
const FETCH_CAPABLE_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);

type StreamFn = (model: unknown, context: unknown, options?: { fetch?: typeof fetch } & Record<string, unknown>) => unknown;

function capturingFetch(file: string, next: () => number, inner: typeof fetch | undefined): typeof fetch {
  const base = inner ?? globalThis.fetch;
  return async (input, init) => {
    const response = await base(input, init);
    if (response.body === null) return response;
    const [forPi, forLog] = response.body.tee();
    const seq = next();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const request = parseBody(init?.body);
    void readAll(forLog)
      .then(({ body, readError }) =>
        writeLine(file, {
          at: new Date().toISOString(),
          seq,
          url,
          method,
          status: response.status,
          request,
          ...summarize(body),
          body,
          ...(readError !== undefined ? { readError } : {}),
        } satisfies RawStreamRecord),
      )
      .catch(() => undefined);
    return new Response(forPi, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Read a stream to its end, keeping what arrived if it fails part-way (a
 * dropped connection, or the supervisor aborting a stalled prompt): those are
 * exactly the requests a raw record is wanted for.
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ body: string; readError?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    return { body: body + decoder.decode() };
  } catch (err) {
    return { body: body + decoder.decode(), readError: err instanceof Error ? err.message : String(err) };
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body === undefined || body === null ? undefined : "(non-text body)";
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** Block types and stop reasons in an Anthropic-messages SSE body. */
export function summarize(body: string): Pick<RawStreamRecord, "blockTypes" | "unknownBlockTypes" | "stopReasons"> {
  const blockTypes: string[] = [];
  const stopReasons: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; content_block?: { type?: string }; delta?: { stop_reason?: string } };
    try {
      event = JSON.parse(line.slice(5).trim()) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "content_block_start" && typeof event.content_block?.type === "string") blockTypes.push(event.content_block.type);
    if (event.type === "message_delta" && typeof event.delta?.stop_reason === "string") stopReasons.push(event.delta.stop_reason);
  }
  return { blockTypes, unknownBlockTypes: [...new Set(blockTypes.filter((t) => !KNOWN_BLOCK_TYPES.has(t)))], stopReasons };
}

async function writeLine(file: string, line: RawStreamRecord | { at: string; note: string }): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}
