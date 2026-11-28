// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Behavioral review findings are fixed test-first (docs/design-issue-fix-graph.md,
 * "Test-first fixes of behavioral findings"): before Fix changes code for a
 * confirmed blocking finding the verifier judged behavioral, the implementer
 * returns a test that the graph runs on the reviewed change with only that
 * test added, where it must fail by assertion; the fix then carries the same
 * bytes, which must pass. An implementer that cannot produce a failing test
 * reports its attempt instead, and the finding goes to the arbiter. Pure
 * functions of evidence: the reproduction result (`finding-reproduction-v1`),
 * its checks and their judgement, read alike by the ledger, the graph and the
 * code review validator.
 */
import { checkoutWriteDigest, checkoutWritePathProblem, MAX_CHECKOUT_WRITE_BYTES, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { COMMAND, FIX_STAGE } from "./constants.js";
import { agentRuns, commandRuns, latestFile, producer, ranArgv, type AgentRun, type CommandRun } from "./evidence.js";
import { isTestPath, type Profile } from "./profile.js";
import { clip } from "./review-common.js";
import { asFindingId, proofProblem, proofTestRef } from "./rulings.js";

export const REPRODUCTION_CONTRACT = "finding-reproduction-v1";

/** A regression test as the reproduction returns it: a new test file, the test's name as the runner selects it, and the whole file. */
export interface FindingTest {
  path: string;
  name: string;
  content: string;
}

export type ReproductionOutcome = "reproduced" | "cannot-reproduce";

/** One finding's answer in `finding-reproduction-v1`. */
export interface ReproductionEntry {
  /** The finding, as the ledger names it (`F<n>`). */
  finding: string;
  outcome: ReproductionOutcome;
  /** The test: for `cannot-reproduce`, the one it tried (empty strings when none). */
  test: FindingTest;
  /** What the implementer tried; for `reproduced`, what the test shows. */
  attempt: string;
  /** What it observed when it ran the test itself. */
  observed: string;
}

const str = { type: "string" };
const strict = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** `finding-reproduction-v1`: every property required, none extra. */
export const REPRODUCTION_SCHEMA = JSON.stringify(
  strict({
    reproductions: {
      type: "array",
      items: strict({
        finding: str,
        outcome: { type: "string", enum: ["reproduced", "cannot-reproduce"] },
        test: strict({ path: str, name: str, content: str }),
        attempt: str,
        observed: str,
      }),
    },
  }),
);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The reproduction's entries, or why it cannot be read. A finding answered twice keeps its first answer. */
export function parseReproduction(output: unknown): { entries: ReproductionEntry[] } | { problem: string } {
  const list = object(output)?.reproductions;
  if (!Array.isArray(list)) return { problem: "the reproduction returned no reproductions" };
  const entries: ReproductionEntry[] = [];
  for (const raw of list) {
    const o = object(raw);
    if (o === undefined) continue;
    const outcome = o.outcome === "reproduced" ? "reproduced" : o.outcome === "cannot-reproduce" ? "cannot-reproduce" : undefined;
    const finding = asFindingId(text(o.finding));
    if (outcome === undefined || !/^F\d+$/.test(finding) || entries.some((e) => e.finding === finding)) continue;
    const t = object(o.test) ?? {};
    entries.push({ finding, outcome, test: { path: text(t.path).trim(), name: text(t.name).trim(), content: text(t.content) }, attempt: text(o.attempt).trim(), observed: text(o.observed).trim() });
  }
  return { entries };
}

/** The implementer's reproduction runs: Fix's read-only `verify` agent jobs, oldest first. */
export const reproductionRuns = (evidence: EvidenceRecord[]): AgentRun[] => agentRuns(evidence, FIX_STAGE, "verify");

/** Why a test cannot be added to the reviewed change as it stands, or undefined: a new file at a test path, not one the change touches. */
export function testProblem(profile: Profile, t: FindingTest, changed: readonly string[]): string | undefined {
  if (t.name === "") return "it names no test";
  if (t.content.trim() === "") return "its file has no content";
  const pathProblem = checkoutWritePathProblem(t.path);
  if (pathProblem !== undefined) return `its path: ${pathProblem}`;
  if (!isTestPath(profile, t.path)) return `${t.path} is not a test path of this repository (${profile.testPaths.suffixes.join(", ")})`;
  if (changed.includes(t.path)) return `the change already touches ${t.path}; a regression test goes to a new file`;
  if (Buffer.byteLength(t.content, "utf8") > MAX_CHECKOUT_WRITE_BYTES) return `its file is larger than ${MAX_CHECKOUT_WRITE_BYTES} bytes`;
  return undefined;
}

/** The test's run in a checkout of the reviewed change `digest` with exactly its bytes added, after the record at `after`: the failing half. */
export function redRun(evidence: EvidenceRecord[], profile: Profile, t: FindingTest, digest: string, after: number): CommandRun | undefined {
  const wanted = checkoutWriteDigest(t.content);
  const argv = profile.runner.argv(proofTestRef(profile, t));
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  return commandRuns(evidence, COMMAND.findingTest)
    .filter((r) => {
      if ((index.get(r.record.ref) ?? -1) <= after || r.record.candidateDigest !== digest) return false;
      if (producer(r.record)?.stageId !== FIX_STAGE || r.checkout?.from !== "candidate" || r.checkout.phase !== "run" || r.checkout.reverted === true) return false;
      const written = r.checkout.written ?? [];
      return written.length === 1 && written[0]!.path === t.path && written[0]!.digest === wanted && ranArgv(r, argv);
    })
    .at(-1);
}

/** The test's newest run on the change `digest` as it is, the test part of it: the passing half. */
export function greenRun(evidence: EvidenceRecord[], profile: Profile, t: FindingTest, digest: string): CommandRun | undefined {
  const argv = profile.runner.argv(proofTestRef(profile, t));
  return commandRuns(evidence, COMMAND.findingTest)
    .filter((r) => r.record.candidateDigest === digest && r.checkout?.from === "candidate" && r.checkout.phase === "run" && r.checkout.reverted !== true && (r.checkout.written ?? []).length === 0 && ranArgv(r, argv))
    .at(-1);
}

/** Why the failing half does not hold, or undefined when the test failed by assertion on the reviewed change. */
export const redProblem = (profile: Profile, t: FindingTest, run: CommandRun | undefined): string | undefined =>
  proofProblem(profile, { ...t, expect: "fail" }, run, { what: "regression test", on: "the reviewed change with only the test added" });

/** Where the passing half stands on a change: the test file to observe, the test to run, a problem, or it holds. */
export type RegressionState = { kind: "observe" } | { kind: "run" } | { kind: "problem"; problem: string } | { kind: "holds"; ref: string };

/**
 * Whether a regression test holds on the change `digest`: its file is part of
 * the change with exactly the bytes that failed (observed), and the test ran
 * there and passed clean.
 */
export function regressionState(evidence: EvidenceRecord[], profile: Profile, t: FindingTest, digest: string): RegressionState {
  const file = latestFile(evidence, t.path, digest);
  if (file === undefined) return { kind: "observe" };
  if (file.record.fingerprint === "missing" || checkoutWriteDigest(file.bytes) !== checkoutWriteDigest(t.content)) {
    return { kind: "problem", problem: `the regression test file ${t.path} must be part of the change with exactly the bytes that failed on the reviewed change; it is ${file.record.fingerprint === "missing" || file.bytes === "" ? "missing" : "different"}` };
  }
  const run = greenRun(evidence, profile, t, digest);
  if (run === undefined) return { kind: "run" };
  const problem = proofProblem(profile, { ...t, expect: "pass" }, run, { what: "regression test", on: "the change" });
  return problem === undefined ? { kind: "holds", ref: run.record.ref } : { kind: "problem", problem };
}

/** A regression test's job: the runner on the named test in a prepared checkout of the candidate, with the test added (`red`) or as the change has it. */
export function findingTestJob(profile: Profile, t: FindingTest, red: boolean): JobSpec {
  return {
    stageId: FIX_STAGE,
    kind: "command",
    purpose: "check",
    readOnly: true,
    instruction: `Regression test ${t.name}${red ? " on the reviewed change" : ""}`,
    checkout: red ? { from: "candidate", write: [{ path: t.path, content: t.content }] } : { from: "candidate" },
    input: { commands: [{ id: COMMAND.findingTest, argv: profile.runner.argv(proofTestRef(profile, t)), timeoutMs: profile.regressionTimeoutMs }] },
  };
}

/** The reproduction's assignment: a failing test for each finding, or the attempt when there is none. */
export function reproductionInstruction(profile: Profile, args: { findings: Array<{ id: string; text: string }>; changed: readonly string[]; problems?: string[] }): string {
  const dirs = profile.testPaths.directories ?? [];
  return [
    ...(args.problems !== undefined && args.problems.length > 0 ? ["Your last reproduction could not be used:", ...args.problems.map((p) => `- ${p}`), ""] : []),
    "Code review confirmed the findings below in the change in this worktree, each with an independent verifier's witness, and judged them behavioral: about what the code does at run time. They are fixed test-first. Before any code changes, write for each finding a test that fails on the change as it is now, the change the code reviewer reviewed, and will pass once the finding is fixed.",
    "",
    "Do not modify any file in the worktree; this job is read-only. Return each test's whole file in your result. You may try it in the run's scratch directory (copy what you need there). Only the controller's run counts: it adds your file, byte for byte, to a clean checkout of the reviewed change and runs the test with the regression runner, and the test must fail by assertion, not by a build error, a panic or a timeout. A test that passes there does not reproduce the finding. Your fix then adds the same file unchanged, and the test must pass on it.",
    "The expected value must come from the issue, its discussion or the code's documented contract, never from the current code's output.",
    "",
    "Findings:",
    ...args.findings.map((f) => `- ${f.text}`),
    "",
    ...(args.changed.length > 0 ? ["The files the change touches (a regression test goes to a new file, not one of these):", ...args.changed.map((p) => `- ${p}`), ""] : []),
    `Test files in this repository end in ${profile.testPaths.suffixes.join(", ")}${dirs.length > 0 ? ` or live under ${dirs.join(", ")}` : ""}; the regression runner is ${profile.runner.id}. ${profile.runner.testFieldHelp}. The runner selects your test by its file's ${profile.runner.id === "go-test" ? "directory (the package)" : "path"} and its name.`,
    "",
    `Your result, \`${REPRODUCTION_CONTRACT}\`: \`reproductions\`, one entry for every finding listed, each with:`,
    "- `finding`: its id as listed (I<n>).",
    "- `outcome`: `reproduced`, or `cannot-reproduce` when you could not write a test that fails on the current code.",
    "- `test`: `{path, name, content}`: a new test file at a test path that does not exist yet, the test's name as the regression runner selects it, and the whole file. For `cannot-reproduce`, the test you tried (empty strings when you wrote none).",
    "- `attempt`: for `reproduced`, what the test shows in a sentence; for `cannot-reproduce`, what you tried.",
    "- `observed`: what the test reported when you ran it; for `cannot-reproduce`, why it could not fail (its output, or what you found in the code).",
    "",
    "Report `cannot-reproduce` honestly rather than a test that does not fail: the finding then goes to an independent arbiter, which may run its own proof tests, and you change no code for it unless the ruling goes against the change.",
  ].join("\n");
}

/** A test in one phrase, for a note, a feedback line or the pull request. */
export const describeTest = (t: Pick<FindingTest, "path" | "name">): string => `\`${t.name}\` in \`${t.path}\``;

/** A test's whole file for an assignment, fenced. */
export const testFile = (t: FindingTest): string => `\`\`\`\n${t.content.replace(/\n$/, "")}\n\`\`\``;

/** An attempt that did not reproduce a finding, in one line. */
export function describeAttempt(u: { attempt: string; test?: Pick<FindingTest, "path" | "name">; observed: string }): string {
  return `${u.attempt !== "" ? clip(u.attempt, 600) : "no attempt described"}${u.test !== undefined ? ` (test ${describeTest(u.test)})` : ""}; observed: ${clip(u.observed || "nothing reported", 600)}`;
}
