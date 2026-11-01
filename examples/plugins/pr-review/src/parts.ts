// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Multi-part writes (design §6.6). One command carries at most about 236,000 characters, so an artifact past that
 * (a large pull request's report.json, qa.json or review.md) is written as a bounded series of part commands, each
 * one job and so each recorded as evidence. The parts append, in order, to `<path>.parts`; the last checks the whole
 * file against the digest every part carries and renames it into place, so the final file is never half written.
 * Validators reconstruct the artifact by concatenating the recorded parts in order and checking the digest.
 * An artifact that fits one command is still written by its single command (`write.ts`).
 */
import { createHash } from "node:crypto";
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, NECESSITY_JSON, PART_BASE, QA_JSON, REPORT_JSON, REVIEW_DIR, REVIEW_HTML, REVIEW_MD } from "./constants.js";
import { commandRuns, succeeded, type CommandRun } from "./evidence.js";
import { necessityWriteCommand, qaWriteCommand, recordCommand, reportWriteCommand, writeChunks, writtenNecessity, writtenQa, writtenRecord, writtenReport } from "./write.js";

/** Argv elements of a part command that are not chunks: the shell, `-c`, the script, the id, the path, k, n, the digest and the chunk count. */
const PART_FIXED = 9;
/** Chunks one part command carries: the executor allows 64 argv elements. */
export const MAX_PART_CHUNKS = 64 - PART_FIXED;
const MAX_PART_INPUT_BYTES = MAX_EXECUTOR_INPUT_BYTES - 4_096;

const PART_SCRIPT =
  'set -eu; path="$1"; k="$2"; n="$3"; digest="$4"; count="$5"; shift 5; [ "$#" -eq "$count" ] || { echo "part carries $# chunks, not $count" >&2; exit 6; }; ' +
  `mkdir -p "$(dirname "$path")" ${REVIEW_DIR}; printf '*\\n' > ${REVIEW_DIR}/.gitignore; ` +
  'if [ "$k" -eq 1 ]; then : > "$path.parts"; else [ -f "$path.parts" ] || { echo "part $k arrived before part 1" >&2; exit 3; }; fi; ' +
  'for part in "$@"; do printf \'%s\' "$part" >> "$path.parts"; done; ' +
  'if [ "$k" -eq "$n" ]; then ' +
  'if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum < "$path.parts" | cut -d" " -f1); [ "$got" = "$digest" ] || { echo "digest mismatch: $got, not $digest" >&2; exit 5; }; fi; ' +
  'mv "$path.parts" "$path"; fi; echo written';

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const partId = (base: string, k: number): string => `${base}-p${k}`;

/** The pieces of `text` that each fit one part command: at most MAX_PART_CHUNKS chunks, and the executor's input bound once JSON-escaped. */
export function splitParts(text: string): string[][] {
  const chunks = writeChunks(text);
  const bound = MAX_PART_INPUT_BYTES - 1_500 - Buffer.byteLength(PART_SCRIPT, "utf8");
  const parts: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const c of chunks) {
    const size = Buffer.byteLength(JSON.stringify(c), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= MAX_PART_CHUNKS || bytes + size > bound)) {
      parts.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += size;
  }
  parts.push(cur);
  return parts;
}

/** The commands that write `text` to `path` as a multi-part artifact: one command per part, in order; one part for a small artifact. */
export function partCommands(base: string, path: string, text: string): EnvironmentCommand[] {
  const parts = splitParts(text);
  const digest = sha256(text);
  return parts.map((chunks, i): EnvironmentCommand => ({ id: partId(base, i + 1), argv: ["sh", "-c", PART_SCRIPT, partId(base, i + 1), path, String(i + 1), String(parts.length), digest, String(chunks.length), ...chunks] }));
}

/** What the evidence holds of an artifact: nothing yet, a problem, or its text (with the records it rests on and where the last of them sits). */
export type Written<T> = { state: "none" } | { state: "failed"; reason: string; refs: string[] } | { state: "read"; value: T; refs: string[]; at: number };

