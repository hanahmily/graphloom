// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { pinnedBase } from "./commands.js";
import type { CommandRun } from "./evidence.js";
import { detectFacts, type Fact } from "./detectors.js";
import { reportFlow, type ReportFlow } from "./flow.js";
import { largeContext, largeReportFlow } from "./large.js";
import { pinnedTexts } from "./questions.js";
import { detectStateCandidates } from "./statecandidates.js";
import { READS, readResult, snapshotState, type Snapshot } from "./snapshot.js";
import type { Profile } from "./profile.js";
import type { ReportContext } from "./report.js";
import type { PullRequest } from "./request.js";
import { reporterSections, type Section } from "./template.js";

/** Everything the report's checks share, derived from the evidence and the profile alone. */
export interface Analysis {
  snapshot: Snapshot;
  sections: Section[];
  facts: Fact[];
  ctx: ReportContext;
}

/**
 * The pull request the evidence itself holds: the recorded `get-pull`'s number
 * and head. A validator has no request to read; the graph only reads the
 * pull request its request names, and Fetch's own requirements tie the
 * checkout to this same head.
 */
export function evidencePull(evidence: readonly EvidenceRecord[], profile: Pick<Profile, "owner" | "repo">): PullRequest | undefined {
  const spec = READS.find((r) => r.key === "pull")!;
  const item = readResult(evidence, spec)?.item;
  const head = item !== undefined && typeof item.head === "object" && item.head !== null ? (item.head as { sha?: unknown }).sha : undefined;
  if (item === undefined || typeof item.number !== "number" || typeof head !== "string") return undefined;
  return { mode: "report", owner: profile.owner, repo: profile.repo, number: item.number, head };
}

export type AnalysisResult = { state: "ready"; analysis: Analysis } | { state: "pending"; reason: string } | { state: "incompatible"; problem: string; refs: string[] };

export function analyze(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest): AnalysisResult {
  const s = snapshotState(evidence, pr, profile.limits, profile.questions.excludeRoots);
  if (s.state === "reading") return { state: "pending", reason: s.why };
  if (s.state === "incompatible") return s;
  const sections = reporterSections(profile);
  const facts = detectFacts(s.snapshot.files, profile);
  const base = pinnedBase(evidence);
  const ctx: ReportContext = { sections, files: s.snapshot.files, facts, pinned: pinnedTexts(s.snapshot.pull, s.snapshot.commits), candidates: detectStateCandidates(s.snapshot.files), ...(base !== undefined ? { base } : {}) };
  const partition = s.snapshot.partition;
  return { state: "ready", analysis: { snapshot: s.snapshot, sections, facts, ctx: s.snapshot.mode.mode === "large" && partition !== undefined ? largeContext(ctx, partition) : ctx } };
}

/**
 * Where the report stands: the standard flow, which in large mode runs over the large context and ends with the account
 * of the areas (design §6.9). The graph and the validators both ask this, over the evidence they hold.
 */
export function reportFlowOf(evidence: readonly EvidenceRecord[], analysis: Analysis, retryable?: (r: CommandRun) => boolean): ReportFlow {
  const partition = analysis.snapshot.partition;
  return analysis.snapshot.mode.mode === "large" && partition !== undefined ? largeReportFlow(evidence, analysis.ctx, partition, retryable) : reportFlow(evidence, analysis.ctx, retryable);
}
