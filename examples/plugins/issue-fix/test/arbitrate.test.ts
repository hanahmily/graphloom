// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * issue-fix 0.17.0: Fix ⇄ Review as edges and the supervisor-only Arbitrate
 * (docs/design-issue-fix-graph.md, "Arbitrate"). A small controller stand-in
 * walks the graph over a live path and side visits as the controller does
 * (docs/design-graph-topology.md §4, §5): forward moves, reentries along
 * edges with a correction each, `enter` and the leave along an out-edge, and
 * receipts that name the evidence they accepted, so the findings ledger and
 * the validators see rulings exactly as a run shows them.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertGraphDefinition, type AgentSessionView, type EvidenceRecord, type GraphDecision, type JobSpec, type Receipt, type RunView, type StageAttempt } from "@graphloom/sdk";
import {
  acceptedRulingSources,
  applyFixerRead,
  chronological,
  checkRuling,
  createGraph,
  createIssue,
  designConflicts,
  emptyIssueTable,
  findingLedger,
  GRAPH_VERSION,
  issueFileJson,
  parseProfile,
  parseVerification,
  pinnedTexts,
  pullRequestDescription,
  shippedProfile,
  validatorById,
  writtenJson,
  type ArbiterResult,
  type DecisionRecord,
  type IssueTable,

} from "../src/index.js";
import { rehearsal } from "../src/rehearsal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BANYANDB = shippedProfile("banyandb");
const PROFILE = parseProfile(BANYANDB);
const ISSUE = 14111;
const TEST = "TestStatus";
const SCHEDULER = "pkg/timestamp/scheduler.go";
const SCHEDULER_TEST = "pkg/timestamp/scheduler_test.go";
const BASE_FILES: Record<string, string> = {
  [SCHEDULER]: "package timestamp\n\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\treturn \"timed out\"\n\t}\n\treturn \"ok\"\n}\n",
  "CHANGES.md": "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Older fix.\n",
};
const FIXED = "package timestamp\n\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\tif running {\n\t\t\treturn \"running\"\n\t\t}\n\t\treturn \"timed out\"\n\t}\n\treturn \"ok\"\n}\n";
const TEST_FILE = 'package timestamp\n\nimport "testing"\n\nfunc TestStatus(t *testing.T) {\n\tif Status(generatedLimit, true) != "running" {\n\t\tt.Fatal("not running")\n\t}\n}\n';
const CHANGES = "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Report a long-running action as running.\n- Older fix.\n";

const RECORD: DecisionRecord = {
  status: "ready",
  title: "Report long-running actions as running",
  summary: "Status reports running at the limit while the action runs.",
  change: "Status reports a still-running action at the limit as running.",
  test: { package: "./pkg/timestamp", name: TEST, expectedValueSource: "the issue's comment: report it as running" },
  productionCaller: "pkg/timestamp.Status",
  decisions: [],
  openQuestions: [],
};
const events = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");
const report = (name: string, outcome: "pass" | "fail") =>
  events({ Action: "run", Test: name }, ...(outcome === "fail" ? [{ Action: "output", Test: name, Output: "x_test.go:6: assertion failed\n" }] : []), { Action: outcome, Test: name }, { Action: outcome, Package: "p" });

const FINDING = { path: SCHEDULER, start_line: 4, end_line: 9, category: "bug", severity: "high", content: "Status reports an action still running at the limit as running, which callers cannot tell from in-time.", evidence: "A caller polling during a long backup sees running past the limit." };
const SECOND = { path: SCHEDULER_TEST, start_line: 5, end_line: 8, category: "test", severity: "high", content: "No test case covers a negative elapsed time.", evidence: "Status(-1, false) reports ok.", distinct: true };
const SUMMARY = { total_files: 3, reviewed_files: 3, skipped: [] };
const pass = (comments: object[] = [], prior: Array<[string, string]> = []) => ({ comments, prior: prior.map(([finding, status]) => ({ finding, status, reason: `${finding} ${status}` })), summary: SUMMARY });
const verdict = (finding: string, v: string, extra: Record<string, unknown> = {}) => ({ finding, verdict: v, reason: `${v} by the verifier`, quotes: v === "confirmed" ? [{ path: SCHEDULER, line: 5, text: "if running {" }] : [], designLevel: false, designBasis: "", ruling: "", ...extra });
const DESIGN_LEVEL = (finding = "F1") => verdict(finding, "confirmed", { designLevel: true, designBasis: "Whether a caller must tell running from in-time at the limit is the issue's design call." });
const COMMENT = "A running backup is not an error; report it as running.";
const ruling = (over: Partial<ArbiterResult> = {}): ArbiterResult => ({
  finding: "F1",
  ruling: "implementation-stands",
  summary: "The thread asks that a running action be reported as running, which the change does.",
  design: [{ source: "comment:1", quote: "A running backup is not an error", says: "A running action is reported as running." }],
  code: [{ path: SCHEDULER, line: 5, quote: "if running {" }],
  proofTests: [],
  undecidable: { question: "", implementation: "", review: "" },
  ...over,
});

type Reply = { output: unknown; status?: string; files?: Record<string, string>; issues?: (file: IssueFile) => void };
interface IssueFile {
  issues: Array<Record<string, unknown> & { id: string; status: string; history: object[] }>;
}
type Supervisor = (input: { trigger: "supervise" | "settled"; reason: string; view: RunView }) => GraphDecision["action"] | "return";

interface Scenario {
  results: Record<string, Reply[]>;
  supervisor?: Supervisor[];
  /** Outcomes of proof tests by test name. */
  proofs?: Record<string, "pass" | "fail">;
  /** The operator's answer to a stop for a design ruling, in order. */
  approvals?: Array<{ decision: "approve" | "decline"; inputs?: Record<string, string>; reason?: string }>;
  /** GREEN's regression outcome for each candidate-checks run (1-based), when not a pass. */
  greenFails?: number[];
  profile?: unknown;
  corrections?: number;
  maxSteps?: number;
  /** `RunView.resumeCommand`, as the controller gives it for a run its launcher manages. */
  resumeCommand?: string;
}

const digestOf = (files: Record<string, string>): string => {
  const changed = Object.entries(files)
    .filter(([p, b]) => !p.startsWith(".graphloom/") && BASE_FILES[p] !== b)
    .sort(([a], [b]) => a.localeCompare(b));
  return changed.length === 0 ? "base" : `d-${createHash("sha256").update(JSON.stringify(changed)).digest("hex").slice(0, 10)}`;
};

