// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * One Arbitrate visit as evidence shows it (docs/design-issue-fix-graph.md,
 * "Inside Arbitrate"): the design point it settles, which the graph pins
 * with a `design-point` command at the start of the visit; the arbiter's runs
 * and the operator's decision since the last accepted ruling; and how an
 * arbiter's result fares against the checks. The graph and the
 * `design-ruling` validator read it alike.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { ARBITRATE_STAGE, COMMAND } from "./constants.js";
import { issueSnapshot, latestCheckoutRun, producer, type AgentRun } from "./evidence.js";
import { designConflicts, findingLedger, type Finding, type FindingLedger, type LedgerOptions } from "./findings.js";
import type { Profile } from "./profile.js";
import { fileIndex } from "./review-common.js";
import {
  acceptedRulingSources,
  arbiterRuns,
  asFindingId,
  attemptOf,
  checkRuling,
  designPointOf,
  parseArbiterResult,
  pinnedTexts,
  proofProblem,
  proofRun,
  rulingApproval,
  sessionOf,
  type ArbiterResult,
  type ProofTest,
  type RulingApproval,
} from "./rulings.js";

export interface Arbitration {
  /** The findings ledger, rulings applied. */
  ledger: FindingLedger;
  /** The first design conflict no ruling holds for: the point a new visit takes up. */
  next?: Finding;
  /** The point this visit settles, as its `design-point` record names it, `F<n>`. */
  point?: string;
  /** Where this visit's evidence starts: after the last accepted ruling and the records of earlier visits. */
  since: number;
  /** The arbiter's runs in this visit, oldest first. */
  runs: Array<{ run: AgentRun; index: number }>;
  /** The operator's newest decision in this visit. */
  approval?: RulingApproval & { index: number };
  /** Arbiter rulings the run holds, against `review.maxRulings`. */
  arbiterRulings: number;
  capped: boolean;
}

/**
 * The visit as evidence shows it. `attempt`, the side visit's attempt, tells
 * this visit's records from an earlier one's; without it (a validator) the
 * visit starts after the last ruling a receipt accepted.
 */
export function arbitration(evidence: EvidenceRecord[], options: LedgerOptions & { profile: Profile; attempt?: number }): Arbitration {
  const ledger = findingLedger(evidence, options);
  const accepted = acceptedRulingSources(evidence, options);
  let since = -1;
  evidence.forEach((e, i) => {
    if (accepted.has(e.ref)) since = i;
    const attempt = attemptOf(e);
    if (options.attempt !== undefined && attempt !== undefined && attempt < options.attempt && producer(e)?.stageId === ARBITRATE_STAGE) since = Math.max(since, i);
  });
  const runs: Arbitration["runs"] = [];
  let point: string | undefined;
  let approval: Arbitration["approval"];
  evidence.forEach((e, i) => {
    if (i <= since) return;
    const attempt = attemptOf(e);
    const thisVisit = options.attempt === undefined || attempt === undefined || attempt === options.attempt;
    const run = arbiterRuns([e])[0];
    if (run !== undefined && thisVisit) runs.push({ run, index: i });
    const named = designPointOf(e);
    if (named !== undefined && thisVisit) point = named;
    const decided = rulingApproval(e);
    if (decided !== undefined) approval = { ...decided, index: i };
  });
  const arbiterRulings = ledger.rulings.filter((r) => r.decider.kind === "arbiter").length;
  const next = designConflicts(ledger)[0];
  return { ledger, ...(next !== undefined ? { next } : {}), ...(point !== undefined ? { point } : {}), since, runs, ...(approval !== undefined ? { approval } : {}), arbiterRulings, capped: arbiterRulings >= options.profile.maxRulings };
}

export type JudgedRun =
  | { kind: "problems"; problems: string[]; result?: ArbiterResult }
  | { kind: "observe"; paths: string[]; result: ArbiterResult }
  | { kind: "proofs"; tests: ProofTest[]; result: ArbiterResult }
  | { kind: "undecidable"; result: ArbiterResult }
  | { kind: "ruled"; result: ArbiterResult };

/**
 * How an arbiter run of this visit fares: its result read, its session's
 * independence, the ruling's rules (point, quotes, citations, proof test
 * paths), the files still to observe, the proof tests still to run, and
 * whether each run behaved as claimed.
 */
export function judgeArbiterRun(arb: Arbitration, at: { run: AgentRun; index: number }, args: { profile: Profile; evidence: EvidenceRecord[]; digest: string | undefined }): JudgedRun {
  const { run } = at;
  if (run.status !== "completed") return { kind: "problems", problems: [`the arbiter did not finish (${run.status})`] };
  const parsed = parseArbiterResult(run.output);
  if ("problem" in parsed) return { kind: "problems", problems: [parsed.problem] };
  const result = parsed.result;
  const independence = independenceProblems(arb, at, args.evidence);
  if (independence.length > 0) return { kind: "problems", problems: independence, result };
  const point = arb.point ?? "";
  const changed = latestCheckoutRun(args.evidence, COMMAND.regression, "candidate", args.digest)?.checkout?.paths ?? [];
  const check = checkRuling(result, { point, pinned: pinnedTexts(args.evidence, args.profile, issueSnapshot(args.evidence)?.issue), files: fileIndex(args.evidence), digest: args.digest, changed, profile: args.profile });
  if (check.problems.length > 0) return { kind: "problems", problems: check.problems, result };
  if (result.ruling === "undecidable") return { kind: "undecidable", result };
  if (check.observe.length > 0) return { kind: "observe", paths: check.observe, result };
  const missing = result.proofTests.filter((t) => proofRun(args.evidence, args.profile, t, args.digest, at.index) === undefined);
  if (missing.length > 0) return { kind: "proofs", tests: missing, result };
  const proofs = result.proofTests.flatMap((t) => proofProblem(args.profile, t, proofRun(args.evidence, args.profile, t, args.digest, at.index)) ?? []);
  if (proofs.length > 0) return { kind: "problems", problems: proofs, result };
  return { kind: "ruled", result };
}

/**
 * The arbiter's session is its own: the visit's first run started fresh, and
 * none of its runs shares a session with the implementer, the code reviewer
 * or the verifier (never their continuation, never one of their forks).
 */
function independenceProblems(arb: Arbitration, at: { run: AgentRun; index: number }, evidence: EvidenceRecord[]): string[] {
  const chain = arb.runs.filter((r) => r.index <= at.index);
  const first = chain[0] ?? at;
  const problems: string[] = [];
  if (sessionOf(first.run).continued) problems.push("the arbiter's session continued another session; an arbiter starts fresh and never continues the implementer's, reviewer's or verifier's");
  const others = new Set(
    evidence.flatMap((e) => {
      const p = producer(e);
      if (p === undefined || p.stageId === ARBITRATE_STAGE || p.kind !== "agent") return [];
      const ref = (e.payload as { codingAgent?: { sessionRef?: unknown } } | undefined)?.codingAgent?.sessionRef;
      return typeof ref === "string" ? [ref] : [];
    }),
  );
  if (chain.some((r) => {
    const ref = sessionOf(r.run).sessionRef;
    return ref !== undefined && others.has(ref);
  })) {
    problems.push("the arbiter ran in a session another role wrote, reviewed or verified the change in");
  }
  return problems;
}

/** The point an approval answers, as the ledger names it. */
export const approvalFinding = (a: RulingApproval): string | undefined => (a.finding !== undefined ? asFindingId(a.finding) : undefined);
