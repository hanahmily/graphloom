// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The supervisor's memory across recovery episodes (design-supervisor-robustness.md
 * §4.4). The controller owns it and stores it in run state: the supervisor adds
 * facts, refutations and open questions with its `record_finding` tool, and the
 * controller writes the attempts from its own settlements. Every episode starts
 * a fresh model session seeded with the live part, so nothing the model said in
 * an earlier episode reaches a later one except through here.
 */

/** Facts kept in run state, live and stale together; the oldest stale ones are dropped first. */
export const MAX_CASE_FACTS = 24;
/** Refuted claims kept, under the same dropping rule as facts. */
export const MAX_CASE_REFUTED = 16;
/** Settled attempts kept, newest last. */
export const MAX_CASE_ATTEMPTS = 12;
/** Open questions kept, newest last. */
export const MAX_CASE_OPEN = 8;
/** Characters kept from one finding's text. */
export const MAX_CASE_TEXT = 300;
/** Evidence refs one finding may cite. */
export const MAX_CASE_REFS = 8;

/**
 * What a finding was established against. A finding goes stale once the
 * run's candidate digest or active plugin version differs from the one
 * recorded here; an absent field is not depended on.
 */
export interface CaseDependency {
  /**
   * The run's workspace candidate digest when the finding was recorded;
   * `null` when the workspace had no candidate change yet.
   */
  candidateDigest?: string | null;
  /** The run's active plugin version when the finding was recorded. */
  activeVersion?: string;
  /**
   * Content identity of the pinned plugin bundle when the finding was
   * recorded. An operator's plugin update replaces the bundle's code while
   * the active version stays the same; this catches it. Recorded together
   * with `activeVersion`; absent in entries from before it existed.
   */
  pluginDigest?: string;
}

export interface CaseStaleness {
  /** Generation in which the controller marked it stale. */
  generation: number;
  /** What changed, e.g. `candidate digest changed`. */
  reason: string;
}

export interface CaseFact {
  id: string;
  text: string;
  /** Evidence refs this run recorded; every one existed when the fact was kept. */
  evidence: string[];
  /** Generation the fact was established in. */
  since: number;
  episodeId?: string;
  dependsOn: CaseDependency;
  /** Set once what the fact depends on changed; a stale fact is never shown to the supervisor. */
  stale?: CaseStaleness;
}

export interface CaseRefutation {
  id: string;
  /** The claim the evidence refutes. */
  claim: string;
  /** Evidence refs that refute it. */
  by: string[];
  since: number;
  episodeId?: string;
  dependsOn: CaseDependency;
  stale?: CaseStaleness;
}

/** One settled supervisor proposal, written by the controller, never by the model. */
export interface CaseAttempt {
  episodeId: string;
  /** The recovery trigger code the proposal answered. */
  trigger: string;
  /** The action and its stated reason. */
  action: string;
  /** What the controller settled for it. */
  outcome: string;
  generation: number;
}

export interface CaseOpenQuestion {
  text: string;
  episodeId?: string;
  since: number;
}

export interface CaseFile {
  facts: CaseFact[];
  refuted: CaseRefutation[];
  attempts: CaseAttempt[];
  open: CaseOpenQuestion[];
}

/** A finding the supervisor submits with `record_finding`. */
export interface CaseFinding {
  /** `fact`: verified by evidence. `refuted`: a claim the evidence disproves. `open`: a question left for later. */
  kind: "fact" | "refuted" | "open";
  text: string;
  /** Evidence refs the finding cites; required for a fact or a refutation. */
  evidence?: string[];
  /**
   * What the finding holds only for: the current workspace candidate, the
   * active plugin version, or both (the default). An empty list depends on
   * neither, for findings about the task itself.
   */
  dependsOn?: Array<"candidate" | "plugin">;
}

/** The controller's answer to a `record_finding` call. */
export interface CaseFindingOutcome {
  kept: boolean;
  /** The kept entry's id. */
  id?: string;
  /** Why it was not kept, e.g. a cited ref that does not exist. */
  reason?: string;
}

export function emptyCaseFile(): CaseFile {
  return { facts: [], refuted: [], attempts: [], open: [] };
}
