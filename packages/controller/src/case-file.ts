// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import {
  emptyCaseFile,
  MAX_CASE_ATTEMPTS,
  MAX_CASE_FACTS,
  MAX_CASE_OPEN,
  MAX_CASE_REFS,
  MAX_CASE_REFUTED,
  MAX_CASE_TEXT,
  type CaseDependency,
  type CaseFile,
  type CaseFinding,
  type CaseFindingOutcome,
} from "@graphloom/sdk";
import { stableHash } from "@graphloom/sdk";
import type { SupervisorSettlement } from "@graphloom/supervisor";
import type { DurableRunState } from "./state.js";

/**
 * The controller-owned case file (design-supervisor-robustness.md §4.4): what
 * the supervisor verified, what it refuted, what the controller settled for
 * its proposals, and what it left open. It replaces the supervisor's chat
 * history as memory across episodes; nothing here names a plugin concept.
 */

const MAX_ATTEMPT_OUTCOME = 300;

export function caseFileOf(state: DurableRunState): CaseFile {
  return state.caseFile ?? emptyCaseFile();
}

/**
 * Mark stale every fact and refutation whose candidate digest or active
 * plugin version differs from the run's own now. Staleness is permanent:
 * a later change back does not revive a finding made against other code.
 */
export function refreshCaseFile(state: DurableRunState): DurableRunState {
  const file = state.caseFile;
  if (file === undefined) return state;
  let changed = false;
  const mark = <T extends { dependsOn: CaseDependency; stale?: unknown }>(entry: T): T => {
    if (entry.stale !== undefined) return entry;
    const reason = staleReason(entry.dependsOn, state);
    if (reason === undefined) return entry;
    changed = true;
    return { ...entry, stale: { generation: state.generation, reason } };
  };
  const facts = file.facts.map(mark);
  const refuted = file.refuted.map(mark);
  if (!changed) return state;
  return { ...state, caseFile: { ...file, facts, refuted } };
}

function staleReason(dependsOn: CaseDependency, state: DurableRunState): string | undefined {
  if (dependsOn.candidateDigest !== undefined && dependsOn.candidateDigest !== (state.candidateDigest ?? null)) {
    return "the workspace candidate changed";
  }
  if (dependsOn.activeVersion !== undefined && dependsOn.activeVersion !== state.activeVersion) {
    return `the active plugin version changed from ${dependsOn.activeVersion} to ${state.activeVersion}`;
  }
  if (dependsOn.pluginDigest !== undefined && dependsOn.pluginDigest !== pluginDigest(state)) {
    return "the pinned plugin bundle was updated";
  }
  return undefined;
}

/** The pinned bundle's content identity: what an operator plugin update replaces. */
export function pluginDigest(state: DurableRunState): string {
  const { manifestDigest, entryDigest } = state.intake.bundle;
  return stableHash([manifestDigest, entryDigest]);
}

/** The part a supervisor sees: stale facts and refutations removed. */
export function liveCaseFile(state: DurableRunState): CaseFile {
  const file = caseFileOf(refreshCaseFile(state));
  return {
    facts: file.facts.filter((f) => f.stale === undefined),
    refuted: file.refuted.filter((r) => r.stale === undefined),
    attempts: [...file.attempts],
    open: [...file.open],
  };
}

/**
 * Keep a finding the supervisor submitted, or say why not. A fact or a
 * refutation is kept only when it cites at least one evidence ref and every
 * ref it cites names evidence this run recorded or one of the episode's
 * investigation steps (`stepIds`). A step id is kept as `inv-<n>@<episode>`,
 * since the same id names another step in a later episode.
 */
