// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the Review stage reviews and where its reviewers start (design §8.1): the files in scope, the review base session,
 * and the deterministic conversation summary that seeds a reviewer. All of it is recorded once, in the `review-scope`
 * record, so a stop and a resume keep it.
 */
import { createHash } from "node:crypto";
import type { EvidenceRecord, RunView } from "@graphloom/sdk";
import type { Area, Partition } from "./areas.js";
import type { Bullet } from "./briefing.js";
import { isObject } from "./evidence.js";
import type { ReviewMode } from "./mode.js";
import type { PullFile } from "./snapshot.js";

export const SCOPE_SCHEMA = "pr-review-scope-v1";
export const SCOPE_RECORD_ID = "review-scope";
/** The reason every reviewer is seeded in this version (`JobSpec.forkFrom` does not exist yet). */
export const NO_FORK_REASON = "forking is not available in this version";
export const SEED_MAX_BYTES = 32 * 1024;
export const SEED_ANSWER_BYTES = 1024;
const CUT_MARK = "… [cut]";

// ---- the operator's approval and its inputs ----

export interface ApprovalOf {
  decision: "approve" | "decline";
  inputs: Record<string, string>;
  /** The evidence record, which the scope record names. */
  ref: string;
}

/** The operator's latest recorded decision on approval `id` with the inputs it carried, from the run's `operator-approval` evidence. */
export function approvalOf(evidence: readonly EvidenceRecord[], id: string): ApprovalOf | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    const p = e.payload as { type?: unknown; approvalId?: unknown; decision?: unknown; inputs?: unknown } | undefined;
    if (p?.type !== "operator-approval" || p.approvalId !== id || (p.decision !== "approve" && p.decision !== "decline")) continue;
    const inputs: Record<string, string> = {};
    if (isObject(p.inputs)) for (const [k, v] of Object.entries(p.inputs)) if (typeof v === "string") inputs[k] = v;
    return { decision: p.decision, inputs, ref: e.ref };
  }
  return undefined;
}

// ---- the files in scope ----

export interface ScopeAreas {
  id: string;
  name: string;
  files: number;
}

export interface ScopeChoice {
  mode: "standard" | "large";
  /** How the scope was decided. */
  source: "whole" | "operator" | "default";
  areas: ScopeAreas[];
  /** Repository-relative paths, in the snapshot's order. */
  files: string[];
}

const AREA_LIST = /^A[0-9]+(,A[0-9]+)*$/;

/** The `areas` input the operator gave, as area ids, or why it cannot be used. */
export function parseAreasInput(raw: string): string[] | { problem: string } {
  const text = raw.replace(/\s+/g, "");
  if (!AREA_LIST.test(text)) return { problem: `--input areas=${JSON.stringify(raw.slice(0, 60))} is not a comma-separated list of area ids such as A3,A17` };
  return [...new Set(text.split(","))];
}

/**
 * The files the reviewers review (design §8.1). A standard pull request is reviewed whole. In large mode the reviewers review
 * only the files of the areas the operator picked with `--approve review-layer --input areas=A3,A17`; without a list, the
 * areas the briefing's "What you need to check" entries for risks, behavior and compatibility cite (their cites name
 * files, and each file is in one area). An input the pull request cannot use, or a default that cites no area, is a problem
 * that asks the operator to name the areas: a large pull request is never reviewed whole by default.
 */
