import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { codingAgentBinding, codingAgentExecutorPackage, CODING_AGENT_RUN_ID } from "@graphloom/executor-coding-agent";
import { confinementUnsupported, createBuiltinExecutorRunner, createScriptedRunner } from "@graphloom/runner";

const harness = fileURLToPath(new URL("./fixtures/confine-probe-harness.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf((await confinementUnsupported()) !== undefined)("a confined coding-agent job (#165)", () => {
  it("saves a fresh session and hands its commands the run's scratch cache variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-confined-agent-"));
    dirs.push(root);
    const worktree = path.join(root, "worktree");
    const artifacts = path.join(root, "artifacts");
    const scratch = path.join(root, "scratch");
    // The session directory is fresh: the controller names it without creating it.
    const sessionDir = path.join(root, "agent-sessions", "op-1");
    await mkdir(worktree, { recursive: true });
    const runner = createBuiltinExecutorRunner({
      packages: [{ manifest: codingAgentExecutorPackage, ...codingAgentBinding({ harness }) }],
      fallback: createScriptedRunner({ jobs: [] }),
    });
    const result = await runner.runJob(
      {
        stageId: "s",
        kind: "agent",
        purpose: "diagnostic",
        instruction: "look around",
        readOnly: true,
        executor: { id: CODING_AGENT_RUN_ID },
        input: { assignment: "look around" },
      },
      {
        runId: "r",
        operationId: "op-1",
        generation: 1,
        worktreePath: worktree,
        artifactDir: artifacts,
        session: { dir: sessionDir },
        confinement: { scratchDir: scratch, writablePaths: [worktree] },
      },
    );
    expect(result.status, result.summary).toBe("ok");
    const summary = result.summary;
    expect(summary).toContain("session-saved");
    expect(await readFile(path.join(sessionDir, "transcript.json"), "utf8")).toBe("{}");
    // The agent-run command saw the redirected values, not the operator's.
    expect(summary).toContain(`${path.join(scratch, "go", "cache")}|${path.join(scratch, "go", "env")}|${path.join(scratch, "go", "tmp")}|${path.join(scratch, "npm")}`);
    expect(existsSync(path.join(root, "agent-sessions"))).toBe(true);
  });
});