/**
 * The artifact a part set wrote, reconstructed by concatenating the recorded parts in order and checking the
 * digest every part carries: a part missing, failed, out of order, naming another file or count, or altered
 * (its text no longer hashes to the digest) is a problem, never a text.
 */
export function readParts(evidence: readonly EvidenceRecord[], base: string, path: string): Written<string> {
  const index = new Map(evidence.map((e, i) => [e.ref, i] as const));
  const latest = new Map<number, CommandRun>();
  const prefix = `${base}-p`;
  for (const run of commandRuns(evidence)) {
    if (!run.command.id.startsWith(prefix)) continue;
    const k = run.command.id.slice(prefix.length);
    if (/^[1-9]\d*$/.test(k)) latest.set(Number(k), run);
  }
  const first = latest.get(1);
  if (first === undefined) return { state: "none" };
  const n = Number(first.command.argv[6]);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) return { state: "failed", reason: `${partId(base, 1)} does not say how many parts ${path} has`, refs: [first.record.ref] };
  const digest = first.command.argv[7] ?? "";
  const refs: string[] = [];
  let text = "";
  let last = -1;
  for (let k = 1; k <= n; k += 1) {
    const run = latest.get(k);
    if (run === undefined) return { state: "failed", reason: `part ${k} of ${n} of ${path} was never written`, refs };
    refs.push(run.record.ref);
    const id = partId(base, k);
    if (!succeeded(run.command)) return { state: "failed", reason: `${id} did not succeed (exit ${run.command.exitCode ?? "signal"})`, refs };
    const a = run.command.argv;
    const chunks = a.slice(PART_FIXED);
    if (a[3] !== id || a[4] !== path || a[5] !== String(k) || a[6] !== String(n)) return { state: "failed", reason: `${id} is not part ${k} of ${n} of ${path}`, refs };
    if (a[7] !== digest) return { state: "failed", reason: `${id} carries another digest than part 1 (the parts are not of one artifact)`, refs };
    if (a[8] !== String(chunks.length)) return { state: "failed", reason: `${id} carries ${chunks.length} chunks, not the ${a[8] ?? "?"} it declares`, refs };
    const at = index.get(run.record.ref) ?? -1;
    if (at < last) return { state: "failed", reason: `${id} was written before an earlier part: the parts are out of order`, refs };
    last = at;
    text += chunks.join("");
  }
  if (sha256(text) !== digest) return { state: "failed", reason: `the parts of ${path} do not hash to their digest: a part was altered`, refs };
  return { state: "read", value: text, refs, at: last };
}

/**
 * An artifact as the evidence holds it: written by its single command (`legacyId`, decoded by `decode`), or by part
 * sets. The later of the two stands, so an artifact that grew past one command is read from its parts.
 */
function readArtifact<T>(evidence: readonly EvidenceRecord[], legacyId: string, decode: (argv: readonly string[]) => T | undefined, parts: Array<{ base: string; path: string }>, join: (texts: string[]) => T): Written<T> {
  const position = (ref: string): number => evidence.findIndex((e) => e.ref === ref);
  const single = commandRuns(evidence, legacyId).at(-1);
  const singleAt = single === undefined ? -1 : position(single.record.ref);
  const sets = parts.map((p) => readParts(evidence, p.base, p.path));
  const setsAt = Math.max(-1, ...sets.flatMap((s) => (s.state === "none" ? [] : s.refs.map(position))));
  if (single !== undefined && singleAt > setsAt) {
    if (!succeeded(single.command)) return { state: "failed", reason: `${legacyId} exited ${single.command.exitCode ?? "on a signal"}`, refs: [single.record.ref] };
    const value = decode(single.command.argv);
    return value === undefined ? { state: "failed", reason: `${legacyId} carries no artifact`, refs: [single.record.ref] } : { state: "read", value, refs: [single.record.ref], at: singleAt };
  }
  const bad = sets.find((s) => s.state === "failed");
  if (bad !== undefined && bad.state === "failed") return bad;
  const have = sets.filter((s): s is Extract<Written<string>, { state: "read" }> => s.state === "read");
  if (have.length === 0) return { state: "none" };
  if (have.length < parts.length) return { state: "failed", reason: `${parts.filter((_, i) => sets[i]!.state === "none").map((p) => p.path).join(", ")} has no recorded parts`, refs: have.flatMap((s) => s.refs) };
  return { state: "read", value: join(have.map((s) => s.value)), refs: have.flatMap((s) => s.refs), at: setsAt };
}

