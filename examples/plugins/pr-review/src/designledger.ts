// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The design section's content after this head's report and Q&A (design-pr-review-split §5.1): the heads, the purposes, the
 * questions and their answers. The ledger's layout, reads and compare-and-swap writes are the review kit's (`kit/ledger.ts`).
 */
import type { FinalAnswer } from "./answers.js";
import { isObject } from "./kit/evidence.js";
import { DESIGN_SCHEMA } from "./kit/ledgerv2.js";
import type { PullRequest } from "./kit/request.js";
import type { PurposeRecord, Question } from "./questions.js";

const ANSWER_CHARS = 400;

export interface LedgerHead {
  sha: string;
  base: string | undefined;
  files: number;
  commits: number;
  facts: number;
}

export interface LedgerQa {
  id: string;
  type: string;
  /** The question's stable key (design §9.4): its type and subject, which maps the same question on a later head to this id. */
  key: string;
  symbol: string | null;
  item: string;
  status: string;
  answer: string;
  state: "open";
  history: Array<{ answer: string; status: string }>;
}

export interface LedgerInput {
  pr: PullRequest;
  base: string | undefined;
  files: number;
  commits: number;
  facts: number;
  questions: readonly Question[];
  answers: readonly FinalAnswer[];
  purposes: readonly PurposeRecord[];
}

/**
 * The design section's `ledger.json` after this head's report and Q&A, keeping what the prior design section holds: its other heads,
 * the questions an earlier head asked and this one did not (so their ids are never reused), and the posted round-1 items. Round 1's
 * outcome on this head (`round1`, `open`, and a round-1 post's review id) is set when the review is published.
 */
export function ledgerJson(i: LedgerInput, priorDesign: unknown): string {
  const prior = isObject(priorDesign) ? priorDesign : {};
  const priorHeads = Array.isArray(prior.heads) ? (prior.heads as unknown[]).filter((h) => isObject(h) && typeof h.sha === "string" && h.sha !== i.pr.head) : [];
  const answers = new Map(i.answers.map((a) => [a.question, a] as const));
  const current = new Set(i.questions.map((q) => q.id));
  const carried = Array.isArray(prior.qa) ? (prior.qa as unknown[]).filter((q) => isObject(q) && typeof q.id === "string" && !current.has(q.id)) : [];
  const items = Array.isArray(prior.items) ? prior.items : [];
  const head: LedgerHead = { sha: i.pr.head, base: i.base, files: i.files, commits: i.commits, facts: i.facts };
  return JSON.stringify({
    schema: DESIGN_SCHEMA,
    heads: [...priorHeads, head],
    purposes: i.purposes,
    qa: [
      ...i.questions.map((q): LedgerQa => {
        const a = answers.get(q.id);
        return { id: q.id, type: q.type, key: q.stable ?? "", symbol: q.symbol ?? q.fn ?? null, item: q.item, status: a?.status ?? "unanswered", answer: (a?.answer ?? "").slice(0, ANSWER_CHARS), state: "open", history: a?.history ?? [] };
      }),
      ...carried,
    ],
    items,
  });
}

export function ledgerMarkdown(i: LedgerInput): string {
  const by = (s: string): number => i.answers.filter((a) => a.status === s).length;
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number}: the design review`,
    "",
    `Head ${i.pr.head}${i.base !== undefined ? ` on base ${i.base}` : ""}: report and Q&A recorded (${i.questions.length} questions: ${by("answered")} answered, ${by("partially answered")} partially answered, ${by("needs author")} needs author).`,
    "",
    "The files beside this one are the latest report.json, qa.json and necessity.json; `git log -p` on this ref is the pull request's history.",
    "",
  ].join("\n");
}
