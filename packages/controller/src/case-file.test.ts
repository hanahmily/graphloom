import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatch,
  MAX_CASE_FACTS,
  observe,
  returnToNormal,
  stop,
  supervise,
  type CaseFile,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type RunView,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import {
  createPiSupervisor,
  createScriptedSupervisor,
  type PiSupervisorSessionPort,
  type SupervisorSettlement,
} from "@graphloom/supervisor";
import { liveCaseFile, recordAttempt, recordFinding, refreshCaseFile } from "./case-file.js";
import { createController, loadRunState, type DurableRunState } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING_PATH = "GREETING.txt";

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
      statement:
        "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    {
      requirementId: "independent-review",
      validatorId: "independent-reviewer",
      version: "1",
      independence: "separate-reviewer" as const,
    },
  ],
};
const passing: Validator = { evaluate: () => ({ status: "passed" as const, reason: "ok" }) };
const validators: Record<string, Validator> = { "exact-greeting": passing, "independent-reviewer": passing };

const temps: string[] = [];
let built: Promise<unknown> | undefined;

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeEnv(
  budgets = "",
  options: { copyBundle?: boolean } = {},
): Promise<{ taskPath: string; stateRoot: string; bundle: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(helloBundle, "dist", "index.js"))) {
    built ??= run("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  await built;
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-case-file-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await run("git", ["init"], { cwd: repoPath });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await run("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repoPath });
  await run("git", ["commit", "-m", "init"], { cwd: repoPath });
  const pluginsDir = path.join(taskDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  let bundle = helloBundle;
  if (options.copyBundle === true) {
    bundle = path.join(taskDir, "hello-bundle");
    await cp(helloBundle, bundle, { recursive: true, dereference: true });
  }
  await symlink(bundle, path.join(pluginsDir, "hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, `graph: hello\nrepo: ./test-repo\nrequest: write the greeting\n${budgets}`, "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state"), bundle };
}

const workJob = (content: string) => ({
  stageId: "write",
  kind: "command" as const,
  purpose: "work" as const,
  instruction: `write ${content}`,
  writeScope: [GREETING_PATH],
});
const writeWork = (content: string) => dispatch(workJob(content), `write ${content}`);

/** A runner whose every job writes its own content to GREETING.txt, changing the candidate. */
const writingRunner = (n: number) =>
  createScriptedRunner({
    jobs: Array.from({ length: n }, () => async (_job, ctx, index) => {
      await writeFile(path.join(ctx.worktreePath, GREETING_PATH), `revision ${index}\n`, "utf8");
      return {
        status: "ok" as const,
        summary: `wrote revision ${index}`,
        evidence: [{ kind: "other" as const, payload: { summary: `wrote revision ${index}` } }],
      };
    }),
  });

function baseState(over: Partial<DurableRunState> = {}): DurableRunState {
  return {
    generation: 1,
    activeVersion: "hello@0.1.0",
    candidateDigest: "digest-a",
    evidence: [{ ref: "ev-1", kind: "other" }, { ref: "ev-2", kind: "other" }],
    intake: { bundle: { manifestDigest: "manifest-a", entryDigest: "entry-a" } },
    ...over,
  } as DurableRunState;
}

describe("case file (unit)", () => {
  it("keeps a fact only when every cited evidence ref exists", () => {
    const state = baseState();
    const missing = recordFinding(state, { kind: "fact", text: "the fix is on disk", evidence: ["ev-1", "ev-404"] }, "ep-1");
    expect(missing.outcome).toEqual({ kept: false, reason: "no recorded evidence has ref ev-404" });
    expect(missing.state.caseFile).toBeUndefined();

    const none = recordFinding(state, { kind: "fact", text: "uncited" }, "ep-1");
    expect(none.outcome.kept).toBe(false);

    const kept = recordFinding(state, { kind: "fact", text: "the fix is on disk", evidence: ["ev-1"] }, "ep-1");
    expect(kept.outcome).toEqual({ kept: true, id: "fact-1" });
    expect(kept.state.caseFile?.facts).toEqual([
      {
        id: "fact-1",
        text: "the fix is on disk",
        evidence: ["ev-1"],
        since: 1,
        episodeId: "ep-1",
        dependsOn: { candidateDigest: "digest-a", activeVersion: "hello@0.1.0", pluginDigest: expect.any(String) },
      },
    ]);
    const refuted = recordFinding(kept.state, { kind: "refuted", text: "the wrapper corrupts arguments", evidence: ["ev-404"] }, "ep-1");
    expect(refuted.outcome.kept).toBe(false);
  });

  it("marks a fact stale when the candidate digest or active version it depends on changes", () => {
    let state = recordFinding(baseState(), { kind: "fact", text: "candidate fact", evidence: ["ev-1"], dependsOn: ["candidate"] }, "ep-1").state;
    state = recordFinding(state, { kind: "fact", text: "plugin fact", evidence: ["ev-2"], dependsOn: ["plugin"] }, "ep-1").state;
    state = recordFinding(state, { kind: "fact", text: "task fact", evidence: ["ev-2"], dependsOn: [] }, "ep-1").state;

    state = refreshCaseFile({ ...state, candidateDigest: "digest-b", generation: 2 });
    expect(state.caseFile?.facts.find((f) => f.text === "candidate fact")?.stale).toEqual({
      generation: 2,
      reason: "the workspace candidate changed",
    });
    expect(liveCaseFile(state).facts.map((f) => f.text)).toEqual(["plugin fact", "task fact"]);

    // An operator plugin update keeps the version but replaces the bundle's code.
    const updated = refreshCaseFile({
      ...state,
      intake: { ...state.intake, bundle: { ...state.intake.bundle, entryDigest: "entry-b" } },
    });
    expect(updated.caseFile?.facts.find((f) => f.text === "plugin fact")?.stale?.reason).toBe(
      "the pinned plugin bundle was updated",
    );
    state = refreshCaseFile({ ...state, activeVersion: "hello@candidate-r1" });
    expect(liveCaseFile(state).facts.map((f) => f.text)).toEqual(["task fact"]);
    // Changing back does not revive a finding made against other code.
    state = refreshCaseFile({ ...state, candidateDigest: "digest-a", activeVersion: "hello@0.1.0" });
    expect(liveCaseFile(state).facts.map((f) => f.text)).toEqual(["task fact"]);
  });

  it("stays bounded, dropping the oldest stale facts first", () => {
    let state = recordFinding(baseState(), { kind: "fact", text: "old candidate fact", evidence: ["ev-1"] }, "ep-1").state;
    state = refreshCaseFile({ ...state, candidateDigest: "digest-b" });
    for (let i = 0; i < MAX_CASE_FACTS; i++) {
      state = recordFinding(state, { kind: "fact", text: `fact ${i}`, evidence: ["ev-1"] }, "ep-2").state;
    }
    const facts = state.caseFile!.facts;
    expect(facts).toHaveLength(MAX_CASE_FACTS);
    expect(facts.some((f) => f.text === "old candidate fact")).toBe(false);
    state = recordFinding(state, { kind: "fact", text: "one more", evidence: ["ev-1"] }, "ep-2").state;
    expect(state.caseFile!.facts).toHaveLength(MAX_CASE_FACTS);
    expect(state.caseFile!.facts[0]!.text).toBe("fact 1");
  });

  it("writes each settlement as an attempt once", () => {
    const settlement: SupervisorSettlement = { action: "dispatch", reason: "retry", facts: ["command evidence ev-3: wrote"] };
    const state = baseState({
      supervisorMark: {
        action: "dispatch",
        reason: "retry",
        episodeId: "ep-1",
        triggerCode: "supervise",
        stageId: "write",
        attempt: 1,
        generation: 1,
        evidenceRefs: [],
        receiptIds: [],
        candidates: {},
        notes: [],
      },
    });
    const once = recordAttempt(state, settlement);
    expect(once.caseFile?.attempts).toEqual([
      { episodeId: "ep-1", trigger: "supervise", action: "dispatch: retry", outcome: "command evidence ev-3: wrote", generation: 1 },
    ]);
    expect(recordAttempt(once, settlement).caseFile?.attempts).toHaveLength(1);
  });
});

describe("case file through the controller", () => {
  it("drops a fact citing the old candidate from the next input, refuses one citing a missing ref, and records attempts from settlements", async () => {
    const env = await makeEnv();
    const files: CaseFile[] = [];
    const outcomes: unknown[] = [];
    const supervisor = createScriptedSupervisor({
      decisions: [
        async (input) => {
          files.push(input.caseFile!);
          const ref = input.view.evidence[input.view.evidence.length - 1]!.ref;
          outcomes.push(await input.recordFinding!({ kind: "fact", text: "GREETING.txt is absent", evidence: [ref] }));
          outcomes.push(await input.recordFinding!({ kind: "fact", text: "the README is fine", evidence: [ref], dependsOn: [] }));
          outcomes.push(await input.recordFinding!({ kind: "fact", text: "invented", evidence: ["ev-g1-99-nothere"] }));
          return writeWork("first");
        },
        (input) => {
          files.push(input.caseFile!);
          return stop({ reason: "seen enough", blocker: "test ends here" }, "stop");
        },
      ],
    });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph([observe({ paths: ["README.md"], includeWorkspaceManifest: true }, "look"), supervise({ reason: "help" }, "escalate")]),
      validators,
      supervisor,
      runner: writingRunner(1),
      stateRoot: env.stateRoot,
      runId: "case-file-stale",
    });
    expect(report.stopReason).toBe("seen enough");
    expect(outcomes).toEqual([
      { kept: true, id: "fact-1" },
      { kept: true, id: "fact-2" },
      { kept: false, reason: "no recorded evidence has ref ev-g1-99-nothere" },
    ]);
    expect(files[0]).toEqual({ facts: [], refuted: [], attempts: [], open: [] });
    // The dispatch changed the candidate: the fact made against it is gone from the next input.
    expect(files[1]!.facts.map((f) => f.text)).toEqual(["the README is fine"]);
    expect(files[1]!.attempts).toEqual([
      expect.objectContaining({ trigger: "supervise", action: "dispatch: write first", generation: 1 }),
    ]);
    expect(files[1]!.attempts[0]!.outcome).toContain("the workspace candidate changed");

    const state = await loadRunState(report.stateDir);
    expect(state.caseFile?.facts.find((f) => f.id === "fact-1")?.stale?.reason).toBe("the workspace candidate changed");
    expect(state.caseFile?.facts).toHaveLength(2);
    // The operator sees the whole case file, stale entries marked.
    const inspected = await createController().inspect(report.stateDir);
    expect(inspected.caseFile.facts.map((f) => [f.id, f.stale !== undefined])).toEqual([
      ["fact-1", true],
      ["fact-2", false],
    ]);
  });

  it("marks a plugin-dependent fact stale when the operator resumes with a plugin update", async () => {
    const env = await makeEnv("", { copyBundle: true });
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph([observe({ paths: ["README.md"] }, "look"), supervise({ reason: "help" }, "escalate")]),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          async (input) => {
            const ref = input.view.evidence[0]!.ref;
            await input.recordFinding!({ kind: "fact", text: "the graph routes review first", evidence: [ref], dependsOn: ["plugin"] });
            await input.recordFinding!({ kind: "fact", text: "README.md says repo", evidence: [ref], dependsOn: ["candidate"] });
            return stop({ reason: "pause", blocker: "operator" }, "pause");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "case-file-plugin-update",
    });
    expect(paused.stopReason).toBe("pause");

    const entry = path.join(env.bundle, "dist", "index.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// a fix to the graph's routing\n`, "utf8");
    const seen: string[][] = [];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph([]),
      validators,
      updatePlugin: true,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            seen.push(input.caseFile!.facts.map((f) => f.text));
            return stop({ reason: "done", blocker: "test ends here" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [] }),
    });

    expect(resumed.stopReason).toBe("done");
    const state = await loadRunState(paused.stateDir);
    expect(state.activeVersion).toBe("hello@0.1.0");
    expect(seen).toEqual([["README.md says repo"]]);
    expect(state.caseFile?.facts.find((f) => f.text === "the graph routes review first")?.stale?.reason).toBe(
      "the pinned plugin bundle was updated",
    );
  });

  it("records the settlement of the supervisor's last proposal when the run ends before another decision", async () => {
    // A stop the supervisor proposed.
    const env = await makeEnv();
    const stopped = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph([supervise({ reason: "help" }, "escalate")]),
      validators,
      supervisor: createScriptedSupervisor({ decisions: [stop({ reason: "no remedy", blocker: "none left" }, "give up")] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "case-file-final-stop",
    });
    expect(stopped.stopReason).toBe("no remedy");
    const afterStop = await createController().inspect(stopped.stateDir);
    expect(afterStop.caseFile.attempts).toEqual([
      expect.objectContaining({ trigger: "supervise", action: "stop: give up", outcome: expect.stringContaining("the run stopped: no remedy") }),
    ]);

    // A return, after which the graph finishes the run.
    let advanced = 0;
    const finishing: GraphPlugin = {
      describe: () => definition,
      advance() {
        advanced += 1;
        return advanced === 1
          ? supervise({ reason: "help" }, "escalate")
          : stop({ reason: "graph finished", blocker: "none" }, "finish");
      },
    };
    const returned = await createController().run({
      taskPath: env.taskPath,
      plugin: finishing,
      validators,
      supervisor: createScriptedSupervisor({ decisions: [returnToNormal({ summary: "nothing to fix" }, "hand back")] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "case-file-final-return",
    });
    expect(returned.stopReason).toBe("graph finished");
    const afterReturn = await createController().inspect(returned.stateDir);
    expect(afterReturn.caseFile.attempts).toEqual([
      expect.objectContaining({ action: "return: hand back", outcome: expect.stringContaining("the run stopped: graph finished") }),
    ]);
    // Resuming does not record it a second time.
    const state = await loadRunState(returned.stateDir);
    expect(state.supervisorMark?.attemptRecorded).toBe(true);
  });

  it("keeps every one of 50 episode prompts under a fixed bound, one fresh session per episode", async () => {
    const EPISODES = 50;
    const env = await makeEnv("budgets:\n  agentInvocations: 400\n  jobs: 200\n  corrections: 200\n");
    const sessions: Array<{ prompts: string[] }> = [];
    const refPattern = /ev-g\d+-\d+-[0-9a-f]{8}/g;
    const openPort = (): PiSupervisorSessionPort => {
      const record = { prompts: [] as string[] };
      sessions.push(record);
      const n = sessions.length;
      return {
        runId: "bounded",
        provider: "minimax-cn",
        modelId: "MiniMax-M3",
        sessionId: `episode-session-${n}`,
        sessionFile: `/nonexistent/episode-session-${n}.jsonl`,
        credentialSource: "options",
        async prompt(text, options) {
          record.prompts.push(text);
          const call = async (name: string, args: Record<string, unknown>) => {
            const tool = options?.tools?.find((t) => t.name === name);
            if (tool === undefined) throw new Error(`tool ${name} not offered`);
            await (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)(`call-${name}`, args);
          };
          // Within an episode: dispatch the revision, then return once it settled.
          if (!text.includes("Since the last proposal (dispatch:")) {
            const refs = text.match(refPattern) ?? [];
            if (refs.length > 0) {
              await call("record_finding", { kind: "fact", text: `episode ${n} saw the greeting revision`, evidence: [refs[refs.length - 1]] });
            }
            await call("dispatch", { reason: `revise ${n}`, job: workJob(`episode ${n}`) });
          } else {
            await call("return", { reason: "back to the graph", return: { summary: `episode ${n} done` } });
          }
          return "";
        },
        async setModel() {},
        async close() {},
      };
    };
    const newSupervisor = (logicalSessionId?: string) =>
      createPiSupervisor({
        session: openPort(),
        openSession: async () => openPort(),
        ...(logicalSessionId !== undefined ? { logicalSessionId } : {}),
      });

    let supervised = 0;
    const plugin: GraphPlugin = {
      describe: () => definition,
      advance(_view: RunView) {
        if (supervised >= EPISODES) return stop({ reason: "episodes done", blocker: "none" }, "done");
        supervised += 1;
        return supervise({ reason: `episode ${supervised}` }, "escalate");
      },
    };
    const runner = writingRunner(EPISODES);
    const controller = createController();
    let report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      supervisor: newSupervisor(),
      runner,
      stateRoot: env.stateRoot,
      runId: "bounded-episodes",
    });
    // One controller loop runs a bounded number of steps; the operator resumes
    // past each, and the run's logical supervisor is restored with a fresh session.
    let resumes = 0;
    while (report.stopReason === "step limit" && resumes < 6) {
      resumes += 1;
      report = await controller.resume({
        runRef: report.stateDir,
        plugin,
        validators,
        runner,
        restoreSupervisor: async (binding) => newSupervisor(binding.sessionId),
      });
    }

    expect(report, `${report.blocker} after ${sessions.length} sessions`).toMatchObject({ stopReason: "episodes done" });
    const state = await loadRunState(report.stateDir);
    expect(state.evidence.length).toBeGreaterThanOrEqual(EPISODES);
    expect(state.supervisorBinding?.sessionId).toBe("episode-session-1");

    const used = sessions.filter((s) => s.prompts.length > 0);
    const episodeOf = (text: string) => /^Episode: (\S+)$/m.exec(text)?.[1];
    // One session per episode: a session never spans two episodes, and only a
    // resume (a new process) gives an episode a second one.
    for (const s of used) expect(new Set(s.prompts.map(episodeOf)).size).toBe(1);
    const episodes = new Set(used.map((s) => episodeOf(s.prompts[0]!)));
    expect(episodes.size).toBe(EPISODES);
    expect(used.length).toBeLessThanOrEqual(EPISODES + resumes);

    // Pessimistic 3 characters a token, as the session's own compaction guard counts.
    const tokens = (text: string) => Math.ceil(text.length / 3);
    // A fixed bound: the prompt caps every list it shows, so it holds for any number of episodes.
    const BOUND = 3_000;
    for (const s of used) {
      for (const p of s.prompts) expect(tokens(p)).toBeLessThan(BOUND);
      // A whole episode stays far below any model's window, so the compaction guard never fires.
      expect(tokens(s.prompts.join(""))).toBeLessThan(2 * BOUND);
    }
    // Each episode's fact was made against its candidate, which the episode's own dispatch replaced.
    expect(state.caseFile!.facts.length).toBe(MAX_CASE_FACTS);
    expect(liveCaseFile(state).facts).toEqual([]);
    expect(state.caseFile!.attempts.length).toBeGreaterThan(0);
  });
});

function createScriptedGraph(advances: GraphDecision[]): GraphPlugin {
  let i = 0;
  return {
    describe: () => definition,
    advance() {
      const next = advances[i++];
      return next ?? stop({ reason: "script done", blocker: "none" }, "done");
    },
  };
}
