// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { checkAssignmentFidelity, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { ledgerReadCommand } from "../src/commands.js";
import { GIT_ENV } from "../src/commands.js";
import { advancePullRequest } from "../src/graph.js";
import { REHEARSAL_MERGE_BASE, rehearsal } from "../src/rehearsal.js";
import { validatorById } from "../src/validators.js";
import { assignmentOf, BANYANDB, candidateEvidence, jobsOf, scenarioWith, simulate, viewOf, type Simulation } from "./support.js";

interface QaFile {
  schema: string;
  symbols: Array<{ id: string; qualified: string; change: string; similar: Array<{ path: string; line: number; score: number }>; tests: number }>;
  purposes: Array<{ item: string; status: string; quote?: string; source?: string }>;
  inventory: { dependencies: Array<{ name: string; version: string; source?: string }>; packages: number };
  weakTest: string;
  questions: Array<{ id: string; type: string; item: string; symbol?: string; origin: string; text: string; answer?: { answer: string; status: string; none_found: boolean; citations: Array<{ path: string }>; searches: unknown[]; proposal: { kind: string; splits: Array<{ name: string; startLine: number; endLine: number }>; testFile: string }; check: { verdict: string; note: string }; history: Array<{ answer: string; status: string }> } }>;
}

const qaOf = (sim: Simulation): QaFile => JSON.parse(sim.qa!.json) as QaFile;
const qOf = (sim: Simulation, type: string, symbol?: string) => qaOf(sim).questions.filter((q) => q.type === type && (symbol === undefined || q.symbol === symbol));
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const superviseOf = (s: Simulation) => (s.final.action.type === "supervise" ? s.final.action.supervise : undefined);
const commandIds = (jobs: JobSpec[]): string[] => jobs.flatMap((j) => ((j.input as { commands?: Array<{ id: string }> } | undefined)?.commands ?? []).map((c) => c.id));
const qaJobs = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.stageId === "questions" || j.stageId === "answers");

describe("every scenario settles Fetch, Report, Questions and Answers and stops final at report ready", () => {
  for (const name of Object.keys(rehearsal(BANYANDB).scenarios)) {
    it(name, () => {
      const sim = simulate({ scenarioName: name });
      expect(stopOf(sim), JSON.stringify(sim.final)).toMatchObject({ reason: "report ready", retryable: false });
      expect(sim.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["fetch", "fetch", "fetch", "report", "report", "report", "questions", "answers", "answers"]);
      const qa = qaOf(sim);
      expect(qa.schema).toBe("pr-qa-v1");
      expect(qa.weakTest).toMatch(/mutation testing is not available in this version/);
      expect(qa.questions.every((q) => q.answer !== undefined)).toBe(true);
    });
  }
});

describe("the assignments name every field the stand-in agents reply with (rehearsal assignment fidelity)", () => {
  for (const name of Object.keys(rehearsal(BANYANDB).scenarios)) {
    it(name, () => {
      const scenario = rehearsal(BANYANDB).scenarios[name]!;
      const sim = simulate({ scenarioName: name });
      for (const job of sim.jobs.filter((j) => j.kind === "agent")) {
        const replies = scenario.results[job.resultSchema!]!;
        for (const reply of replies) expect(checkAssignmentFidelity(assignmentOf(job), reply.output), `${name}: ${job.resultSchema}`).toEqual([]);
      }
    });
  }
});

describe("every command job fits the command executor's input contract", () => {
  for (const name of Object.keys(rehearsal(BANYANDB).scenarios)) {
    it(name, () => {
      const sim = simulate({ scenarioName: name });
      for (const job of sim.jobs.filter((j) => j.kind === "command" && j.executor === undefined)) {
        const input = job.input as { commands: Array<{ id: string; argv: string[] }> };
        expect(input.commands.length, job.instruction).toBeLessThanOrEqual(16);
        for (const c of input.commands) {
          expect(c.argv.length, c.id).toBeLessThanOrEqual(64);
          for (const arg of c.argv) expect(arg.length, `${c.id} argument`).toBeLessThanOrEqual(4096);
        }
        expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(256_000);
      }
    });
  }
});

