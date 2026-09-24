/**
 * Child-process worker for user-authored executors.
 *
 * Protocol (one JSON object per line on stdin/stdout):
 *   → { kind: "execute", id, input, ctx }
 *   ← { kind: "ok", output } | { kind: "error", message }
 *
 * Entry module must export `executors` as an array of ExecutorDefinition
 * (from defineExecutor). Schemas are not re-run here; the parent validates.
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

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", message: "malformed request JSON" })}\n`,
    );
    continue;
  }
  if (req?.kind !== "execute" || typeof req.id !== "string") {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", message: "expected execute request" })}\n`,
    );
    continue;
  }
  const def = byId.get(req.id);
  if (!def) {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", message: `unknown executor ${req.id}` })}\n`,
    );
    continue;
  }
  try {
    const output = await def.execute(req.input, req.ctx ?? {});
    process.stdout.write(`${JSON.stringify({ kind: "ok", output })}\n`);
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}
