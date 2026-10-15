import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piRepairDeps } from "../src/repair-config.js";
import type { SupervisorConfig } from "../src/supervisor-config.js";

const live = process.env.GRAPHLOOM_LIVE_MINIMAX === "1";
const temps: string[] = [];

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const CONFIG: SupervisorConfig = { provider: "minimax-cn", modelId: "MiniMax-M3", models: [{ provider: "minimax-cn", modelId: "MiniMax-M3" }] };

/** A controller-issued candidate: `<repairsDir>/<artifactId>/candidate`, with a snapshot record beside it. */
async function issuedCandidate(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "gl-live-repair-"));
  temps.push(base);
  const repairsDir = path.join(base, "repairs");
  const root = path.join(repairsDir, "repair-1", "candidate");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(repairsDir, "repair-1", "snapshot.json"), "{}", "utf8");
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(root, name), bytes, "utf8");
  return root;
}

describe("piRepairDeps reviewer (live MiniMax)", () => {
  it.skipIf(!live)(
    "reads the candidate with read-only tools and rejects a patch that admits it breaks the contract",
    async () => {
      const root = await issuedCandidate({
        "validator.js": [
          "// CONTRACT: evaluate() must return `failed` when the input is empty.",
          "// KNOWN DEFECT: this patch makes evaluate() always return `passed`, even for empty input,",
          "// so it no longer detects the empty-input case at all.",
          "export function evaluate(input) {",
          "  return { status: 'passed' };",
          "}",
          "",
        ].join("\n"),
      });

      const deps = piRepairDeps(CONFIG, "/unused");
      const result = await deps.reviewer.review({
        candidateRoot: root,
        baseRoot: "/unused",
        baseDigest: "base",
        candidateDigest: "candidate",
        target: "validator",
        reason: "the validator lets an empty input through, contrary to the requirement",
        task: "Fix evaluate() to reject empty input.",
        requirement: "evaluate() must return `failed` when the input is empty",
        patchSummary: "removed the empty-input check so evaluate() always returns passed",
        evidence: [],
        maxProviderCalls: 10,
      });

      expect(result.approved).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(deps.reviewer.drainProviderCalls?.()).toBeGreaterThan(0);
    },
    120_000,
  );
});
