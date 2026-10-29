// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomBytes } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ConfinementSpec } from "@graphloom/sdk";
import { newEvidenceRef } from "./admit.js";
import { harnessOfSessionRef } from "./agent-sessions.js";
import { withDirectoryLock } from "./lock.js";
import { isClaimStale, readOwnerClaim } from "./owner.js";
import { isUnsettled } from "./reconcile.js";
import { loadRunState, saveRunState, type AgentSessionRecord, type DurableRunState } from "./state.js";

/** Largest stored conversation transcript (`maxConversationBytes` in the runner config). */
export const DEFAULT_MAX_CONVERSATION_BYTES = 32 * 1024 * 1024;

/** Where a run's conversations are kept inside its session directory. */
export function conversationsDir(stateDir: string): string {
  return path.join(stateDir, "agent-sessions", "operator");
}

/** The directory holding a session's saved copy: a job's own, or the conversations'. */
export function savedSessionDir(record: AgentSessionRecord): string {
  return record.sessionDir;
}

export type OpenStatus = "ok" | "running" | "pi: no interactive restore" | "wiped" | "transcript omitted" | "not a coding agent session";

export interface SessionRow {
  /** The record id: a job session's operation id, or a conversation's. */
  id: string;
  stageId: string;
  attempt: number;
  dispatchKey: string;
  executorId: string;
  harness?: AgentSessionRecord["harness"];
  sessionRef: string;
  status: AgentSessionRecord["status"];
  settledAt: string;
  origin: "job" | "operator";
  /** The operation a continuation carried on, or a conversation's parent (record id). */
  continuedFrom?: string;
  parent?: string;
  /** The parent's session ref, for a conversation. */
  parentRef?: string;
  startedAt?: string;
  endedAt?: string;
  contextTokens?: number;
  openable: OpenStatus;
}

/** The operations whose session a continuing dispatch carries on: it and everything it continued. */
function continuedLineage(state: DurableRunState, from: string | undefined): Set<string> {
  const lineage = new Set<string>();
  let next = from;
  while (next !== undefined && !lineage.has(next)) {
    lineage.add(next);
    next = state.agentSessions?.find((r) => r.operationId === next)?.continuedFrom;
  }
  return lineage;
}

/** Whether the job that owns `record`, or a continuation of it, has not settled. */
function ownerRunning(state: DurableRunState, record: AgentSessionRecord): boolean {
  const pending = state.pendingDispatch;
  if (pending === undefined || !isUnsettled(pending)) return false;
  if (pending.operationId === record.operationId) return true;
  const carried = pending.job.continueFrom;
  return carried !== undefined && continuedLineage(state, carried).has(record.operationId);
}

/** Why `record` cannot be opened, as a row reads it; `ok` when it can. */
export function openStatus(state: DurableRunState, record: AgentSessionRecord): OpenStatus {
  if (state.status === "succeeded" || state.status === "failed") return "wiped";
  const harness = record.harness ?? harnessOfSessionRef(record.sessionRef);
  if (harness === "pi") return "pi: no interactive restore";
  if (harness === undefined) return "not a coding agent session";
  if (record.transcript?.omitted === true) return "transcript omitted";
  if (ownerRunning(state, record)) return "running";
  return "ok";
}

export function sessionRows(state: DurableRunState): SessionRow[] {
  const records = state.agentSessions ?? [];
  return records.map((r) => {
    const parent = r.parent !== undefined ? records.find((p) => p.operationId === r.parent) : undefined;
    return {
      id: r.operationId,
      stageId: r.stageId,
      attempt: r.attempt,
      dispatchKey: r.dispatchKey,
      executorId: r.executorId,
      ...(r.harness !== undefined ? { harness: r.harness } : harnessOfSessionRef(r.sessionRef) !== undefined ? { harness: harnessOfSessionRef(r.sessionRef)! } : {}),
      sessionRef: r.sessionRef,
      status: r.status,
      settledAt: r.settledAt,
      origin: r.origin === "operator" ? "operator" : "job",
      ...(r.continuedFrom !== undefined ? { continuedFrom: r.continuedFrom } : {}),
      ...(r.parent !== undefined ? { parent: r.parent } : {}),
      ...(parent !== undefined ? { parentRef: parent.sessionRef } : {}),
      ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
      ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
      ...(r.contextTokens !== undefined ? { contextTokens: r.contextTokens } : {}),
      openable: openStatus(state, r),
    };
  });
}

export interface SessionSelector {
  stage?: string;
  /** A session ref, an operation id, or a conversation's record id. */
  ref?: string;
  fromOriginal?: boolean;
}