/** The controller, as far as these flows need it. */
function simulate(s: Scenario) {
  const config = s.profile ?? BANYANDB;
  const definition = createGraph().describe(config);
  assertGraphDefinition(definition);
  const evidence: EvidenceRecord[] = [];
  const receipts: Receipt[] = [];
  const sessions: AgentSessionView[] = [];
  const jobs: JobSpec[] = [];
  const decisions: GraphDecision[] = [];
  const supervised: Array<{ trigger: string; reason: string }> = [];
  const files: Record<string, string> = { ...BASE_FILES };
  const used: Record<string, number> = {};
  const attempts: Record<string, number> = {};
  const openAttempt: Record<string, boolean> = {};
  const approvals = [...(s.approvals ?? [])];
  const supervisor = [...(s.supervisor ?? [])];
  let pathVisits: StageAttempt[] = [{ stageId: "fix", attempt: 1 }];
  attempts.fix = 1;
  let side: StageAttempt | undefined;
  let current: StageAttempt = { stageId: "fix", attempt: 1 };
  let generation = 1;
  let seq = 0;
  let privateState: string | undefined;
  let candidates = 0;
  const budgets = { agentInvocations: 64, jobs: 200, decisions: 400, corrections: s.corrections ?? 8 };
  const next = <T>(contract: string): T => {
    const list = s.results[contract] ?? [];
    const i = used[contract] ?? 0;
    used[contract] = i + 1;
    if (list.length === 0) throw new Error(`no reply for ${contract}`);
    return list[Math.min(i, list.length - 1)] as T;
  };
  const digest = () => digestOf(files);
  const push = (kind: EvidenceRecord["kind"], payload: Record<string, unknown>, job?: JobSpec, op = `op-${seq + 1}`, withDigest = true): EvidenceRecord => {
    const e: EvidenceRecord = {
      ref: `ev-${++seq}`,
      kind,
      generation,
      ...(withDigest ? { candidateDigest: digest() } : {}),
      ...(job?.resultSchema !== undefined ? { resultSchema: job.resultSchema } : {}),
      payload:
        job === undefined
          ? payload
          : { ...payload, producer: { operationId: op, stageId: job.stageId, attempt: attempts[job.stageId] ?? 1, purpose: job.purpose, readOnly: job.readOnly === true, kind: job.kind, ...(job.executor !== undefined ? { executorId: job.executor.id } : {}) } },
    };
    evidence.push(e);
    return e;
  };
  push("command", { command: { id: "ocr", argv: ["sh"], exitCode: 0, stdoutTail: "/opt/ocr\n", stderrTail: "" }, environment: { phase: "preflight" } }, undefined, "env", false);
  const onPath = (id: string) => pathVisits.some((v) => v.stageId === id);
  const forward = (id: string) => {
    if (side !== undefined && side.stageId === id) return;
    if (onPath(id)) return;
    if (side !== undefined) throw new Error(`the graph acted for ${id} while the side visit of ${side.stageId} is open`);
    const tail = pathVisits.at(-1)!.stageId;
    if (!definition.edges!.some((e) => e.from === tail && e.to === id)) throw new Error(`undeclared edge ${tail} → ${id}`);
    attempts[id] = (attempts[id] ?? 0) + 1;
    pathVisits = [...pathVisits, { stageId: id, attempt: attempts[id]! }];
  };
  const reenter = (id: string) => {
    if (budgets.corrections <= 0) throw new Error("corrections budget exhausted");
    budgets.corrections -= 1;
    attempts[id] = (attempts[id] ?? 0) + 1;
    const at = pathVisits.findIndex((v) => v.stageId === id);
    pathVisits = [...pathVisits.slice(0, at), { stageId: id, attempt: attempts[id]! }];
    openAttempt[id] = true;
    current = { stageId: id, attempt: attempts[id]! };
    generation += 1;
  };
  const leave = (id: string) => {
    if (!definition.edges!.some((e) => e.from === side!.stageId && e.to === id)) throw new Error(`undeclared edge ${side!.stageId} → ${id}`);
    openAttempt[side!.stageId] = false;
    side = undefined;
    if (onPath(id)) reenter(id);
    else {
      forward(id);
      current = pathVisits.at(-1)!;
    }
  };
  const ask = (trigger: "supervise" | "settled", reason: string, view: RunView): void => {
    supervised.push({ trigger, reason });
    for (;;) {
      const step = supervisor.shift();
      if (step === undefined) throw new Error(`the supervisor has no decision for ${trigger}: ${reason}`);
      const action = step({ trigger, reason, view });
      if (action === "return") return;
      if (action.type === "enter") {
        if (side !== undefined) throw new Error("enter while a side visit is open");
        attempts[action.enter.stageId] = (attempts[action.enter.stageId] ?? 0) + 1;
        side = { stageId: action.enter.stageId, attempt: attempts[action.enter.stageId]! };
        openAttempt[side.stageId] = true;
        current = side;
      } else if (action.type === "reenter") {
        if (side !== undefined) leave(action.reenter.stageId);
        else reenter(action.reenter.stageId);
      } else throw new Error(`unscripted supervisor action ${action.type}`);
    }
  };
  const visible = (d: string) => {
    const seen = new Set<string>();
    return evidence
      .filter((e) => e.candidateDigest === undefined || e.candidateDigest === d)
      .reverse()
      .filter((e) => {
        const key = e.kind === "file" ? `file:${String((e.payload as { path?: unknown }).path)}` : undefined;
        if (key === undefined) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .reverse();
  };
  const identity = (r: Receipt) => (r.requirementId === "decisions-recorded" ? true : r.candidateDigest === digest());
  const view = (step: number): RunView => ({
    runId: "run",
    ...(s.resumeCommand !== undefined ? { resumeCommand: s.resumeCommand } : {}),
    task: { request: `Fix apache/skywalking#${ISSUE}.`, repo: "../banyandb" },
    current,
    receipts: receipts.map((r) => ({ ...r, valid: r.valid && identity(r) })),
    evidence: structuredClone(evidence),
    outstanding: [],
    budgets: { ...budgets },
    validatorBindings: definition.defaultValidators,
    generation,
    stateRevision: step,
    activeVersion: `issue-fix@${GRAPH_VERSION}`,
    config,
    candidateDigest: digest(),
    topology: { start: "fix", terminal: ["review"], edges: definition.edges!, implicit: false, path: structuredClone(pathVisits), ...(side !== undefined ? { sideVisit: { ...side } } : {}) },
    ...(sessions.length > 0 ? { agentSessions: structuredClone(sessions) } : {}),
    ...(privateState !== undefined ? { privateState } : {}),
    ...(Object.values(openAttempt).some(Boolean) ? { openAttempt: { ...openAttempt } } : {}),
  });

  const run = (job: JobSpec, op: string) => {
    jobs.push(job);
    forward(job.stageId);
    current = side?.stageId === job.stageId ? side : (pathVisits.find((v) => v.stageId === job.stageId) ?? current);
    const input = job.input as { commands?: Array<{ id: string; argv: string[] }> };
    if (job.executor?.id === "graphloom.github/get-issue") {
      push("other", { github: { item: { number: ISSUE, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: [], body: "Backups over five minutes log action timed out." } } }, job, op);
      return;
    }
    if (job.executor?.id === "graphloom.github/list-issue-comments") {
      push("other", { github: { items: [{ author: "maintainer", createdAt: "2026-09-01", body: COMMENT }], page: { complete: true } } }, job, op);
      return;
    }
    if (job.kind === "agent") {
      const reply = next<Reply>(job.resultSchema!);
      for (const [p, b] of Object.entries(reply.files ?? {})) files[p] = b;
      if (reply.issues !== undefined) {
        const file = JSON.parse(files[".graphloom/issues.json"]!) as IssueFile;
        reply.issues(file);
        files[".graphloom/issues.json"] = JSON.stringify(file);
      }
      if (job.purpose === "work") openAttempt[job.stageId] = false;
      const sessionRef = `${(job.input as { harness: string }).harness}-${job.continueFrom ?? op}`;
      push("other", { codingAgent: { harness: (job.input as { harness: string }).harness, status: reply.status ?? "completed", output: reply.output, sessionRef, continued: job.continueFrom !== undefined } }, job, op);
      sessions.push({ operationId: op, stageId: job.stageId, attempt: attempts[job.stageId] ?? 1, generation, dispatchKey: job.jobId ?? `${job.purpose}:${job.executor!.id}`, executorId: job.executor!.id, status: "ok", ...(job.continueFrom !== undefined ? { continuedFrom: job.continueFrom } : {}) });
      return;
    }
    const checkout = job.checkout;
    if (checkout !== undefined) {
      const changed = Object.keys(files).filter((p) => !p.startsWith(".graphloom/") && BASE_FILES[p] !== files[p]);
      const written = "write" in checkout && checkout.write !== undefined ? checkout.write.map((w) => ({ path: w.path, digest: `sha256:${createHash("sha256").update(w.content, "utf8").digest("hex")}`, bytes: Buffer.byteLength(w.content) })) : undefined;
      const green = checkout.from === "candidate" && input.commands!.some((c) => c.id === "regression");
      if (green) candidates += 1;
      for (const c of input.commands!) {
        let exitCode = 0;
        let text: string | undefined;
        if (c.id === "regression") {
          const fails = checkout.from === "base" || (s.greenFails ?? []).includes(candidates);
          text = report(TEST, fails ? "fail" : "pass");
          exitCode = fails ? 1 : 0;
        } else if (c.id === "proof-test") {
          const name = c.argv.at(-2) === undefined ? "" : (job.checkout as { write: Array<{ path: string }> }).write[0]!.path;
          const t = Object.entries(s.proofs ?? {}).find(([n]) => c.argv.join(" ").includes(n));
          const outcome = t?.[1] ?? "pass";
          text = report(t?.[0] ?? name, outcome);
          exitCode = outcome === "fail" ? 1 : 0;
        }
        const stdout = c.id === "changes-diff" ? "+- Report a long-running action as running.\n" : "";
        push(
          "command",
          {
            command: { id: c.id, argv: c.argv, exitCode, stdoutTail: stdout, stderrTail: "", ...(text !== undefined ? { report: { text, truncated: false } } : {}) },
            checkout: { from: checkout.from, base: "base-sha", commit: `c-${op}`, paths: checkout.from === "base" ? (checkout as { paths: string[] }).paths : changed, prepared: true, mutations: [], phase: "run", ...(written !== undefined ? { written } : {}) },
          },
          job,
          op,
        );
      }
      return;
    }
    for (const c of input.commands!) {
      if (c.id === "issues-write") {
        files[".graphloom/issues.json"] = writtenJson(c.argv)!;
        push("command", { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: "written\n", stderrTail: "" } }, job, op);
      } else if (c.id === "issues-read") {
        const file = files[".graphloom/issues.json"];
        push("command", { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: file === undefined ? "missing\n" : "present\n", stderrTail: "", ...(file !== undefined ? { report: { text: file, truncated: false } } : {}) } }, job, op);
      } else {
        push("command", { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: c.id === "deliver" ? "abc\n" : "", stderrTail: "", ...(c.id === "deliver" ? { report: { text: c.argv.slice(6 + Number(c.argv[5])).join(""), truncated: false } } : {}) } }, job, op);
      }
    }
  };

  const max = s.maxSteps ?? 200;
  for (let step = 0; step < max; step += 1) {
    const v = view(step);
    const decision = createGraph().advance(v);
    decisions.push(decision);
    if (decision.privateState !== undefined) privateState = decision.privateState;
    const action = decision.action;
    const op = `op-${step}`;
    if (action.type === "dispatch") run(action.job, op);
    else if (action.type === "observe") {
      for (const p of action.observe.paths ?? []) push("file", { path: p, bytes: files[p] ?? "" });
    } else if (action.type === "validate") {
      const id = action.validate.stageId;
      forward(id);
      const stage = definition.stages.find((x) => x.id === id)!;
      const d = digest();
      const results = stage.requirementIds.map((requirementId) => {
        const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
        const result = validatorById(binding.validatorId)!.evaluate({
          requirementId,
          statement: "s",
          evidence: visible(d),
          history: evidence.filter((e) => e.candidateDigest !== undefined && e.candidateDigest !== d),
          candidateDigest: d,
          config,
          request: v.task.request,
          receipts: v.receipts,
          validatorBindings: definition.defaultValidators,
        });
        return { requirementId, binding, result };
      });
      const failure = results.find((r) => r.result.status !== "passed");
      openAttempt[id] = false;
      if (failure !== undefined) throw new Error(`validate ${id} failed: ${failure.requirementId}: ${failure.result.reason}`);
      for (const r of results) {
        for (const old of receipts) if (old.requirementId === r.requirementId) old.valid = false;
        receipts.push({ id: `rcpt-${receipts.length + 1}`, stageId: id, requirementId: r.requirementId, validatorBinding: r.binding, candidateFingerprint: "fp", evidenceRefs: visible(d).map((e) => e.ref), valid: true, candidateDigest: d });
      }
      if (side?.stageId === id) ask("settled", results.map((r) => r.result.reason).join("; "), view(step));
    } else if (action.type === "reenter") {
      if (side !== undefined) throw new Error("the graph reentered while a side visit is open");
      const tail = pathVisits.at(-1)!.stageId;
      if (action.reenter.stageId !== tail && !definition.edges!.some((e) => e.from === tail && e.to === action.reenter.stageId)) throw new Error(`undeclared edge ${tail} → ${action.reenter.stageId}`);
      reenter(action.reenter.stageId);
    } else if (action.type === "supervise") {
      ask("supervise", action.supervise.reason, v);
    } else if (action.type === "stop" && action.stop.reason === "design ruling needs the operator" && approvals.length > 0) {
      const a = approvals.shift()!;
      generation += 1;
      push("other", { type: "operator-approval", approvalId: "design-ruling", decision: a.decision, files: [], ...(a.inputs !== undefined ? { inputs: a.inputs } : {}), ...(a.reason !== undefined ? { reason: a.reason } : {}), operator: "maintainer", at: "t", generation }, undefined, "op-approval", false);
    } else {
      const deliver = jobs.find((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === "deliver");
      const body = deliver !== undefined ? (() => {
        const argv = (deliver.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
        return argv.slice(6 + Number(argv[5])).join("");
      })() : undefined;
      return { decision, decisions, jobs, evidence, receipts, supervised, path: pathVisits.map((p) => p.stageId), side, budgets, files, body, ledger: findingLedger(evidence, { receipts, bindings: definition.defaultValidators, profile: parseProfile(config) }) };
    }
  }
  throw new Error(`the graph did not finish in ${max} steps`);
}

const PLAN_AND_FIX = (files: Record<string, string> = {}): Reply[] => [
  { output: RECORD },
  { output: RECORD, files: { [SCHEDULER]: FIXED, [SCHEDULER_TEST]: TEST_FILE, "CHANGES.md": CHANGES, ...files } },
];
const enter: Supervisor = () => ({ type: "enter", enter: { stageId: "arbitrate", reason: "a design conflict" } });
const back: Supervisor = () => "return";
const leaveTo = (to: string): Supervisor => () => ({ type: "reenter", reenter: { stageId: to, reason: `leave to ${to}` } });
const assignmentOf = (job: JobSpec) => (job.input as { assignment: string }).assignment;
const arbiterJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "arbitrate" && j.kind === "agent");