/** The commands that write `report.json` and `review.md`: one command when both fit it, else a part set for each. */
export function reportWriteCommands(json: string, markdown: string): EnvironmentCommand[] {
  const one = reportWriteCommand(json, markdown);
  return one !== undefined ? [one] : [...partCommands(PART_BASE.reportJson, REPORT_JSON, json), ...partCommands(PART_BASE.reviewMd, REVIEW_MD, markdown)];
}

/** The commands that write `qa.json` and the whole `review.md`. */
export function qaWriteCommands(json: string, markdown: string): EnvironmentCommand[] {
  const one = qaWriteCommand(json, markdown);
  return one !== undefined ? [one] : [...partCommands(PART_BASE.qaJson, QA_JSON, json), ...partCommands(PART_BASE.qaMd, REVIEW_MD, markdown)];
}

/** The commands that write `necessity.json`: one command when it fits, else a part set. */
export function necessityWriteCommands(json: string): EnvironmentCommand[] {
  const one = necessityWriteCommand(json);
  return one !== undefined ? [one] : partCommands(PART_BASE.necessityJson, NECESSITY_JSON, json);
}

/** The commands that write `review.html` at the Report stage (`qa` false) or, whole, at the Answers stage. */
export const htmlWriteCommands = (html: string, qa: boolean): EnvironmentCommand[] => partCommands(qa ? PART_BASE.qaHtml : PART_BASE.reviewHtml, REVIEW_HTML, html);

/** The commands that record a step of a large run (an area, the synthesis, an answered batch): one command when it fits, else a part set. */
export function recordCommands(id: string, dir: string, json: string): EnvironmentCommand[] {
  const one = recordCommand(id, dir, json);
  return one !== undefined ? [one] : partCommands(id, `${REVIEW_DIR}/${dir}/${id}.json`, json);
}

/** What `report.json` and `review.md` hold, as written by their command or their parts. */
export function recordedReport(evidence: readonly EvidenceRecord[]): Written<{ json: string; markdown: string }> {
  return readArtifact(evidence, COMMAND.reportWrite, writtenReport, [{ base: PART_BASE.reportJson, path: REPORT_JSON }, { base: PART_BASE.reviewMd, path: REVIEW_MD }], ([json, markdown]) => ({ json: json!, markdown: markdown! }));
}

/** What `qa.json` and the whole `review.md` hold. */
export function recordedQa(evidence: readonly EvidenceRecord[]): Written<{ json: string; markdown: string }> {
  return readArtifact(evidence, COMMAND.qaWrite, writtenQa, [{ base: PART_BASE.qaJson, path: QA_JSON }, { base: PART_BASE.qaMd, path: REVIEW_MD }], ([json, markdown]) => ({ json: json!, markdown: markdown! }));
}

/** What `necessity.json` holds. */
export function recordedNecessityJson(evidence: readonly EvidenceRecord[]): Written<string> {
  return readArtifact(evidence, COMMAND.necessityWrite, (argv) => writtenNecessity(argv), [{ base: PART_BASE.necessityJson, path: NECESSITY_JSON }], ([json]) => json!);
}

/** What `review.html` holds, as the Report stage (`qa` false) or the Answers stage wrote it. */
export function recordedHtml(evidence: readonly EvidenceRecord[], qa: boolean): Written<string> {
  return readParts(evidence, qa ? PART_BASE.qaHtml : PART_BASE.reviewHtml, REVIEW_HTML);
}

/** What a record holds (`area-record-A1`, `synthesis-record`, `answers-record-2`): its command's JSON, or its parts'. */
export function recordedRecord(evidence: readonly EvidenceRecord[], id: string, dir: string): Written<string> {
  return readArtifact(evidence, id, (argv) => writtenRecord(argv, id), [{ base: id, path: `${REVIEW_DIR}/${dir}/${id}.json` }], ([json]) => json!);
}
