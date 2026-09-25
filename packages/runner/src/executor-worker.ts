/**
 * Child-process worker for executor packages (built-in or user-authored).
 *
 * Protocol (one JSON object per line on stdin/stdout):
 *   → { kind: "execute", id, version?, input, ctx, credentials?, allowedEffects? }
 *   ← { kind: "ok", output } | { kind: "error", message }
 *
 * Entry module must export `executors` as an array of ExecutorDefinition
 * (from defineExecutor). The parent never imports executor code, so the pinned
 * version, granted effect, and input/output schemas are enforced here.
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
}, req: { version?: unknown; allowedEffects?: unknown; input?: unknown }): string | undefined {
  if (req.version !== undefined && req.version !== def.version) {
    return `executor ${def.id} pinned version ${String(req.version)} but installed ${def.version ?? "(unversioned)"}`;
  }
  if (Array.isArray(req.allowedEffects) && !req.allowedEffects.includes(def.effect)) {
    return `executor ${def.id} effect ${String(def.effect)} is not granted`;
  }
  if (def.inputSchema && !def.inputSchema(req.input)) {
    return `executor ${def.id}: input failed schema validation`;
  }
  return undefined;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    reply({ kind: "error", message: "malformed request JSON" });
    continue;
  }
  if (req?.kind !== "execute" || typeof req.id !== "string") {
    reply({ kind: "error", message: "expected execute request" });
    continue;
  }
  const def = byId.get(req.id);
  if (!def) {
    reply({ kind: "error", message: `unknown executor ${req.id}` });
    continue;
  }
  const refused = refusal(def, req);
  if (refused) {
    reply({ kind: "error", message: refused });
    continue;
  }
  const credentials: Record<string, string> =
    req.credentials && typeof req.credentials === "object" ? req.credentials : {};
  const ctx = {
    ...(req.ctx ?? {}),
    credentials: {
      async get(name: string) {
        return Object.hasOwn(credentials, name) ? credentials[name] : undefined;
      },
    },
  };
  try {
    const output = await def.execute(req.input, ctx);
    if (def.outputSchema && !def.outputSchema(output)) {
      reply({ kind: "error", message: `executor ${def.id}: output failed schema validation` });
      continue;
    }
    reply({ kind: "ok", output });
  } catch (err) {
    reply({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
