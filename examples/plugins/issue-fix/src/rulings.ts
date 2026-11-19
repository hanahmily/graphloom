// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Design rulings (docs/design-issue-fix-graph.md, "Arbitrate"): the arbiter's
 * `design-ruling-v1` result, the texts its design quotes must match, its
 * proof tests, the operator's `design-ruling` approval, and which of them a
 * receipt of Arbitrate accepted. Pure functions of evidence, like the
 * findings ledger that applies the rulings (findings.ts).
 */
import { checkoutWriteDigest, checkoutWritePathProblem, MAX_CHECKOUT_WRITE_BYTES, type EnvironmentCommand, type EvidenceRecord, type Receipt, type ValidatorBinding } from "@graphloom/sdk";
import { ARBITRATE_STAGE, COMMAND, DESIGN_RULING_APPROVAL, REQUIREMENT_RULING } from "./constants.js";
import { contextDocuments, readContext } from "./context.js";
import { agentRuns, commandRuns, describeCommand, issueComments, producer, succeeded, type AgentRun, type CommandRun, type Issue, type IssueComment } from "./evidence.js";
import { issueCommand } from "./issues.js";
import { harnessName, isTestPath, principlesRef, type Profile } from "./profile.js";
import type { RegressionTestRef } from "./runners/index.js";
import { checkQuotes, clip, observablePath, quoteInText, type FileIndex, type Quote } from "./review-common.js";

export const RULING_CONTRACT = "design-ruling-v1";
/** The design-ruling validator's binding as the graph declares it. */
export const RULING_BINDING: ValidatorBinding = { requirementId: REQUIREMENT_RULING, validatorId: "design-ruling", version: "1" };

export const RULING_DECISIONS = ["implementation-stands", "review-stands", "undecidable"] as const;
export type ArbiterDecision = (typeof RULING_DECISIONS)[number];
export type RulingDecision = Exclude<ArbiterDecision, "undecidable">;

/** Design statements and code citations a ruling gives: one to five of each. */
export const MAX_RULING_CITES = 5;
/** Proof tests an arbiter may write. */
export const MAX_PROOF_TESTS = 2;

export interface DesignStatement {
  /** `issue`, `comment:<n>`, `doc:<name>` or `principles`. */
  source: string;
  quote: string;
  says: string;
}

export interface CodeCitation {
  path: string;
  line: number;
  quote: string;
}

export interface ProofTest {
  path: string;
  name: string;
  content: string;
  expect: "fail" | "pass";
  shows: string;
}

export interface Undecidable {
  question: string;
  implementation: string;
  review: string;
}

/** The arbiter's result, `design-ruling-v1`. */
export interface ArbiterResult {
  /** The finding it rules on, as `F<n>`. */
  finding: string;
  ruling: ArbiterDecision;
  summary: string;
  design: DesignStatement[];
  code: CodeCitation[];
  proofTests: ProofTest[];
  undecidable: Undecidable;
}

const str = { type: "string" };
const strict = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** `design-ruling-v1`: every property required, none extra; `undecidable` holds empty strings unless the ruling is `undecidable`. */
export const RULING_SCHEMA = JSON.stringify(
  strict({
    finding: str,
    ruling: { type: "string", enum: RULING_DECISIONS },
    summary: str,
    design: { type: "array", items: strict({ source: str, quote: str, says: str }) },
    code: { type: "array", items: strict({ path: str, line: { type: "integer" }, quote: str }) },
    proofTests: { type: "array", items: strict({ path: str, name: str, content: str, expect: { type: "string", enum: ["fail", "pass"] }, shows: str }) },
    undecidable: strict({ question: str, implementation: str, review: str }),
  }),
);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** `I5` or `F5` as the ledger names it, `F5`; anything else as given. */
export const asFindingId = (id: string): string => id.trim().replace(/^[IF](\d+)$/i, "F$1");