export function chooseScope(i: { mode: ReviewMode; files: readonly PullFile[]; partition?: Partition | undefined; check: Record<"risks" | "behavior" | "compatibility", readonly Bullet[]>; areasInput?: string | undefined }): ScopeChoice | { problem: string } {
  if (i.mode.mode !== "large" || i.partition === undefined) {
    if (i.areasInput !== undefined) return { problem: "--input areas was given, but this pull request is not large and is reviewed whole; approve again without it" };
    return { mode: "standard", source: "whole", areas: [], files: i.files.map((f) => f.path) };
  }
  const readable = i.partition.areas.filter((a): a is Area => a.kind === "read");
  const ids = readable.map((a) => a.id);
  const listed = `the areas are ${ids.join(", ")}`;
  let picked: Area[];
  let source: "operator" | "default";
  if (i.areasInput !== undefined) {
    const parsed = parseAreasInput(i.areasInput);
    if ("problem" in parsed) return { problem: `${parsed.problem}; ${listed}` };
    const unknown = parsed.filter((id) => !ids.includes(id));
    if (unknown.length > 0) return { problem: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an area of this pull request that the reviewers can read (${listed}; the generated files are never reviewed); approve again with --input areas=<ids>` };
    picked = readable.filter((a) => parsed.includes(a.id));
    source = "operator";
  } else {
    const cited = new Set([...i.check.risks, ...i.check.behavior, ...i.check.compatibility].flatMap((b) => b.cites.map((c) => c.path)));
    picked = readable.filter((a) => a.paths.some((p) => cited.has(p)));
    source = "default";
    if (picked.length === 0) return { problem: `no area is cited by the briefing's risks, behavior and compatibility entries, so there is no default scope for this large pull request (${listed}); approve with --input areas=<ids>` };
  }
  const paths = new Set(picked.flatMap((a) => a.paths));
  return { mode: "large", source, areas: picked.map((a) => ({ id: a.id, name: a.name, files: a.paths.length })), files: i.files.map((f) => f.path).filter((p) => paths.has(p)) };
}

// ---- the review base session and the conversation summary ----

/** One recorded conversation of the operator (`operator-conversation` evidence), with its turn extract. */
export interface Conversation {
  ref: string;
  stageId: string;
  baseSession: string;
  forkSession: string;
  harness?: string;
  endedAt: string;
  contextTokens: number;
  transcriptOmitted: boolean;
  turns: Array<{ operator: string; answer?: string; operatorCut?: boolean; answerCut?: boolean; droppedBefore?: number }>;
}

/** The operator conversations the evidence holds, in the order recorded. */
export function conversations(evidence: readonly EvidenceRecord[]): Conversation[] {
  const out: Conversation[] = [];
  for (const e of evidence) {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p?.type !== "operator-conversation" || typeof p.forkSession !== "string" || typeof p.baseSession !== "string" || typeof p.stageId !== "string" || !Array.isArray(p.turns)) continue;
    out.push({
      ref: e.ref,
      stageId: p.stageId,
      baseSession: p.baseSession,
      forkSession: p.forkSession,
      ...(typeof p.harness === "string" ? { harness: p.harness } : {}),
      endedAt: typeof p.endedAt === "string" ? p.endedAt : "",
      contextTokens: typeof p.contextTokens === "number" ? p.contextTokens : 0,
      transcriptOmitted: typeof p.transcript === "string" && p.transcript.startsWith("omitted"),
      turns: (p.turns as unknown[]).filter(isObject).map((t) => ({
        operator: String(t.operator ?? ""),
        ...(typeof t.answer === "string" ? { answer: t.answer } : {}),
        ...(t.operatorCut === true ? { operatorCut: true } : {}),
        ...(t.answerCut === true ? { answerCut: true } : {}),
        ...(typeof t.droppedBefore === "number" ? { droppedBefore: t.droppedBefore } : {}),
      })),
    });
  }
  return out;
}

/** The review base session, as recorded: what a later fork would start from. */
export interface BaseSession {
  /** `conversation`: the latest operator conversation of the Answers stage; `answerer`: the answerer's own session; `none`: nothing recorded. */
  kind: "conversation" | "answerer" | "none";
  stageId: string;
  /** The session's record in the run (`AgentSessionView.operationId`), which `forkFrom` would name. */
  operationId?: string;
  sessionRef?: string;
  settledAt?: string;
  harness?: string;
  contextTokens?: number;
  transcriptOmitted?: boolean;
  /** The session refs of the conversations the summary comes from, oldest first. */
  chain: string[];
}

/**
 * The review base session (design §8.1): the latest operator conversation of the chat stage by `endedAt`, else the answerer's
 * own session (its newest session of `answererJob` in that stage, corrections included). `chatStage` is the stage `graphloom
 * session open` discusses: the Answers stage, or the Questions stage when N1 was the only question.
 */
