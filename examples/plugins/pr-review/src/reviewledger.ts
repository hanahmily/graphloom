// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The ledger's `review` section after the draft (design-pr-review-split §4.1 `ledger-recorded`, §5.1, §5.2): pr-review advances only
 * its own section, by compare-and-swap from the value Fetch read, with this head, its context source, the round-1 head it counts
 * and its lead counts; Publish's `ledger-published` adds the review's ids. A v1 ledger is migrated by this first write (§5.4): the
 * design section the migration builds is carried in, with the v1 commit's report, Q&A and necessity record.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { commandRuns, isObject, reportText, succeeded } from "./kit/evidence.js";
import { COMMAND } from "./kit/constants.js";
import { parseLedger } from "./kit/commands.js";
import { ledgerRead, oldValue, priorState, readBaselines, reviewLedgerWriteCommands, reviewMigrationOf, type ReviewMigration } from "./kit/ledger.js";
import { REVIEW_SCHEMA, reviewMarkdown } from "./kit/ledgerv2.js";
import type { PullRequest } from "./kit/request.js";
import type { Draft } from "./draft.js";

/** This head's entry in the review section, before its review is posted. */
export interface ReviewHead {
  sha: string;
  base?: string;
  context: Draft["context"];
  round1: { head: string; open: number } | null;
  leads: Draft["leads"];
}

/** The review section's `ledger.json` with this head recorded: the prior section's other heads and its findings kept as they were. */
export function reviewLedgerJson(prior: unknown, head: ReviewHead): string {
  const p = isObject(prior) ? prior : {};
  const heads = (Array.isArray(p.heads) ? p.heads : []).filter((h) => !(isObject(h) && h.sha === head.sha));
  return JSON.stringify({ schema: REVIEW_SCHEMA, heads: [...heads, head], findings: Array.isArray(p.findings) ? p.findings : [] });
}

export const reviewHeadOf = (draft: Pick<Draft, "head" | "base" | "context" | "round1" | "leads">): ReviewHead => ({
  sha: draft.head,
  ...(draft.base !== undefined ? { base: draft.base } : {}),
  context: draft.context,
  round1: draft.round1 === null ? null : { head: draft.round1.head, open: draft.round1.open.length },
  leads: draft.leads,
});

export type ReviewLedgerWrite =
  | { state: "ready"; old: string; baseline: string; migration: ReviewMigration; json: string; parts: EnvironmentCommand[]; write: EnvironmentCommand }
  | { state: "read"; commands: EnvironmentCommand[] }
  | { state: "problem"; reason: string; refs: string[] }
  /** Another PR review advanced the review section after this run's Fetch: this run's finding ids and earlier findings are stale. */
  | { state: "stale"; reason: string; refs: string[] };

/** The write of the review section with this head, recomputed from the ledger Fetch read and the draft. */
export function reviewLedgerWrite(evidence: readonly EvidenceRecord[], pr: PullRequest, draft: Draft): ReviewLedgerWrite {
  const read = ledgerRead(evidence);
  if (read === undefined) return { state: "problem", reason: "the ledger value Fetch read is not in the evidence", refs: [] };
  const old = oldValue(read.ledger);
  const prior = priorState(evidence, old);
  if (prior.state === "missing") return { state: "read", commands: prior.next };
  if (prior.state === "unreadable") return { state: "problem", reason: `the prior ledger cannot be read (${prior.reason}); it is never overwritten`, refs: [prior.run.record.ref] };
  const baselines = readBaselines(read.ledger, prior, pr);
  if (baselines === undefined) return { state: "problem", reason: "the prior ledger's sections have not been read", refs: [] };
  // The review section a re-read (after "ledger moved") finds must be the one Fetch read: the draft numbers its findings on from that
  // section and judges its earlier findings, so a section another PR review advanced since makes the draft stale. Only the design
  // section may have moved (it is carried over as the ref holds it).
  const first = commandRuns(evidence, COMMAND.ledger).filter((r) => succeeded(r.command))[0];
  const fetched = first === undefined ? undefined : parseLedger(reportText(first).text);
  if (first !== undefined && fetched !== undefined && first.record.ref !== read.run.record.ref) {
    const fetchedPrior = priorState(evidence, oldValue(fetched));
    if (fetchedPrior.state === "missing") return { state: "read", commands: fetchedPrior.next };
    const was = readBaselines(fetched, fetchedPrior, pr)?.review;
    if (was !== baselines.review) return { state: "stale", reason: `another PR review advanced the pull request's review section (${was ?? "unread"} to ${baselines.review}) after this run's Fetch, so this run's finding ids and earlier findings are stale: start a new pr-review task for this head`, refs: [first.record.ref, read.run.record.ref] };
  }
  const migration = reviewMigrationOf(prior, pr);
  const json = reviewLedgerJson(prior.state === "read" ? prior.value.review : undefined, reviewHeadOf(draft));
  const message = `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: ${draft.context.source} context, ${draft.comments.length} finding comment(s) drafted`;
  const w = reviewLedgerWriteCommands(pr, old, baselines.review, json, reviewMarkdown(pr), migration, message);
  return { state: "ready", old, baseline: baselines.review, migration, json, parts: w.parts, write: w.write };
}