/** The arbiter's result, or why it cannot be read. */
export function parseArbiterResult(output: unknown): { result: ArbiterResult } | { problem: string } {
  const o = object(output);
  if (o === undefined) return { problem: "the arbiter returned no result" };
  const ruling = RULING_DECISIONS.find((d) => d === o.ruling);
  if (ruling === undefined) return { problem: `the ruling is ${JSON.stringify(o.ruling)}, not one of ${RULING_DECISIONS.join(", ")}` };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(object).filter((x): x is Record<string, unknown> => x !== undefined) : []);
  const design = list(o.design).map((d) => ({ source: text(d.source).trim(), quote: text(d.quote), says: text(d.says) }));
  const code = list(o.code).map((c) => ({ path: text(c.path).trim(), line: Number.isInteger(c.line) ? (c.line as number) : 0, quote: text(c.quote) }));
  const proofTests = list(o.proofTests).map((t) => ({ path: text(t.path).trim(), name: text(t.name).trim(), content: text(t.content), expect: t.expect === "pass" ? ("pass" as const) : ("fail" as const), shows: text(t.shows) }));
  const u = object(o.undecidable) ?? {};
  return {
    result: {
      finding: asFindingId(text(o.finding)),
      ruling,
      summary: text(o.summary).trim(),
      design,
      code,
      proofTests,
      undecidable: { question: text(u.question).trim(), implementation: text(u.implementation).trim(), review: text(u.review).trim() },
    },
  };
}

// ---- The arbiter's runs and the operator's answers --------------------------------

/** The arbiter's runs (Arbitrate's read-only `review` jobs), oldest first. */
export const arbiterRuns = (evidence: EvidenceRecord[]): AgentRun[] => agentRuns(evidence, ARBITRATE_STAGE, "review");

/** The attempt of Arbitrate a record was produced under, when the controller recorded it. */
export const attemptOf = (e: EvidenceRecord): number | undefined => (producer(e) as { attempt?: unknown } | undefined)?.attempt as number | undefined;

export interface RulingApproval {
  record: EvidenceRecord;
  decision: "approve" | "decline";
  /** For an approval: the finding, the ruling and the note the operator gave. */
  finding?: string;
  ruling?: RulingDecision;
  note?: string;
  /** For a decline: the reason given. */
  reason?: string;
  operator: string;
}

/** The operator's `design-ruling` decision a record holds, or undefined. */
export function rulingApproval(e: EvidenceRecord): RulingApproval | undefined {
  const p = object(e.payload);
  if (p?.type !== "operator-approval" || p.approvalId !== DESIGN_RULING_APPROVAL) return undefined;
  const decision = p.decision === "approve" ? "approve" : p.decision === "decline" ? "decline" : undefined;
  if (decision === undefined) return undefined;
  const inputs = object(p.inputs) ?? {};
  const ruling = inputs.ruling === "implementation-stands" || inputs.ruling === "review-stands" ? inputs.ruling : undefined;
  return {
    record: e,
    decision,
    ...(typeof inputs.finding === "string" ? { finding: asFindingId(inputs.finding) } : {}),
    ...(ruling !== undefined ? { ruling } : {}),
    ...(typeof inputs.note === "string" ? { note: inputs.note } : {}),
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
    operator: text(p.operator) || "operator",
  };
}

/** The command that pins a visit's design point in the evidence: its argv names the finding. */
export const DESIGN_POINT_COMMAND = "design-point";

/** The command that records `finding` as the point an Arbitrate visit settles. */
export function designPointCommand(finding: string): EnvironmentCommand {
  return { id: DESIGN_POINT_COMMAND, argv: ["sh", "-c", `printf '%s\\n' "$1"`, DESIGN_POINT_COMMAND, finding] };
}

/** The finding a `design-point` record names, or undefined. */
export function designPointOf(e: EvidenceRecord): string | undefined {
  const run = issueCommand(e, DESIGN_POINT_COMMAND);
  if (run === undefined || !run.ok || run.argv[3] !== DESIGN_POINT_COMMAND) return undefined;
  const id = run.argv[4];
  return id !== undefined && /^F\d+$/.test(id) ? id : undefined;
}