describe("answer-finds-existing-helper", () => {
  const sim = simulate({ scenarioName: "answer-finds-existing-helper" });

  it("runs the groundwork, the questioner, the answerer, the verification, the checker, the writes and the ledger, in that order", () => {
    expect(qaJobs(sim).map((j) => `${j.stageId}/${j.kind}/${j.instruction.split(" ").slice(0, 3).join(" ")}`)).toEqual([
      "questions/command/Read the base",
      "questions/command/Read the base",
      "questions/command/Read the base",
      "questions/agent/Ask the questions",
      "answers/agent/Answer the questions",
      "answers/command/Check the answers'",
      "answers/agent/Check the answers",
      "answers/command/Write .graphloom/review/qa.json and",
      "answers/command/Advance the pull",
    ]);
  });

  it("reads only the pinned base commit with read-only commands: every search names the base, none runs repository code, none writes the worktree", () => {
    const groundwork = qaJobs(sim).filter((j) => j.kind === "command" && j.instruction.startsWith("Read the base"));
    expect(groundwork.every((j) => j.readOnly === true && j.purpose === "diagnostic")).toBe(true);
    expect((groundwork[0]!.input as { env: unknown }).env).toEqual({ ...GIT_ENV });
    const searches = groundwork.flatMap((j) => (j.input as { commands: Array<{ id: string; argv: string[] }> }).commands).filter((c) => c.id.startsWith("search-"));
    expect(searches.map((c) => c.id)).toEqual(["search-S1"]);
    expect(searches[0]!.argv).toContain(REHEARSAL_MERGE_BASE);
    for (const j of groundwork) for (const c of (j.input as { commands: Array<{ argv: string[] }> }).commands) expect(c.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(commandIds(groundwork)).toEqual(["base-tree", "base-manifests", "search-S1", "dep-sites-1", "dep-source-go-1", "cand-1"]);
  });

  it("observes the changed source files before extracting symbols from them", () => {
    const i = sim.decisions.findIndex((d) => d.action.type === "observe" && (d.action as { observe: { paths: string[] } }).observe.paths.includes("pkg/retention/ttl.go"));
    expect(i).toBeGreaterThan(0);
  });

  it("confines the questioner, the answerer and the checker untrusted-read on three roles, the checker on a harness other than the answerer's", () => {
    const [questioner, answerer, checker] = sim.jobs.filter((j) => j.kind === "agent" && (j.stageId === "questions" || j.stageId === "answers"));
    expect([questioner, answerer, checker].map((j) => (j!.input as { harness: string }).harness)).toEqual(["codex", "claude-code", "codex"]);
    expect([questioner, answerer, checker].map((j) => [j!.resultSchema, j!.purpose, j!.readOnly])).toEqual([["questions-v1", "diagnostic", true], ["answers-v1", "diagnostic", true], ["answer-check-v1", "review", true]]);
    for (const j of [questioner, answerer, checker]) {
      expect(j!.confinement).toMatchObject({ kind: "bwrap", network: true, binds: [] });
      expect((j!.confinement as { mask: string[] }).mask).toContain("/work/tree/CLAUDE.md");
    }
    expect(answerer).toMatchObject({ jobId: "answerer" });
    expect(questioner).toMatchObject({ jobId: "questioner" });
  });

  it("answers the existing-equivalent question from the base, with the helper's lines, its call site and the search, and the checker supports it", () => {
    const q = qOf(sim, "existing-equivalent")[0]!;
    expect(q.answer).toMatchObject({ status: "answered", none_found: false, check: { verdict: "supported" } });
    expect(q.answer!.citations.map((c) => c.path)).toEqual(["pkg/timestamp/duration.go", "banyand/measure/flusher.go"]);
    expect(q.answer!.answer).toContain("`ParseDuration` (pkg/timestamp/duration.go:30)");
  });

  it("scores the candidate's similarity from the base definition and records it with the symbol", () => {
    const s = qaOf(sim).symbols[0]!;
    expect(s).toMatchObject({ qualified: "retention.ParseTTL", change: "new", tests: 0 });
    expect(s.similar).toHaveLength(1);
    expect(s.similar[0]).toMatchObject({ path: "pkg/timestamp/duration.go", line: 30 });
    expect(s.similar[0]!.score).toBeGreaterThan(0.5);
    expect(assignmentOf(sim.jobs.find((j) => j.jobId === "questioner")!)).toContain("candidate pkg/timestamp/duration.go:30, similarity");
  });

  it("writes review.md as Report, then Measurements, then Q&A, and qa.json, without a verdict, and posts nothing", () => {
    const md = sim.qa!.markdown;
    expect(md.indexOf("# Report")).toBeLessThan(md.indexOf("# Measurements"));
    expect(md.indexOf("# Measurements")).toBeLessThan(md.indexOf("# Q&A"));
    expect(md).not.toContain("Pending: the Questions and Answers stages");
    expect(md).toContain("**A — answered.** `ParseDuration` (pkg/timestamp/duration.go:30)");
    expect(md).not.toMatch(/verdict|severity|request-changes|\bapprove\b/i);
    expect(sim.jobs.flatMap((j) => (j.executor !== undefined ? [j.executor.id] : [])).filter((id) => id.startsWith("graphloom.github/")).every((id) => /\/(get|list)-/.test(id))).toBe(true);
  });

  it("keeps the Report part of review.md byte for byte what the Report stage wrote, with only the pending Q&A replaced", () => {
    expect(sim.qa!.markdown.startsWith(sim.written!.markdown.slice(0, sim.written!.markdown.indexOf("# Q&A")))).toBe(true);
    expect(sim.written!.markdown).toContain("# Q&A\nPending");
  });
});

describe("citations are resolved in the tree they name", () => {
  const unresolved = scenarioWith("answer-finds-existing-helper", (s) => {
    s.commands!["cite-1"] = { exitCode: 0, stdout: "1 ok\n2 missing\nchecked 2\n" };
  });

  it("sends the answers back with the citation that names no file, then hands them to the supervisor after two corrections", () => {
    const sim = simulate({ scenario: unresolved });
    const answerers = jobsOf(sim, "Answer the questions");
    expect(answerers).toHaveLength(3);
    expect(assignmentOf(answerers[1]!)).toContain("Q1: citation base:banyand/measure/flusher.go:52-52 names no such file in that tree");
    expect(answerers[1]!.resultSchema).toBe("answers-v1");
    expect(answerers[1]!.continueFrom).toBeDefined();
    expect(superviseOf(sim)!.reason).toMatch(/still fail deterministic validation after 2 corrections: Q1: citation base:banyand\/measure\/flusher\.go:52-52 names no such file/);
    expect(sim.jobs.some((j) => j.purpose === "review" && j.stageId === "answers")).toBe(false);
  });

  it("hands over a verification command that did not run, rather than judging unverified answers", () => {
    const broken = scenarioWith("answer-finds-existing-helper", (s) => {
      s.commands!["cite-1"] = { exitCode: 127, stderr: "git: not found" };
    });
    expect(superviseOf(simulate({ scenario: broken }))!.reason).toMatch(/cite-1 did not run: exit 127: git: not found/);
  });

  it("hands over a verification that did not check every citation", () => {
    const short = scenarioWith("answer-finds-existing-helper", (s) => {
      s.commands!["cite-1"] = { exitCode: 0, stdout: "1 ok\nchecked 1\n" };
    });
    expect(superviseOf(simulate({ scenario: short }))!.reason).toMatch(/cite-1 checked 1 of 2 entries/);
  });
});

describe("answer-no-library-with-whole-repo-search", () => {
  const sim = simulate({ scenarioName: "answer-no-library-with-whole-repo-search" });
  const q = () => qOf(sim, "reuse-library")[0]!;

  it("answers none found, listing the whole-repository searches and the dependency inventory with each source's status", () => {
    expect(q().answer).toMatchObject({ none_found: true, status: "partially answered", check: { verdict: "supported" } });
    expect(q().answer!.searches).toHaveLength(3);
    const inventory = qaOf(sim).inventory;
    expect(inventory.dependencies.map((d) => `${d.name} ${d.version}`)).toEqual(["github.com/spf13/cobra v1.9.1", "github.com/robfig/cron/v3 v3.0.1", "go.uber.org/multierr v1.11.0"]);
    expect(inventory.dependencies.every((d) => d.source === undefined)).toBe(true);
    expect(sim.qa!.markdown).toContain("3 declared dependencies (0 with source available, 3 source unavailable)");
  });

  it("hands the answerer the inventory with each version and its source status", () => {
    const text = assignmentOf(sim.jobs.find((j) => j.jobId === "answerer")!);
    expect(text).toContain("go github.com/spf13/cobra v1.9.1 [go.mod] no use found — source unavailable");
    expect(text).toContain("go go.uber.org/multierr v1.11.0 (indirect or dev)");
    expect(text).toContain("No dependency source is available on this machine");
  });

  it("mounts a dependency's source read-only in the answerer's confinement when the cache holds it, and lets the answerer cite it", () => {
    const cached = scenarioWith("answer-no-library-with-whole-repo-search", (s) => {
      s.commands!["dep-source-go-1"] = { exitCode: 0, stdout: "go\tgithub.com/spf13/cobra\tv1.9.1\t/home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1\n# end\n" };
    });
    const s2 = simulate({ scenario: cached });
    const [answerer, checker] = [jobsOf(s2, "Answer the questions")[0]!, jobsOf(s2, "Check the answers against")[0]!];
    expect((answerer.confinement as { binds: unknown[] }).binds).toEqual([{ path: "/home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1", readOnly: true }]);
    expect(assignmentOf(answerer)).toContain("Dependency source is mounted read-only at: /home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1");
    expect(assignmentOf(answerer)).toContain("go github.com/spf13/cobra v1.9.1 [go.mod] no use found — source available: /home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1");
    // The checker gets the same read-only mount, to re-check a dependency citation where it points.
    expect((checker.confinement as { binds: unknown[] }).binds).toEqual([{ path: "/home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1", readOnly: true }]);
    expect(qaOf(s2).inventory.dependencies[0]!.source).toBe("/home/u/go/pkg/mod/github.com/spf13/cobra@v1.9.1");
  });

  it("makes the library answer partially answered while a dependency's source is unavailable: an answered one is sent back", () => {
    const wrong = scenarioWith("answer-no-library-with-whole-repo-search", (s) => {
      const reply = s.results["answers-v1"]![0]!.output as { answers: Array<{ question: string; status: string }> };
      for (const a of reply.answers) if (a.question === q().id) a.status = "answered";
      s.results["answers-v1"]!.push(structuredClone(s.results["answers-v1"]![0]!));
      ((s.results["answers-v1"]![1]!.output as { answers: Array<{ question: string; status: string }> }).answers.find((a) => a.question === q().id)!).status = "partially answered";
    });
    const s2 = simulate({ scenario: wrong });
    const answerers = jobsOf(s2, "Answer the questions");
    expect(answerers).toHaveLength(2);
    expect(assignmentOf(answerers[1]!)).toMatch(/source available here, so a "none found" library answer is "partially answered"/);
    expect(answerers[1]).toMatchObject({ continueFrom: expect.any(String) });
    expect(answerers[0]!.continueFrom).toBeUndefined();
    expect(stopOf(s2)).toMatchObject({ reason: "report ready" });
  });
});

describe("answer-checker-contradicts", () => {
  const sim = simulate({ scenarioName: "answer-checker-contradicts" });

  it("sends the unsupported answer back once, to the same session, with the checker's note; the corrected answer cites the vendored equivalent", () => {
    const answerers = jobsOf(sim, "Answer the questions");
    expect(answerers.map((j) => j.resultSchema)).toEqual(["answers-v1", "answers-revision-v1"]);
    expect(answerers[1]!.continueFrom).toBeDefined();
    const text = assignmentOf(answerers[1]!);
    expect(text).toContain("Q1: the answer checker found it unsupported: git grep -n 'func Jitter' finds vendor/github.com/foo/jitter/jitter.go:12");
    expect(text).toContain("Questions (1):");
    const q = qOf(sim, "existing-equivalent")[0]!;
    expect(q.answer).toMatchObject({ status: "answered", none_found: false, check: { verdict: "supported" } });
    expect(q.answer!.citations.map((c) => c.path)).toEqual(["vendor/github.com/foo/jitter/jitter.go"]);
    expect(q.answer!.history.map((h) => h.status)).toEqual(["answered", "answered"]);
    expect(q.answer!.history[0]!.answer).toContain("No existing equivalent");
  });

  it("checks the whole set again after the correction, with a fresh checker session each time", () => {
    const checkers = jobsOf(sim, "Check the answers against");
    expect(checkers).toHaveLength(2);
    expect(checkers.every((j) => j.purpose === "review" && j.continueFrom === undefined)).toBe(true);
    expect(assignmentOf(checkers[1]!)).toContain("[existing-equivalent]");
  });

  it("verifies the corrected answer's citation before the second check", () => {
    const order = qaJobs(sim).filter((j) => j.stageId === "answers").map((j) => (j.kind === "agent" ? `${j.resultSchema}` : j.instruction.split(" ")[0]!));
    expect(order).toEqual(["answers-v1", "answer-check-v1", "answers-revision-v1", "Check", "answer-check-v1", "Write", "Advance"]);
    expect(commandIds(qaJobs(sim).filter((j) => j.instruction.startsWith("Check the answers'")))).toEqual(["cite-1"]);
  });

  it("downgrades to needs author, with both statements recorded, when the correction is still unsupported", () => {
    const stubborn = scenarioWith("answer-checker-contradicts", (s) => {
      const second = s.results["answer-check-v1"]![1]!.output as { verdicts: Array<{ question: string; verdict: string; note: string; searches: unknown[] }> };
      const v = second.verdicts.find((x) => x.question === "Q1")!;
      v.verdict = "unsupported";
      v.note = "the cited file does not define Jitter";
    });
    const s2 = simulate({ scenario: stubborn });
    expect(stopOf(s2)).toMatchObject({ reason: "report ready" });
    expect(jobsOf(s2, "Answer the questions")).toHaveLength(2);
    const q = qOf(s2, "existing-equivalent")[0]!;
    expect(q.answer).toMatchObject({ status: "needs author", check: { verdict: "downgraded", note: "the cited file does not define Jitter" } });
    expect(q.answer!.history).toHaveLength(2);
    expect(q.answer!.history[0]!.answer).toContain("No existing equivalent");
    expect(q.answer!.history[1]!.answer).toContain("vendor/github.com/foo/jitter/jitter.go:12");
    expect(s2.qa!.markdown).toContain("**Q1 [existing-equivalent] ▶ needs author**");
    expect(s2.qa!.markdown).toMatch(/Statements before the downgrade: first \(answered\): "No existing equivalent[^"]*"; corrected \(answered\): "`Jitter`/);
  });
});