export function selectBase(view: Pick<RunView, "agentSessions" | "evidence" | "generation">, chatStage: string, answererJob: string): BaseSession {
  const sessions = view.agentSessions ?? [];
  const all = conversations(view.evidence).filter((c) => c.stageId === chatStage);
  const latest = all.reduce<Conversation | undefined>((best, c) => (best === undefined || c.endedAt >= best.endedAt ? c : best), undefined);
  if (latest !== undefined) {
    const row = sessions.find((s) => s.origin === "operator" && s.sessionRef === latest.forkSession);
    const chain = chainOf(view.evidence, latest).map((c) => c.forkSession);
    return {
      kind: "conversation",
      stageId: chatStage,
      ...(row !== undefined ? { operationId: row.operationId } : {}),
      sessionRef: latest.forkSession,
      settledAt: latest.endedAt,
      ...(latest.harness !== undefined ? { harness: latest.harness } : {}),
      contextTokens: latest.contextTokens,
      ...(latest.transcriptOmitted ? { transcriptOmitted: true } : {}),
      chain,
    };
  }
  const mine = sessions.filter((s) => s.stageId === chatStage && s.dispatchKey === answererJob && s.status === "ok" && s.origin === undefined && s.generation <= view.generation);
  const continued = new Set(mine.map((s) => s.continuedFrom).filter((x) => x !== undefined));
  const newest = mine.filter((s) => !continued.has(s.operationId)).at(-1);
  if (newest === undefined) return { kind: "none", stageId: chatStage, chain: [] };
  return {
    kind: "answerer",
    stageId: chatStage,
    operationId: newest.operationId,
    ...(newest.sessionRef !== undefined ? { sessionRef: newest.sessionRef } : {}),
    ...(newest.settledAt !== undefined ? { settledAt: newest.settledAt } : {}),
    ...(newest.harness !== undefined ? { harness: newest.harness } : {}),
    ...(newest.contextTokens !== undefined ? { contextTokens: newest.contextTokens } : {}),
    chain: [],
  };
}

/** The conversations along `from`'s chain, oldest first: each names the session it forked, which is the earlier conversation's fork. */
export function chainOf(evidence: readonly EvidenceRecord[], from: Conversation): Conversation[] {
  const all = conversations(evidence);
  const chain: Conversation[] = [];
  let cur: Conversation | undefined = from;
  while (cur !== undefined && !chain.includes(cur)) {
    chain.unshift(cur);
    const up: string = cur.baseSession;
    cur = all.find((c) => c.forkSession === up);
  }
  return chain;
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** `text` cut to at most `max` bytes of UTF-8, without splitting a character, with the cut marked. */
export function cutBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const room = Math.max(0, max - bytes(CUT_MARK));
  let end = Math.min(text.length, room);
  while (end > 0 && bytes(text.slice(0, end)) > room) end -= 1;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${CUT_MARK}`;
}

export interface Summary {
  text: string;
  bytes: number;
  /** Cuts made: agent answers cut or dropped, maintainer messages cut, turns dropped whole. */
  cuts: number;
  turns: number;
}

interface SummaryTurn {
  conversation: number;
  endedAt: string;
  operator: string;
  answer?: string;
}

const render = (turns: readonly SummaryTurn[], dropped: number): string => {
  const lines: string[] = [];
  let last = -1;
  if (dropped > 0) lines.push(`(${dropped} older turn${dropped === 1 ? "" : "s"} of the conversation left out to fit the bound)`, "");
  for (const t of turns) {
    if (t.conversation !== last) {
      lines.push(`Conversation ${t.conversation}${t.endedAt !== "" ? ` (ended ${t.endedAt})` : ""}:`);
      last = t.conversation;
    }
    lines.push(`Maintainer: ${t.operator}`);
    if (t.answer !== undefined) lines.push(`Agent: ${t.answer}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
};

