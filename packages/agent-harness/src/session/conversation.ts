// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What GraphLoom reads out of a recorded agent transcript (docs/design-typescript-core.md section 15):
 * the human turns, the agent's final answer of each, the turn extract plugins read as run evidence,
 * and the context estimate. Deterministic and harness-neutral in its output; the two transcript
 * formats (Claude Code's session JSONL, Codex's rollout) are read here and nowhere else.
 */

/** A conversation turn: what the human said and the agent's final text answer to it. */
export interface Turn {
  user: string;
  answer?: string;
}

export type TranscriptHarness = "claude-code" | "codex";

/**
 * The line GraphLoom's opening note starts with. The note is context for the opened agent, never an
 * operator turn, so the extract and the "did the operator say anything" test skip a turn that starts so.
 */
export const OPENING_NOTE_PREFIX = "[GraphLoom opening note]";

function records(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      /* a partial last line */
    }
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The text blocks of a Claude Code message's content; tool results and other blocks are not text. */
function claudeText(content: unknown): { text: string; onlyToolResults: boolean } {
  if (typeof content === "string") return { text: content, onlyToolResults: false };
  if (!Array.isArray(content)) return { text: "", onlyToolResults: false };
  const parts: string[] = [];
  let tool = 0;
  for (const block of content) {
    const b = obj(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "tool_result") tool += 1;
  }
  return { text: parts.join("\n"), onlyToolResults: tool > 0 && parts.length === 0 };
}

/** A Claude Code session transcript's human turns, each with the last text the agent wrote before the next one. */
export function claudeTurns(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const r of records(text)) {
    if (r.isSidechain === true) continue;
    const message = obj(r.message);
    if (r.type === "user" && message !== undefined && r.isMeta !== true) {
      const { text: t, onlyToolResults } = claudeText(message.content);
      if (onlyToolResults || t.trim() === "") continue;
      turns.push({ user: t });
    } else if (r.type === "assistant" && message !== undefined && turns.length > 0) {
      const { text: t } = claudeText(message.content);
      if (t.trim() !== "") turns[turns.length - 1]!.answer = t;
    }
  }
  return turns;
}

/** A Codex rollout's human turns, with each turn's last agent message. */
export function codexTurns(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const r of records(text)) {
    const p = obj(r.payload);
    if (r.type !== "event_msg" || p === undefined) continue;
    if (p.type === "user_message" && typeof p.message === "string") turns.push({ user: p.message });
    else if (p.type === "agent_message" && typeof p.message === "string" && turns.length > 0) turns[turns.length - 1]!.answer = p.message;
    else if (p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message !== "" && turns.length > 0) turns[turns.length - 1]!.answer = p.last_agent_message;
  }
  return turns;
}

export function transcriptTurns(harness: TranscriptHarness, text: string): Turn[] {
  return harness === "claude-code" ? claudeTurns(text) : codexTurns(text);
}

/** The turns after the first `parentTurns` (the parent's own, which a fork's transcript starts with), without the opening note. */
export function conversationTurns(harness: TranscriptHarness, transcript: string, parentTranscript: string): Turn[] {
  const own = transcriptTurns(harness, transcript).slice(transcriptTurns(harness, parentTranscript).length);
  return own.filter((t) => !t.user.trimStart().startsWith(OPENING_NOTE_PREFIX));
}

/** One entry of the turn extract. */
export interface ExtractTurn {
  operator: string;
  answer?: string;
  /** The operator message was cut to fit the bound. */
  operatorCut?: true;
  /** The agent answer was cut to its limit or dropped to fit the bound. */
  answerCut?: true;
}

export const EXTRACT_MAX_BYTES = 256 * 1024;
export const EXTRACT_OPERATOR_BYTES = 128 * 1024;
export const EXTRACT_ANSWER_BYTES = 4 * 1024;
const CUT_MARK = "… [cut]";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** `text` cut to at most `max` bytes of UTF-8, without splitting a character, with the cut marked. */
export function cutText(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const room = Math.max(0, max - bytes(CUT_MARK));
  let end = Math.min(text.length, room);
  while (end > 0 && bytes(text.slice(0, end)) > room) end -= 1;
  // Never end between the halves of a surrogate pair.
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${CUT_MARK}`;
}

/**
 * The turn extract (at most 256 KiB): each operator message verbatim, up to 128 KiB in all, and each
 * answer cut to 4 KiB. Past the limit the oldest agent answers go first, then the oldest operator
 * messages; every cut is marked. Tool calls and results never appear.
 */
export function turnExtract(turns: readonly Turn[]): ExtractTurn[] {
  const out: ExtractTurn[] = turns.map((t) => {
    const answer = t.answer !== undefined ? cutText(t.answer, EXTRACT_ANSWER_BYTES) : undefined;
    return { operator: t.user, ...(answer !== undefined ? { answer, ...(answer !== t.answer ? { answerCut: true as const } : {}) } : {}) };
  });
  // Operator messages: whole up to 128 KiB in all; beyond it the oldest are cut to a stub.
  let operatorBytes = out.reduce((n, t) => n + bytes(t.operator), 0);
  for (let i = 0; i < out.length && operatorBytes > EXTRACT_OPERATOR_BYTES; i += 1) {
    const t = out[i]!;
    const before = bytes(t.operator);
    const room = Math.max(256, before - (operatorBytes - EXTRACT_OPERATOR_BYTES));
    t.operator = cutText(t.operator, room);
    t.operatorCut = true;
    operatorBytes -= before - bytes(t.operator);
  }
  const size = (): number => bytes(JSON.stringify(out));
  for (let i = 0; i < out.length && size() > EXTRACT_MAX_BYTES; i += 1) {
    const t = out[i]!;
    if (t.answer !== undefined) {
      t.answer = CUT_MARK;
      t.answerCut = true;
    }
  }
  for (let i = 0; i < out.length && size() > EXTRACT_MAX_BYTES; i += 1) {
    const t = out[i]!;
    t.operator = CUT_MARK;
    t.operatorCut = true;
  }
  return out;
}

/**
 * The input context of the transcript's last model call from its own usage records (Claude Code: input
 * plus cache reads and writes of the last assistant message; Codex: the last token count), or its byte
 * size divided by four when there is none.
 */
export function contextTokens(harness: TranscriptHarness, transcript: string): number {
  let tokens: number | undefined;
  for (const r of records(transcript)) {
    if (harness === "claude-code") {
      const usage = r.type === "assistant" ? obj(obj(r.message)?.usage) : undefined;
      if (usage === undefined) continue;
      const n = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
      tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    } else {
      const p = obj(r.payload);
      if (r.type !== "event_msg" || p?.type !== "token_count") continue;
      const last = obj(obj(p.info)?.last_token_usage);
      if (typeof last?.input_tokens === "number") tokens = last.input_tokens;
    }
  }
  return tokens !== undefined && tokens > 0 ? tokens : Math.ceil(bytes(transcript) / 4);
}
