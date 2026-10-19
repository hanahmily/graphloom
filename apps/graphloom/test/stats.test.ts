import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedGraph, dispatch, observe, stop, validate, type EvidenceRecord, type GraphDefinition, type JobSpec, type Validator } from "@graphloom/sdk";
import { createScriptedRunner, type JobContext } from "@graphloom/runner";
import { createController, loadRunState } from "@graphloom/controller";
import { formatRunStats, loadRunStats, runStats } from "../src/stats.js";
import { execFileAsync, makeCliEnv, repoRoot } from "./cli-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures/stats");
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("graphloom stats on recorded runs (#150)", () => {
  it("reports a run saved before the usage ledger, per stage and in total, saying what is estimated", async () => {
    // Trimmed from issue-fix run 395ec998-6e4 (hanahmily/graphloom#122): budgets were set once, never edited.
    const stats = await loadRunStats(path.join(fixtures, "395ec998-6e4"));
    expect(stats).toMatchObject({ runId: "395ec998-6e4", graphId: "issue-fix", status: "succeeded", generations: 5 });
    expect(stats.usageSource.kind).toBe("estimated");
    expect(stats.stages).toEqual([
      expect.objectContaining({ stageId: "fix", attempts: 4, agentInvocations: 91, receipts: { valid: 5, invalidated: 15 } }),
      expect.objectContaining({ stageId: "review", attempts: 4, agentInvocations: 215, receipts: { valid: 1, invalidated: 0 } }),
    ]);
    expect(stats.stages[1]!.jobs).toMatchObject({ total: 22, agent: 13, command: 9, byPurpose: { review: 8 } });
    expect(stats.agentInvocations).toEqual({ stages: 306, outsideStages: 17, total: 323, exactness: "estimate" });
    expect(stats.budgets.find((b) => b.budget === "jobs")).toMatchObject({ used: 64, exactness: "estimate" });
    expect(stats.budgets.find((b) => b.budget === "activeMs")).toMatchObject({ used: 5_445_466 });
    expect(stats.jobs).toMatchObject({ recorded: 49, budgetUsed: 64, environmentChecks: 2, exactness: "lower bound" });
    expect(stats.versionTransitions).toEqual({ intake: 1, reenter: 3, resume: 1 });
    expect(stats.supervisor).toMatchObject({ episodes: 3, exactness: "lower bound", source: "episode ids referenced in run state" });
    expect(stats.span?.wallMs).toBe(Date.parse("2026-10-18T11:43:22.301Z") - Date.parse("2026-10-18T04:34:24.311Z"));
  });

  it("does not trust budget deltas a hand edit made meaningless", async () => {
    // Trimmed from run 4c70ff66-dd9 (#119): intake budgets were raised to 1,000,000 by hand mid-run.
    const stats = await loadRunStats(path.join(fixtures, "4c70ff66-dd9"));
    expect(stats.agentInvocations).toEqual({ stages: 803, exactness: "lower bound" });
    for (const budget of ["jobs", "decisions", "corrections", "activeMs"]) {
      const line = stats.budgets.find((b) => b.budget === budget)!;
      expect(line.exactness, budget).toBe("unknown");
      expect(line.used, budget).toBeUndefined();
    }
    expect(stats.jobs.budgetUsed).toBeUndefined();
    expect(stats.stages.map((s) => [s.stageId, s.attempts, s.agentInvocations])).toEqual([
      ["fix", 11, 182],
      ["review", 11, 621],
    ]);
    expect(stats.remedies.count).toBe(9);
    expect(formatRunStats(stats)).toContain("calls outside the stages unknown (the agent budget was edited by hand)");
  });

  it("handles a state missing every optional field", () => {
    const bare = {
      runId: "bare",
      status: "stopped",
      generation: 1,
      activeVersion: "g@1",
      current: { stageId: "a", attempt: 1 },
      receipts: [],
      evidence: [],
      definition: { graphId: "g", version: "1", stages: [{ id: "a", name: "A", requirementIds: [] }], requirements: [], defaultValidators: [] },
      budgets: { agentInvocations: 60, jobs: 120, decisions: 500, corrections: 8 },
      intake: { task: {}, bundle: { graphId: "g" }, budgets: { agentInvocations: 64, jobs: 128, decisions: 512, corrections: 8 } },
      versionHistory: [],
    } as never;
    const stats = runStats(bare);
    expect(stats.stages).toEqual([expect.objectContaining({ stageId: "a", attempts: 1, agentInvocations: 0 })]);
    expect(stats.budgets.map((b) => [b.budget, b.used])).toEqual([
      ["agentInvocations", 4],
      ["jobs", 8],
      ["decisions", 12],
      ["corrections", 0],
    ]);
    expect(stats.span).toBeUndefined();
    expect(formatRunStats(stats)).toContain("run bare");
  });

  it("prints a table, or JSON with --json, by state directory or by run id under --state-root, leaving the state untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gl-stats-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await cp(path.join(fixtures, "395ec998-6e4"), path.join(root, "395ec998-6e4"), { recursive: true });
    const before = await readFile(path.join(root, "395ec998-6e4/state.json"), "utf8");

    const table = await execFileAsync(process.execPath, [cli, "stats", path.join(root, "395ec998-6e4")]);
    expect(table.stdout).toMatch(/^stage\s+attempts\s+agent calls\s+jobs/m);
    expect(table.stdout).toMatch(/^review\s+4\s+215\s+22\s+13\s+9\s+8\s+1\/0$/m);
    expect(table.stdout).toMatch(/^agentInvocations\s+323\s+999677\s+1000000\s+1000000\s+estimate$/m);
    expect(table.stdout).toContain("agent calls: 306 by stage jobs (exact), 17 by the supervisor, reviewer and repairs, 323 in total (estimate)");

    const json = await execFileAsync(process.execPath, [cli, "stats", "395ec998-6e4", "--state-root", root, "--json"]);
    const parsed = JSON.parse(json.stdout) as { runId: string; agentInvocations: { total: number } };
    expect(parsed).toMatchObject({ runId: "395ec998-6e4", agentInvocations: { total: 323 } });
    expect(await readFile(path.join(root, "395ec998-6e4/state.json"), "utf8")).toBe(before);
  });

  it("is exact for a run that keeps the usage ledger", async () => {
    const env = await makeCliEnv(cleanups);
    await writeFile(path.join(env.dir, "task.yaml"), `graph: hello\nrepo: ./test-repo\nrequest: "Write the greeting."\nbudgets:\n  agentInvocations: 30\n`);
    const report = await createController().run({
      taskPath: path.join(env.dir, "task.yaml"),
      plugin: createScriptedGraph({ definition: helloDefinition, advances: completes }),
      validators,
      runner: createScriptedRunner({ jobs: [agent, agent] }),
      stateRoot: env.stateRoot,
      runId: "ledger-stats",
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const stats = runStats(state);
    expect(stats.usageSource).toEqual({ kind: "ledger", exactness: "exact" });
    // Two scripted agent jobs, each charged one call at settlement; none reserved per stage.
    expect(stats.budgets.find((b) => b.budget === "agentInvocations")).toMatchObject({ used: 2, left: 28, granted: 30, intake: 30, exactness: "exact" });
    expect(stats.budgets.find((b) => b.budget === "jobs")).toMatchObject({ used: 2, exactness: "exact" });
    expect(stats.budgets.find((b) => b.budget === "decisions")?.used).toBe(6);
    expect(stats.agentInvocations).toEqual({ stages: 0, outsideStages: 2, total: 2, exactness: "exact" });
  }, 60_000);
});

const helloDefinition: GraphDefinition = {
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
};
const latest = (evidence: EvidenceRecord[], kind: string) => [...evidence].reverse().find((e) => e.kind === kind)?.payload as Record<string, unknown> | undefined;
const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate: ({ evidence }) => (latest(evidence, "file")?.bytes === "Hello, GraphLoom!\n" ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "missing" }),
  },
  "independent-reviewer": {
    evaluate: ({ evidence }) => (latest(evidence, "review")?.verdict === "approved" ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "missing" }),
  },
};
const completes = [
  dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: ["GREETING.txt"] }, "write"),
  observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write" }, "validate write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review" }, "validate review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];
const agent = async (job: JobSpec, ctx: JobContext) => {
  if (job.purpose === "review") return { status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }] };
  await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), "Hello, GraphLoom!\n");
  return { status: "ok" as const, summary: "wrote" };
};
