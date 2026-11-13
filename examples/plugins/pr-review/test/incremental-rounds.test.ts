// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JobSpec, RehearsalScenario } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { Answer } from "../src/answers.js";
import { priorFileCommand, priorFileText } from "../src/incremental.js";
import { priorShowCommand, writtenLedger } from "../src/ledger.js";
import { partCommands, readParts, recordedNecessityJson } from "../src/parts.js";
import { ledgerPublishedCommand } from "../src/publish.js";
import { incrementalRehearsal, REHEARSAL_HEAD } from "../src/rehearsal.js";
import { passReply } from "../src/rehearsal-review.js";
import { REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from "../src/review.js";
import type { Question } from "../src/questions.js";
import { recordedRound1 } from "../src/reviewdraft.js";
import { answersComplete, questionsComplete } from "../src/validators.js";
import { BANYANDB, candidateEvidence, simulate, type Simulation } from "./support.js";

const sh = promisify(execFile);
const REF = "refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger";
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7 };
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const HEAD1 = "1".repeat(40);
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const partial = (id: string) => (q: Question, _s: unknown, _r: unknown, dflt: Answer): Answer => (q.id === id ? { ...dflt, status: "partially answered" } : dflt);

/** The ledger a run leaves in the review clone, held in a real repository so the prior files are read as Fetch reads them. */
class LedgerRepo {
  dir = "";
  async init(dirs: string[]): Promise<this> {
    this.dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-incremental-"));
    dirs.push(this.dir);
    await sh("git", ["init", "-q", "-b", "main", this.dir], { env });
    return this;
  }
  private git = async (...args: string[]): Promise<string> => (await sh("git", args, { cwd: this.dir, env })).stdout.trim();
  private exec = async (argv: readonly string[], extra: Record<string, string> = {}) => sh(argv[0]!, argv.slice(1), { cwd: this.dir, env: { ...env, ...extra } });