const latest = (records: readonly AgentSessionRecord[], at: (r: AgentSessionRecord) => string): AgentSessionRecord | undefined =>
  records.reduce<AgentSessionRecord | undefined>((best, r) => (best === undefined || at(r) >= at(best) ? r : best), undefined);

/**
 * The session `session open` forks (docs/design-typescript-core.md section 15). With `stage`: the stage's
 * latest operator conversation (a chained fork), or with none, or with `fromOriginal`, the stage's job session:
 * the latest attempt that recorded one, the dispatch key that attempt dispatched first, that key's latest
 * session. With `ref`: that record. With neither: the run's latest session.
 */
export function selectSession(state: DurableRunState, selector: SessionSelector): AgentSessionRecord | { refusal: string } {
  const records = state.agentSessions ?? [];
  if (records.length === 0) return { refusal: `run ${state.runId} recorded no agent session` };
  if (selector.ref !== undefined) {
    const byId = records.find((r) => r.operationId === selector.ref);
    if (byId !== undefined) return byId;
    const byRef = latest(records.filter((r) => r.sessionRef === selector.ref), (r) => r.settledAt);
    if (byRef !== undefined) return byRef;
    return { refusal: `run ${state.runId} has no session ${JSON.stringify(selector.ref)}; graphloom session list ${state.runId} shows them` };
  }
  if (selector.stage !== undefined) {
    const inStage = records.filter((r) => r.stageId === selector.stage);
    if (inStage.length === 0) return { refusal: `run ${state.runId} recorded no agent session in stage ${JSON.stringify(selector.stage)}` };
    if (selector.fromOriginal !== true) {
      const chat = latest(inStage.filter((r) => r.origin === "operator"), (r) => r.endedAt ?? r.settledAt);
      if (chat !== undefined) return chat;
    }
    const jobs = inStage.filter((r) => r.origin !== "operator");
    if (jobs.length === 0) return { refusal: `stage ${selector.stage} has no job session to start from` };
    const attempt = Math.max(...jobs.map((r) => r.attempt));
    const ofAttempt = jobs.filter((r) => r.attempt === attempt);
    // The key whose job settled first was dispatched first: in a stage where an author's job is followed by a checker's, the author.
    const firstKey = [...ofAttempt].sort((a, b) => a.settledAt.localeCompare(b.settledAt))[0]!.dispatchKey;
    return latest(ofAttempt.filter((r) => r.dispatchKey === firstKey), (r) => r.settledAt)!;
  }
  return latest(records, (r) => r.endedAt ?? r.settledAt)!;
}

/** Why `record` cannot be forked, or undefined. The files, the executor and the host are checked by the caller. */
export function openRefusal(state: DurableRunState, record: AgentSessionRecord): string | undefined {
  const status = openStatus(state, record);
  switch (status) {
    case "ok":
      break;
    case "wiped":
      return `run ${state.runId} has ${state.status}: its saved sessions were removed, so there is nothing to restore (the evidence stays in run state)`;
    case "pi: no interactive restore":
      return `session ${record.sessionRef} is a Pi session: Pi has no interactive restore, so it cannot be opened; read its transcript in the run's state instead`;
    case "transcript omitted":
      return `the conversation ${record.operationId}'s transcript was over the bound and not stored, so it cannot be forked; open from the original (--from-original) instead`;
    case "running":
      return `the job that owns session ${record.sessionRef} (or a continuation of it) is still running; open it after it settles`;
    case "not a coding agent session":
      return `session ${record.sessionRef} was not recorded by a harness this command can open`;
  }
  const byPrefix = harnessOfSessionRef(record.sessionRef);
  if (record.harness !== undefined && byPrefix !== undefined && record.harness !== byPrefix) {
    return `session ${record.sessionRef}'s record says ${record.harness} but its ref names ${byPrefix}; refusing to open it in either`;
  }
  return undefined;
}

/**
 * One line of status for the opened agent, from generic run data: what the stage's other jobs reported
 * after this session ended, and the run's status. Built from records, never from model output.
 */
export function openingNote(state: DurableRunState, record: AgentSessionRecord): string {
  const records = state.agentSessions ?? [];
  const jobRoot = (r: AgentSessionRecord): AgentSessionRecord => {
    let cur = r;
    while (cur.parent !== undefined) {
      const up = records.find((p) => p.operationId === cur.parent);
      if (up === undefined) break;
      cur = up;
    }
    return cur;
  };
  const root = jobRoot(record);
  const since = records.filter((r) => r.origin !== "operator" && r.stageId === record.stageId && r.settledAt > root.settledAt && r.operationId !== root.operationId);
  const parts = since.map((r) => `a job of ${r.dispatchKey} settled ${r.status}${r.summary !== undefined ? ` (${r.summary})` : ""}`);
  const status = `run status ${state.status}${state.stopReason !== undefined ? ` (${state.stopReason})` : ""}`;
  const kind = record.origin === "operator" ? "an earlier conversation on the" : "the";
  const text = `This is a fork of ${kind} ${record.stageId} session; since it ended: ${[...parts, status].join(", ")}.`;
  return text.length > 700 ? `${text.slice(0, 699)}…` : text;
}