describe("issue-fix 0.17.0 topology", () => {
  it("declares Fix ⇄ Review as edges and the supervisor-only Arbitrate with its approval and contracts", async () => {
    const d = createGraph().describe(BANYANDB);
    expect(() => assertGraphDefinition(d)).not.toThrow();
    // The graph's version comes from its one source of truth, which `release.sh prepare` may bump (docs/design-release.md §3).
    expect(d.version).toBe(GRAPH_VERSION);
    expect(d.stages.find((s) => s.id === "arbitrate")).toEqual({ id: "arbitrate", name: "Arbitrate", requirementIds: ["design-ruling"], entry: "supervisor", maxVisits: 6 });
    expect(d.edges).toEqual([
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arbitrate", to: "fix" },
      { from: "arbitrate", to: "review" },
    ]);
    expect(d).toMatchObject({ start: "fix", terminal: ["review"] });
    expect(d.approvals).toEqual([
      {
        id: "design-ruling",
        stageId: "arbitrate",
        description: "Rule on a design question the arbiter could not decide",
        inputs: [
          { name: "finding", pattern: "[FI][0-9]+" },
          { name: "ruling", pattern: "implementation-stands|review-stands" },
          { name: "note", description: "The design basis, in a sentence or two" },
        ],
      },
    ]);
    expect(d.resultContracts!.map((c) => [c.name, c.evidenceKind])).toEqual([
      ["decision-record-v2", "other"],
      ["finding-verification-v2", "other"],
      ["code-review-v2", "review"],
      ["design-ruling-v1", "other"],
    ]);
    expect(d.requirements.find((r) => r.id === "code-review")!.prerequisiteRequirementIds).toEqual(["design-ruling"]);
    expect(d.defaultValidators.filter((b) => ["code-review", "design-ruling"].includes(b.requirementId))).toEqual([
      { requirementId: "code-review", validatorId: "open-code-review", version: "3" },
      { requirementId: "design-ruling", validatorId: "design-ruling", version: "1" },
    ]);
    // maxVisits follows review.maxRulings: three more points the operator rules on after the cap.
    expect(createGraph().describe({ ...(BANYANDB as object), review: { ...(BANYANDB as { review: object }).review, maxRulings: 0 } }).stages.at(-1)!.maxVisits).toBe(3);
    const manifest = JSON.parse(await readFile(path.join(here, "../graphloom.manifest.json"), "utf8")) as { sdkProtocol: number; version: string };
    expect(manifest).toMatchObject({ sdkProtocol: 2, version: GRAPH_VERSION });
    const pkg = JSON.parse(await readFile(path.join(here, "../package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(GRAPH_VERSION);
  });

  it("defaults and checks the arbiter's profile fields, and every shipped profile sets the arbiter", () => {
    const minimal = structuredClone(BANYANDB) as { harnesses: Record<string, string>; review: Record<string, unknown> };
    delete minimal.harnesses.arbiter;
    delete minimal.review.arbiter;
    const p = parseProfile(minimal);
    expect(p.roles.arbiter).toBe("codex");
    expect(p.arbiter).toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(p.maxRulings).toBe(3);
    for (const name of ["banyandb", "banyandb-ql", "canopy", "graphloom"] as const) {
      const raw = shippedProfile(name) as { harnesses: { arbiter?: string }; review: { arbiter?: object } };
      expect(raw.harnesses.arbiter, name).toBe("codex");
      expect(raw.review.arbiter, name).toEqual({ model: "gpt-6-astra", effort: "high" });
    }
    expect(() => parseProfile({ ...minimal, review: { ...minimal.review, maxRulings: 62 } })).toThrow(/maxRulings/);
    expect(() => parseProfile({ ...minimal, review: { ...minimal.review, arbiter: { effort: "high" } } })).toThrow(/review.arbiter.model/);
    expect(() => parseProfile({ ...minimal, harnesses: { ...minimal.harnesses, arbiter: "gpt" } })).toThrow(/harnesses.arbiter/);
    expect(() => parseProfile({ ...minimal, review: { ...minimal.review, principles: { path: "../x.md" } } })).toThrow(/principles.path/);
  });
});

describe("a design conflict the review raises", () => {
  const scenario = (arbiter: Reply[], extra: Partial<Scenario> = {}): Scenario => ({
    results: {
      "decision-record-v2": PLAN_AND_FIX(),
      "code-review-v2": [{ output: pass([FINDING]) }, { output: pass([], [["F1", "still_present"]]) }, { output: pass() }],
      "finding-verification-v2": [{ output: { verdicts: [DESIGN_LEVEL()] } }],
      "design-ruling-v1": arbiter,
    },
    supervisor: [enter, back, leaveTo("review"), back],
    ...extra,
  });

  it("hands over from Review, rules implementation-stands, and Review's next pass is given the ruling (arbitrate-review)", () => {
    const sim = simulate(scenario([{ output: ruling() }]));
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(sim.path).toEqual(["fix", "review"]);
    // A design-level confirmation is disputed, never sent to Fix: no implementer run after the first.
    expect(sim.jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
    const handover = sim.supervised[0]!;
    expect(handover.trigger).toBe("supervise");
    expect(handover.reason).toContain("I1 pkg/timestamp/scheduler.go:4-9");
    expect(handover.reason).toContain("the verifier judged it at the design level: Whether a caller must tell running from in-time");
    expect(handover.reason).toContain("enter arbitrate from Review");
    // The arbiter: a fresh read-only review job on the profile's arbiter harness, model and effort.
    const [arbiter] = arbiterJobs(sim.jobs);
    expect(arbiter).toMatchObject({ jobId: "arbiter", purpose: "review", readOnly: true, resultSchema: "design-ruling-v1", input: { harness: "codex", harnessOptions: { model: "gpt-6-astra", effort: "high" } } });
    expect(arbiter!.continueFrom).toBeUndefined();
    // The point is pinned first, the citation observed before the validation.
    const pointJob = sim.jobs.find((j) => j.stageId === "arbitrate" && j.kind === "command")!;
    expect((pointJob.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv.at(-1)).toBe("F1");
    expect(sim.supervised[1]).toMatchObject({ trigger: "settled" });
    expect(sim.supervised[1]!.reason).toContain("leave along arbitrate → review");
    // Review ran again on the same change, and its pass was told the ruling.
    const passes = sim.jobs.filter((j) => j.stageId === "review" && j.purpose === "review");
    expect(passes).toHaveLength(3);
    expect(assignmentOf(passes[2]!)).toContain("Design rulings that hold in this run");
    expect(assignmentOf(passes[2]!)).toContain("R1 on I1: implementation-stands");
    // The ledger: R1 dismissed F1, its issue dismissed by the arbiter.
    expect(sim.ledger.rulings.map((r) => [r.id, r.finding, r.decision, r.decider.kind])).toEqual([["R1", "F1", "implementation-stands", "arbiter"]]);
    const issue = sim.ledger.issues.issues.find((i) => i.id === "I1")!;
    expect(issue).toMatchObject({ status: "dismissed", ruling: "R1" });
    expect(issue.history.at(-1)).toMatchObject({ actor: "arbiter", from: null, to: "dismissed" });
    // The pull request's Design rulings section.
    expect(sim.body).toContain("## Design rulings");
    expect(sim.body).toContain("**R1** on I1: `implementation-stands`, decided by an independent arbiter (Codex, gpt-6-astra)");
    expect(sim.body).toContain('Design (comment:1): "A running backup is not an error"');
    expect(sim.body).toContain("Code: pkg/timestamp/scheduler.go:5 `if running {`");
    // Leaving to Review was a reentry: one correction.
    expect(sim.budgets.corrections).toBe(7);
  });

  it("revises once, continuing the arbiter's own session, when a citation does not match", () => {
    const wrong = ruling({ code: [{ path: SCHEDULER, line: 5, quote: "return \"never written\"" }] });
    const sim = simulate(scenario([{ output: wrong }, { output: ruling() }]));
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const [first, revision] = arbiterJobs(sim.jobs);
    expect(revision!.continueFrom).toBeDefined();
    expect(assignmentOf(revision!)).toContain("Your ruling did not verify");
    expect(assignmentOf(revision!)).toContain("code citation 1's quote is not within three lines of pkg/timestamp/scheduler.go:5");
    expect(first!.continueFrom).toBeUndefined();
  });

  it("asks the operator after a second failure, with the question, both cases and the two commands", () => {
    const wrong = ruling({ design: [{ source: "comment:1", quote: "nothing the thread says", says: "x" }] });
    const sim = simulate(scenario([{ output: wrong }]));
    expect(arbiterJobs(sim.jobs)).toHaveLength(2);
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "design ruling needs the operator", retryable: false } });
    const blocker = (sim.decision.action as { stop: { blocker: string } }).stop.blocker;
    expect(blocker).toContain("did not verify after one revision");
    expect(blocker).toContain("graphloom resume run --approve design-ruling --input finding=F1 --input ruling=review-stands");
    expect(blocker).toContain("graphloom resume run --decline design-ruling");
    expect(sim.side).toMatchObject({ stageId: "arbitrate" });
  });

  it("names the run's own resume command in the blocker: a hub run's is the hub's", () => {
    const wrong = ruling({ design: [{ source: "comment:1", quote: "nothing the thread says", says: "x" }] });
    const sim = simulate({ ...scenario([{ output: wrong }]), resumeCommand: "graphloom hub resume s-1" });
    const blocker = (sim.decision.action as { stop: { blocker: string } }).stop.blocker;
    expect(blocker).toContain("Rule on it: graphloom hub resume s-1 --approve design-ruling --input finding=F1 --input ruling=review-stands");
    expect(blocker).toContain("graphloom hub resume s-1 --decline design-ruling");
    expect(blocker).not.toContain("graphloom resume");
  });

  const undecidable = ruling({ ruling: "undecidable", design: [], code: [], undecidable: { question: "Must a caller tell running at the limit from in-time?", implementation: "The thread asks for running.", review: "A caller cannot tell." } });

  it("waits on the operator for an undecidable point, and an approval for that finding settles it (undecidable → approve)", () => {
    const s = scenario([{ output: undecidable }], { approvals: [{ decision: "approve", inputs: { finding: "F1", ruling: "review-stands", note: "The status must tell a caller the action is past its limit." } }], supervisor: [enter, back, leaveTo("fix"), back] });
    // Back in Fix the implementer addresses the finding, and the next pass finds it resolved.
    s.results["decision-record-v2"] = [...PLAN_AND_FIX(), { output: RECORD, files: { [SCHEDULER]: `${FIXED}// tells a caller the action is past its limit\n` } }];
    s.results["code-review-v2"] = [{ output: pass([FINDING]) }, { output: pass([], [["F1", "still_present"]]) }, { output: pass([], [["I1", "resolved"]]) }];
    const sim = simulate(s);
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(sim.decisions.some((d) => d.action.type === "stop" && d.action.stop.reason === "design ruling needs the operator" && d.action.stop.blocker.includes("Must a caller tell running"))).toBe(true);
    expect(sim.body).toContain("**R1** on I1: `review-stands`, decided by the operator (maintainer). The status must tell a caller the action is past its limit.");
    // The operator's review-stands ruling sent the run back to Fix with the finding confirmed and the ruling as its witness.
    expect(sim.ledger.rulings.map((r) => [r.id, r.decision, r.decider.kind])).toEqual([["R1", "review-stands", "operator"]]);
    const fixes = sim.jobs.filter((j) => j.purpose === "work");
    expect(fixes.length).toBeGreaterThan(1);
    expect(assignmentOf(fixes[1]!)).toContain("R1 on I1: review-stands, decided by the operator (maintainer)");
    expect(assignmentOf(fixes[1]!)).toContain("The finding stands: fix it; it cannot be contested again.");
  });

  it("stops again when the approval names another finding than the one waiting", () => {
    const sim = simulate(scenario([{ output: undecidable }], { approvals: [{ decision: "approve", inputs: { finding: "F7", ruling: "review-stands", note: "x" } }] }));
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "design ruling needs the operator" } });
    expect((sim.decision.action as { stop: { blocker: string } }).stop.blocker).toContain("the operator's approval names I7, but the design point waiting is I1");
  });

  it("defers a declined point: it no longer blocks, and the pull request lists it as an open design question", () => {
    const sim = simulate(scenario([{ output: undecidable }], { approvals: [{ decision: "decline", reason: "A product question for the maintainers." }] }));
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(sim.ledger.deferred.map((d) => d.finding)).toEqual(["F1"]);
    expect(sim.ledger.issues.issues.find((i) => i.id === "I1")).toMatchObject({ status: "deferred" });
    expect(sim.body).toContain("## Open design questions");
    expect(sim.body).toContain("- I1: Must a caller tell running at the limit from in-time?");
    expect(sim.body).toContain("The operator: A product question for the maintainers.");
  });

  it("sends every point to the operator once the run holds review.maxRulings arbiter rulings", () => {
    const capped = { ...(BANYANDB as object), review: { ...(BANYANDB as { review: object }).review, maxRulings: 0 } };
    const sim = simulate(scenario([{ output: ruling() }], { profile: capped }));
    expect(arbiterJobs(sim.jobs)).toHaveLength(0);
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "design ruling needs the operator" } });
    expect((sim.decision.action as { stop: { blocker: string } }).stop.blocker).toContain("its review.maxRulings of 0");
  });
});

