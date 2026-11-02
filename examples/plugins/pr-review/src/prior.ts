// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What an earlier run left in the ledger, as a later run on a new head reads it (design §9, part 2 of 0.21): the registry of
 * items (round 1's issues and round 2's findings with their status), the ids to continue from, the stable key that maps the same
 * issue on a new head to its earlier id, and the re-anchoring of an earlier finding to the new head's patch. Everything here is
 * a pure function of the ledger's value and the snapshot, so the graph and the validators agree.
 */
import { createHash } from "node:crypto";
import { COMMAND } from "./constants.js";
import { ledgerRead, oldValue, priorState } from "./ledger.js";
import { isObject } from "./evidence.js";
import { lineText, parsePatch } from "./patch.js";
import type { PullFile } from "./snapshot.js";
import type { EvidenceRecord } from "@graphloom/sdk";

/** The status an item carries in the ledger: open until a later head fixes it or a verifier withdraws it. */
export type ItemStatus = "open" | "fixed" | "withdrawn";

/** One posted item of an earlier head, as the registry holds it (the latest state of its id). */
export interface PriorItem {
  id: string;
  origin: "round1" | "round2";
  /** The stable key: round 1's type and subject, round 2's aspect and anchor. */
  key: string;
  status: ItemStatus;
  /** The head the item was first posted on. */
  head: string;
  /** The aspect whose sweep judges a round-2 finding (the one that raised it). */
  aspect?: string;
  path?: string;
  line?: number;
  endLine?: number;
  side?: "RIGHT" | "LEFT";
  anchorText?: string;
  /** A round-2 finding's severity and kind, as it was posted. */
  severity?: string;
  kind?: string;
  /** The file's patch with its hunk numbers stripped, and the hunk's `[index, old start, new start]`, when the item was anchored. */
  patchId?: string;
  hunk?: [number, number, number];
  /** The item's text as posted, without its marker. */
  text?: string;
  reviewId?: number;
  commentId?: number | null;
  inline?: boolean;
  /** Each head's status of it, oldest first. */
  history: Array<{ head: string; status: string }>;
}

export interface PriorRegistry {
  items: PriorItem[];
  /** The ledger's questions by id and stable key, so the same question on a new head keeps its id. */
  qa: Array<{ id: string; key: string }>;
  /** The numbers the next new question and finding take. */
  nextQ: number;
  nextF: number;
  /** The heads the ledger has seen, oldest first. */
  heads: string[];
}

export const EMPTY_REGISTRY: PriorRegistry = { items: [], qa: [], nextQ: 1, nextF: 1, heads: [] };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const idNumber = (id: string, letter: string): number => (id.startsWith(letter) && /^\d+$/.test(id.slice(1)) ? Number(id.slice(1)) : 0);

/** The registry a prior `ledger.json` holds (its heads, its questions and its posted items). */
export function registryOf(ledger: unknown): PriorRegistry {
  if (!isObject(ledger)) return EMPTY_REGISTRY;
  const heads = (Array.isArray(ledger.heads) ? ledger.heads : []).filter(isObject).map((h) => str(h.sha)).filter((s): s is string => s !== undefined);
  const qa = (Array.isArray(ledger.qa) ? ledger.qa : []).filter(isObject).map((q) => ({ id: str(q.id) ?? "", key: str(q.key) ?? "" })).filter((q) => q.id !== "");
  const items = new Map<string, PriorItem>();
  for (const raw of Array.isArray(ledger.findings) ? ledger.findings : []) {
    if (!isObject(raw)) continue;
    const id = str(raw.id);
    const origin = raw.origin === "round1" || raw.origin === "round2" ? raw.origin : undefined;
    if (id === undefined || origin === undefined) continue;
    const gh = isObject(raw.github) ? raw.github : {};
    const hunk = Array.isArray(raw.hunk) && raw.hunk.length === 3 && raw.hunk.every((n) => typeof n === "number") ? ([raw.hunk[0], raw.hunk[1], raw.hunk[2]] as [number, number, number]) : undefined;
    const status: ItemStatus = raw.state === "fixed" || raw.state === "withdrawn" ? raw.state : "open";
    const history = (Array.isArray(raw.history) ? raw.history : []).filter(isObject).map((h) => ({ head: str(h.head) ?? "", status: str(h.status) ?? "" }));
    const item: PriorItem = {
      id,
      origin,
      key: str(raw.key) ?? "",
      status,
      head: str(raw.head) ?? "",
      ...(str(raw.aspect) !== undefined ? { aspect: str(raw.aspect)! } : {}),
      ...(str(raw.path) !== undefined ? { path: str(raw.path)! } : {}),
      ...(num(raw.line) !== undefined ? { line: num(raw.line)! } : {}),
      ...(num(raw.endLine) !== undefined ? { endLine: num(raw.endLine)! } : {}),
      ...(raw.side === "RIGHT" || raw.side === "LEFT" ? { side: raw.side } : {}),
      ...(str(raw.anchorText) !== undefined ? { anchorText: str(raw.anchorText)! } : {}),
      ...(str(raw.severity) !== undefined ? { severity: str(raw.severity)! } : {}),
      ...(str(raw.kind) !== undefined ? { kind: str(raw.kind)! } : {}),
      ...(str(raw.patchId) !== undefined ? { patchId: str(raw.patchId)! } : {}),
      ...(hunk !== undefined ? { hunk } : {}),
      ...(str(raw.text) !== undefined ? { text: str(raw.text)! } : {}),
      ...(num(gh.reviewId) !== undefined ? { reviewId: num(gh.reviewId)! } : {}),
      ...(gh.commentId === null || num(gh.commentId) !== undefined ? { commentId: (gh.commentId as number | null) } : {}),
      ...(typeof gh.inline === "boolean" ? { inline: gh.inline } : {}),
      history,
    };
    items.set(id, item);
  }
  const all = [...items.values()];
  const nextQ = 1 + Math.max(0, ...qa.map((q) => idNumber(q.id, "Q")), ...all.map((i) => idNumber(i.id, "Q")));
  const nextF = 1 + Math.max(0, ...all.map((i) => idNumber(i.id, "F")));
  return { items: all, qa, nextQ, nextF, heads };
}