/** The point the newest `design-point` record before `at` names. */
export function designPointBefore(evidence: readonly EvidenceRecord[], at: number): string | undefined {
  for (let i = at - 1; i >= 0; i -= 1) {
    const id = designPointOf(evidence[i]!);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** A record a ruling can rest on: an arbiter run or the operator's decision. */
const isDecisionRecord = (e: EvidenceRecord): boolean => arbiterRuns([e]).length > 0 || rulingApproval(e) !== undefined;

/** The receipts and admitted bindings a ledger needs to know which rulings count. */
export interface RulingContext {
  receipts?: readonly Receipt[];
  bindings?: readonly ValidatorBinding[];
}

/**
 * The decision records an Arbitrate receipt accepted, each with the receipt
 * that did: for every `design-ruling` receipt minted under the currently
 * admitted binding of that requirement (valid or not: it records what the
 * validator accepted when it was minted), the newest arbiter run or
 * operator decision among the records it names. A replaced validator's
 * receipts accept nothing.
 */
export function acceptedRulingSources(evidence: readonly EvidenceRecord[], ctx: RulingContext | undefined): Map<string, string> {
  const accepted = new Map<string, string>();
  const receipts = ctx?.receipts ?? [];
  if (receipts.length === 0) return accepted;
  const admitted = ctx?.bindings?.find((b) => b.requirementId === REQUIREMENT_RULING) ?? RULING_BINDING;
  for (const r of receipts) {
    if (r.requirementId !== REQUIREMENT_RULING) continue;
    if (r.validatorBinding.validatorId !== admitted.validatorId || r.validatorBinding.version !== admitted.version) continue;
    const refs = new Set(r.evidenceRefs);
    for (let i = evidence.length - 1; i >= 0; i -= 1) {
      const e = evidence[i]!;
      if (!refs.has(e.ref) || !isDecisionRecord(e)) continue;
      if (!accepted.has(e.ref)) accepted.set(e.ref, r.id);
      break;
    }
  }
  return accepted;
}

// ---- The texts design statements quote ---------------------------------------------

/** A text the run pinned, by the source name a design statement gives. */
export interface PinnedText {
  source: string;
  text: string;
}

/**
 * The texts a design statement may quote, as the run pinned them: the issue
 * (its title and body), each comment of the snapshot (`comment:<n>`, from 1),
 * each context document by its name (`doc:<name>`) and the principles file.
 */
export function pinnedTexts(evidence: EvidenceRecord[], profile: Profile, issue: Issue | undefined): PinnedText[] {
  const texts: PinnedText[] = [];
  if (issue !== undefined) texts.push({ source: "issue", text: `${issue.title}\n\n${issue.body}` });
  const comments: IssueComment[] = issueComments(evidence)?.comments ?? [];
  comments.forEach((c, i) => texts.push({ source: `comment:${i + 1}`, text: c.body }));
  for (const d of contextDocuments(evidence, profile)) texts.push({ source: `doc:${d.name}`, text: d.text });
  const principles = principlesRef(profile);
  if (principles !== undefined) {
    const read = readContext(evidence, principles);
    if (read.kind === "read") texts.push({ source: "principles", text: read.doc.text });
  }
  return texts;
}

/** Whether a design statement's quote is in the pinned text it names; a source the run did not pin never matches. */
export function designQuoteMatches(d: DesignStatement, pinned: readonly PinnedText[]): boolean {
  const source = pinned.find((p) => p.source === d.source);
  return source !== undefined && quoteInText(d.quote, source.text);
}

/** A code citation as the quote rule reads it. */
export const asQuote = (c: CodeCitation): Quote => ({ path: c.path, line: c.line, text: c.quote });

// ---- Checking a ruling ----------------------------------------------------------------

/** What the checks of a result found: problems, and the candidate files still to observe for its code citations. */
export interface RulingCheck {
  problems: string[];
  observe: string[];
}

/**
 * The rules a ruling must meet before its proof tests count: it rules on
 * `point`; a decided ruling has one to five design statements, each quoting
 * a text the run pinned, one to five code citations that match the candidate
 * `digest` (`files`, the observed bytes), and at most two proof tests at new
 * test paths; an undecidable one states the question and both cases.
 */
export function checkRuling(result: ArbiterResult, args: { point: string; pinned: readonly PinnedText[]; files: FileIndex; digest: string | undefined; changed: readonly string[]; profile: Profile }): RulingCheck {
  const problems: string[] = [];
  const observe: string[] = [];
  if (result.finding !== args.point) problems.push(`the result rules on ${result.finding || "no finding"}, but the point to settle is ${args.point}`);
  if (result.summary === "") problems.push("the summary is empty");
  if (result.ruling === "undecidable") {
    const u = result.undecidable;
    if (u.question === "" || u.implementation === "" || u.review === "") problems.push("an undecidable ruling states the question for the operator and the best case for each side (undecidable.question, implementation, review)");
    return { problems, observe };
  }
  if (result.design.length === 0) problems.push("a ruling quotes at least one design statement from the issue, its comments, a pinned document or the principles file; the arbiter's own view of good design is not a ruling");
  if (result.design.length > MAX_RULING_CITES) problems.push(`more than ${MAX_RULING_CITES} design statements`);
  for (const [i, d] of result.design.slice(0, MAX_RULING_CITES).entries()) {
    if (!args.pinned.some((p) => p.source === d.source)) problems.push(`design statement ${i + 1} names the source ${JSON.stringify(d.source)}, which the run did not pin (sources: ${args.pinned.map((p) => p.source).join(", ") || "none"})`);
    else if (!designQuoteMatches(d, args.pinned)) problems.push(`design statement ${i + 1}'s quote is not in ${d.source} (copy it exactly; at least 8 characters): ${clip(d.quote, 160)}`);
  }
  if (result.code.length === 0) problems.push("a ruling cites at least one line of the candidate code");
  if (result.code.length > MAX_RULING_CITES) problems.push(`more than ${MAX_RULING_CITES} code citations`);
  for (const [i, c] of result.code.slice(0, MAX_RULING_CITES).entries()) {
    if (!observablePath(c.path)) {
      problems.push(`code citation ${i + 1} names ${JSON.stringify(c.path)}, not a repository file path`);
      continue;
    }
    const check = checkQuotes([asQuote(c)], args.digest, args.files);
    if (check === "mismatch") problems.push(`code citation ${i + 1}'s quote is not within three lines of ${c.path}:${c.line} in the candidate: ${clip(c.quote, 160)}`);
    else if (check !== "match") observe.push(...check.filter((p) => !observe.includes(p)));
  }
  if (result.proofTests.length > MAX_PROOF_TESTS) problems.push(`more than ${MAX_PROOF_TESTS} proof tests`);
  const seen = new Set<string>();
  for (const [i, t] of result.proofTests.slice(0, MAX_PROOF_TESTS).entries()) {
    const where = `proof test ${i + 1} (${t.path || "no path"})`;
    const pathProblem = checkoutWritePathProblem(t.path);
    if (pathProblem !== undefined) problems.push(`${where}: ${pathProblem}`);
    else if (!isTestPath(args.profile, t.path)) problems.push(`${where}: not a test path of this repository (${args.profile.testPaths.suffixes.join(", ")})`);
    else if (args.changed.includes(t.path)) problems.push(`${where}: the candidate changes that path; write the test to a new file`);
    else if (seen.has(t.path)) problems.push(`${where}: the path is used twice`);
    seen.add(t.path);
    if (t.name === "") problems.push(`${where}: no test name`);
    if (t.content.trim() === "") problems.push(`${where}: no content`);
    if (Buffer.byteLength(t.content, "utf8") > MAX_CHECKOUT_WRITE_BYTES) problems.push(`${where}: larger than ${MAX_CHECKOUT_WRITE_BYTES} bytes`);
  }
  return { problems, observe };
}

// ---- Proof tests ---------------------------------------------------------------------

/** The regression runner's reference for a proof test: a Go test's package is its directory; a vitest test's is its file. */
export function proofTestRef(profile: Profile, t: ProofTest): RegressionTestRef {
  if (profile.runner.id === "go-test") {
    const dir = t.path.split("/").slice(0, -1).join("/");
    return { package: dir === "" ? "." : `./${dir}`, name: t.name };
  }
  return { package: t.path, name: t.name };
}

/** The newest run of `t`, after the record at `after`: its regression command in a candidate checkout of `digest` with exactly its bytes added. */
export function proofRun(evidence: EvidenceRecord[], profile: Profile, t: ProofTest, digest: string | undefined, after: number): CommandRun | undefined {
  const wanted = checkoutWriteDigest(t.content);
  const argv = profile.runner.argv(proofTestRef(profile, t));
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  return commandRuns(evidence, COMMAND.proof)
    .filter((r) => {
      if ((index.get(r.record.ref) ?? -1) <= after || digest === undefined || r.record.candidateDigest !== digest) return false;
      if (producer(r.record)?.stageId !== ARBITRATE_STAGE || r.checkout?.from !== "candidate" || r.checkout.phase !== "run") return false;
      const written = (r.checkout.written ?? []).filter((w) => w.path === t.path);
      return written.length === 1 && written[0]!.digest === wanted && r.command.argv.length === argv.length && r.command.argv.every((a, i) => a === argv[i]);
    })
    .at(-1);
}

/** Why a proof test's run does not behave as the arbiter claimed, or undefined when it does: `fail` under RED's contract, `pass` ran and passed clean. */
export function proofProblem(profile: Profile, t: ProofTest, run: CommandRun | undefined): string | undefined {
  const ref = proofTestRef(profile, t);
  const label = `proof test ${profile.runner.label(ref)} (${t.path})`;
  if (run === undefined) return `${label} has not run in a checkout of the candidate`;
  if (run.checkout?.prepared !== true) return `${label} ran in an unprepared checkout`;
  if (run.checkout.mutations.length > 0) return `${label}'s run left files changed: ${run.checkout.mutations.slice(0, 5).join(", ")}`;
  if (run.command.timedOut === true || run.command.aborted === true || run.command.spawnError !== undefined) return `${label} did not finish (${describeCommand(run.command)})`;
  const outcome = profile.runner.outcome(run.command.report?.text ?? run.command.stdoutTail, ref);
  if (t.expect === "fail") {
    return outcome === "failed" && !succeeded(run.command) ? undefined : `${label} was to fail by assertion on the candidate, but its run reports ${outcome} (${describeCommand(run.command)})`;
  }
  return outcome === "passed" && succeeded(run.command) ? undefined : `${label} was to pass on the candidate, but its run reports ${outcome} (${describeCommand(run.command)})`;
}

/** A proof test's recorded result, for the ledger and the pull request. */
export function proofResult(profile: Profile, t: ProofTest, run: CommandRun | undefined): string {
  const problem = proofProblem(profile, t, run);
  return problem === undefined ? `${t.expect === "fail" ? "failed by assertion" : "passed"} on the candidate, as claimed (${run!.record.ref})` : problem;
}

// ---- A ruling as the ledger keeps it ---------------------------------------------------

export interface Ruling {
  /** R1, R2, … in the order the rulings were accepted. */
  id: string;
  /** The finding it rules on, `F<n>`. */
  finding: string;
  decision: RulingDecision;
  /** Who decided: the arbiter's harness and model, or the operator. */
  decider: { kind: "arbiter"; harness: string; model?: string } | { kind: "operator"; operator: string };
  summary: string;
  design: DesignStatement[];
  /** The candidate lines it cites; empty for the operator's ruling, which holds for the rest of the run. */
  code: CodeCitation[];
  proofTests: Array<ProofTest & { result: string }>;
  /** The decision record and the receipt that accepted it. */
  source: string;
  receipt: string;
  /** The candidate it was made on. */
  digest?: string;
}

/** A design point the operator declined to rule on: it no longer blocks, and the pull request lists it with both cases. */
export interface DeferredPoint {
  finding: string;
  question: string;
  implementation: string;
  review: string;
  reason?: string;
  source: string;
  receipt: string;
}

/** Who decided a ruling, as people read it. */
export function deciderName(r: Ruling): string {
  return r.decider.kind === "operator" ? `the operator (${r.decider.operator})` : `an independent arbiter (${harnessName(r.decider.harness)}${r.decider.model !== undefined ? `, ${r.decider.model}` : ""})`;
}

const cite = (c: CodeCitation): string => `${c.path}:${c.line} \`${clip(c.quote, 160)}\``;

/** A ruling in one paragraph, for an agent's assignment or the supervisor. */
export function describeRuling(r: Ruling, issueId: string): string {
  const design = r.design.map((d) => `${d.source}: "${clip(d.quote, 200)}"`).join("; ");
  const code = r.code.map(cite).join("; ");
  return `${r.id} on ${issueId}: ${r.decision}, decided by ${deciderName(r)}. ${clip(r.summary, 800)}${design !== "" ? ` Design: ${design}.` : ""}${code !== "" ? ` Cited lines: ${code}.` : " It holds for the rest of the run."}`;
}

/** The pull request's "Design rulings" entry for a ruling. */
export function rulingSectionLines(r: Ruling, issueId: string): string[] {
  return [
    `- **${r.id}** on ${issueId}: \`${r.decision}\`, decided by ${deciderName(r)}. ${r.summary}`,
    ...r.design.map((d) => `  - Design (${d.source}): "${d.quote.replace(/\s+/g, " ").trim()}" — ${d.says}`),
    ...r.code.map((c) => `  - Code: ${cite(c)}`),
    ...r.proofTests.map((t) => `  - Proof test \`${t.name}\` (${t.path}, expected to ${t.expect}): ${t.shows} Result: ${t.result}.`),
  ];
}

/** The pull request's "Open design questions" entry for a deferred point. */
export function deferredSectionLines(d: DeferredPoint, issueId: string): string[] {
  return [
    `- ${issueId}: ${d.question}`,
    `  - The implementation's case: ${d.implementation}`,
    `  - The review's case: ${d.review}`,
    ...(d.reason !== undefined && d.reason.trim() !== "" ? [`  - The operator: ${d.reason.trim()}`] : []),
  ];
}

/** Records of an arbiter run's own sessions: whether a run continued a session (the coding agent's `continued`) and its session id. */
export function sessionOf(run: AgentRun): { continued: boolean; sessionRef?: string } {
  const agent = object(object(run.record.payload)?.codingAgent);
  return { continued: agent?.continued === true, ...(typeof agent?.sessionRef === "string" ? { sessionRef: agent.sessionRef } : {}) };
}
