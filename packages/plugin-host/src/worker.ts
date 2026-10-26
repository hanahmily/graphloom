// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Child worker: load a plugin entry and serve NDJSON wire requests on stdin/stdout.
 * Protocol uses a private stdout write; plugin console/stdout is diverted to stderr
 * so logs cannot interleave with NDJSON responses.
 */
import { Console } from "node:console";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  PROTOCOL_VERSION,
  WireValidationError,
  assertGraphDecision,
  assertGraphDefinition,
  assertGraphRehearsal,
  assertValidationResult,
  assertWireRequest,
  parseJsonBounded,
  type GraphPlugin,
  type GraphRehearsal,
  type Validator,
  type WireEnvelope,
  type WireResponse,
} from "@graphloom/sdk";

const protocolStdoutWrite = process.stdout.write.bind(process.stdout);

isolatePluginStdout();

async function main(): Promise<void> {
  const entry = process.argv[2];
  if (!entry) {
    writeError(baseEnvelope(), "internal", "worker requires entry module path");
    process.exit(1);
  }

  let plugin: GraphPlugin;
  let resolveValidator: (id: string) => Validator | undefined = () => undefined;
  try {
    const mod = (await import(pathToFileURL(entry).href)) as {
      createGraph?: () => GraphPlugin | Promise<GraphPlugin>;
      default?: GraphPlugin | (() => GraphPlugin | Promise<GraphPlugin>);
      validatorById?: (id: string) => Validator | undefined;
      exactGreetingValidator?: Validator;
      independentReviewValidator?: Validator;
    };
    if (typeof mod.createGraph === "function") {
      plugin = await mod.createGraph();
    } else if (typeof mod.default === "function") {
      plugin = await mod.default();
    } else if (mod.default && typeof mod.default === "object") {
      plugin = mod.default;
    } else {
      throw new Error("plugin entry must export createGraph() or default GraphPlugin");
    }
    resolveValidator = (id: string) =>
      mod.validatorById?.(id) ??
      (id === "exact-greeting" ? mod.exactGreetingValidator : undefined) ??
      (id === "independent-reviewer" ? mod.independentReviewValidator : undefined);
  } catch (err) {
    writeError(baseEnvelope(), "internal", `failed to load plugin: ${errorMessage(err)}`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let envelope: WireEnvelope = baseEnvelope();
    try {
      const raw = parseJsonBounded(line);
      const req = assertWireRequest(raw);
      envelope = {
        protocolVersion: PROTOCOL_VERSION,
        runId: req.runId,
        operationId: req.operationId,
        generation: req.generation,
        expectedStateRevision: req.expectedStateRevision,
        activeVersion: req.activeVersion,
        ...(req.recoveryEpisodeId !== undefined
          ? { recoveryEpisodeId: req.recoveryEpisodeId }
          : {}),
      };

      if (req.kind === "describe") {
        const definition = assertGraphDefinition(
          await Promise.resolve(req.config !== undefined ? plugin.describe(req.config) : plugin.describe()),
        );
        writeResponse({ ...envelope, kind: "describe_ok", definition });
        continue;
      }
      if (req.kind === "advance") {
        const decision = assertGraphDecision(await Promise.resolve(plugin.advance(req.view)));
        writeResponse({ ...envelope, kind: "advance_ok", decision });
        continue;
      }
      if (req.kind === "evaluate") {
        const validator = resolveValidator(req.validatorId);
        if (!validator) {
          writeError(envelope, "unknown", `validator not found: ${req.validatorId}`);
          continue;
        }
        const result = assertValidationResult(
          await Promise.resolve(validator.evaluate(req.input)),
        );
        writeResponse({ ...envelope, kind: "evaluate_ok", result });
        continue;
      }
      if (req.kind === "rehearsal") {
        const rehearsal = await loadRehearsalExport(req.entry, req.config);
        writeResponse({ ...envelope, kind: "rehearsal_ok", ...(rehearsal !== undefined ? { rehearsal } : {}) });
        continue;
      }
      writeError(envelope, "unknown", "unsupported request kind");
    } catch (err: unknown) {
      // parseJsonBounded/assertWireRequest can throw before envelope is set from
      // the real request (oversized, malformed), leaving it as baseEnvelope()'s
      // empty runId. The parent's own wire validation then rejects that error
      // response too, masking the real cause behind a confusing "malformed"
      // failure. Recover what we can from the raw line so the error we send
      // back still names the run it came from.
      if (envelope.runId === "") envelope = recoverEnvelope(line);
      if (isWireValidationError(err)) {
        writeError(envelope, err.code, err.message);
      } else {
        writeError(envelope, "internal", errorMessage(err));
      }
    }
  }
}

/**
 * Loads a bundle's declared rehearsal entry (docs/design-graph-rehearsal.md
 * §4.4) inside this already-sandboxed child, same as the graph entry this
 * process loaded at startup — the rehearsal module is the same untrusted
 * bundle code, so the CLI process that asks for it must never `import()` it
 * directly.
 */
async function loadRehearsalExport(entry: string, config: unknown): Promise<GraphRehearsal | undefined> {
  const mod = (await import(pathToFileURL(entry).href)) as { rehearsal?: unknown };
  // A function of the run's config (GraphRehearsalExport) for a graph whose
  // scenarios depend on it; plain data otherwise.
  const rehearsal = typeof mod.rehearsal === "function" ? await Promise.resolve((mod.rehearsal as (c: unknown) => unknown)(config)) : mod.rehearsal;
  if (rehearsal === undefined) return undefined;
  return assertGraphRehearsal(rehearsal);
}

/** Divert console and process.stdout writes to stderr before loading plugin code. */
function isolatePluginStdout(): void {
  const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  console.log = stderrConsole.log.bind(stderrConsole);
  console.info = stderrConsole.info.bind(stderrConsole);
  console.debug = stderrConsole.debug.bind(stderrConsole);
  console.dir = stderrConsole.dir.bind(stderrConsole);
  console.trace = stderrConsole.trace.bind(stderrConsole);

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) => {
    if (typeof encoding === "function") {
      return process.stderr.write(chunk, encoding);
    }
    if (encoding !== undefined) {
      return process.stderr.write(chunk, encoding, cb);
    }
    return process.stderr.write(chunk, cb);
  }) as typeof process.stdout.write;
}

