import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "@graphloom/sdk";
import { CODE_REVIEW_SCHEMA, codeReviewInstruction, DEDUPE_RULE, findingLedger, issueTableRows, parseCodeReview, shippedProfile, parseProfile, verificationInstruction } from "../src/index.js";
import { knownFindings } from "../src/findings.js";

const canopy = parseProfile(shippedProfile("canopy"));
const SUMMARY = { total_files: 3, reviewed_files: 3, skipped: [] };

let n = 0;
const agent = (purpose: string, digest: string, output: unknown): EvidenceRecord => ({
  ref: `r-${++n}`,
  kind: "other",
  generation: 1,
  candidateDigest: digest,
  payload: {
    codingAgent: { status: "completed", output },
    producer: { operationId: `op-${n}`, stageId: "review", purpose, readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" },
  },
});
const pass = (digest: string, comments: Array<Record<string, unknown>>, statuses: Record<string, string> = {}, contract: string | null = "dedupe-1") =>
  agent("review", digest, { ...(contract !== null ? { contract } : {}), comments, prior: Object.entries(statuses).map(([finding, status]) => ({ finding, status, reason: `${finding} ${status}` })), summary: SUMMARY });
const confirm = (digest: string, ...ids: string[]) =>
  agent("diagnostic", digest, {
    verdicts: ids.map((finding) => ({ finding, verdict: "confirmed", reason: `${finding} is real`, quotes: [{ path: "canopy/server/src/x.ts", line: 1, text: "x" }] })),
  });
const comment = (path: string, start_line: number, end_line: number, content: string, extra: Record<string, unknown> = {}) => ({
  path,
  start_line,
  end_line,
  category: "bug",
  severity: "high",
  content,
  ...extra,
});

/**
 * The six pairs of run c44b4ae7-5d1 review round 1 (apache/skywalking#14159):
 * the first pass raised I1..I6, a sweep pass on the same change raised I7..I12
 * for the same problems with other words. Locations are the tracker's own.
 */
const FIRST = [
  comment("canopy/server/src/plugins/session.ts", 100, 102, "Preserve cookie renewal on streamed proxy responses."),
  comment("canopy/server/src/plugins/session.ts", 90, 93, "Implement the required API-token authentication."),
  comment("canopy/server/src/config.ts", 166, 174, "Preserve the development override before loading CANOPY_USERS."),
  comment("canopy/server/src/config.ts", 199, 211, "Cover the new session-configuration loading paths."),
  comment("canopy/server/test/password.test.ts", 57, 59, "Assert that unknown-user authentication actually performs dummy Argon2."),
  comment("canopy/server/src/routes/auth.ts", 96, 99, "Add regression coverage for replacing an existing session during login."),
];
// I1/I7, I2/I8, I3/I9 and I5/I11 sit on the same path with overlapping lines; I4/I10 and I6/I12 are
// the same problems seen from the test file, so the reviewer names the earlier issue (a duplicate of I<n>).
const SECOND = [
  comment("canopy/server/src/plugins/session.ts", 100, 102, "Sliding-expiry renewal Set-Cookie is not delivered on proxied successful responses."),
  comment("canopy/server/src/plugins/session.ts", 90, 93, "API-token (bearer) authentication is not implemented: the bearer resolver is missing."),
  comment("canopy/server/src/config.ts", 166, 175, "CANOPY_USERS is loaded and must exist before the CANOPY_DEV_NOAUTH override applies."),
  comment("canopy/server/test/config.test.ts", 77, 155, "No test covers loading or validating session settings (ttlMinutes, cookie).", { finding: "I4" }),
  comment("canopy/server/test/password.test.ts", 57, 60, "The unknown-user test only asserts false, so removing the dummy Argon2 passes."),
  comment("canopy/server/test/bff.test.ts", 115, 187, "No test logs in while already holding a session cookie, so the replacement is untested.", { finding: "I6" }),
];

describe("code review records one entry per problem (issue 182)", () => {
  const evidence = [pass("d1", FIRST), confirm("d1", "F1", "F2", "F3", "F4", "F5", "F6"), pass("d1", SECOND)];

  it("turns the run's six pairs into six findings and six issues, each keeping both texts", () => {
    const ledger = findingLedger(evidence);
    expect(ledger.findings.map((f) => f.id)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    for (const f of ledger.findings) expect(f.merged, f.id).toHaveLength(1);
    expect(ledger.findings[0]!.merged![0]!.comment.content).toContain("Sliding-expiry renewal");
    expect(ledger.findings[3]!.merged![0]!.comment.path).toBe("canopy/server/test/config.test.ts");
    expect(ledger.passes.at(-1)!.raised).toEqual([]);
    expect(ledger.issues.issues.map((i) => i.id)).toEqual(["I1", "I2", "I3", "I4", "I5", "I6"]);
    expect(ledger.issues.issues[0]!.description).toContain("Also raised at");
  });

  it("applies a verifier verdict on a merged entry once, and shows one table row per problem", () => {
    const verdicts = [...evidence.slice(0, 3), confirm("d1", "F1")];
    // F1 was confirmed already; a second pass of the verifier covers only pending findings, so nothing moves twice.
    const ledger = findingLedger(verdicts);
    const i1 = ledger.issues.issues.find((i) => i.id === "I1")!;
    expect(i1.history.map((h) => [h.actor, h.from, h.to])).toEqual([["verifier", null, "open"]]);
    expect(issueTableRows(ledger.issues.issues)).toHaveLength(2 + 6);
    // A twin raised before verification is verified with its finding: one verdict, one issue.
    const early = findingLedger([pass("d1", FIRST), pass("d1", SECOND), confirm("d1", "F1", "F2", "F3", "F4", "F5", "F6")]);
    expect(early.findings).toHaveLength(6);
    expect(early.issues.issues.map((i) => i.history.map((h) => h.to))).toEqual(Array(6).fill(["open"]));
    expect(early.verifications[0]!.covered).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
  });

  it("keeps two different problems on different lines of one file as two findings, and honours distinct", () => {
    const apart = findingLedger([pass("d1", [comment("a.ts", 10, 12, "first problem"), comment("a.ts", 40, 44, "second problem")])]);
    expect(apart.findings).toHaveLength(2);
    // Same lines in one pass: merged by default, kept apart when the reviewer marks them distinct.
    const same = findingLedger([pass("d1", [comment("a.ts", 10, 12, "first problem"), comment("a.ts", 11, 13, "same problem, other words")])]);
    expect(same.findings).toHaveLength(1);
    const distinct = findingLedger([pass("d1", [comment("a.ts", 10, 12, "first problem"), comment("a.ts", 11, 13, "a different problem", { distinct: true })])]);
    expect(distinct.findings).toHaveLength(2);
    // A later pass of the round: same lines merge, distinct does not, and a lower severity is no finding at all.
    const later = findingLedger([
      pass("d1", [comment("a.ts", 10, 12, "first problem")]),
      pass("d1", [comment("a.ts", 12, 20, "overlaps"), comment("a.ts", 11, 12, "not the same", { distinct: true }), comment("a.ts", 11, 12, "minor", { severity: "low" })]),
    ]);
    expect(later.findings.map((f) => [f.id, f.merged?.length ?? 0])).toEqual([["F1", 1], ["F2", 0]]);
  });

  it("keeps ids and verdicts of evidence recorded before 0.10.0: only passes carrying the contract merge", () => {
    const dup = comment("a.ts", 10, 12, "first problem");
    const legacy = [
      pass("d1", [dup, comment("a.ts", 11, 12, "same problem, other words"), comment("b.ts", 1, 2, "independent defect")], {}, null),
      agent("diagnostic", "d1", {
        verdicts: [
          { finding: "F1", verdict: "confirmed", reason: "real", quotes: [{ path: "a.ts", line: 10, text: "x" }] },
          { finding: "F2", verdict: "refuted", reason: "not real", quotes: [{ path: "a.ts", line: 11, text: "unmatched text for the file" }] },
          { finding: "F3", verdict: "confirmed", reason: "real", quotes: [{ path: "b.ts", line: 1, text: "y" }] },
        ],
      }),
    ];
    const ledger = findingLedger(legacy);
    expect(ledger.findings.map((f) => [f.id, f.comment.path, f.merged])).toEqual([["F1", "a.ts", undefined], ["F2", "a.ts", undefined], ["F3", "b.ts", undefined]]);
    expect(ledger.findings[2]!.state).toBe("confirmed");
    expect(ledger.findings[0]!.state).toBe("confirmed");
    expect(ledger.issues.issues.find((i) => i.id === "I3")!.status).toBe("open");
    // The same comments in a pass that carries the contract are one finding.
    const current = findingLedger([pass("d1", [dup, comment("a.ts", 11, 12, "same problem, other words"), comment("b.ts", 1, 2, "independent defect")])]);
    expect(current.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    // A later pass with the contract does not renumber what older passes assigned.
    const mixed = findingLedger([...legacy, pass("d1", [comment("a.ts", 11, 12, "again")])]);
    expect(mixed.findings.map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
  });

  it("never merges a distinct comment, whichever of two overlapping comments comes first", () => {
    const plain = comment("a.ts", 10, 12, "plain problem");
    const apart = comment("a.ts", 11, 13, "different problem", { distinct: true });
    for (const order of [[plain, apart], [apart, plain]]) {
      expect(findingLedger([pass("d1", order)]).findings, JSON.stringify(order.map((c) => c.content))).toHaveLength(2);
    }
    // Across passes too: a later plain comment does not join an earlier distinct finding, nor the reverse.
    expect(findingLedger([pass("d1", [apart]), pass("d1", [plain])]).findings).toHaveLength(2);
    expect(findingLedger([pass("d1", [plain]), pass("d1", [apart])]).findings).toHaveLength(2);
    // Severity sorting puts the critical one first: still two.
    const critical = comment("a.ts", 11, 12, "critical one", { severity: "critical", distinct: true });
    expect(findingLedger([pass("d1", [plain, critical])]).findings).toHaveLength(2);
  });

  it("does not merge across rounds, and a repeat of the same text adds nothing", () => {
    const rounds = findingLedger([pass("d1", [comment("a.ts", 10, 12, "first problem")]), pass("d2", [comment("a.ts", 10, 12, "first problem, again")])]);
    expect(rounds.findings).toHaveLength(2);
    const repeat = findingLedger([pass("d1", [comment("a.ts", 10, 12, "first problem")]), pass("d1", [comment("a.ts", 10, 12, "first problem")])]);
    expect(repeat.findings).toHaveLength(1);
    expect(repeat.findings[0]!.merged).toBeUndefined();
  });

  it("gives the sweep and the cross-file check the round's findings and the duplicate rule, and the verifier the merged texts", () => {
    const ledger = findingLedger(evidence.slice(0, 2));
    const text = codeReviewInstruction(canopy, { ocr: "ocr", base: "b", background: "", known: knownFindings(ledger), sweep: true, round: 1, issues: { file: ".graphloom/issues.json", markdown: ".graphloom/issues.md" } });
    expect(text).toContain(DEDUPE_RULE);
    expect(text).toContain("- I4 (open)");
    expect(text.indexOf(DEDUPE_RULE)).toBeLessThan(text.indexOf("Extra rule for"));
    expect(codeReviewInstruction(canopy, { ocr: "ocr", base: "b", background: "", round: 4 })).not.toContain(DEDUPE_RULE);
    const merged = findingLedger([pass("d1", FIRST), pass("d1", SECOND)]);
    expect(verificationInstruction(canopy, { findings: merged.findings.slice(0, 1), background: "bg", changed: [] })).toContain("The same problem, raised again on the same lines");
  });

  it("allows a distinct flag in the result contract and reads it", () => {
    const schema = JSON.parse(CODE_REVIEW_SCHEMA) as { properties: { comments: { items: { required: string[]; properties: Record<string, unknown> } } } };
    expect(schema.properties.comments.items.required).toContain("distinct");
    expect(schema.properties.comments.items.properties.distinct).toEqual({ type: "boolean" });
    const parsed = parseCodeReview({ comments: [comment("a.ts", 1, 2, "x", { distinct: true }), comment("a.ts", 3, 4, "y", { distinct: false })], summary: SUMMARY });
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(parsed.report.comments.map((c) => c.distinct)).toEqual([true, undefined]);
  });
});

// The real run's evidence, when the state file is on this machine: round 1 recorded 14 entries for about 8 problems.
const REPLAY = process.env.ISSUE_FIX_REPLAY_C44B4AE7 ?? "/mnt/d/skywalking-banyandb/graphloom-state/c44b4ae7-5d1/state.json";
describe.skipIf(!existsSync(REPLAY))("replay of run c44b4ae7-5d1 (issue 182)", () => {
  it("replays the pre-0.10 evidence as it was: no merging, ids and verdicts untouched", () => {
    const state = JSON.parse(readFileSync(REPLAY, "utf8")) as { evidence: EvidenceRecord[] };
    const ledger = findingLedger(state.evidence);
    expect(ledger.findings.some((f) => f.merged !== undefined)).toBe(false);
    expect(ledger.findings.filter((f) => f.round === 1).length).toBeGreaterThanOrEqual(12);
    expect(new Set(ledger.issues.issues.map((i) => i.id)).size).toBe(ledger.issues.issues.length);
  });
});