  /** The ledger after a run: its Answers commit with the real `qa.json` and `necessity.json`, then Publish's patch; and every read Fetch makes of it on the next head. */
  async advance(sim: Simulation, label: string): Promise<Ledgers> {
    const rename = (s: string): string => s.split(REHEARSAL_HEAD).join(label);
    const job = sim.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    const written = writtenLedger((job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)!;
    const necessity = recordedNecessityJson(sim.evidence);
    if (necessity.state !== "read") throw new Error("necessity.json was not recorded");
    await writeFile(path.join(this.dir, "ledger.json"), rename(written.json));
    await writeFile(path.join(this.dir, "qa.json"), rename(sim.qa!.json));
    await writeFile(path.join(this.dir, "necessity.json"), necessity.value);
    for (const name of ["ledger.md", "report.json"]) await writeFile(path.join(this.dir, name), "{}\n");
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", "answers");
    await this.git("update-ref", REF, await this.git("rev-parse", "HEAD"));
    const patch = readParts(sim.evidence, "publish-patch", ".graphloom/review/ledger/publish-patch.json");
    if (patch.state !== "read") throw new Error(`the ledger patch was not written: ${patch.state}`);
    const text = rename(patch.value);
    for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", text)) await this.exec(part.argv);
    await this.exec(ledgerPublishedCommand({ ...PULL, head: label }, JSON.parse(text), process.execPath).argv);
    const sha = await this.git("rev-parse", REF);
    const out = path.join(this.dir, ".report");
    const registry: Record<string, string> = {};
    for (let k = 0, n = 1; k < n; k += 1) {
      const c = priorShowCommand(sha, process.execPath, k);
      await this.exec(c.argv, { GRAPHLOOM_REPORT_FILE: out });
      registry[c.id] = await readFile(out, "utf8");
      if (k === 0) n = Number(/^graphloom-prior 0 (\d+) /.exec(registry[c.id]!)![1]);
    }
    return { sha, registry, qa: await this.git("show", `${sha}:qa.json`), necessity: await this.git("show", `${sha}:necessity.json`) };
  }
}

interface Ledgers {
  sha: string;
  /** The `ledger-prior` parts, as the command prints them. */
  registry: Record<string, string>;
  qa: string;
  necessity: string;
}

/** What a later head's Fetch reads: the ledger ref, its registry, the earlier Q&A and necessity record (changed by `edit`), and the delta. */
interface LaterHead {
  delta?: string;
  deltaExit?: number;
  /** Change the earlier Q&A as the ledger holds it (a test's way of saying what the earlier head had not asked yet). */
  qa?: (qa: Record<string, unknown>) => void;
  /** `absent` for a ledger written before 0.26. */
  necessity?: "absent";
  /** What the read of the base files the earlier answers cite prints, when the bases differ. */
  baseDelta?: string;
}

const cut = (text: string): string => text.split("\n").filter(Boolean).join("\n");
const deltaOf = (...files: string[]): string => `${cut(files.join("\n"))}\ngraphloom-delta-end\n`;
const hunkFile = (p: string, ...hunks: string[]): string => [`diff --git a/${p} b/${p}`, ...hunks].join("\n");
/** Burst was added by the update: new lines 14 to 16 of the file. */
const BURST_ADDED = deltaOf(hunkFile("pkg/quota/limit.go", "@@ -13,0 +14,3 @@"));
const without = (...ids: string[]) => (qa: Record<string, unknown>): void => {
  qa.questions = (qa.questions as Array<{ id: string }>).filter((q) => !ids.includes(q.id));
  qa.symbols = (qa.symbols as Array<{ id: string }>).filter((s) => s.id !== "S2");
};

function onLedger(scenario: RehearsalScenario, at: Ledgers, later: LaterHead = {}): RehearsalScenario {
  const s = structuredClone(scenario);
  const c = s.commands!;
  c["ledger-read"] = { exitCode: 0, stdout: `present ${at.sha}\n` };
  for (const [id, stdout] of Object.entries(at.registry)) c[id] = { exitCode: 0, stdout };
  const qa = JSON.parse(at.qa) as Record<string, unknown>;
  later.qa?.(qa);
  const parts = (file: "qa" | "necessity", text: string): void => {
    const n = Number(/^graphloom-prior 0 (\d+) /.exec(priorFileText(text, 0))![1]);
    for (let k = 0; k < n; k += 1) c[priorFileCommand(file, at.sha, process.execPath, k).id] = { exitCode: 0, stdout: priorFileText(text, k) };
  };
  parts("qa", JSON.stringify(qa));
  if (later.necessity === "absent") c["ledger-prior-nec"] = { exitCode: 0, stdout: "graphloom-prior-absent\n" };
  else parts("necessity", at.necessity);
  if (later.baseDelta !== undefined) c["ledger-delta-base"] = { exitCode: 0, stdout: later.baseDelta };
  c["ledger-delta"] = { exitCode: later.deltaExit ?? 0, stdout: later.delta ?? deltaOf() };
  return s;
}

/** The reviewers' replies for a later head whose earlier round 2 posted F3: each pass raises nothing, and the maintainability pass finds F3 fixed. */
function calm(scenario: RehearsalScenario): RehearsalScenario {
  scenario.results[REVIEW_SCHEMA_NAME] = [passReply(1, []), passReply(1, [], [{ finding: "F3", status: "fixed", reason: "the loop is gone" }]), passReply(1, [])];
  scenario.results[VERIFY_SCHEMA_NAME] = [];
  return scenario;
}

const end = (scenario: RehearsalScenario, config: Record<string, unknown> = {}): Simulation => simulate({ scenario, config, maxSteps: 900, through: "end" });
const agentJobs = (s: Simulation, stage: string): string[] => s.jobs.filter((j) => j.kind === "agent" && j.stageId === stage).map((j) => j.instruction);
/** The question ids an agent job was given (the enum its result's id field is constrained to). */
const idsOf = (j: JobSpec, field: string): string[] => ((j.knownReferences ?? {}) as Record<string, { ids?: string[]; values?: string[] }>)[field]?.ids ?? ((j.knownReferences ?? {}) as Record<string, { values?: string[] }>)[field]?.values ?? [];
const qaOf = (s: Simulation) => JSON.parse(s.qa!.json) as { incremental?: Record<string, unknown>; questions: Array<{ id: string; carried?: { head: string }; answer?: { status: string } }>; necessity?: { carried?: { head: string } } };
const askedIds = (s: Simulation): string[] => {
  const j = s.jobs.find((x) => x.kind === "agent" && x.stageId === "answers" && x.instruction.startsWith("Answer the questions"));
  return j === undefined ? [] : idsOf(j, "answers[].question");
};

describe("round 1 on a later head asks only about what changed", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const config = BANYANDB;
  const stateOf: { issue?: Ledgers; clean?: Ledgers; issueSim?: Simulation; cleanSim?: Simulation; fixedSim?: Simulation } = {};

  it("head 1 (a full round 1, whatever the profile says): Q1 is partially answered, so round 1 posts it and ends; the ledger holds the Q&A and N1's record", async () => {
    const sim = end(incrementalRehearsal(config, { answer: partial("Q1") }));
    stateOf.issueSim = sim;
    expect(stopOf(sim)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^round 1: changes requested/) });
    expect(agentJobs(sim, "questions")).toEqual(["Answer the necessity question N1 from the whole codebase", "Check the necessity answer against the trees", "Ask the questions (ask only; never answer)"]);
    expect(agentJobs(sim, "review")).toEqual([]);
    // A first head has no earlier ledger: nothing is said of incremental review.
    expect(qaOf(sim).incremental).toBeUndefined();
    expect(qaOf(sim).questions.map((q) => q.id)).toEqual(["N1", "Q1", "Q2", "Q3", "Q4"]);
    stateOf.issue = await (await new LedgerRepo().init(dirs)).advance(sim, HEAD1);
    expect(JSON.parse(stateOf.issue.qa).pull.head).toBe(HEAD1);
    expect(JSON.parse(stateOf.issue.necessity).schema).toBe("pr-necessity-v1");
  });

  it("the earlier issue is fixed: it is asked again alone, Burst (new in the update) is asked, N1 and the unchanged Q2 are carried, and round 2 runs in the same run", () => {
    const asked = (q: { id: string }) => ["Q1", "Q3", "Q4"].includes(q.id);
    const sim = end(onLedger(incrementalRehearsal(config, { asked, necessityCarried: true }), stateOf.issue!, { delta: BURST_ADDED, qa: without("Q3", "Q4") }));
    expect(stopOf(sim), JSON.stringify(sim.final).slice(0, 500)).toMatchObject({ reason: "complete" });
    // No N1 job (it is carried), and one answerer and one checker job, for exactly the questions asked.
    expect(agentJobs(sim, "questions")).toEqual(["Ask the questions (ask only; never answer)"]);
    expect(agentJobs(sim, "answers")).toEqual(["Answer the questions from the whole codebase", "Check the answers against the trees"]);
    expect(askedIds(sim)).toEqual(["Q1", "Q3", "Q4"]);
    const qa = qaOf(sim);
    stateOf.fixedSim = sim;
    expect(qa.incremental).toEqual({ from: HEAD1, to: REHEARSAL_HEAD, asked: 3, rechecks: 1, carried: 2 });
    expect(qa.questions.filter((q) => q.carried !== undefined).map((q) => [q.id, q.carried!.head])).toEqual([["N1", HEAD1], ["Q2", HEAD1]]);
    expect(qa.necessity?.carried).toEqual({ head: HEAD1 });
    expect(sim.qa!.markdown).toContain(`Since the last review (1111111 → 0123456): 3 asked (new or changed code), 1 of them re-checks of earlier issues, 2 carried from earlier heads.`);
    expect(sim.qa!.markdown).toContain("(carried from 1111111)");
    // Round 1: Q1 is fixed, nothing is open, so round 2 ran.
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues).toEqual([]);
    expect(r1.state === "read" && r1.value.prior).toEqual([{ id: "Q1", key: expect.stringContaining("quota.Limit"), status: "fixed", reason: "its question is now answered, with no blocking category" }]);
    expect(agentJobs(sim, "review").length).toBeGreaterThan(0);
  });

  it("the validators recompute what is carried: the same evidence passes, and a delta that touches a carried answer's subject makes the recorded Q&A fail", () => {
    const sim = stateOf.fixedSim!;
    // As the Answers stage left it: the evidence up to the ledger write (a validator sees only the newest review).
    const upto = sim.evidence.findIndex((e) => (e.payload as { command?: { id?: string } }).command?.id === "ledger-write");
    const check = (evidence: typeof sim.evidence) => [questionsComplete, answersComplete].map((v) => v.evaluate({ requirementId: "x", statement: "", evidence: candidateEvidence(evidence.slice(0, upto + 1), "d1"), candidateDigest: "d1", config })).map((r) => (r.status === "passed" ? "passed" : `${r.status}: ${r.reason}`));
    expect(check(sim.evidence)).toEqual(["passed", "passed"]);
    // The delta now says Limit's lines changed: Q2 is no longer carried, but the recorded qa.json carries it.
    const tampered = sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id?: string; stdoutTail?: string } }).command;
      return c?.id === "ledger-delta" ? { ...e, payload: { ...(e.payload as object), command: { ...c, stdoutTail: deltaOf(hunkFile("pkg/quota/limit.go", "@@ -7,2 +7,3 @@")) } } } : e;
    });
    expect(check(tampered as typeof sim.evidence)[1]).not.toBe("passed");
  });

  it("the earlier issue is still open: only the targeted re-check and the new code are asked, Q2 is carried, round 2 does not run, and the issue stays listed", () => {
    const asked = (q: { id: string }) => ["Q1", "Q3", "Q4"].includes(q.id);
    const sim = end(onLedger(incrementalRehearsal(config, { asked, necessityCarried: true, answer: partial("Q1") }), stateOf.issue!, { delta: BURST_ADDED, qa: without("Q3", "Q4") }));
    expect(stopOf(sim)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^round 1: changes requested/) });
    expect(askedIds(sim)).toEqual(["Q1", "Q3", "Q4"]);
    expect(qaOf(sim).questions.find((q) => q.id === "Q2")!.carried).toEqual({ head: HEAD1 });
    expect(agentJobs(sim, "review")).toEqual([]);
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues.map((i) => i.id)).toEqual(["Q1"]);
    expect(r1.state === "read" && r1.value.prior).toEqual([{ id: "Q1", key: expect.any(String), status: "open", reason: "it is still an issue on this head" }]);
    const body = String(sim.github.creates[0]!.body);
    expect(body.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body).toContain("- Q1: still open");
  });

  it("an update that changes a function's lines asks that function's questions; the other function's answers are carried", () => {
    // Round 1 passed on the earlier head, and round 2 ran: this head asks the delta's questions only, then round 2.
    const clean = end(incrementalRehearsal(config));
    stateOf.cleanSim = clean;
    expect(stopOf(clean)).toMatchObject({ reason: "complete" });
    return new LedgerRepo().init(dirs).then(async (repo) => {
      stateOf.clean = await repo.advance(clean, HEAD1);
      // Lines 7 to 9 of Limit (lines 6 to 11) changed.
      const asked = (q: { id: string }) => ["Q1", "Q2"].includes(q.id);
      const sim = end(onLedger(calm(incrementalRehearsal(config, { asked, necessityCarried: true })), stateOf.clean, { delta: deltaOf(hunkFile("pkg/quota/limit.go", "@@ -7,2 +7,3 @@")) }));
      expect(stopOf(sim)).toMatchObject({ reason: "complete" });
      expect(askedIds(sim)).toEqual(["Q1", "Q2"]);
      expect(qaOf(sim).questions.filter((q) => q.carried !== undefined).map((q) => q.id)).toEqual(["N1", "Q3", "Q4"]);
      expect(qaOf(sim).incremental).toMatchObject({ asked: 2, rechecks: 0, carried: 3 });
      expect(agentJobs(sim, "review").length).toBeGreaterThan(0);
    });
  });

  it("an update that touches nothing the answers rest on asks nothing: no answerer and no checker job, and round 2 runs", () => {
    const sim = end(onLedger(calm(incrementalRehearsal(config, { asked: () => false, necessityCarried: true })), stateOf.clean!, { delta: deltaOf(hunkFile("docs/guide.md", "@@ -1 +1 @@")) }));
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(agentJobs(sim, "answers")).toEqual([]);
    expect(agentJobs(sim, "questions")).toEqual(["Ask the questions (ask only; never answer)"]);
    expect(qaOf(sim).incremental).toEqual({ from: HEAD1, to: REHEARSAL_HEAD, asked: 0, rechecks: 0, carried: 5 });
    expect(qaOf(sim).questions.every((q) => q.carried?.head === HEAD1 && q.answer?.status === "answered")).toBe(true);
    expect(agentJobs(sim, "review").length).toBeGreaterThan(0);
  });

  it("the base moved and a base file the answers cite differs between the two bases: the questions that cite it are asked again, the others carried", () => {
    // Q2 and Q4 cite pkg/schema/ttl_test.go in the base tree, N1 cites pkg/timestamp/duration.go; Q1 and Q3 cite nothing.
    const moved = (qa: Record<string, unknown>): void => {
      (qa.pull as { base: string }).base = "9".repeat(40);
    };
    const sim = end(onLedger(calm(incrementalRehearsal(config, { asked: (q) => ["Q2", "Q4"].includes(q.id), necessityCarried: true })), stateOf.clean!, { delta: deltaOf(), qa: moved, baseDelta: "changed pkg/schema/ttl_test.go\nsame pkg/timestamp/duration.go\n" }));
    expect(stopOf(sim), JSON.stringify(sim.final).slice(0, 500)).toMatchObject({ reason: "complete" });
    expect(askedIds(sim)).toEqual(["Q2", "Q4"]);
    expect(qaOf(sim).questions.filter((q) => q.carried !== undefined).map((q) => q.id)).toEqual(["N1", "Q1", "Q3"]);
    // The read of which base files differ ran once, over the cited files in order.
    const base = sim.evidence.flatMap((e) => ((e.payload as { command?: { id?: string; argv?: string[] } }).command?.id === "ledger-delta-base" ? [(e.payload as { command: { argv: string[] } }).command.argv.slice(4)] : []));
    expect(base).toEqual([["9".repeat(40), "fedcba9876543210fedcba9876543210fedcba98", "pkg/schema/ttl_test.go", "pkg/timestamp/duration.go"]]);
  });
});

