// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { CODING_AGENT, GET_ISSUE, LIST_ISSUE_COMMENTS } from "./constants.js";
import { packageOutput } from "./gotest.js";

/** Who produced a piece of evidence; the controller attaches it to job evidence. */
export interface Producer {
  operationId: string;
  stageId: string;
  purpose: string;
  readOnly: boolean;
  kind: string;
  executorId?: string;
}

export interface CommandOutcome {
  id: string;
  argv: string[];
  exitCode: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  spawnError?: string;
  stdoutTail: string;
  stderrTail: string;
  report?: { text: string; truncated: boolean };
}

/** Where a checkout job ran (see the controller's CheckoutRecord). */
export interface CheckoutRecord {
  from: "candidate" | "base";
  base: string;
  commit: string;
  paths: string[];
  prepared: boolean;
  mutations: string[];
  phase: "prepare" | "run";
  /** True when a `from: "candidate"` checkout's own revert patch was applied. */
  reverted?: boolean;
  /** Paths the revert patch touches, present whenever `reverted` is true. */
  revertedPaths?: string[];
  /** Git's message when the revert patch did not apply to the candidate; no command ran. */
  revertError?: string;
  /** The revert patch text that did not apply. */
  revertPatch?: string;
}

export interface CommandRun {
  record: EvidenceRecord;
  command: CommandOutcome;
  checkout?: CheckoutRecord;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  body: string;
  labels: string[];
}

