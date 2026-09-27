/**
 * Test worker that replies with malformed or deliberately stale envelopes.
 * argv[2] = mode: "malformed" | "stale-generation"
 * Ignores the plugin entry path if present as argv[3].
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "malformed";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req = {};
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(`not-json\n`);
    continue;
  }

  if (mode === "malformed") {
    process.stdout.write(`{"not":"a wire response"}\n`);
    continue;
  }

  if (mode.startsWith("json-")) {
    process.stdout.write(`${mode.slice(5)}\n`);
    continue;
  }

  if (mode === "stale-generation") {
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        runId: req.runId,
        operationId: req.operationId,
        generation: (req.generation ?? 0) - 1,
        expectedStateRevision: req.expectedStateRevision,
        activeVersion: req.activeVersion,
        kind: "describe_ok",
        definition: {
          graphId: "stale",
          version: "0",
          stages: [{ id: "s", name: "S", requirementIds: ["r"] }],
          requirements: [
            { id: "r", statement: "x", evidenceSchema: "x" },
          ],
          defaultValidators: [
            { requirementId: "r", validatorId: "v", version: "1" },
          ],
        },
      })}\n`,
    );
  }
}