describe("a design conflict the fixer raises", () => {
  /** Round 1 confirms F1 and F2; the graph sends Fix back; the fixer fixes I1 and contests I2. */
  const contest = (note = 'The issue scopes the change to long actions: "Backups over five minutes log action timed out."') => (file: IssueFile) => {
    const i1 = file.issues.find((i) => i.id === "I1")!;
    const i2 = file.issues.find((i) => i.id === "I2")!;
    i1.history.push({ actor: "fixer", from: i1.status, to: "fixed", note: "Fixed at scheduler.go:5." });
    i1.status = "fixed";
    i2.history.push({ actor: "fixer", from: i2.status, to: "design-conflict", note });
    i2.status = "design-conflict";
  };
  const PROOF = { path: "pkg/timestamp/arbiter_proof_test.go", name: "TestArbiterNegative", content: "package timestamp\n", expect: "fail" as const, shows: "Status(-1, false) is ok." };
  const SECOND_CITE = [{ path: SCHEDULER_TEST, line: 5, quote: "func TestStatus(t *testing.T) {" }];
  const scenario = (arbiter: ArbiterResult, after: Reply[], reviews: object[], supervisor: Supervisor[], extra: Partial<Scenario> = {}): Scenario => ({
    results: {
      "decision-record-v2": [
        ...PLAN_AND_FIX(),
        { output: RECORD, files: { [SCHEDULER]: `${FIXED}// evaluated per call\n` }, issues: contest() },
        ...after,
      ],
      "code-review-v2": [{ output: pass([FINDING, SECOND]) }, { output: pass([], [["F1", "still_present"], ["F2", "still_present"]]) }, ...reviews.map((output) => ({ output }))],
      "finding-verification-v2": [{ output: { verdicts: [verdict("F1", "confirmed"), verdict("F2", "confirmed", { quotes: [{ path: SCHEDULER_TEST, line: 5, text: "func TestStatus(t *testing.T) {" }] })] } }],
      "design-ruling-v1": [{ output: arbiter }],
    },
    supervisor,
    proofs: { TestArbiterNegative: "fail" },
    ...extra,
    profile: { ...(BANYANDB as object), review: { ...(BANYANDB as { review: object }).review, maxReentries: 4 } },
  });

  it("hands over from an accepted Fix; review-stands with a proof test sends it back to Fix, which fixes it (arbitrate-fixer)", () => {
    const sim = simulate(
      scenario(
        ruling({ finding: "F2", ruling: "review-stands", design: [{ source: "issue", quote: "Backups over five minutes", says: "The status of elapsed time is the issue." }], code: SECOND_CITE, proofTests: [PROOF] }),
        [{ output: RECORD, files: { [SCHEDULER_TEST]: `${TEST_FILE}// negative case\n` }, issues: (file) => {
          const i2 = file.issues.find((i) => i.id === "I2")!;
          i2.history.push({ actor: "fixer", from: i2.status, to: "fixed", note: "Covered a negative elapsed time." });
          i2.status = "fixed";
        } }],
        [pass([], [["I1", "resolved"], ["I2", "resolved"]])],
        [enter, back, leaveTo("fix"), back],
      ),
    );
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(sim.path).toEqual(["fix", "review"]);
    // The hand-over came from Fix, after Fix was accepted on its other work.
    const at = sim.decisions.findIndex((d) => d.action.type === "supervise");
    const fixValidations = sim.decisions.slice(0, at).filter((d) => d.action.type === "validate" && d.action.validate.stageId === "fix");
    expect(fixValidations.length).toBe(2);
    expect(sim.supervised[0]!.reason).toContain("Fix is accepted on its other work, and the fixer contests 1 finding(s)");
    expect(sim.supervised[0]!.reason).toContain("I2 pkg/timestamp/scheduler_test.go:5-8");
    expect(sim.supervised[0]!.reason).toContain("the fixer contests it: The issue scopes the change to long actions");
    // The proof test ran in a checkout of the candidate with the test added, under the profile's runner.
    const proof = sim.jobs.find((j) => j.stageId === "arbitrate" && j.checkout !== undefined)!;
    expect(proof.checkout).toEqual({ from: "candidate", write: [{ path: PROOF.path, content: PROOF.content }] });
    expect((proof.input as { commands: Array<{ id: string; argv: string[] }> }).commands[0]).toMatchObject({ id: "proof-test", argv: PROFILE.runner.argv({ package: "./pkg/timestamp", name: "TestArbiterNegative" }) });
    // Leaving to Fix is a reentry; the fixer is told the ruling.
    const fixes = sim.jobs.filter((j) => j.purpose === "work");
    expect(assignmentOf(fixes.at(-1)!)).toContain("R1 on I2: review-stands");
    expect(sim.ledger.issues.issues.find((i) => i.id === "I2")!.history.map((h) => `${h.actor}:${h.to}`)).toEqual(["verifier:open", "fixer:design-conflict", "arbiter:open", "fixer:fixed", "reviewer:done"]);
    expect(sim.body).toContain("Proof test `TestArbiterNegative` (pkg/timestamp/arbiter_proof_test.go, expected to fail)");
    expect(sim.body).toContain("failed by assertion on the candidate, as claimed");
  });

  it("implementation-stands leaves to Review as a forward move, with no correction spent (arbitrate-fixer-stands)", () => {
    let before = -1;
    const sim = simulate(
      scenario(
        ruling({ finding: "F2", design: [{ source: "issue", quote: "Backups over five minutes", says: "The change is about long actions." }], code: SECOND_CITE }),
        [],
        [pass([], [["I1", "resolved"]])],
        [enter, back, ({ view }) => ((before = view.budgets.corrections), { type: "reenter", reenter: { stageId: "review", reason: "implementation stands" } }), back],
      ),
    );
    expect(sim.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(sim.path).toEqual(["fix", "review"]);
    expect(sim.budgets.corrections).toBe(before);
    expect(sim.ledger.issues.issues.find((i) => i.id === "I2")).toMatchObject({ status: "dismissed", ruling: "R1" });
    expect(sim.ledger.findings.find((f) => f.id === "F2")).toMatchObject({ state: "dismissed", ruling: "R1" });
  });

  it("corrects a failing Fix check before handing the conflict over", () => {
    const sim = simulate({
      ...scenario(ruling({ finding: "F2", design: [{ source: "issue", quote: "Backups over five minutes", says: "x" }], code: SECOND_CITE }), [{ output: RECORD, files: { [SCHEDULER]: `${FIXED}// evaluated per call, twice\n` } }], [pass([], [["I1", "resolved"]])], [enter, back, leaveTo("review"), back]),
      greenFails: [2],
    });
    const at = sim.decisions.findIndex((d) => d.action.type === "supervise");
    const works = sim.decisions.slice(0, at).filter((d) => d.action.type === "dispatch" && d.action.job.purpose === "work");
    // The plan's implementation, the review correction, and the correction of the failed GREEN, all before the hand-over.
    expect(works).toHaveLength(3);
    expect(assignmentOf((works[2]!.action as { job: JobSpec }).job)).toContain("Your last change did not pass");
  });
});

describe("rulings in the findings ledger", () => {
  const D1 = "d1";
  const D2 = "d2";
  let n = 0;
  const rec = (kind: EvidenceRecord["kind"], payload: Record<string, unknown>, digest?: string, producer?: Record<string, unknown>): EvidenceRecord => ({
    ref: `r${++n}`,
    kind,
    ...(digest !== undefined ? { candidateDigest: digest } : {}),
    payload: { ...payload, ...(producer !== undefined ? { producer } : {}) },
  });
  const agent = (stageId: string, purpose: string, output: unknown, digest: string) =>
    rec("other", { codingAgent: { harness: "codex", status: "completed", output } }, digest, { operationId: `op${n}`, stageId, attempt: 1, purpose, readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" });
  const file = (bytes: string, digest: string) => rec("file", { path: SCHEDULER, bytes }, digest);
  const point = (finding: string, digest: string) => rec("command", { command: { id: "design-point", argv: ["sh", "-c", "x", "design-point", finding], exitCode: 0, stdoutTail: "", stderrTail: "" } }, digest, { operationId: "p", stageId: "arbitrate", attempt: 1, purpose: "diagnostic", readOnly: true, kind: "command" });
  const receiptFor = (refs: EvidenceRecord[], version = "1"): Receipt => ({ id: `rc${n}`, stageId: "arbitrate", requirementId: "design-ruling", validatorBinding: { requirementId: "design-ruling", validatorId: "design-ruling", version }, candidateFingerprint: "f", evidenceRefs: refs.map((e) => e.ref), valid: true });

  const base = () => {
    const evidence = [
      agent("review", "review", pass([FINDING]), D1),
      agent("review", "diagnostic", { verdicts: [DESIGN_LEVEL()] }, D1),
      file(FIXED, D1),
      point("F1", D1),
      agent("arbitrate", "review", ruling(), D1),
    ];
    return { evidence, receipts: [receiptFor(evidence)] };
  };

  it("counts a ruling only on a design-ruling receipt minted under the binding admitted now", () => {
    const { evidence, receipts } = base();
    expect(findingLedger(evidence, { receipts }).rulings.map((r) => r.id)).toEqual(["R1"]);
    expect(findingLedger(evidence).rulings).toEqual([]);
    expect(findingLedger(evidence, { receipts, bindings: [{ requirementId: "design-ruling", validatorId: "design-ruling", version: "2" }] }).rulings).toEqual([]);
    expect(designConflicts(findingLedger(evidence))).toHaveLength(1);
    expect(designConflicts(findingLedger(evidence, { receipts }))).toHaveLength(0);
  });

  it("keeps a finding dismissed when a later pass raises it by name while the cited lines match, and verifies it again once they change", () => {
    const { evidence, receipts } = base();
    const unchanged = [...evidence, agent("review", "review", pass([{ ...FINDING, finding: "I1" }]), D2), file(FIXED, D2)];
    expect(findingLedger(unchanged, { receipts }).findings[0]).toMatchObject({ state: "dismissed", ruling: "R1" });
    const changed = [...evidence, agent("review", "review", pass([{ ...FINDING, finding: "I1" }]), D2), file(FIXED.replace("if running {", "if busy {"), D2)];
    const lapsed = findingLedger(changed, { receipts }).findings[0]!;
    expect(lapsed.state).toBe("pending");
    expect(lapsed.ruling).toBeUndefined();
  });

  it("dismisses a new comment on the ruled point when the verifier refutes it citing the ruling, on the ruling's own citations", () => {
    const { evidence, receipts } = base();
    const again = [
      ...evidence,
      agent("review", "review", pass([{ ...FINDING, start_line: 30, end_line: 31, content: "Running at the limit is indistinguishable." }]), D2),
      file(FIXED, D2),
      agent("review", "diagnostic", { verdicts: [verdict("F2", "refuted", { ruling: "R1" })] }, D2),
    ];
    const ledger = findingLedger(again, { receipts });
    expect(ledger.findings[1]).toMatchObject({ id: "F2", state: "dismissed", ruling: "R1" });
    expect(ledger.findings[1]!.refutation!.reason).toContain("(design ruling R1)");
  });

  it("applies a ruling to the finding a later pass names when the view lacks the pass that raised it (a validator's view)", () => {
    const { evidence, receipts } = base();
    // The controller shows a validator only the candidate's latest review pass: the one that raised F1 is gone.
    const partial = [...evidence.slice(1), agent("review", "review", pass([{ ...FINDING, finding: "I1" }]), D1)];
    const ledger = findingLedger(partial, { receipts });
    expect(ledger.findings.map((f) => [f.id, f.state, f.ruling])).toEqual([["F1", "dismissed", "R1"]]);
    expect(ledger.issues.issues.find((i) => i.id === "I1")).toMatchObject({ status: "dismissed", ruling: "R1" });
    // A new comment after it is numbered past it.
    const more = findingLedger([...partial, agent("review", "review", pass([SECOND]), D1)], { receipts });
    expect(more.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    // An unrelated finding in the view's only pass does not take the id a waiting ruling reserves.
    const unrelated = findingLedger([...evidence.slice(1), agent("review", "review", pass([SECOND]), D1)], { receipts });
    expect(unrelated.findings.map((f) => f.id)).toEqual(["F2"]);
  });

  it("keeps a declined point deferred in a validator's view that lacks the pass that raised it", () => {
    const decline = rec("other", { type: "operator-approval", approvalId: "design-ruling", decision: "decline", files: [], operator: "op", at: "t", generation: 2 });
    const evidence = [agent("review", "review", pass([FINDING]), D1), agent("review", "diagnostic", { verdicts: [DESIGN_LEVEL()] }, D1), point("F1", D1), decline];
    const receipts = [receiptFor(evidence)];
    expect(findingLedger(evidence, { receipts }).findings[0]).toMatchObject({ id: "F1", state: "deferred" });
    const partial = [...evidence.slice(1), agent("review", "review", pass([{ ...FINDING, finding: "I1" }]), D1)];
    const ledger = findingLedger(partial, { receipts });
    expect(ledger.findings.map((f) => [f.id, f.state])).toEqual([["F1", "deferred"]]);
    expect(ledger.deferred.map((d) => d.finding)).toEqual(["F1"]);
  });

  it("lapses a review-stands ruling once a pass sees the lines it cites changed", () => {
    const evidence = [
      agent("review", "review", pass([FINDING]), D1),
      agent("review", "diagnostic", { verdicts: [DESIGN_LEVEL()] }, D1),
      file(FIXED, D1),
      point("F1", D1),
      agent("arbitrate", "review", ruling({ ruling: "review-stands" }), D1),
    ];
    const receipts = [receiptFor(evidence)];
    expect(findingLedger(evidence, { receipts }).findings[0]).toMatchObject({ state: "confirmed", ruling: "R1" });
    const same = [...evidence, file(FIXED, D2), agent("review", "review", pass([], [["I1", "still_present"]]), D2)];
    expect(findingLedger(same, { receipts }).findings[0]!.ruling).toBe("R1");
    const changed = [...evidence, file(FIXED.replace("if running {", "if busy {"), D2), agent("review", "review", pass([], [["I1", "still_present"]]), D2)];
    const lapsed = findingLedger(changed, { receipts }).findings[0]!;
    expect(lapsed).toMatchObject({ state: "confirmed" });
    expect(lapsed.ruling).toBeUndefined();
  });

  it("orders a validator's history and evidence by the run's record sequence, so an older approval is not taken for the newest decision", () => {
    const seqRef = (e: EvidenceRecord, seq: number): EvidenceRecord => ({ ...e, ref: `ev-g1-${seq}-abcd` });
    const old = seqRef({ ...rec("other", { type: "operator-approval", approvalId: "design-ruling", decision: "approve", files: [], inputs: { finding: "F1", ruling: "review-stands", note: "n" }, operator: "op", at: "t", generation: 1 }) }, 5);
    const later = seqRef(agent("arbitrate", "review", ruling({ finding: "F2" }), D2), 9);
    // History (another candidate) first, then the live candidate's records and every record without one, as the controller passes them.
    const given = [later, old];
    expect(chronological(given).map((e) => e.ref)).toEqual([old.ref, later.ref]);
    const receipt: Receipt = { ...receiptFor([old, later]), id: "rc-later" };
    expect([...acceptedRulingSources(chronological(given), { receipts: [receipt] })]).toEqual([[later.ref, "rc-later"]]);
  });

  it("reads finding-verification-v2's design fields, and a v1 verdict as not design-level", () => {
    const parsed = parseVerification({ verdicts: [DESIGN_LEVEL(), { finding: "F2", verdict: "refuted", reason: "r", quotes: [] }] });
    expect("verdicts" in parsed && parsed.verdicts.get("F1")).toMatchObject({ designLevel: true, designBasis: expect.stringContaining("design call") });
    expect("verdicts" in parsed && parsed.verdicts.get("F2")!.designLevel).toBeUndefined();
  });
});

describe("design-ruling-v1 checks", () => {
  const evidence: EvidenceRecord[] = [
    { ref: "i", kind: "other", payload: { github: { item: { number: ISSUE, title: "T", state: "open", url: "u", labels: [], body: "Backups over five minutes log action timed out." } }, producer: { operationId: "o", stageId: "fix", purpose: "diagnostic", readOnly: true, kind: "command", executorId: "graphloom.github/get-issue" } } },
    { ref: "c", kind: "other", payload: { github: { items: [{ author: "m", createdAt: null, body: COMMENT }], page: { complete: true } }, producer: { operationId: "o2", stageId: "fix", purpose: "diagnostic", readOnly: true, kind: "command", executorId: "graphloom.github/list-issue-comments" } } },
    { ref: "f", kind: "file", candidateDigest: "d", payload: { path: SCHEDULER, bytes: FIXED } },
  ];
  const files = new Map([[`d\n${SCHEDULER}`, FIXED]]);
  const pinned = pinnedTexts(evidence, PROFILE, { number: ISSUE, title: "T", state: "open", url: "u", body: "Backups over five minutes log action timed out.", labels: [] });
  const check = (r: ArbiterResult, changed: string[] = []) => checkRuling(r, { point: "F1", pinned, files, digest: "d", changed, profile: PROFILE });

  it("verifies design quotes against the pinned texts and code citations against the candidate", () => {
    expect(pinned.map((p) => p.source)).toEqual(["issue", "comment:1"]);
    expect(check(ruling())).toEqual({ problems: [], observe: [] });
    expect(check(ruling({ design: [{ source: "comment:1", quote: "short", says: "x" }] })).problems[0]).toContain("design statement 1's quote is not in comment:1");
    expect(check(ruling({ design: [{ source: "doc:design.md", quote: "A running backup is not an error", says: "x" }] })).problems[0]).toContain("which the run did not pin");
    expect(check(ruling({ code: [{ path: SCHEDULER, line: 40, quote: "if running {" }] })).problems[0]).toContain("code citation 1's quote is not within three lines");
    expect(check(ruling({ code: [{ path: "pkg/other.go", line: 1, quote: "package other" }] })).observe).toEqual(["pkg/other.go"]);
    expect(check(ruling({ design: [] })).problems[0]).toContain("at least one design statement");
    expect(check(ruling({ finding: "F2" })).problems[0]).toContain("the point to settle is F1");
    expect(check(ruling({ ruling: "undecidable" })).problems[0]).toContain("undecidable ruling states the question");
  });

  it("holds proof tests to new test paths outside the change", () => {
    const t = { path: "pkg/timestamp/proof_test.go", name: "TestProof", content: "package timestamp\n", expect: "fail" as const, shows: "x" };
    expect(check(ruling({ proofTests: [t] })).problems).toEqual([]);
    expect(check(ruling({ proofTests: [{ ...t, path: "pkg/timestamp/proof.go" }] })).problems[0]).toContain("not a test path");
    expect(check(ruling({ proofTests: [t] }), [t.path]).problems[0]).toContain("the candidate changes that path");
    expect(check(ruling({ proofTests: [{ ...t, path: "../proof_test.go" }] })).problems[0]).toContain(". or .. segment");
    expect(check(ruling({ proofTests: [t, { ...t, path: "a_test.go" }, { ...t, path: "b_test.go" }] })).problems).toContain("more than 2 proof tests");
  });
});

describe("the issues file with design conflicts", () => {
  const table = (): IssueTable => {
    const t = emptyIssueTable();
    createIssue(t, { id: "F1", comment: FINDING }, { status: "open", actor: "verifier", note: "confirmed", raisedIn: 1, ctx: { round: 1, digest: "d1", ref: "e1" } });
    t.written = new Map(t.issues.map((i) => [i.id, structuredClone(i)]));
    return t;
  };
  const read = (t: IssueTable, edit: (f: IssueFile) => void, ruled?: string) => {
    const file = JSON.parse(issueFileJson(t)) as IssueFile;
    edit(file);
    applyFixerRead(t, { present: true, text: JSON.stringify(file) }, { round: 2, digest: "d2", ref: "e2" }, () => ruled);
    return t;
  };
  const contest = (note: string) => (f: IssueFile) => {
    f.issues[0]!.status = "design-conflict";
    f.issues[0]!.history.push({ actor: "fixer", from: "open", to: "design-conflict", note });
  };

  it("accepts the fixer contesting an open issue with its argument", () => {
    const t = read(table(), contest('It contradicts "A running backup is not an error".'));
    expect(t.issues[0]).toMatchObject({ status: "design-conflict" });
    expect(t.rejections).toEqual([]);
  });

  it("rejects a contest while a ruling holds, one without an argument, and one over 2,000 characters", () => {
    expect(read(table(), contest("x"), "R1").rejections[0]!.note).toContain("ruling R1 holds for it");
    expect(read(table(), (f) => void (f.issues[0]!.status = "design-conflict")).rejections[0]!.note).toContain("without a history entry");
    expect(read(table(), contest("y".repeat(2_001))).rejections[0]!.note).toContain("more than 2000");
    expect(read(table(), (f) => void (f.issues[0]!.status = "deferred")).rejections[0]!.note).toContain("only the operator defers");
  });
});

describe("the pull request's design sections", () => {
  it("renders Design rulings and Open design questions after the review issues", () => {
    const body = pullRequestDescription(PROFILE, {
      issue: ISSUE,
      issueTitle: "T",
      record: RECORD,
      base: "base",
      review: "Reviewed.",
      issues: ["| Issue |"],
      rulings: ["- **R1** on I1: `implementation-stands`"],
      openDesignQuestions: ["- I2: Should it?"],
    });
    const at = (s: string) => body.indexOf(s);
    expect(at("## Review issues")).toBeLessThan(at("## Design rulings"));
    expect(at("## Design rulings")).toBeLessThan(at("## Open design questions"));
  });
});

describe("the rehearsal scenarios", () => {
  it("declare the Arbitrate scenarios with their expected paths", () => {
    const { scenarios } = rehearsal(BANYANDB);
    for (const name of ["arbitrate-review", "arbitrate-fixer", "arbitrate-fixer-stands"]) {
      expect(scenarios[name]!.expect, name).toMatchObject({ status: "succeeded", path: ["fix", "review"] });
    }
    expect(scenarios["arbitrate-operator"]!.expect).toMatchObject({ status: "stopped", stopReason: "design ruling needs the operator" });
    // Every verification reply carries finding-verification-v2's design fields.
    for (const [name, s] of Object.entries(scenarios)) {
      for (const reply of s.results["finding-verification-v2"] ?? []) {
        for (const v of (reply.output as { verdicts: object[] }).verdicts) expect(v, name).toHaveProperty("designLevel");
      }
      expect(s.results["finding-verification-v1"], name).toBeUndefined();
    }
  });

  it("walks the fixer's contest through the real issues-file diff", () => {
    const s = rehearsal(BANYANDB).scenarios["arbitrate-fixer-stands"]!;
    const effect = s.results["decision-record-v2"]![2]!.effects!.find((e) => e.path === ".graphloom/issues.json")!;
    const t = emptyIssueTable();
    const raised = (s.results["code-review-v2"]![0]!.output as { comments: Array<Record<string, unknown>> }).comments;
    raised.forEach((c, i) => createIssue(t, { id: `F${i + 1}`, comment: c as never }, { status: "open", actor: "verifier", note: "confirmed", raisedIn: 1, ctx: { round: 1, digest: "d1", ref: "e1" } }));
    t.written = new Map(t.issues.map((i) => [i.id, structuredClone(i)]));
    applyFixerRead(t, { present: true, text: effect.bytes }, { round: 2, digest: "d2", ref: "e2" });
    expect(t.rejections).toEqual([]);
    expect(t.issues.map((i) => i.status)).toEqual(["fixed", "design-conflict"]);
  });
});

