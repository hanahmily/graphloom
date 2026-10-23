import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedGraph, dispatch, returnToNormal, stop, type GraphDefinition, type ScriptedAdvance } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController } from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const definition: GraphDefinition = {
  graphId: "hello",
  version: "0.1.0",
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
  requirements: [
    {
      id: "greeting-bytes",
      statement:
        "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement: "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
  ],
  resultContracts: [
    { name: "verdicts-v1", schema: { type: "object", required: ["verdicts"], properties: { verdicts: { type: "array" } } }, evidenceKind: "other" },
  ],
};

const verify = (): ScriptedAdvance =>
  dispatch({ stageId: "review", kind: "agent", purpose: "diagnostic", instruction: "verify", readOnly: true, resultSchema: "verdicts-v1" }, "verify the findings");
const freeForm = (): ScriptedAdvance =>
  dispatch({ stageId: "review", kind: "agent", purpose: "diagnostic", instruction: "look around", readOnly: true }, "probe");
const never = { evaluate: () => ({ status: "inconclusive" as const, reason: "n/a" }) };
const done = (): ScriptedAdvance => stop({ reason: "done", blocker: "none" }, "stop");

/** What the coding-agent executor records for a run: a wrapper around the agent's structured output. */
const agentResult = (status: "completed" | "failed", output: unknown) => ({ codingAgent: { harness: "claude-code", status, output } });
const failedRun = () => ({
  status: "failed" as const,
  summary: "Claude Code run failed (success): You've hit your session limit",
  evidence: [{ kind: "other" as const, payload: agentResult("failed", null) }],
});
const okRun = (output: unknown) => () => ({ status: "ok" as const, summary: "done", evidence: [{ kind: "other" as const, payload: agentResult("completed", output) }] });
const freeFormRun = () => ({ status: "ok" as const, summary: "looked around" });

async function triggersFor(advances: ScriptedAdvance[], jobs: Array<() => { status: "ok" | "failed"; summary: string; evidence?: Array<{ kind: "other"; payload: unknown }> }>) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-streak-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "init");
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: hello\nrepo: ./test-repo\nrequest: |\n  verify\n", "utf8");

  const triggers: Array<{ code: string; message: string }> = [];
  const supervisor = createScriptedSupervisor({
    decisions: Array.from({ length: 6 }, () => (input: { trigger: { code: string; message: string } }) => {
      triggers.push({ code: input.trigger.code, message: input.trigger.message });
      return returnToNormal({ summary: "carry on" }, "return");
    }),
  });
  const report = await createController().run({
    taskPath,
    plugin: createScriptedGraph({ definition, advances }),
    validators: { "exact-greeting": never, "independent-reviewer": never },
    runner: createScriptedRunner({ jobs }),
    supervisor,
    stateRoot: path.join(taskDir, "state"),
    runId: "streak",
  });
  return { triggers, report };
}

describe("contract-invalid streak (#191)", () => {
  it("does not count failed runs as contract-invalid, nor blame the next unrelated job for them", async () => {
    // The recorded shape: three verifier runs hit a quota stop (output null,
    // status failed), then a job in the same stage and purpose with no
    // contract settled and tripped the streak ("contract unknown").
    const { triggers } = await triggersFor([verify(), verify(), verify(), freeForm(), done()], [failedRun, failedRun, failedRun, freeFormRun]);
    expect(triggers.map((t) => t.code)).toEqual(["executor_failed", "executor_failed", "executor_failed"]);
    expect(triggers.some((t) => t.message.includes("contract-invalid"))).toBe(false);
  }, 60_000);

  it("still reports a genuinely invalid answer streak, naming the contract", async () => {
    const { triggers } = await triggersFor([verify(), verify(), done()], [okRun({ verdicts: "not-an-array" }), okRun(null)]);
    expect(triggers[0]).toMatchObject({ code: "contract_violation" });
    expect(triggers[0]!.message).toBe("stage review: 2 consecutive contract-invalid results for purpose diagnostic (contract verdicts-v1)");
  }, 60_000);
});
