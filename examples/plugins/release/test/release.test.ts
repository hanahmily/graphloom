// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord, GraphDecision, Receipt, RunView } from "@graphloom/sdk";
import {
  CHANGELOG_PATH,
  QUALIFICATION_CASES,
  VERSION_PATH,
  advanceRelease,
  qualifyValidators,
  changelogEntryValidator,
  createGraph,
  independentReviewValidator,
  releaseScopeValidator,
  semverFileValidator,
  validatorById,
} from "../src/index.js";

const request = "Release version 1.2.0: record it in VERSION and add a CHANGELOG.md entry for the new export command.";
const ENTRY = "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-09-27\n\n### Added\n\n- Export command\n\n## [1.1.0] - 2026-08-01\n\n- Older\n";

let seq = 0;
const file = (path: string, bytes: string | null, generation = 1): EvidenceRecord => ({
  ref: `ev-${++seq}`,
  kind: "file",
  generation,
  payload: { path, bytes: bytes ?? "" },
  fingerprint: bytes === null ? "missing" : `fp-${seq}`,
});
const workspace = (changedPaths: string[], generation = 1): EvidenceRecord => ({
  ref: `ev-${++seq}`,
  kind: "workspace",
  generation,
  payload: { changedPaths },
});
const review = (verdict: string, summary?: string, generation = 1): EvidenceRecord => ({
  ref: `ev-${++seq}`,
  kind: "review",
  generation,
  payload: { verdict, ...(summary !== undefined ? { summary } : {}) },
});
const receipt = (stageId: string, requirementId: string, valid = true): Receipt => ({
  id: `r-${stageId}-${requirementId}`,
  stageId,
  requirementId,
  validatorBinding: { requirementId, validatorId: "v", version: "1" },
  candidateFingerprint: "fp",
  evidenceRefs: [],
  valid,
});
const input = (evidence: EvidenceRecord[]) => ({ requirementId: "r", statement: "s", evidence });

function view(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-release",
    task: { request },
    current: { stageId: "bump", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 32, jobs: 64, decisions: 128, corrections: 8 },
    validatorBindings: createGraph().describe().defaultValidators,
    generation: 1,
    stateRevision: 1,
    activeVersion: "release@0.1.0",
    ...over,
  };
}

/** Advance, then feed the decision's private state into the next view. */
function step(v: RunView): { decision: GraphDecision; next: (over?: Partial<RunView>) => RunView } {
  const decision = advanceRelease(v);
  return {
    decision,
    next: (over = {}) => view({ ...v, ...(decision.privateState !== undefined ? { privateState: decision.privateState } : {}), ...over }),
  };
}

