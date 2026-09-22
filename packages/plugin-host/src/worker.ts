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
  assertWireRequest,
  parseJsonBounded,
  type GraphPlugin,
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
  try {
    const mod = (await import(pathToFileURL(entry).href)) as {
      createGraph?: () => GraphPlugin | Promise<GraphPlugin>;
      default?: GraphPlugin | (() => GraphPlugin | Promise<GraphPlugin>);
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
        const definition = assertGraphDefinition(await Promise.resolve(plugin.describe()));
        writeResponse({ ...envelope, kind: "describe_ok", definition });
        continue;
      }
      if (req.kind === "advance") {
        const decision = assertGraphDecision(await Promise.resolve(plugin.advance(req.view)));
        writeResponse({ ...envelope, kind: "advance_ok", decision });
        continue;
      }
      if (req.kind === "evaluate") {
        writeError(envelope, "unknown", "evaluate is not supported by this worker yet");
        continue;
      }
      writeError(envelope, "unknown", "unsupported request kind");
    } catch (err: unknown) {
      if (isWireValidationError(err)) {
        writeError(envelope, err.code, err.message);
      } else {
        writeError(envelope, "internal", errorMessage(err));
      }
    }
  }
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
