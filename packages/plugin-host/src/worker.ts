/**
 * Child worker: load a plugin entry and serve NDJSON wire requests on stdin/stdout.
 * Logs go to stderr only — never interleave with the protocol channel.
 */
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
    } catch (err) {
      if (err instanceof WireValidationError) {
        writeError(envelope, err.code, err.message);
      } else {
        writeError(envelope, "internal", errorMessage(err));
      }
    }
  }
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
  process.stdout.write(`${JSON.stringify(response)}\n`);
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

main().catch((err: unknown) => {
  writeError(baseEnvelope(), "internal", errorMessage(err));
  process.exit(1);
});
