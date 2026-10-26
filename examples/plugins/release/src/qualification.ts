// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ValidationStatus, Validator } from "@graphloom/sdk";
import { CHANGELOG_PATH, VERSION_PATH } from "./constants.js";
import { createGraph } from "./graph.js";

/** One expected outcome, derived from a requirement statement rather than from any validator's code. */
export interface QualificationCase {
  validatorId: string;
  name: string;
  evidence: EvidenceRecord[];
  expected: ValidationStatus;
}

export interface QualificationReport {
  ok: boolean;
  summary: string;
  /** Cases the candidate got wrong, as "validatorId: name (expected X, got Y)". */
  candidateMismatches: string[];
  /** Cases the old version got wrong: the reproduced defect. */
  baselineMismatches: string[];
}

type ValidatorLookup = (validatorId: string) => Validator | undefined;

let seq = 0;
const file = (path: string, bytes: string | null): EvidenceRecord => ({
  ref: `qualify-${++seq}`,
  kind: "file",
  payload: { path, bytes: bytes ?? "" },
  fingerprint: bytes === null ? "missing" : `qualify-fp-${seq}`,
});
const workspace = (changedPaths: string[]): EvidenceRecord => ({ ref: `qualify-${++seq}`, kind: "workspace", payload: { changedPaths } });
const review = (payload: unknown): EvidenceRecord => ({ ref: `qualify-${++seq}`, kind: "review", payload });

const LOG_HEAD = "# Changelog\n\n## [Unreleased]\n\n";
const entry = (changelog: string | null, version: string | null = "1.2.0\n"): EvidenceRecord[] => [
  file(VERSION_PATH, version),
  file(CHANGELOG_PATH, changelog),
];
const semver = (name: string, bytes: string | null, expected: ValidationStatus): QualificationCase => ({
  validatorId: "semver-file",
  name,
  evidence: [file(VERSION_PATH, bytes)],
  expected,
});
const changelog = (name: string, evidence: EvidenceRecord[], expected: ValidationStatus): QualificationCase => ({
  validatorId: "changelog-entry",
  name,
  evidence,
  expected,
});

/** Positive and negative cases for every shipped validator. */
export const QUALIFICATION_CASES: readonly QualificationCase[] = [
  semver("one version and a newline", "1.2.0\n", "passed"),
  semver("missing newline", "1.2.0", "failed"),
  semver("leading v", "v1.2.0\n", "failed"),
  semver("two-part version", "1.2\n", "failed"),
  semver("trailing blank line", "1.2.0\n\n", "failed"),
  semver("missing VERSION", null, "failed"),
  { validatorId: "semver-file", name: "never observed", evidence: [], expected: "inconclusive" },

  changelog("dated heading", entry(`${LOG_HEAD}## [1.2.0] - 2026-09-27\n\n- Export command\n\n## [1.1.0] - 2026-08-01\n\n- Older\n`), "passed"),
  changelog("undated heading", entry("## [1.2.0]\n\n- Export command\n"), "passed"),
  changelog("bullet under a subsection", entry(`${LOG_HEAD}## [1.2.0] - 2026-09-27\n\n### Added\n\n- Export command\n`), "passed"),
  changelog("mismatched VERSION", entry(`${LOG_HEAD}## [1.2.0] - 2026-09-27\n\n- Export command\n`, "1.3.0\n"), "failed"),
  changelog("older release first", entry(`${LOG_HEAD}## [1.1.0] - 2026-08-01\n\n- Older\n\n## [1.2.0]\n\n- Export command\n`), "failed"),
  changelog("heading without brackets", entry("## 1.2.0\n\n- Export command\n"), "failed"),
  changelog("malformed date", entry("## [1.2.0] - 27/09/2026\n\n- Export command\n"), "failed"),
  changelog("text after the heading", entry("## [1.2.0] - 2026-09-27 (beta)\n\n- Export command\n"), "failed"),
  changelog("no listed change", entry("## [1.2.0] - 2026-09-27\n\nExport command.\n"), "failed"),
  changelog("empty bullet", entry("## [1.2.0] - 2026-09-27\n\n- \n"), "failed"),
  changelog("only an Unreleased section", entry(`${LOG_HEAD}- Pending\n`), "failed"),
  changelog("missing CHANGELOG.md", entry(null), "failed"),
  changelog("missing VERSION", entry("## [1.2.0]\n\n- Export command\n", null), "failed"),
  changelog("VERSION without a version", entry("## [1.2.0]\n\n- Export command\n", "next\n"), "failed"),
  changelog("VERSION never observed", [file(CHANGELOG_PATH, "## [1.2.0]\n\n- Export command\n")], "inconclusive"),

  { validatorId: "release-scope", name: "exactly VERSION and CHANGELOG.md", evidence: [workspace([CHANGELOG_PATH, VERSION_PATH])], expected: "passed" },
  { validatorId: "release-scope", name: "an unrelated path", evidence: [workspace([CHANGELOG_PATH, VERSION_PATH, "src/x.ts"])], expected: "failed" },
  { validatorId: "release-scope", name: "CHANGELOG.md unchanged", evidence: [workspace([VERSION_PATH])], expected: "failed" },
  { validatorId: "release-scope", name: "no manifest", evidence: [], expected: "inconclusive" },

  { validatorId: "independent-reviewer", name: "approved", evidence: [review({ verdict: "approved", summary: "ok" })], expected: "passed" },
  { validatorId: "independent-reviewer", name: "changes requested", evidence: [review({ verdict: "request_changes" })], expected: "failed" },
  { validatorId: "independent-reviewer", name: "unknown verdict", evidence: [review({ verdict: "lgtm" })], expected: "inconclusive" },
];

/**
 * Qualify a candidate's validators against the cases. With a baseline, the
 * old version must get at least one case wrong: a repair has to reproduce the
 * defect it fixes.
 */
export function qualifyValidators(candidate: ValidatorLookup, baseline?: ValidatorLookup): QualificationReport {
  const candidateMismatches = mismatches(candidate);
  const baselineMismatches = baseline ? mismatches(baseline) : [];
  const total = QUALIFICATION_CASES.length;
  let summary: string;
  if (candidateMismatches.length > 0) {
    summary = `candidate fails ${candidateMismatches.length} of ${total} qualification cases: ${candidateMismatches.join("; ")}`;
  } else if (baseline && baselineMismatches.length === 0) {
    summary = `the old version passes all ${total} qualification cases, so no defect is reproduced`;
  } else {
    summary = `candidate passes all ${total} qualification cases` + (baseline ? `; the old version fails ${baselineMismatches.join("; ")}` : "");
  }
  return {
    ok: candidateMismatches.length === 0 && (!baseline || baselineMismatches.length > 0),
    summary,
    candidateMismatches,
    baselineMismatches,
  };
}

function mismatches(lookup: ValidatorLookup): string[] {
  return QUALIFICATION_CASES.flatMap((c) => {
    const got = outcome(lookup, c);
    return got === c.expected ? [] : [`${c.validatorId}: ${c.name} (expected ${c.expected}, got ${got})`];
  });
}

function outcome(lookup: ValidatorLookup, c: QualificationCase): string {
  const validator = lookup(c.validatorId);
  if (validator === undefined) return "no validator";
  const definition = createGraph().describe();
  const requirementId = definition.defaultValidators.find((b) => b.validatorId === c.validatorId)!.requirementId;
  const statement = definition.requirements.find((r) => r.id === requirementId)!.statement;
  try {
    return validator.evaluate({ requirementId, statement, evidence: c.evidence }).status;
  } catch (err) {
    return `a throw (${err instanceof Error ? err.message : String(err)})`;
  }
}