describe("purposes", () => {
  it("needs-author-purpose: a purpose question answered needs author, marked in review.md, the answers listing what was read", () => {
    const sim = simulate({ scenarioName: "needs-author-purpose" });
    const purposes = qOf(sim, "purpose");
    expect(purposes).toHaveLength(2);
    expect(purposes.every((q) => q.answer!.status === "needs author")).toBe(true);
    expect(purposes[0]!.answer!.searches.length).toBeGreaterThan(0);
    expect(qaOf(sim).purposes.every((p) => p.status === "asked")).toBe(true);
    expect(sim.qa!.markdown).toMatch(/- \*\*Q\d+ \[purpose\] ▶ needs author\*\*/);
  });

  it("purpose-stated: a purpose recorded stated with its quote, no purpose question, and the quote is in the pull request's text", () => {
    const sim = simulate({ scenarioName: "purpose-stated" });
    expect(qOf(sim, "purpose")).toEqual([]);
    const stated = qaOf(sim).purposes;
    expect(stated).toHaveLength(2);
    expect(stated.every((p) => p.status === "stated" && p.source === "body")).toBe(true);
    expect(stated.map((p) => p.quote)).toEqual(["a nightly sweep at 3am that removes expired data", "so retention can be set per group"]);
    expect(sim.qa!.markdown).toContain('Purpose: stated — "so retention can be set per group" (pull request body)');
  });
});