/**
 * The registry the run continues from: the ledger value the first `ledger-read` saw and the prior `ledger.json` read from that commit.
 * A ledger that is absent, or whose prior has not been read, gives the empty registry (a run starts from F1 and Q1).
 */
export function registryFromEvidence(evidence: readonly EvidenceRecord[]): PriorRegistry {
  const read = ledgerRead(evidence);
  if (read === undefined || !read.ledger.present) return EMPTY_REGISTRY;
  const prior = priorState(evidence, oldValue(read.ledger));
  return prior.state === "read" ? registryOf(prior.value) : EMPTY_REGISTRY;
}

// ---- stable keys and ids ----

export interface KeyQuestion {
  id: string;
  type: string;
  item: string;
  symbol?: string | undefined;
  fn?: string | undefined;
  fnPath?: string | undefined;
}

export interface KeySymbol {
  id: string;
  path: string;
  qualified: string;
}

/**
 * The stable key of each question: its type and its subject, which is what the same question on a new head shares. The subject
 * is the symbol (path and qualified name), the measured function (path and name), or else the change item's first cited path
 * (an item's own id and text are the reporter's and differ from head to head). Two questions that share a key are told apart by
 * their order.
 */
export function questionKeys(questions: readonly KeyQuestion[], symbols: readonly KeySymbol[], itemPath: (item: string) => string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const q of questions) {
    const sym = q.symbol !== undefined ? symbols.find((s) => s.id === q.symbol) : undefined;
    const base =
      q.type === "necessity"
        ? "necessity|N1"
        : sym !== undefined
          ? `${q.type}|sym|${sym.path}|${sym.qualified}`
          : q.fn !== undefined
            ? `${q.type}|fn|${q.fnPath ?? ""}|${q.fn}`
            : `${q.type}|item|${itemPath(q.item) ?? q.item}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(q.id, n === 1 ? base : `${base}#${n}`);
  }
  return out;
}

/** The ids of a run's questions: a question whose key the ledger holds keeps its id, the others number on from the ledger's last. */
export function continueIds<T extends { id: string; type: string }>(questions: readonly T[], keys: ReadonlyMap<string, string>, registry: PriorRegistry): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const q of registry.qa) if (q.key !== "") byKey.set(q.key, q.id);
  for (const i of registry.items) if (i.origin === "round1" && i.key !== "" && !byKey.has(i.key)) byKey.set(i.key, i.id);
  const used = new Set<string>();
  const out = new Map<string, string>();
  let next = registry.nextQ;
  for (const q of questions) {
    if (q.type === "necessity") {
      out.set(q.id, q.id);
      continue;
    }
    const prior = byKey.get(keys.get(q.id) ?? "");
    if (prior !== undefined && !used.has(prior)) {
      used.add(prior);
      out.set(q.id, prior);
    } else {
      let id = `Q${next}`;
      next += 1;
      while (used.has(id)) {
        id = `Q${next}`;
        next += 1;
      }
      used.add(id);
      out.set(q.id, id);
    }
  }
  return out;
}

// ---- anchors ----

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A file's patch with the line numbers of its hunk headers stripped: equal for a patch that only moved. */
export function patchId(patch: string | null): string | undefined {
  return patch === null || patch === "" ? undefined : sha(patch.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@"));
}

/** The `[index, old start, new start]` of the hunk of `patch` whose lines on `side` include `line`. */
export function hunkAt(patch: string | null, side: "RIGHT" | "LEFT", line: number): [number, number, number] | undefined {
  if (patch === null) return undefined;
  let cur: { k: number; old: number; neu: number; o: number; n: number } | undefined;
  let count = -1;
  for (const raw of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m !== null) {
      count += 1;
      cur = { k: count, old: Number(m[1]), neu: Number(m[2]), o: Number(m[1]), n: Number(m[2]) };
      continue;
    }
    if (cur === undefined || raw.startsWith("\\")) continue;
    const c = raw.charAt(0);
    const at: [number, number, number] = [cur.k, cur.old, cur.neu];
    if (c === "+") {
      if (side === "RIGHT" && cur.n === line) return at;
      cur.n += 1;
    } else if (c === "-") {
      if (side === "LEFT" && cur.o === line) return at;
      cur.o += 1;
    } else {
      if ((side === "RIGHT" && cur.n === line) || (side === "LEFT" && cur.o === line)) return at;
      cur.o += 1;
      cur.n += 1;
    }
  }
  return undefined;
}

