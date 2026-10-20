/**
 * Child-process worker for executor packages (built-in or user-authored).
 *
 * Protocol (one JSON object per line on stdin/stdout, one execute per process):
 *   → { kind: "describe" }                                  ← { kind: "described", executors: [{ id, version?, effect, inputShape? }] }
 *   → { kind: "check", id, version?, effect?, input, allowedEffects? } ← { kind: "checked", refusal? }
 *   → { kind: "execute", id, version?, effect?, input, ctx, credentials?, allowedEffects?, tools?, usage? }
 *   ← { kind: "tool_call", seq, toolCallId, tool, input }   → { kind: "tool_result", seq, result }
 *   ← { kind: "model_call", seq }                           → { kind: "model_call_result", seq, granted }
 *   ← { kind: "ok", output } | { kind: "error", message }
 *   SIGTERM stops the job: `ctx.signal` aborts and unanswered requests are refused.
 *
 * Entry module must export `executors` as an array of ExecutorDefinition
 * (from defineExecutor). The parent never imports executor code, so the pinned
 * version, granted effect, and input/output schemas are enforced here. Tool
 * calls and model reservations are serviced by the controller while the
 * executor waits.
 */
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const entry = process.argv[2];
if (!entry) {
  process.stderr.write("executor-worker: missing entry module path\n");
  process.exit(2);
}

const mod = await import(pathToFileURL(entry).href);
const list = Array.isArray(mod.executors)
  ? mod.executors
  : mod.default?.executors;
if (!Array.isArray(list)) {
  process.stderr.write("executor-worker: entry must export executors[]\n");
  process.exit(2);
}

const byId = new Map();
for (const def of list) {
  if (def && typeof def.id === "string" && typeof def.execute === "function") {
    byId.set(def.id, def);
  }
}

function reply(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function refusal(def: {
  id: string;
  version?: string;
  effect?: string;
  inputSchema?: (v: unknown) => boolean;
  inputProblem?: (v: unknown) => string | undefined;
}, req: { version?: unknown; effect?: unknown; allowedEffects?: unknown; input?: unknown }): string | undefined {
  if (req.version !== undefined && req.version !== def.version) {
    return `executor ${def.id} pinned version ${String(req.version)} but installed ${def.version ?? "(unversioned)"}`;
  }
  if (req.effect !== undefined && req.effect !== def.effect) {
    return `executor ${def.id} effect ${String(def.effect)} does not match declared ${String(req.effect)}`;
  }
  if (Array.isArray(req.allowedEffects) && !req.allowedEffects.includes(def.effect)) {
    return `executor ${def.id} effect ${String(def.effect)} is not granted`;
  }
  if (def.inputSchema && !def.inputSchema(req.input)) {
    let problem: string | undefined;
    try {
      problem = def.inputProblem?.(req.input);
    } catch {
      problem = undefined;
    }
    return `executor ${def.id}: input failed schema validation${problem ? `: ${problem}` : ""}`;
  }
  return undefined;
}

/** A declared input shape that serializes within the bound, or undefined: one bad shape must not lose the whole reply. */
function wireShape(shape: unknown): unknown {
  if (shape === null || typeof shape !== "object" || Array.isArray(shape)) return undefined;
  const schema = (shape as { schema?: unknown }).schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  try {
    const raw = JSON.stringify(shape);
    return raw !== undefined && Buffer.byteLength(raw, "utf8") <= 8_192 ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

let seq = 0;
const waiting = new Map<number, (value: unknown) => void>();

// The host stops a job with SIGTERM: the executor's signal aborts so it can stop
// what it started, and requests the host will no longer answer are refused.
const abort = new AbortController();
process.on("SIGTERM", () => {
  abort.abort();
  for (const [id, resolve] of waiting) {
    waiting.delete(id);
    resolve(undefined);
  }
});

function request(message: Record<string, unknown>): Promise<unknown> {
  seq += 1;
  const id = seq;
  if (abort.signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    reply({ ...message, seq: id });
  });
}

async function execute(req: Record<string, any>): Promise<void> {
  const def = byId.get(req.id);
  if (!def) {
    reply({ kind: "error", message: `unknown executor ${req.id}` });
    return;
  }
  const refused = refusal(def, req);
  if (refused) {
    reply({ kind: "error", message: refused });
    return;
  }
  const credentials: Record<string, string> =
    req.credentials && typeof req.credentials === "object" ? req.credentials : {};
  const ctx: Record<string, unknown> = {
    ...(req.ctx ?? {}),
    signal: abort.signal,
    credentials: {
      async get(name: string) {
        return Object.hasOwn(credentials, name) ? credentials[name] : undefined;
      },
    },
  };
  if (Array.isArray(req.tools)) {
    ctx.tools = {
      bindings: req.tools,
      call: async (call: { toolCallId: string; tool: string; input: unknown }) =>
        (await request({ kind: "tool_call", toolCallId: call.toolCallId, tool: call.tool, input: call.input })) ?? {
          status: "failed",
          summary: "executor stopped before the tool call was answered",
        },
    };
  }
  if (req.usage === true) {
    ctx.usage = {
      reserveModelCall: async () => (await request({ kind: "model_call" })) === true,
    };
  }
  try {
    const output = await def.execute(req.input, ctx);
    if (def.outputSchema && !def.outputSchema(output)) {
      reply({ kind: "error", message: `executor ${def.id}: output failed schema validation` });
      return;
    }
    reply({ kind: "ok", output });
  } catch (err) {
    reply({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

let running: Promise<void> | undefined;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    reply({ kind: "error", message: "malformed request JSON" });
    continue;
  }
  if (msg?.kind === "tool_result" || msg?.kind === "model_call_result") {
    const resolve = waiting.get(msg.seq);
    waiting.delete(msg.seq);
    resolve?.(msg.kind === "tool_result" ? msg.result : msg.granted);
    continue;
  }
  if (msg?.kind === "describe") {
    reply({
      kind: "described",
      executors: [...byId.values()].map((d) => ({ id: d.id, version: d.version, effect: d.effect, inputShape: wireShape(d.inputShape) })),
    });
    continue;
  }
  if (msg?.kind === "check" && typeof msg.id === "string") {
    // The refusal execute would give, without executing: lets the host reject
    // a job before admitting it.
    const def = byId.get(msg.id);
    const refused = def ? refusal(def, msg) : `unknown executor ${msg.id}`;
    reply({ kind: "checked", ...(refused !== undefined ? { refusal: refused } : {}) });
    continue;
  }
  if (msg?.kind !== "execute" || typeof msg.id !== "string" || running !== undefined) {
    reply({ kind: "error", message: "expected one execute request" });
    continue;
  }
  // Not awaited here: the loop must keep reading tool and model replies.
  running = execute(msg);
}
// The host closes stdin once it needs no more replies; finish the execute before exiting.
await running;