/** The smallest `k` in `[0, n]` for which `fits(k)` holds, `fits` being monotone (more of the oldest cut never makes it bigger); `n + 1` when none does. */
function smallest(n: number, fits: (k: number) => boolean): number {
  if (fits(0)) return 0;
  if (!fits(n)) return n + 1;
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The deterministic conversation summary (design §8.1): the turn extracts of the conversations along the base's chain, oldest
 * first, each maintainer message verbatim and each agent answer cut to 1 KiB, at most 32 KiB in all. Past that, the oldest agent
 * answers go first (each becomes a cut marker), then the oldest maintainer messages are cut (each becomes a cut marker); when
 * even that does not fit, the messages stay whole and the oldest turns are left out, counted. Every cut is marked.
 */
export function conversationSummary(chain: readonly Conversation[], max: number = SEED_MAX_BYTES): Summary {
  let cuts = 0;
  const base: SummaryTurn[] = chain.flatMap((c, i) =>
    c.turns.map((t): SummaryTurn => {
      const answer = t.answer === undefined ? undefined : cutBytes(t.answer, SEED_ANSWER_BYTES);
      if (answer !== undefined && answer !== t.answer) cuts += 1;
      return { conversation: i + 1, endedAt: c.endedAt, operator: t.operator, ...(answer !== undefined ? { answer } : {}) };
    }),
  );
  const total = chain.reduce((n, c) => n + c.turns.length, 0);
  const n = base.length;
  const cutAnswers = (k: number): SummaryTurn[] => base.map((t, i) => (i < k && t.answer !== undefined && t.answer !== CUT_MARK ? { ...t, answer: CUT_MARK } : t));
  const cutOperators = (k: number, turns: SummaryTurn[]): SummaryTurn[] => turns.map((t, i) => (i < k ? { ...t, operator: CUT_MARK } : t));
  const fit = (text: string): boolean => bytes(text) <= max;
  const countAnswerCuts = (k: number): number => base.slice(0, k).filter((t) => t.answer !== undefined && t.answer !== CUT_MARK).length;
  let text = render(base, 0);
  if (fit(text)) return { text, bytes: bytes(text), cuts, turns: total };
  const a = smallest(n, (k) => fit(render(cutAnswers(k), 0)));
  if (a <= n) {
    const turns = cutAnswers(a);
    text = render(turns, 0);
    return { text, bytes: bytes(text), cuts: cuts + countAnswerCuts(a), turns: total };
  }
  const allAnswers = cutAnswers(n);
  cuts += countAnswerCuts(n);
  const o = smallest(n, (k) => fit(render(cutOperators(k, allAnswers), 0)));
  if (o <= n) {
    text = render(cutOperators(o, allAnswers), 0);
    return { text, bytes: bytes(text), cuts: cuts + o, turns: total };
  }
  // Even every message as a marker does not fit: keep the newest turns whole and say how many were left out.
  const d = smallest(n - 1, (k) => fit(render(allAnswers.slice(k), k)));
  const left = Math.min(d, n - 1);
  text = render(allAnswers.slice(left), left);
  if (fit(text)) return { text, bytes: bytes(text), cuts: cuts + left, turns: total };
  // Not even the newest turn fits whole (one very long maintainer message): it is cut too, with its marker, so the
  // summary never passes its bound.
  const last = allAnswers[n - 1]!;
  const room = smallest(bytes(last.operator), (b) => !fit(render([{ ...last, operator: cutBytes(last.operator, b) }], n - 1))) - 1;
  text = render([{ ...last, operator: cutBytes(last.operator, Math.max(0, room)) }], n - 1);
  return { text, bytes: bytes(text), cuts: cuts + (n - 1) + 1, turns: total };
}

/** Why every reviewer is seeded, not forked: the transcript was omitted, the base is over the token bound, or (always, in this version) forking does not exist. */
export function seedReason(base: BaseSession, maxParentTokens: number): string {
  if (base.transcriptOmitted === true) return `the base session's transcript was omitted; ${NO_FORK_REASON}`;
  if (base.contextTokens !== undefined && base.contextTokens > maxParentTokens) return `base context ${base.contextTokens.toLocaleString("en-US")} tokens over ${maxParentTokens.toLocaleString("en-US")}`;
  return NO_FORK_REASON;
}

// ---- the scope record ----

/** What the Review stage's first command records: the scope and the base session, which a stop and a resume keep. */
export interface ScopeRecord {
  schema: typeof SCOPE_SCHEMA;
  mode: "standard" | "large";
  source: ScopeChoice["source"];
  /** The operator's `areas` input as given, and the approval that carried it. */
  areasInput?: string;
  approvalRef?: string;
  areas: ScopeAreas[];
  files: string[];
  base: BaseSession;
  context: { kind: "seeded"; reason: string };
  summary: { sha256: string; bytes: number; cuts: number; turns: number };
  /** The harness each aspect's reviewer and verifier run on. */
  harnesses: Record<string, { reviewer: string; verifier: string }>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const scopeRecordJson = (r: ScopeRecord): string => JSON.stringify(r);

export function parseScopeRecord(json: string): ScopeRecord | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObject(v) || v.schema !== SCOPE_SCHEMA || !Array.isArray(v.files) || !Array.isArray(v.areas) || !isObject(v.base) || !isObject(v.context) || !isObject(v.summary) || !isObject(v.harnesses)) return undefined;
    return v as unknown as ScopeRecord;
  } catch {
    return undefined;
  }
}

/** The summary of the conversations a recorded base names, recomputed from the evidence: what every assignment holds and what the record's digest covers. */
export function summaryFor(evidence: readonly EvidenceRecord[], base: BaseSession): Summary {
  const all = conversations(evidence);
  const tip = base.sessionRef === undefined ? undefined : all.find((c) => c.forkSession === base.sessionRef);
  if (base.kind !== "conversation" || tip === undefined) return { text: "", bytes: 0, cuts: 0, turns: 0 };
  return conversationSummary(chainOf(evidence, tip));
}