/** What a posted item records of its place, so a later head can find it again. */
export function anchorInfo(file: PullFile | undefined, side: "RIGHT" | "LEFT", line: number): { anchorText?: string; patchId?: string; hunk?: [number, number, number] } {
  if (file === undefined || file.patch === null) return {};
  const text = lineText(file.parsed ?? parsePatch(file.patch), side === "RIGHT" ? "head" : "base", line);
  const id = patchId(file.patch);
  const hunk = hunkAt(file.patch, side, line);
  return { ...(text !== undefined && norm(text) !== "" ? { anchorText: norm(text).slice(0, 200) } : {}), ...(id !== undefined ? { patchId: id } : {}), ...(hunk !== undefined ? { hunk } : {}) };
}

/** The round-2 key of a finding: its aspect and its anchor (the file and the text of the commented line, else the line). */
export const findingKey = (aspect: string, path: string, line: number, anchorText: string | undefined): string => `${aspect}|${path}|${anchorText !== undefined ? sha(anchorText) : `L${line}`}`;

/**
 * The aspect whose sweep judges an earlier round-2 finding. A finding a 0.21 run posted records none (nor its kind), so it goes to a
 * fixed aspect: correctness when its kind is known to be behavioral, else maintainability (what a 0.21 run posted were the
 * non-behavioral findings, since a behavioral one was not drafted as a comment).
 */
export const aspectOfItem = (item: Pick<PriorItem, "aspect" | "kind">): string => item.aspect ?? (item.kind === "behavioral" ? "correctness" : "maintainability");

/** The window (in lines) around its old place in which an earlier finding's anchor text is looked for in the new patch. */
export const REANCHOR_WINDOW = 20;

export type Reanchored = { state: "gone" } | { state: "found"; line: number; endLine: number; how: "same" | "shifted" | "searched" } | { state: "outdated" };

/**
 * An earlier finding at the new head: its file is no longer changed (`gone`); its file's patch is the same with hunks that only
 * moved, so its lines shift by the hunk's offset; else its anchor text is found within `REANCHOR_WINDOW` lines of the old place in
 * the new patch; else it is `outdated` (no longer anchored to the diff).
 */
export function reanchor(item: Pick<PriorItem, "path" | "line" | "endLine" | "side" | "anchorText" | "patchId" | "hunk">, files: readonly PullFile[]): Reanchored {
  if (item.path === undefined || item.line === undefined) return { state: "outdated" };
  const file = files.find((f) => f.path === item.path);
  if (file === undefined) return { state: "gone" };
  const side = item.side ?? "RIGHT";
  const end = item.endLine ?? item.line;
  if (item.patchId !== undefined && item.hunk !== undefined && patchId(file.patch) === item.patchId) {
    const delta = hunkDelta(file.patch, side, item.hunk);
    if (delta !== undefined) return { state: "found", line: item.line + delta, endLine: end + delta, how: delta === 0 ? "same" : "shifted" };
  }
  if (item.anchorText !== undefined) {
    const parsed = file.parsed ?? parsePatch(file.patch);
    const want = norm(item.anchorText);
    let best: number | undefined;
    for (const l of parsed.lines) {
      if (side === "RIGHT" ? l.kind === "del" : l.kind === "add") continue;
      const n = side === "RIGHT" ? l.line : l.kind === "del" ? l.line : l.baseLine ?? l.line;
      if (norm(l.text) !== want || Math.abs(n - item.line) > REANCHOR_WINDOW) continue;
      if (best === undefined || Math.abs(n - item.line) < Math.abs(best - item.line)) best = n;
    }
    if (best !== undefined) return { state: "found", line: best, endLine: best + (end - item.line), how: "searched" };
  }
  return { state: "outdated" };
}

/** How far the recorded hunk moved in the new patch (the same but for its numbers, so the hunks correspond by their order). */
function hunkDelta(patch: string | null, side: "RIGHT" | "LEFT", hunk: [number, number, number]): number | undefined {
  if (patch === null) return undefined;
  const heads = [...patch.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)];
  const m = heads[hunk[0]];
  return m === undefined ? undefined : Number(m[side === "RIGHT" ? 2 : 1]) - hunk[side === "RIGHT" ? 2 : 1];
}

/** Whether two ranges on one file (and side) overlap. */
export const overlaps = (a: { path: string; side?: string; start: number; end: number }, b: { path: string; side?: string; start: number; end: number }): boolean =>
  a.path === b.path && (a.side ?? "RIGHT") === (b.side ?? "RIGHT") && a.start <= b.end && b.start <= a.end;

/** The command id the prior ledger is read with, for the Fetch stage to share with Answers. */
export const PRIOR_COMMAND = COMMAND.ledgerPrior;
