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
  /** The response body exactly as received. */
  body: string;
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
  agent.streamFunction = (model, context, options) =>
    original(model, context, { ...options, fetch: capturingFetch(file, () => (seq += 1), options?.fetch) });
}

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
    void new Response(forLog)
      .text()
      .then((body) => writeRecord(file, { at: new Date().toISOString(), seq, url, method, status: response.status, request, ...summarize(body), body }))
      .catch(() => undefined);
    return new Response(forPi, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
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

async function writeRecord(file: string, record: RawStreamRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}
