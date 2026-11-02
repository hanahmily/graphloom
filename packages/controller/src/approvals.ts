// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { MAX_APPROVAL_FILE_BYTES, MAX_APPROVAL_INPUT_CHARS } from "@graphloom/sdk";
import { newEvidenceRef } from "./admit.js";
import type { DurableRunState } from "./state.js";

/** `graphloom resume <run> --approve <id>` or `--decline <id> [--reason <text>]`. */
export interface ApprovalRequest {
  approvalId: string;
  decision: "approve" | "decline";
  reason?: string;
  /** Who decided: the operator's login name, recorded as given. */
  operator?: string;
  /** `--input <name>=<value>` values of an approve, checked against the approval's declared inputs. */
  inputs?: Record<string, string>;
}

/** The `operator-approval` evidence payload (docs/design-pr-review-graph.md section 11, decision half). */
export interface OperatorApprovalPayload {
  type: "operator-approval";
  approvalId: string;
  decision: "approve" | "decline";
  reason?: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  /** The operator's input values by declared name (absent when none were given); the controller does not read their meaning. */
  inputs?: Record<string, string>;
  operator: string;
  at: string;
  generation: number;
}

/** Longest `--reason` kept in the evidence. */
export const MAX_APPROVAL_REASON = 1_000;

/**
 * Why this approval cannot be recorded, or undefined. Checked before the
 * resume changes anything: the run is stopped (an approval answers a stop),
 * the graph declared the id, and an approval the graph marks `unavailable`
 * is refused with the graph's own message (a decline still records).
 */
export function approvalRefusal(state: DurableRunState, request: ApprovalRequest): string | undefined {
  if (state.status === "succeeded" || state.status === "failed") {
    return `run ${state.runId} has ${state.status}; there is nothing left to ${request.decision}`;
  }
  const declared = state.definition.approvals ?? [];
  const entry = declared.find((a) => a.id === request.approvalId);
  if (entry === undefined) {
    return declared.length === 0
      ? `graph ${state.definition.graphId} declares no approvals`
      : `graph ${state.definition.graphId} declares no approval ${JSON.stringify(request.approvalId)}; it declares ${declared.map((a) => a.id).join(", ")}`;
  }
  if (request.decision === "approve" && entry.unavailable !== undefined) return entry.unavailable;
  const inputProblem = inputRefusal(entry, request);
  if (inputProblem !== undefined) return inputProblem;
  if (request.reason !== undefined && request.reason.length > MAX_APPROVAL_REASON) {
    return `--reason is ${request.reason.length} characters, more than ${MAX_APPROVAL_REASON}`;
  }
  if (state.status !== "stopped") return `run ${state.runId} is ${state.status}; ${request.decision} an approval when it has stopped`;
  return undefined;
}

/** Why the `--input` values do not fit what the approval declared, or undefined. */
function inputRefusal(entry: { id: string; inputs?: Array<{ name: string; pattern?: string }> }, request: ApprovalRequest): string | undefined {
  const given = Object.entries(request.inputs ?? {});
  if (given.length === 0) return undefined;
  if (request.decision === "decline") return "--input goes with --approve: a decline takes no input";
  const declared = entry.inputs ?? [];
  if (declared.length === 0) return `approval ${JSON.stringify(entry.id)} declares no inputs`;
  for (const [name, value] of given) {
    const input = declared.find((d) => d.name === name);
    if (input === undefined) return `approval ${JSON.stringify(entry.id)} declares no input ${JSON.stringify(name)}; it declares ${declared.map((d) => d.name).join(", ")}`;
    if (value.length > MAX_APPROVAL_INPUT_CHARS) return `input ${name} is ${value.length} characters, more than ${MAX_APPROVAL_INPUT_CHARS}`;
    if (/[\u0000-\u001f]/.test(value)) return `input ${name} holds a control character`;
    if (input.pattern !== undefined && !new RegExp(`^(?:${input.pattern})$`).test(value)) return `input ${name} is ${JSON.stringify(value.length > 80 ? `${value.slice(0, 79)}…` : value)}, which does not match the declared pattern ${input.pattern}`;
  }
  return undefined;
}

/** Read the declared files under the worktree: regular files below it, 256 KiB together. */
async function pinFiles(worktree: string, files: readonly string[]): Promise<OperatorApprovalPayload["files"]> {
  const root = await realpath(worktree);
  const pinned: OperatorApprovalPayload["files"] = [];
  let total = 0;
  for (const rel of files) {
    const file = path.join(root, rel);
    const info = await lstat(file).catch(() => undefined);
    if (info === undefined) throw new Error(`approval file ${rel} does not exist in the worktree`);
    if (!info.isFile()) throw new Error(`approval file ${rel} is not a regular file`);
    const real = await realpath(file);
    if (!real.startsWith(root + path.sep)) throw new Error(`approval file ${rel} leaves the worktree`);
    total += info.size;
    if (total > MAX_APPROVAL_FILE_BYTES) throw new Error(`the files an approval pins are more than ${MAX_APPROVAL_FILE_BYTES} bytes together`);
    const handle = await open(file, "r");
    try {
      const bytes = await handle.readFile();
      pinned.push({ path: rel, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    } finally {
      await handle.close();
    }
  }
  return pinned;
}

/** Record the decision as `operator-approval` evidence, under the run lock the caller holds. */
export async function applyApproval(state: DurableRunState, request: ApprovalRequest): Promise<DurableRunState> {
  // `approvalRefusal` judged the request while the run was still stopped; here the resume has already started it again.
  const entry = state.definition.approvals?.find((a) => a.id === request.approvalId);
  if (entry === undefined) throw new Error(`graph ${state.definition.graphId} declares no approval ${JSON.stringify(request.approvalId)}`);
  const files = request.decision === "approve" && entry.files !== undefined ? await pinFiles(state.worktreePath, entry.files) : [];
  const payload: OperatorApprovalPayload = {
    type: "operator-approval",
    approvalId: request.approvalId,
    decision: request.decision,
    ...(request.reason !== undefined && request.reason !== "" ? { reason: request.reason } : {}),
    files,
    ...(request.decision === "approve" && request.inputs !== undefined && Object.keys(request.inputs).length > 0 ? { inputs: { ...request.inputs } } : {}),
    operator: request.operator ?? "operator",
    at: new Date().toISOString(),
    generation: state.generation,
  };
  const ref = newEvidenceRef(state);
  return {
    ...state,
    evidence: [...state.evidence, { ref, kind: "other", generation: state.generation, payload }],
    stateRevision: state.stateRevision + 1,
  };
}