describe("missing-test", () => {
  const sim = simulate({ scenarioName: "missing-test" });

  it("adds the required missing-test question the questioner left out, in the plugin's own wording", () => {
    const q = qOf(sim, "missing-test");
    expect(q).toHaveLength(2);
    expect(q[0]!).toMatchObject({ origin: "required", text: "Which test covers quota.Limit (pkg/quota/limit.go:6)? The test map found none in the pull request." });
    expect(q[1]!.text).toMatch(/^Which test covers quota\.Burst/);
    const asked = (JSON.parse(JSON.stringify(sim.jobs.find((j) => j.jobId === "questioner")!.input)) as { assignment: string }).assignment;
    expect(asked).toContain('key "missing-test:S1"');
  });

  it("answers needs author, naming where a test would live and what to cover, with the proposal attached", () => {
    const a = qOf(sim, "missing-test")[0]!.answer!;
    expect(a.status).toBe("needs author");
    expect(a.proposal).toMatchObject({ kind: "test", testFile: "pkg/quota/limit_test.go" });
    expect(a.answer).toContain("A test would live beside it, in pkg/quota");
    expect(sim.qa!.markdown).toContain("Proposal: `TestLimit` in pkg/quota/limit_test.go");
  });
});

describe("complex-function", () => {
  const sim = simulate({ scenarioName: "complex-function" });

  it("shows the measurement row, and answers split-function with a proposal whose ranges lie inside the function and whose names are new", () => {
    expect(sim.qa!.markdown).toContain("| `schema.ParseTTL` pkg/schema/ttl.go:6 | added | 12 (over the limit of 10) | 4 (over the limit of 3) | unknown: not run (coverage arrives in a later wave) | 156 (upper bound, coverage unknown) | not run: no coverage |");
    const a = qOf(sim, "split-function")[0]!.answer!;
    expect(a).toMatchObject({ status: "answered", proposal: { kind: "split" } });
    for (const s of a.proposal.splits) {
      expect(s.startLine).toBeGreaterThanOrEqual(6);
      expect(s.endLine).toBeLessThanOrEqual(35);
    }
    expect(commandIds(qaJobs(sim))).toContain("names-1");
    expect(sim.qa!.markdown).toMatch(/\*\*A — answered \(proposal\)\.\*\*/);
  });

  it("asks complexity-coverage, and answers needs author with a test outline", () => {
    const a = qOf(sim, "complexity-coverage")[0]!.answer!;
    expect(a).toMatchObject({ status: "needs author", proposal: { kind: "test" } });
  });

  it("sends a split proposal back that reaches outside the function, or reuses a name in the package", () => {
    const outside = scenarioWith("complex-function", (s) => {
      const bad = structuredClone(s.results["answers-v1"]![0]!);
      const answers = (bad.output as { answers: Array<{ question: string; proposal: { splits: Array<{ name: string; startLine: number; endLine: number }> } }> }).answers;
      const split = answers.find((a) => a.question === "Q6")!;
      split.proposal.splits[1]!.endLine = 99;
      split.proposal.splits[0]!.name = "ParseTTL";
      s.results["answers-v1"]!.unshift(bad);
    });
    const s2 = simulate({ scenario: outside });
    const answerers = jobsOf(s2, "Answer the questions");
    expect(answerers).toHaveLength(2);
    const text = assignmentOf(answerers[1]!);
    expect(text).toMatch(/Q6 split "ParseTTL": the name already exists in the package pkg\/schema/);
    expect(text).toMatch(/Q6 split "ParseTTLCheckRange": lines \d+-99 are not inside ParseTTL \(6-35\)/);
    expect(stopOf(s2)).toMatchObject({ reason: "report ready" });
  });

  it("sends back a name the base already defines in the package: the names check sees what the answerer's own searches might miss", () => {
    const exists = scenarioWith("complex-function", (s) => {
      s.commands!["names-1"] = { exitCode: 0, stdout: "exists ParseTTLTokenize\nchecked 2\n" };
    });
    const s2 = simulate({ scenario: exists });
    expect(superviseOf(s2)!.reason).toMatch(/still fail deterministic validation after 2 corrections: Q6: the proposed name ParseTTLTokenize already exists in the package/);
  });
});