describe("release graph definition", () => {
  it("declares Bump → Changelog → Review, with two requirements on Changelog, matching the shipped manifest", () => {
    const def = createGraph().describe();
    expect(def.stages.map((s) => [s.id, s.requirementIds])).toEqual([
      ["bump", ["version-file"]],
      ["changelog", ["changelog-entry", "release-scope"]],
      ["review", ["release-review"]],
    ]);
    for (const binding of def.defaultValidators) expect(validatorById(binding.validatorId)).toBeDefined();
    const manifest = JSON.parse(readFileSync(new URL("../graphloom.manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      graphId: def.graphId,
      version: def.version,
      privateStateSchema: def.privateStateSchema,
      repairContract: "source-repairable",
      requirements: def.requirements,
      stages: def.stages,
    });
  });
});

describe("release validators", () => {
  it("accepts one semantic version and a newline in VERSION, and nothing looser", () => {
    expect(semverFileValidator.evaluate(input([file(VERSION_PATH, "1.2.0\n")])).status).toBe("passed");
    for (const bytes of ["1.2.0", "v1.2.0\n", "1.2\n", "1.2.0\n\n"]) {
      expect(semverFileValidator.evaluate(input([file(VERSION_PATH, bytes)])).status).toBe("failed");
    }
    expect(semverFileValidator.evaluate(input([file(VERSION_PATH, null)])).reason).toBe("VERSION does not exist");
    expect(semverFileValidator.evaluate(input([])).status).toBe("inconclusive");
  });

  it("checks the first release section below [Unreleased] against VERSION, with or without a date", () => {
    const check = (changelog: string | null, version = "1.2.0\n") =>
      changelogEntryValidator.evaluate(input([file(VERSION_PATH, version), file(CHANGELOG_PATH, changelog)]));
    expect(check(ENTRY)).toEqual({ status: "passed", reason: "CHANGELOG.md opens with a 1.2.0 entry" });
    expect(check("## [1.2.0]\n\n- Export command\n").status).toBe("passed");
    expect(check(ENTRY, "1.3.0\n").reason).toBe("first release section is 1.2.0, but VERSION is 1.3.0");
    expect(check("## [1.2.0] - 2026-09-27\n\nExport command.\n").reason).toBe('the 1.2.0 section lists no "- " change');
    expect(check("## 1.2.0\n\n- Export command\n").reason).toMatch(/^first release heading "## 1.2.0" is not/);
    expect(check("# Changelog\n\n## [Unreleased]\n\n- Pending\n").reason).toBe("CHANGELOG.md has no release section below [Unreleased]");
    expect(check(null).reason).toBe("CHANGELOG.md does not exist");
    expect(check(ENTRY, "next\n").reason).toBe("VERSION holds no version to match");
    expect(changelogEntryValidator.evaluate(input([file(CHANGELOG_PATH, ENTRY)])).status).toBe("inconclusive");
  });

  it("requires VERSION and CHANGELOG.md to be the release's only changes", () => {
    const check = (paths: string[]) => releaseScopeValidator.evaluate(input([workspace(paths)]));
    expect(check([CHANGELOG_PATH, VERSION_PATH]).status).toBe("passed");
    expect(check([CHANGELOG_PATH, VERSION_PATH, "src/x.ts"]).reason).toBe("unrelated paths changed: src/x.ts");
    expect(check([VERSION_PATH]).reason).toBe("not changed: CHANGELOG.md");
    expect(releaseScopeValidator.evaluate(input([])).status).toBe("inconclusive");
  });

  it("passes only an approving review verdict", () => {
    expect(independentReviewValidator.evaluate(input([review("approved", "ok")]))).toEqual({ status: "passed", reason: "ok" });
    expect(independentReviewValidator.evaluate(input([review("request_changes", "name the command")])).status).toBe("failed");
    expect(independentReviewValidator.evaluate(input([review("lgtm")])).status).toBe("inconclusive");
  });
});

describe("release repair qualification", () => {
  const alwaysPasses = (id: string) =>
    id === "changelog-entry" ? { evaluate: () => ({ status: "passed" as const, reason: "always passes" }) } : validatorById(id);
  const dropsDates = (id: string) =>
    id === "changelog-entry"
      ? {
          evaluate: (i: Parameters<typeof changelogEntryValidator.evaluate>[0]) => {
            const log = i.evidence.find((e) => (e.payload as { path?: string } | undefined)?.path === CHANGELOG_PATH);
            const dated = / - \d{4}-\d{2}-\d{2}/.test((log?.payload as { bytes?: string } | undefined)?.bytes ?? "");
            return dated ? { status: "failed" as const, reason: "dated" } : changelogEntryValidator.evaluate(i);
          },
        }
      : validatorById(id);

  it("covers every shipped validator with passing and failing cases, all of which the shipped validators satisfy", () => {
    for (const binding of createGraph().describe().defaultValidators) {
      const statuses = QUALIFICATION_CASES.filter((c) => c.validatorId === binding.validatorId).map((c) => c.expected);
      expect(statuses, binding.validatorId).toEqual(expect.arrayContaining(["passed", "failed"]));
    }
    expect(qualifyValidators(validatorById)).toMatchObject({ ok: true, candidateMismatches: [] });
  });

  it("qualifies a fix only when the old version reproduces the defect", () => {
    const fixed = qualifyValidators(validatorById, dropsDates);
    expect(fixed.ok).toBe(true);
    expect(fixed.baselineMismatches).toEqual([
      "changelog-entry: dated heading (expected passed, got failed)",
      "changelog-entry: bullet under a subsection (expected passed, got failed)",
    ]);
    expect(qualifyValidators(validatorById, validatorById)).toMatchObject({
      ok: false,
      summary: `the old version passes all ${QUALIFICATION_CASES.length} qualification cases, so no defect is reproduced`,
    });
  });

  it("rejects an always-passing replacement on the requirement's negative cases", () => {
    const report = qualifyValidators(alwaysPasses, dropsDates);
    expect(report.ok).toBe(false);
    expect(report.candidateMismatches).toEqual(
      expect.arrayContaining([
        "changelog-entry: mismatched VERSION (expected failed, got passed)",
        "changelog-entry: heading without brackets (expected failed, got passed)",
        "changelog-entry: no listed change (expected failed, got passed)",
        "changelog-entry: VERSION never observed (expected inconclusive, got passed)",
      ]),
    );
    expect(report.summary).toMatch(/^candidate fails \d+ of \d+ qualification cases: /);
  });

  it("counts a missing or throwing validator as a mismatch", () => {
    const report = qualifyValidators((id) =>
      id === "semver-file" ? undefined : id === "release-scope" ? { evaluate: () => { throw new Error("boom"); } } : validatorById(id),
    );
    expect(report.candidateMismatches).toContain("semver-file: missing newline (expected failed, got no validator)");
    expect(report.candidateMismatches).toContain("release-scope: an unrelated path (expected failed, got a throw (boom))");
  });
});

describe("release graph routing", () => {
  it("runs each work stage as dispatch → observe → validate, then an independent review, then stops complete", () => {
    let s = step(view());
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "bump", purpose: "work", writeScope: [VERSION_PATH] } });
    s = step(s.next());
    expect(s.decision.action).toEqual({ type: "observe", observe: { paths: [VERSION_PATH], includeWorkspaceManifest: true } });
    s = step(s.next({ evidence: [file(VERSION_PATH, "1.2.0\n"), workspace([VERSION_PATH])] }));
    expect(s.decision.action).toEqual({ type: "validate", validate: { stageId: "bump", requirementIds: ["version-file"] } });

    const bumped = [receipt("bump", "version-file")];
    s = step(s.next({ receipts: bumped }));
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "changelog", writeScope: [CHANGELOG_PATH] } });
    s = step(s.next({ receipts: bumped }));
    expect(s.decision.action).toEqual({
      type: "observe",
      observe: { paths: [VERSION_PATH, CHANGELOG_PATH], includeWorkspaceManifest: true },
    });
    const observed = [file(VERSION_PATH, "1.2.0\n"), file(CHANGELOG_PATH, ENTRY), workspace([CHANGELOG_PATH, VERSION_PATH])];
    s = step(s.next({ receipts: bumped, evidence: observed }));
    expect(s.decision.action).toEqual({
      type: "validate",
      validate: { stageId: "changelog", requirementIds: ["changelog-entry", "release-scope"] },
    });

    const logged = [...bumped, receipt("changelog", "changelog-entry"), receipt("changelog", "release-scope")];
    s = step(s.next({ receipts: logged }));
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "review", purpose: "review", readOnly: true } });
    s = step(s.next({ receipts: logged, evidence: [...observed, review("approved", "matches")] }));
    expect(s.decision.action).toEqual({ type: "validate", validate: { stageId: "review", requirementIds: ["release-review"] } });
    s = step(s.next({ receipts: [...logged, receipt("review", "release-review")] }));
    expect(s.decision.action).toEqual({ type: "stop", stop: { reason: "complete", blocker: "none" } });
  });

  it("corrects a failing stage once with the validator's reason, then asks the supervisor", () => {
    let s = step(step(view()).next());
    const bad = [file(VERSION_PATH, "v1.2.0\n"), workspace([VERSION_PATH])];
    s = step(s.next({ evidence: bad }));
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "bump", purpose: "work" } });
    if (s.decision.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(s.decision.action.job.instruction).toMatch(/^The previous attempt failed validation: VERSION must be MAJOR\.MINOR\.PATCH/);
    s = step(s.next({ evidence: bad }));
    expect(s.decision.action.type).toBe("observe");
    const again = [...bad, file(VERSION_PATH, "v1.2.0\n"), workspace([VERSION_PATH])];
    s = step(s.next({ evidence: again }));
    expect(s.decision.action).toMatchObject({
      type: "supervise",
      supervise: { reason: expect.stringMatching(/^bump still fails validation: VERSION must be/), evidenceRefs: again.map((e) => e.ref) },
    });
  });

  it("reenters Changelog on a change request and gives the rewrite the reviewer's words", () => {
    const logged = [receipt("bump", "version-file"), receipt("changelog", "changelog-entry"), receipt("changelog", "release-scope")];
    const reviewing = JSON.stringify({ stageId: "review", generation: 1, dispatched: true, observed: false, corrections: 0, ran: ["bump", "changelog"] });
    const verdict = review("request_changes", "Name the export command's flag.");
    let s = step(view({ receipts: logged, evidence: [verdict], privateState: reviewing }));
    expect(s.decision.action).toEqual({
      type: "reenter",
      reenter: { stageId: "changelog", reason: "Name the export command's flag.", evidenceRefs: [verdict.ref] },
    });
    s = step(s.next({ generation: 2, receipts: [logged[0]!] }));
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "changelog" } });
    if (s.decision.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(s.decision.action.job.instruction).toContain("An independent reviewer asked for changes: Name the export command's flag.");
  });

  it("revalidates work already done instead of redoing it when a repair restarts the run at Bump", () => {
    const escalated = JSON.stringify({ stageId: "changelog", generation: 1, dispatched: true, observed: true, corrections: 1, ran: ["bump", "changelog"] });
    const invalidated = [receipt("bump", "version-file", false)];
    let s = step(view({ generation: 2, receipts: invalidated, privateState: escalated }));
    expect(s.decision.action).toEqual({ type: "observe", observe: { paths: [VERSION_PATH], includeWorkspaceManifest: true } });
    s = step(s.next({ receipts: [...invalidated, receipt("bump", "version-file")] }));
    expect(s.decision.action.type).toBe("observe");
    expect(s.decision.action).toMatchObject({ observe: { paths: [VERSION_PATH, CHANGELOG_PATH] } });
  });

  it("ignores a stale verdict after a candidate change and asks for a fresh review", () => {
    const logged = [receipt("bump", "version-file"), receipt("changelog", "changelog-entry"), receipt("changelog", "release-scope")];
    const reviewing = JSON.stringify({ stageId: "review", generation: 1, dispatched: true, observed: false, corrections: 0, ran: ["bump", "changelog"] });
    const staleReview: EvidenceRecord = { ...review("approved", "old", 1), candidateDigest: "digest-1" };
    const s = step(
      view({ generation: 2, candidateDigest: "digest-2", receipts: logged, evidence: [staleReview], privateState: reviewing }),
    );
    expect(s.decision.action).toMatchObject({ type: "dispatch", job: { stageId: "review", readOnly: true } });
    // The fresh reviewer returned nothing: the old approval (a different candidate) must not stand in for it.
    expect(step(s.next()).decision.action).toMatchObject({ type: "supervise", supervise: { reason: "the reviewer returned no verdict" } });
  });

  it("validates an approval that spent the last agent invocation, and stops only when more agent work is needed", () => {
    const logged = [receipt("bump", "version-file"), receipt("changelog", "changelog-entry"), receipt("changelog", "release-scope")];
    const reviewing = JSON.stringify({ stageId: "review", generation: 1, dispatched: true, observed: false, corrections: 0, ran: ["bump", "changelog"] });
    const spent = { agentInvocations: 0, jobs: 60, decisions: 100, corrections: 8 };
    const approved = view({ receipts: logged, evidence: [review("approved", "matches")], privateState: reviewing, budgets: spent });
    expect(advanceRelease(approved).action).toEqual({ type: "validate", validate: { stageId: "review", requirementIds: ["release-review"] } });

    const exhausted = { type: "stop", stop: { reason: "budgets exhausted", blocker: "no agent invocations left", retryable: false } };
    expect(advanceRelease(view({ budgets: spent })).action).toEqual(exhausted);
    expect(advanceRelease(view({ receipts: logged, budgets: spent })).action).toEqual(exhausted);
    const bumping = JSON.stringify({ stageId: "bump", generation: 1, dispatched: true, observed: true, corrections: 0, ran: ["bump"] });
    const bad = [file(VERSION_PATH, "v1.2.0\n"), workspace([VERSION_PATH])];
    expect(advanceRelease(view({ evidence: bad, privateState: bumping, budgets: spent })).action).toEqual(exhausted);
  });

  it("stops on a request that names no version to release", () => {
    expect(advanceRelease(view({ task: { request: "Write release notes." } })).action).toEqual({
      type: "stop",
      stop: { reason: "incompatible task", blocker: "the request names no MAJOR.MINOR.PATCH version to release", retryable: false },
    });
  });
});