function baseEnvelope(): WireEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runId: "",
    operationId: "",
    generation: 0,
    expectedStateRevision: 0,
    activeVersion: "",
  };
}

/**
 * Best-effort envelope fields scraped from a request line that failed full
 * parsing or validation (oversized, malformed), without re-parsing the whole
 * line: a regex scan works even on a line too large for parseJsonBounded, and
 * degrades to the empty defaults only if the line carries no such fields at all.
 */
function recoverEnvelope(line: string): WireEnvelope {
  const str = (key: string): string => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(line)?.[1] ?? "";
  const optionalStr = (key: string): string | undefined => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(line)?.[1];
  const num = (key: string): number => {
    const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(line);
    return m ? Number(m[1]) : 0;
  };
  const recoveryEpisodeId = optionalStr("recoveryEpisodeId");
  return {
    protocolVersion: PROTOCOL_VERSION,
    runId: str("runId"),
    operationId: str("operationId"),
    generation: num("generation"),
    expectedStateRevision: num("expectedStateRevision"),
    activeVersion: str("activeVersion"),
    ...(recoveryEpisodeId !== undefined ? { recoveryEpisodeId } : {}),
  };
}

function writeResponse(response: WireResponse): void {
  protocolStdoutWrite(`${JSON.stringify(response)}\n`);
}

function writeError(
  envelope: WireEnvelope,
  code: "malformed" | "stale" | "oversized" | "unknown" | "internal",
  message: string,
): void {
  writeResponse({ ...envelope, kind: "error", code, message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWireValidationError(err: unknown): err is WireValidationError {
  return err instanceof WireValidationError;
}

main().catch((err: unknown) => {
  writeError(baseEnvelope(), "internal", errorMessage(err));
  process.exit(1);
});