describe("crap-upper-bound", () => {
  const sim = simulate({ scenarioName: "crap-upper-bound" });

  it("shows CRAP 42 as an upper bound with unknown coverage, and asks no complexity-coverage question", () => {
    expect(sim.qa!.markdown).toContain("| `offline.Sync` pkg/offline/sync.go:6 | modified | 6 | 2 | unknown: not run (coverage arrives in a later wave) | 42 (upper bound, coverage unknown) | not run: no coverage |");
    expect(qaOf(sim).questions.map((q) => q.type)).toEqual(["missing-test"]);
    expect(qaOf(sim).symbols[0]).toMatchObject({ qualified: "offline.Sync", change: "modified" });
  });

  it("reads the base's declarations of the modified file to call its symbol modified, and searches the base's tests for it as context only", () => {
    expect(commandIds(qaJobs(sim))).toContain("base-defs-1");
    expect(commandIds(qaJobs(sim))).toContain("search-S1");
  });
});

describe("the ledger (design 9.1)", () => {
  const sim = simulate({ scenarioName: "answer-finds-existing-helper" });
  const write = () => {
    const job = sim.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    return (job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
  };

  it("advances the ref by compare-and-swap from the value Fetch read: absent here, in one read-only command job", () => {
    const job = sim.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    expect(job).toMatchObject({ kind: "command", readOnly: true, purpose: "diagnostic", stageId: "answers" });
    const argv = write();
    expect(argv[4]).toBe("refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger");
    expect(argv[5]).toBe("absent");
    const json = JSON.parse(argv.slice(8, 8 + Number(argv[7])).join("")) as { schema: string; heads: Array<{ sha: string; reported: boolean; reviewed: boolean }>; qa: Array<{ id: string; status: string }> };
    expect(json.schema).toBe("graphloom-pr-ledger-v1");
    expect(json.heads).toEqual([expect.objectContaining({ sha: "0123456789abcdef0123456789abcdef01234567", reported: true, reviewed: false })]);
    expect(json.qa.map((q) => q.id)).toEqual(qaOf(sim).questions.map((q) => q.id));
  });

  it("keeps the heads of a prior ledger, reading its ledger.json first and swapping from its commit", () => {
    const prior = "d".repeat(40);
    const withPrior = scenarioWith("answer-finds-existing-helper", (s) => {
      s.commands!["ledger-read"] = { exitCode: 0, stdout: `present ${prior}\n` };
      s.commands!["ledger-prior"] = { exitCode: 0, stdout: JSON.stringify({ schema: "graphloom-pr-ledger-v1", heads: [{ sha: "e".repeat(40), reported: true, reviewed: false }] }) };
    });
    const s2 = simulate({ scenario: withPrior });
    expect(stopOf(s2)).toMatchObject({ reason: "report ready" });
    expect(s2.jobs.some((j) => j.instruction.startsWith("Read the prior ledger"))).toBe(true);
    const job = s2.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    const argv = (job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(argv[5]).toBe(prior);
    const json = JSON.parse(argv.slice(8, 8 + Number(argv[7])).join("")) as { heads: Array<{ sha: string }> };
    expect(json.heads.map((h) => h.sha)).toEqual(["e".repeat(40), "0123456789abcdef0123456789abcdef01234567"]);
  });

  it("never overwrites a prior ledger it cannot read whole: a failed read, a non-JSON one and one that is not a ledger go to the supervisor, and are read again after the resume", () => {
    const prior = "d".repeat(40);
    const withPrior = (stub: { exitCode: number; stdout?: string; stderr?: string }) =>
      simulate({
        scenario: scenarioWith("answer-finds-existing-helper", (s) => {
          s.commands!["ledger-read"] = { exitCode: 0, stdout: `present ${prior}\n` };
          s.commands!["ledger-prior"] = stub;
        }),
      });
    const cases: Array<[{ exitCode: number; stdout?: string; stderr?: string }, RegExp]> = [
      [{ exitCode: 128, stderr: "fatal: path is not in the commit" }, /exited 128/],
      [{ exitCode: 0, stdout: "not json" }, /it is not JSON/],
      [{ exitCode: 0, stdout: JSON.stringify({ heads: [] }) }, /not a graphloom-pr-ledger-v1 document/],
    ];
    for (const [stub, reason] of cases) {
      const sim = withPrior(stub);
      expect(superviseOf(sim)!.reason, JSON.stringify(stub)).toMatch(/the prior ledger's ledger\.json cannot be read .*the ledger is not overwritten/);
      expect(superviseOf(sim)!.reason).toMatch(reason);
      expect(sim.jobs.some((j) => j.instruction.startsWith("Advance the pull"))).toBe(false);
      const again = advancePullRequest(viewOf(sim, { generation: 2, resume: { generation: 2, at: "2026-10-29T00:00:00Z", pluginUpdated: false } }));
      expect(again.action).toMatchObject({ type: "dispatch", job: { instruction: "Read the prior ledger's ledger.json" } });
    }
  });

  it("stops retryably 'ledger moved' when the compare-and-swap loses the race", () => {
    const lost = scenarioWith("answer-finds-existing-helper", (s) => {
      s.commands!["ledger-write"] = { exitCode: 4, stderr: "ledger moved" };
    });
    const s2 = simulate({ scenario: lost });
    expect(stopOf(s2)).toMatchObject({ reason: "ledger moved", retryable: true });
    expect(stopOf(s2)!.blocker).toContain("refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger");
    // The Answers stage is not accepted: the record of this head is not complete until the ledger holds it.
    expect(s2.receipts.some((r) => r.stageId === "answers")).toBe(false);
  });

  it("after the operator's resume, reads the ledger again before writing, and then swaps from what it read", () => {
    const lost = scenarioWith("answer-finds-existing-helper", (s) => {
      s.commands!["ledger-write"] = { exitCode: 4, stderr: "ledger moved" };
    });
    const s2 = simulate({ scenario: lost });
    const resume = { generation: 2, resume: { generation: 2, at: "2026-10-29T00:00:00Z", pluginUpdated: false } };
    const reread = advancePullRequest(viewOf(s2, resume));
    expect(reread.action).toMatchObject({ type: "dispatch", job: { instruction: "Read the pull request's ledger ref again" } });
    const winner = "f".repeat(40);
    const read = s2.evidence.find((e) => (e.payload as { command?: { id?: string } }).command?.id === "ledger-read") as EvidenceRecord;
    const evidence = [...s2.evidence, { ...read, ref: "reread", generation: 2, payload: { ...(read.payload as object), command: { ...(read.payload as { command: object }).command, stdoutTail: `present ${winner}\n` } } } as EvidenceRecord];
    const next = advancePullRequest(viewOf({ ...s2, evidence }, resume));
    expect(next.action).toMatchObject({ type: "dispatch", job: { instruction: "Read the prior ledger's ledger.json" } });
    const priors = [...evidence, { ...read, ref: "prior", generation: 2, payload: { ...(read.payload as object), command: { id: "ledger-prior", argv: ["sh", "-c", "x", "ledger-prior", winner], exitCode: 0, stdoutTail: JSON.stringify({ schema: "graphloom-pr-ledger-v1", heads: [] }), stderrTail: "" } } } as EvidenceRecord];
    const write2 = advancePullRequest(viewOf({ ...s2, evidence: priors }, resume));
    expect(write2.action).toMatchObject({ type: "dispatch", job: { instruction: expect.stringMatching(/^Advance the pull/) } });
    const argv = ((write2.action as { job: JobSpec }).job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(argv[5]).toBe(winner);
  });
});

describe("the Questions and Answers validators", () => {
  const sim = simulate({ scenarioName: "answer-finds-existing-helper" });
  const evaluate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
  const tamper = (id: string, change: (argv: string[]) => string[]): EvidenceRecord[] =>
    sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string; argv: string[] } }).command;
      return c?.id === id ? ({ ...e, payload: { ...(e.payload as object), command: { ...c, argv: change([...c.argv]) } } } as EvidenceRecord) : e;
    });

  it("pass on the untouched evidence", () => {
    for (const id of ["questions-complete", "answers-complete", "answers-grounded"]) expect(evaluate(id, sim.evidence), id).toMatchObject({ status: "passed" });
  });

  it("reject a qa-write whose file is not what the evidence recomputes, and a ledger write from another value or with other content", () => {
    expect(evaluate("answers-complete", tamper("qa-write", (a) => [...a.slice(0, 5), '{"forged":true}', ...a.slice(6)]))).toMatchObject({ status: "failed", reason: expect.stringMatching(/not what the evidence recomputes/) });
    expect(evaluate("answers-complete", tamper("ledger-write", (a) => [...a.slice(0, 5), "c".repeat(40), ...a.slice(6)]))).toMatchObject({ status: "failed", reason: expect.stringMatching(/compare-and-swap from the value Fetch read/) });
    expect(evaluate("answers-complete", tamper("ledger-write", (a) => [...a.slice(0, 8), '{"heads":[]}', ...a.slice(9)]))).toMatchObject({ status: "failed" });
  });

  it("do not pass before the work is done: no Q&A written, no ledger, no verdict", () => {
    const noWrite = sim.evidence.filter((e) => (e.payload as { command?: { id: string } }).command?.id !== "qa-write");
    expect(evaluate("answers-complete", noWrite)).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/has not been written/) });
    const noCheck = sim.evidence.filter((e) => e.resultSchema !== "answer-check-v1");
    expect(evaluate("answers-grounded", noCheck)).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/answer check is not finished \(checker\)/) });
    const noQuestions = sim.evidence.filter((e) => e.resultSchema !== "questions-v1");
    expect(evaluate("questions-complete", noQuestions)).toMatchObject({ status: "inconclusive" });
  });

  it("fail a groundwork read that did not run, rather than judging questions from nothing", () => {
    const failed = sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string } }).command;
      return c?.id === "base-tree" ? ({ ...e, payload: { ...(e.payload as object), command: { ...c, exitCode: 128 } } } as EvidenceRecord) : e;
    });
    expect(evaluate("questions-complete", failed)).toMatchObject({ status: "failed", reason: expect.stringMatching(/groundwork could not be read/) });
  });

  it("are bound as the design says: answers-grounded needs a separate reviewer, the others none", async () => {
    const { createGraph } = await import("../src/graph.js");
    const d = createGraph().describe(BANYANDB);
    expect(d.defaultValidators.filter((b) => b.independence !== undefined).map((b) => [b.requirementId, b.independence])).toEqual([["claims-checked", "separate-reviewer"], ["answers-grounded", "separate-reviewer"]]);
    expect(d.resultContracts!.find((c) => c.name === "answer-check-v1")!.evidenceKind).toBe("review");
  });
});