export function recordFinding(
  state: DurableRunState,
  finding: CaseFinding,
  episodeId: string | undefined,
  stepIds: ReadonlySet<string> = new Set(),
): { state: DurableRunState; outcome: CaseFindingOutcome } {
  const refused = (reason: string) => ({ state, outcome: { kept: false, reason } });
  if (finding === null || typeof finding !== "object") return refused("a finding must be an object");
  const kind = finding.kind;
  if (kind !== "fact" && kind !== "refuted" && kind !== "open") {
    return refused(`kind must be fact, refuted or open, not ${JSON.stringify(kind)}`);
  }
  const text = typeof finding.text === "string" ? finding.text.trim() : "";
  if (text === "") return refused("text must be a non-empty string");
  const bounded = text.length > MAX_CASE_TEXT ? `${text.slice(0, MAX_CASE_TEXT)}…` : text;
  const refreshed = refreshCaseFile(state);
  const file = caseFileOf(refreshed);
  const at = { since: refreshed.generation, ...(episodeId !== undefined ? { episodeId } : {}) };

  if (kind === "open") {
    const open = [...file.open.filter((q) => q.text !== bounded), { text: bounded, ...at }].slice(-MAX_CASE_OPEN);
    return { state: { ...refreshed, caseFile: { ...file, open } }, outcome: { kept: true } };
  }

  const evidence = Array.isArray(finding.evidence)
    ? [...new Set(finding.evidence.filter((r): r is string => typeof r === "string"))]
    : [];
  if (evidence.length === 0) {
    return refused(`a ${kind === "fact" ? "fact" : "refutation"} must cite at least one evidence ref this run recorded`);
  }
  if (evidence.length > MAX_CASE_REFS) return refused(`cite at most ${MAX_CASE_REFS} evidence refs`);
  const known = new Set(refreshed.evidence.map((e) => e.ref));
  const missing = evidence.filter((ref) => !known.has(ref) && !stepIds.has(ref));
  if (missing.length > 0) {
    return refused(
      `no recorded evidence${stepIds.size > 0 ? " or investigation step of this episode" : ""} has ${missing.length === 1 ? "ref" : "refs"} ${missing.join(", ")}`,
    );
  }
  const cites = evidence.map((ref) => (!known.has(ref) && stepIds.has(ref) && episodeId !== undefined ? `${ref}@${episodeId}` : ref));
  const scopes = finding.dependsOn ?? ["candidate", "plugin"];
  if (!Array.isArray(scopes) || scopes.some((s) => s !== "candidate" && s !== "plugin")) {
    return refused('dependsOn must list "candidate" and/or "plugin"');
  }
  const dependsOn: CaseDependency = {
    ...(scopes.includes("candidate") ? { candidateDigest: refreshed.candidateDigest ?? null } : {}),
    ...(scopes.includes("plugin") ? { activeVersion: refreshed.activeVersion, pluginDigest: pluginDigest(refreshed) } : {}),
  };
  const seq = (refreshed.caseFileSeq ?? 0) + 1;

  if (kind === "fact") {
    const same = file.facts.find((f) => f.stale === undefined && f.text === bounded);
    if (same !== undefined) return { state: refreshed, outcome: { kept: true, id: same.id } };
    const id = `fact-${seq}`;
    const facts = bound([...file.facts, { id, text: bounded, evidence: cites, ...at, dependsOn }], MAX_CASE_FACTS);
    return { state: { ...refreshed, caseFileSeq: seq, caseFile: { ...file, facts } }, outcome: { kept: true, id } };
  }
  const same = file.refuted.find((r) => r.stale === undefined && r.claim === bounded);
  if (same !== undefined) return { state: refreshed, outcome: { kept: true, id: same.id } };
  const id = `refuted-${seq}`;
  const refuted = bound([...file.refuted, { id, claim: bounded, by: cites, ...at, dependsOn }], MAX_CASE_REFUTED);
  return { state: { ...refreshed, caseFileSeq: seq, caseFile: { ...file, refuted } }, outcome: { kept: true, id } };
}

/** Keep at most `max` entries, dropping the oldest stale ones first, then the oldest live ones. */
function bound<T extends { stale?: unknown }>(entries: T[], max: number): T[] {
  const kept = [...entries];
  while (kept.length > max) {
    const oldestStale = kept.findIndex((e) => e.stale !== undefined);
    kept.splice(oldestStale >= 0 ? oldestStale : 0, 1);
  }
  return kept;
}

/**
 * Record the settlement of the supervisor's last proposal as an attempt,
 * once. The controller writes it from its own observations; the model has
 * no way to add or edit one.
 */
export function recordAttempt(state: DurableRunState, settlement: SupervisorSettlement | undefined): DurableRunState {
  const mark = state.supervisorMark;
  if (settlement === undefined || mark === undefined || mark.attemptRecorded === true) return state;
  const file = caseFileOf(state);
  const outcome = settlement.facts.join("; ");
  const action = `${mark.action}: ${mark.reason}`;
  const attempts = [
    ...file.attempts,
    {
      episodeId: mark.episodeId ?? "none",
      trigger: mark.triggerCode ?? "none",
      action: action.length > MAX_CASE_TEXT ? `${action.slice(0, MAX_CASE_TEXT)}…` : action,
      outcome: outcome.length > MAX_ATTEMPT_OUTCOME ? `${outcome.slice(0, MAX_ATTEMPT_OUTCOME)}…` : outcome,
      generation: mark.generation,
    },
  ].slice(-MAX_CASE_ATTEMPTS);
  return {
    ...state,
    caseFile: { ...file, attempts },
    supervisorMark: { ...mark, attemptRecorded: true },
  };
}