describe("a full round 1 when there is no usable earlier Q&A", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const config = BANYANDB;
  let at: Ledgers;
  it("sets up the earlier head", async () => {
    at = await (await new LedgerRepo().init(dirs)).advance(end(incrementalRehearsal(config)), HEAD1);
  });
  /** A later head that asks every question, as a first head does, with the reason recorded and the Q&A header saying so. */
  const full = (scenario: RehearsalScenario, reason: string, cfg: Record<string, unknown> = {}): void => {
    const sim = simulate({ scenario, config: cfg, maxSteps: 400 });
    expect(stopOf(sim)?.reason).toBe("answers accepted");
    expect(agentJobs(sim, "questions")[0]).toBe("Answer the necessity question N1 from the whole codebase");
    expect(askedIds(sim)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const qa = qaOf(sim);
    expect(qa.incremental).toEqual({ full: expect.stringContaining(reason) });
    expect(qa.questions.some((q) => q.carried !== undefined)).toBe(false);
    expect(sim.qa!.markdown).toContain(`Every question was asked: ${qa.incremental!.full as string}.`);
  };
  it("is what the profile asks for with questions.incremental: false", () => {
    const off = { ...config, questions: { ...(config.questions as object), incremental: false } };
    full(onLedger(incrementalRehearsal(off), at, { delta: deltaOf() }), "the profile turns incremental review off", { questions: { ...(config.questions as object), incremental: false } });
  });
  it("is what a ledger written before 0.26 gets: it holds no necessity.json", () => {
    full(onLedger(incrementalRehearsal(config), at, { necessity: "absent" }), "holds no necessity.json (a ledger written before 0.26 has none)");
  });
  it("is what a head gets when the delta cannot be read (the earlier head's commit is not in the review clone)", () => {
    full(onLedger(incrementalRehearsal(config), at, { deltaExit: 128 }), "not in the review clone");
  });
  it("is what a head gets when the delta is cut short", () => {
    full(onLedger(incrementalRehearsal(config), at, { delta: hunkFile("pkg/quota/limit.go", "@@ -1 +1 @@") }), "cut");
  });
  it("is what a head gets when the earlier Q&A was of another mode", () => {
    full(onLedger(incrementalRehearsal(config), at, { delta: deltaOf(), qa: (qa) => void (qa.mode = "large") }), "was of large mode");
  });
});