describe("stopping rules", () => {
  it("stops when no agent invocation is left for the questioner", () => {
    const sim = simulate({ scenarioName: "answer-finds-existing-helper" });
    const kept = sim.evidence.filter((e) => !["questions-v1", "answers-v1", "answers-revision-v1", "answer-check-v1"].includes(e.resultSchema ?? "") && !["cite-1", "qa-write", "ledger-write"].includes((e.payload as { command?: { id: string } }).command?.id ?? ""));
    const asked = advancePullRequest(viewOf({ ...sim, receipts: sim.receipts.filter((r) => r.stageId === "fetch" || r.stageId === "report"), evidence: kept }, { budgets: { agentInvocations: 0, jobs: 100, decisions: 100, corrections: 12 } }));
    expect(asked.action).toMatchObject({ type: "stop", stop: { reason: "budgets exhausted" } });
  });

  it("stops the run 'incompatible task', naming the size, when the pull request adds more symbols than the profile allows", () => {
    const sim = simulate({ scenarioName: "missing-test", config: { limits: { maxNewSymbols: 1 } } });
    expect(stopOf(sim)).toMatchObject({ reason: "incompatible task", retryable: false });
    expect(stopOf(sim)!.blocker).toContain("the pull request adds 2 symbols, past the profile's limits.maxNewSymbols of 1");
    expect(sim.jobs.some((j) => j.kind === "agent" && j.stageId === "questions")).toBe(false);
  });
});
