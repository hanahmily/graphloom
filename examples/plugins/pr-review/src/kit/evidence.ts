// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { CODING_AGENT } from "./constants.js";

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

export interface CommandRun {
  record: EvidenceRecord;
  command: CommandOutcome;
}

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function producer(e: EvidenceRecord): Producer | undefined {
  const p = isObject(e.payload) ? e.payload.producer : undefined;
  return isObject(p) && typeof p.operationId === "string" ? (p as unknown as Producer) : undefined;
}

/** Command results, oldest first, optionally only those with `id`; environment checks are left out. */
export function commandRuns(evidence: readonly EvidenceRecord[], id?: string): CommandRun[] {
  const runs: CommandRun[] = [];
  for (const record of evidence) {
    if (record.kind !== "command" || !isObject(record.payload)) continue;
    const command = record.payload.command;
    if (!isObject(command) || typeof command.id !== "string" || (id !== undefined && command.id !== id)) continue;
    if (isObject(record.payload.environment)) continue;
    runs.push({ record, command: command as unknown as CommandOutcome });
  }
  return runs;
}

export function succeeded(command: CommandOutcome): boolean {
  return command.exitCode === 0 && command.timedOut !== true && command.aborted !== true && command.spawnError === undefined;
}

/** The text a command printed: its report file when it wrote one, else its output tail (a rehearsal's stub has no report). */
export function reportText(run: CommandRun): { text: string; truncated: boolean } {
  return run.command.report !== undefined ? { text: run.command.report.text, truncated: run.command.report.truncated } : { text: run.command.stdoutTail, truncated: false };
}

export function describeCommand(command: CommandOutcome): string {
  if (command.spawnError !== undefined) return `${command.id} could not start: ${command.spawnError}`;
  if (command.timedOut === true) return `${command.id} timed out`;
  if (command.aborted === true) return `${command.id} was aborted`;
  return `${command.id} exited ${command.exitCode ?? "on a signal"}`;
}

export function outputTail(command: CommandOutcome, maxChars = 1_500): string {
  const text = [command.stderrTail, command.stdoutTail].filter((t) => t.trim().length > 0).join("\n");
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}

/** The last line the latest passing run of environment check `id` printed. */
export function environmentOutput(evidence: readonly EvidenceRecord[], id: string): string | undefined {
  for (const record of [...evidence].reverse()) {
    if (record.kind !== "command" || !isObject(record.payload) || !isObject(record.payload.environment)) continue;
    const command = record.payload.command as CommandOutcome | undefined;
    if (command?.id !== id) continue;
    if (!succeeded(command)) return undefined;
    return String(command.stdoutTail ?? "").trim().split("\n").at(-1)?.trim() || undefined;
  }
  return undefined;
}

export interface AgentRun {
  record: EvidenceRecord;
  producer: Producer;
  status: string;
  output: unknown;
  /** The controller's check of the result against its contract, when the job named one. */
  contract?: NonNullable<EvidenceRecord["contract"]>;
}

/** Coding-agent results of the contract `schema`, oldest first. */
export function agentRuns(evidence: readonly EvidenceRecord[], schema: string): AgentRun[] {
  const runs: AgentRun[] = [];
  for (const record of evidence) {
    const p = producer(record);
    if (p === undefined || record.resultSchema !== schema) continue;
    if (p.executorId !== undefined && p.executorId !== CODING_AGENT.id) continue;
    const agent = isObject(record.payload) ? record.payload.codingAgent : undefined;
    const contract = record.contract !== undefined ? { contract: record.contract } : {};
    if (isObject(agent)) {
      runs.push({ record, producer: p, status: String(agent.status), output: agent.output, ...contract });
      continue;
    }
    // A contract-valid "review" result is flattened to the validated output itself, producer reattached as a sibling.
    if (record.kind === "review" && isObject(record.payload)) {
      const { producer: _producer, ...output } = record.payload;
      runs.push({ record, producer: p, status: "completed", output, ...contract });
    }
  }
  return runs;
}

/**
 * The evidence the controller hands a validator for the live candidate (its `candidateEvidence`): records with
 * no candidate identity or this one, the latest observation of each file, and only the latest review and
 * workspace record. A requirement must be decidable from this alone, so the graph judges the same view
 * before it asks for a validation.
 */
export function validatorEvidence(evidence: readonly EvidenceRecord[], digest: string | undefined): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const files = new Set<string>();
  const kinds = new Set<string>();
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    if (e.candidateDigest !== undefined && e.candidateDigest !== digest) continue;
    if (e.kind === "file") {
      const p = isObject(e.payload) ? e.payload.path : undefined;
      if (typeof p !== "string" || files.has(p)) continue;
      files.add(p);
    } else if (e.kind === "review" || e.kind === "workspace") {
      if (kinds.has(e.kind)) continue;
      kinds.add(e.kind);
    }
    out.unshift(e);
  }
  return out;
}

export function latestFile(evidence: readonly EvidenceRecord[], path: string): { record: EvidenceRecord; bytes: string; missing: boolean } | undefined {
  for (const record of [...evidence].reverse()) {
    if (record.kind !== "file" || !isObject(record.payload) || record.payload.path !== path) continue;
    return { record, bytes: String(record.payload.bytes ?? ""), missing: record.fingerprint === "missing" };
  }
  return undefined;
}
