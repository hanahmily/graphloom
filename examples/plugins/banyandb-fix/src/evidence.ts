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

export interface ReviewVerdict {
  record: EvidenceRecord;
  verdict: string;
  summary: string;
  findings: Array<{ axis?: string; severity?: string; detail: string }>;
  productDecision?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function producer(e: EvidenceRecord): Producer | undefined {
  const p = object(object(e.payload)?.producer);
  return p !== undefined && typeof p.operationId === "string" ? (p as unknown as Producer) : undefined;
}

export function inGeneration(evidence: EvidenceRecord[], generation: number): EvidenceRecord[] {
  return evidence.filter((e) => e.generation === undefined || e.generation === generation);
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

/** The latest run of `id` bound to `digest` in a checkout of `from`, after preparation. */
export function latestCheckoutRun(
  evidence: EvidenceRecord[],
  id: string,
  from: CheckoutRecord["from"],
  digest: string | undefined,
): CommandRun | undefined {
  return commandRuns(evidence, id)
    .filter((r) => r.checkout?.from === from && r.checkout.phase === "run" && digest !== undefined && r.record.candidateDigest === digest)
    .at(-1);
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
    const agent = object(object(record.payload)?.codingAgent);
    if (p === undefined || agent === undefined || p.stageId !== stageId || p.purpose !== purpose) continue;
    if (p.executorId !== undefined && p.executorId !== CODING_AGENT.id) continue;
    runs.push({ record, producer: p, status: String(agent.status), output: agent.output });
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

export function issueComments(evidence: EvidenceRecord[]): { record: EvidenceRecord; comments: IssueComment[] } | undefined {
  for (const record of [...evidence].reverse()) {
    if (producer(record)?.executorId !== LIST_ISSUE_COMMENTS.id) continue;
    const items = object(object(record.payload)?.github)?.items;
    if (!Array.isArray(items)) continue;
    return {
      record,
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

export function latestReview(evidence: EvidenceRecord[]): ReviewVerdict | undefined {
  const record = [...evidence].reverse().find((e) => e.kind === "review");
  const payload = object(record?.payload);
  if (record === undefined || payload === undefined) return undefined;
  const findings = Array.isArray(payload.findings)
    ? payload.findings.flatMap((raw) => {
        const f = object(raw);
        return f !== undefined && typeof f.detail === "string"
          ? [{ detail: f.detail, ...(typeof f.axis === "string" ? { axis: f.axis } : {}), ...(typeof f.severity === "string" ? { severity: f.severity } : {}) }]
          : [];
      })
    : [];
  return {
    record,
    verdict: String(payload.verdict ?? ""),
    summary: String(payload.summary ?? ""),
    findings,
    ...(typeof payload.productDecision === "string" && payload.productDecision.trim() !== "" ? { productDecision: payload.productDecision } : {}),
  };
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
