/**
 * Child-process worker for executor packages (built-in or user-authored).
 *
 * Protocol (one JSON object per line on stdin/stdout, one execute per process):
 *   → { kind: "execute", id, version?, effect?, input, ctx, credentials?, allowedEffects?, tools?, usage? }
 *   ← { kind: "tool_call", seq, toolCallId, tool, input }   → { kind: "tool_result", seq, result }
 *   ← { kind: "model_call", seq }                           → { kind: "model_call_result", seq, granted }
 *   ← { kind: "ok", output } | { kind: "error", message }
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
    return `executor ${def.id}: input failed schema validation`;
  }
  return undefined;
}

let seq = 0;
const waiting = new Map<number, (value: unknown) => void>();

function request(message: Record<string, unknown>): Promise<unknown> {
  seq += 1;
  const id = seq;
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
    credentials: {
      async get(name: string) {
        return Object.hasOwn(credentials, name) ? credentials[name] : undefined;
      },
    },
  };
  if (Array.isArray(req.tools)) {
    ctx.tools = {
      bindings: req.tools,
      call: (call: { toolCallId: string; tool: string; input: unknown }) =>
        request({ kind: "tool_call", toolCallId: call.toolCallId, tool: call.tool, input: call.input }),
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

let started = false;
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
  if (msg?.kind !== "execute" || typeof msg.id !== "string" || started) {
    reply({ kind: "error", message: "expected one execute request" });
    continue;
  }
  started = true;
  void execute(msg);
}