export interface IssueComment {
  author: string | null;
  createdAt: string | null;
  body: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function producer(e: EvidenceRecord): Producer | undefined {
  const p = object(object(e.payload)?.producer);
  return p !== undefined && typeof p.operationId === "string" ? (p as unknown as Producer) : undefined;
}

/** Evidence for the given accepted candidate identity, or carrying no candidate identity at all (e.g. environment checks). */
export function forIdentity(evidence: EvidenceRecord[], identity: string | undefined): EvidenceRecord[] {
  return evidence.filter((e) => e.candidateDigest === undefined || e.candidateDigest === identity);
}

/** Command results, oldest first, optionally only those with `id`. */
export function commandRuns(evidence: EvidenceRecord[], id?: string): CommandRun[] {
  const runs: CommandRun[] = [];
  for (const record of evidence) {
    if (record.kind !== "command") continue;
    const payload = object(record.payload);
    const command = object(payload?.command);
    if (command === undefined || typeof command.id !== "string" || (id !== undefined && command.id !== id)) continue;
    if (object(payload?.environment) !== undefined) continue;
    const checkout = object(payload?.checkout) as CheckoutRecord | undefined;
    runs.push({ record, command: command as unknown as CommandOutcome, ...(checkout !== undefined ? { checkout } : {}) });
  }
  return runs;
}

/** The last line the latest passing run of environment check `id` printed. */
export function environmentOutput(evidence: EvidenceRecord[], id: string): string | undefined {
  for (const record of [...evidence].reverse()) {
    const payload = object(record.payload);
    const command = object(payload?.command) as CommandOutcome | undefined;
    if (record.kind !== "command" || object(payload?.environment) === undefined || command?.id !== id) continue;
    if (!succeeded(command)) return undefined;
    return String(command.stdoutTail ?? "").trim().split("\n").at(-1)?.trim() || undefined;
  }
  return undefined;
}

/**
 * The latest run of `id` bound to `digest` in a plain checkout of `from`,
 * after preparation. Excludes a `from: "candidate"` checkout whose own
 * revert patch was applied — that is a distinct kind of evidence (see
 * `latestRevertedCheckoutRun`), and the regression command id is shared
 * between a real GREEN run and a reverted RED retry on the same digest.
 */
export function latestCheckoutRun(
  evidence: EvidenceRecord[],
  id: string,
  from: CheckoutRecord["from"],
  digest: string | undefined,
): CommandRun | undefined {
  return commandRuns(evidence, id)
    .filter((r) => r.checkout?.from === from && r.checkout.reverted !== true && r.checkout.phase === "run" && digest !== undefined && r.record.candidateDigest === digest)
    .at(-1);
}

/**
 * The latest run of `id` bound to `digest` in a checkout of the full
 * candidate with its own revert patch applied: undoing one specific,
 * already-identified behavioral change while keeping everything else the
 * candidate has, including earlier-round infrastructure a later test may
 * depend on to even build.
 */
export function latestRevertedCheckoutRun(evidence: EvidenceRecord[], id: string, digest: string | undefined): CommandRun | undefined {
  return commandRuns(evidence, id)
    .filter((r) => r.checkout?.from === "candidate" && r.checkout.reverted === true && r.checkout.phase === "run" && digest !== undefined && r.record.candidateDigest === digest)
    .at(-1);
}

/**
 * The latest report, bound to `digest`, that a revert patch did not apply to
 * the candidate, with the patch text that failed.
 */
export function latestRevertFailure(evidence: EvidenceRecord[], digest: string | undefined): { error: string; patch: string | undefined } | undefined {
  for (const record of [...evidence].reverse()) {
    if (digest === undefined || record.candidateDigest !== digest) continue;
    const checkout = object(object(record.payload)?.checkout) as CheckoutRecord | undefined;
    if (checkout?.revertError === undefined) continue;
    return { error: checkout.revertError, patch: checkout.revertPatch };
  }
  return undefined;
}

/** Runs from the same checkout job as `run` (same checkout commit and operation). */
export function sameCheckoutJob(evidence: EvidenceRecord[], run: CommandRun, id: string): CommandRun | undefined {
  const op = producer(run.record)?.operationId;
  return commandRuns(evidence, id).find((r) => producer(r.record)?.operationId === op && r.checkout?.commit === run.checkout?.commit);
}

export function succeeded(command: CommandOutcome): boolean {
  return command.exitCode === 0 && command.timedOut !== true && command.aborted !== true && command.spawnError === undefined;
}

export function describeCommand(command: CommandOutcome): string {
  if (command.spawnError !== undefined) return `${command.id} could not start: ${command.spawnError}`;
  if (command.timedOut === true) return `${command.id} timed out`;
  if (command.aborted === true) return `${command.id} was aborted`;
  return `${command.id} exited ${command.exitCode ?? "on a signal"}`;
}

/** The last lines of a command's output, for a correction or a reviewer. */
export function outputTail(command: CommandOutcome, maxChars = 3_000): string {
  const reported = command.report !== undefined ? packageOutput(command.report.text) : "";
  const text = [reported, command.stderrTail, command.stdoutTail].filter((t) => t.trim().length > 0).join("\n");
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}

export interface AgentRun {
  record: EvidenceRecord;
  producer: Producer;
  status: string;
  output: unknown;
}

/** Coding-agent results for `stageId` and `purpose`, oldest first. */
export function agentRuns(evidence: EvidenceRecord[], stageId: string, purpose: string): AgentRun[] {
  const runs: AgentRun[] = [];
  for (const record of evidence) {
    const p = producer(record);
    if (p === undefined || p.stageId !== stageId || p.purpose !== purpose) continue;
    if (p.executorId !== undefined && p.executorId !== CODING_AGENT.id) continue;
    const agent = object(object(record.payload)?.codingAgent);
    if (agent !== undefined) {
      runs.push({ record, producer: p, status: String(agent.status), output: agent.output });
      continue;
    }
    // A contract-valid "review" result flattens to the validated output itself,
    // producer reattached as a sibling (packages/controller/src/loop.ts's
    // classifyAgentResult) — this only ever happens for a completed result;
    // an invalid one always keeps the codingAgent wrapper above.
    if (record.kind === "review") {
      const { producer: _producer, ...output } = object(record.payload) ?? {};
      runs.push({ record, producer: p, status: "completed", output });
    }
  }
  return runs;
}

export function issueSnapshot(evidence: EvidenceRecord[], number: number): { record: EvidenceRecord; issue: Issue } | undefined {
  for (const record of [...evidence].reverse()) {
    if (producer(record)?.executorId !== GET_ISSUE.id) continue;
    const item = object(object(object(record.payload)?.github)?.item);
    if (item === undefined || item.number !== number) continue;
    const labels = Array.isArray(item.labels) ? item.labels.filter((l): l is string => typeof l === "string") : [];
    return {
      record,
      issue: {
        number,
        title: String(item.title ?? ""),
        state: String(item.state ?? ""),
        url: String(item.url ?? ""),
        body: String(item.body ?? ""),
        labels,
      },
    };
  }
  return undefined;
}

export function issueComments(evidence: EvidenceRecord[]): { record: EvidenceRecord; comments: IssueComment[]; complete: boolean } | undefined {
  for (const record of [...evidence].reverse()) {
    if (producer(record)?.executorId !== LIST_ISSUE_COMMENTS.id) continue;
    const github = object(object(record.payload)?.github);
    const items = github?.items;
    if (!Array.isArray(items)) continue;
    return {
      record,
      complete: object(github?.page)?.complete === true,
      comments: items.map((raw) => {
        const c = object(raw) ?? {};
        return {
          author: typeof c.author === "string" ? c.author : null,
          createdAt: typeof c.createdAt === "string" ? c.createdAt : null,
          body: String(c.body ?? ""),
        };
      }),
    };
  }
  return undefined;
}

export function latestFile(evidence: EvidenceRecord[], path: string, digest: string | undefined): { record: EvidenceRecord; bytes: string } | undefined {
  for (const record of [...evidence].reverse()) {
    const payload = object(record.payload);
    if (record.kind !== "file" || payload?.path !== path) continue;
    if (digest !== undefined && record.candidateDigest !== digest) continue;
    return { record, bytes: String(payload.bytes ?? "") };
  }
  return undefined;
}