/** What `session open` hands the controller once the agent has exited. */
export interface ConversationCapture {
  /** The session the fork came from: its record id. */
  parentId: string;
  /** The fork's session ref and its own harness-defined identity. */
  sessionRef: string;
  startedAt: string;
  endedAt: string;
  /** A directory with the fork's saved copy (`<ref>.json`, `<ref>.jsonl`, `<ref>/`) to move into the run; absent when the transcript was omitted. */
  stagedDir?: string;
  transcript: { sha256: string; bytes: number; omitted?: true };
  contextTokens: number;
  /** The turn extract, opaque to the controller. */
  turns: unknown;
}

export type ConversationOutcome = { recorded: true; recordId: string; evidenceRef: string } | { recorded: false; reason: string };

/**
 * Record an operator conversation: only now and only for the write, under the run lock, and only into a run
 * that has stopped (a running controller holds its own copy of the state and would overwrite this write) and
 * has not finished (its saved sessions are gone). Otherwise nothing is recorded and the reason says why.
 */
export async function recordConversation(stateDir: string, capture: ConversationCapture): Promise<ConversationOutcome> {
  return withDirectoryLock(stateDir, "run.exec.lock", async () => {
    const state = await loadRunState(stateDir);
    if (state.status === "succeeded" || state.status === "failed") {
      return { recorded: false as const, reason: `run ${state.runId} finished while the agent ran, and its saved sessions were removed` };
    }
    const owner = await readOwnerClaim(stateDir);
    if (state.status !== "stopped" || (owner !== undefined && !isClaimStale(owner))) {
      return { recorded: false as const, reason: `run ${state.runId} is ${state.status === "stopped" ? "owned by a live controller" : state.status}; a conversation is recorded into a run that has stopped` };
    }
    const records = state.agentSessions ?? [];
    const parent = records.find((r) => r.operationId === capture.parentId);
    if (parent === undefined) return { recorded: false as const, reason: `session ${capture.parentId} is no longer in run ${state.runId}` };
    let root = parent;
    while (root.parent !== undefined) {
      const up = records.find((r) => r.operationId === root.parent);
      if (up === undefined) break;
      root = up;
    }
    const recordId = `conv-${randomBytes(4).toString("hex")}`;
    const dir = conversationsDir(stateDir);
    if (capture.stagedDir !== undefined) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await cp(capture.stagedDir, dir, { recursive: true, errorOnExist: true, force: false });
    }
    const harness = parent.harness ?? harnessOfSessionRef(capture.sessionRef);
    const record: AgentSessionRecord = {
      operationId: recordId,
      stageId: parent.stageId,
      attempt: parent.attempt,
      generation: state.generation,
      dispatchKey: "operator",
      executorId: parent.executorId,
      status: "ok",
      sessionRef: capture.sessionRef,
      sessionDir: dir,
      settledAt: capture.endedAt,
      ...(harness !== undefined ? { harness } : {}),
      ...(parent.confinement !== undefined ? { confinement: structuredClone(parent.confinement as ConfinementSpec) } : {}),
      origin: "operator",
      parent: parent.operationId,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
      transcript: capture.transcript,
      contextTokens: capture.contextTokens,
    };
    const evidenceRef = newEvidenceRef(state);
    const payload = {
      type: "operator-conversation",
      stageId: parent.stageId,
      baseSession: parent.sessionRef,
      rootSession: root.sessionRef,
      forkSession: capture.sessionRef,
      ...(harness !== undefined ? { harness } : {}),
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
      transcript: capture.transcript.omitted === true ? `omitted (${capture.transcript.bytes} bytes)` : { sha256: capture.transcript.sha256, bytes: capture.transcript.bytes },
      sha256: capture.transcript.sha256,
      contextTokens: capture.contextTokens,
      turns: capture.turns,
    };
    try {
      await saveRunState({
        ...state,
        agentSessions: [...records, record],
        evidence: [...state.evidence, { ref: evidenceRef, kind: "other", generation: state.generation, payload }],
        stateRevision: state.stateRevision + 1,
      });
    } catch (err) {
      if (capture.stagedDir !== undefined) {
        for (const name of [capture.sessionRef, `${capture.sessionRef}.json`, `${capture.sessionRef}.jsonl`]) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
    return { recorded: true as const, recordId, evidenceRef };
  });
}
