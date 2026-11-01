// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND, NECESSITY_JSON, QA_JSON, REPORT_JSON, REVIEW_DIR, REVIEW_MD } from "./constants.js";

/**
 * Writing a file as a graph command, chunked as issue-fix's issues writer is:
 * the text travels in the argv, in pieces that fit one element each, so the
 * bytes written are evidence and the argv is the record of them. No model
 * and no repository code is involved.
 */

/** UTF-16 units per argv element; the command executor allows 4,096 characters. */
const CHUNK = 4_000;
/** Argv elements the executor allows (64) less the shell, `-c`, the script, the id and the count. */
const MAX_CHUNKS = 59;
const MAX_COMMAND_INPUT_BYTES = MAX_EXECUTOR_INPUT_BYTES - 4_096;

/** Chunks that never split a surrogate pair, so each argv element stays valid text. */
export function writeChunks(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

const inputBytes = (command: EnvironmentCommand): number => Buffer.byteLength(JSON.stringify({ commands: [command] }), "utf8");

const script = (jsonFile: string): string =>
  'set -eu; n="$1"; shift; json=""; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done; md=""; for part in "$@"; do md="$md$part"; done; ' +
  `mkdir -p ${REVIEW_DIR}; printf '*\\n' > ${REVIEW_DIR}/.gitignore; ` +
  `printf '%s' "$json" > ${jsonFile}.tmp; mv ${jsonFile}.tmp ${jsonFile}; ` +
  `printf '%s' "$md" > ${REVIEW_MD}.tmp; mv ${REVIEW_MD}.tmp ${REVIEW_MD}; echo written`;

/**
 * The command that writes a JSON file and `review.md` together, or undefined when the two do not fit one command
 * (the caller then writes each as a bounded multi-part artifact, `partCommands`).
 */
function fileWriteCommand(id: string, jsonFile: string, json: string, markdown: string): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const md = writeChunks(markdown);
  const sh = script(jsonFile);
  const command: EnvironmentCommand = { id, argv: ["sh", "-c", sh, id, String(parts.length), ...parts, ...md] };
  return command.argv.length - 5 <= MAX_CHUNKS && inputBytes(command) <= MAX_COMMAND_INPUT_BYTES ? command : undefined;
}

/** The command that writes `report.json` and `review.md`. */
export const reportWriteCommand = (json: string, markdown: string): EnvironmentCommand | undefined => fileWriteCommand(COMMAND.reportWrite, REPORT_JSON, json, markdown);

/** The command that writes `qa.json` and the whole `review.md` (Report, Measurements, Q&A). */
export const qaWriteCommand = (json: string, markdown: string): EnvironmentCommand | undefined => fileWriteCommand(COMMAND.qaWrite, QA_JSON, json, markdown);

/** The JSON and markdown a `report-write` or `qa-write` argv wrote. */
export function writtenFiles(argv: readonly string[], id: string): { json: string; markdown: string } | undefined {
  const n = Number(argv[4]);
  if (argv[3] !== id || !Number.isSafeInteger(n) || n < 0) return undefined;
  return { json: argv.slice(5, 5 + n).join(""), markdown: argv.slice(5 + n).join("") };
}

export const writtenReport = (argv: readonly string[]): { json: string; markdown: string } | undefined => writtenFiles(argv, COMMAND.reportWrite);
export const writtenQa = (argv: readonly string[]): { json: string; markdown: string } | undefined => writtenFiles(argv, COMMAND.qaWrite);

const jsonScript = (jsonFile: string): string =>
  'set -eu; n="$1"; shift; json=""; for part in "$@"; do json="$json$part"; done; ' +
  `mkdir -p ${REVIEW_DIR}; printf '*\\n' > ${REVIEW_DIR}/.gitignore; ` +
  `printf '%s' "$json" > ${jsonFile}.tmp; mv ${jsonFile}.tmp ${jsonFile}; echo written`;

/**
 * The command that writes `necessity.json` (design §7.5), the recorded outcome of N1: its checked answer and the
 * decision it led to. The bytes are evidence, so the Answers stage and its validators read the decision from here
 * even after a later review has superseded the check that made it. Undefined when it does not fit one command.
 */
export function necessityWriteCommand(json: string): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const command: EnvironmentCommand = { id: COMMAND.necessityWrite, argv: ["sh", "-c", jsonScript(NECESSITY_JSON), COMMAND.necessityWrite, String(parts.length), ...parts] };
  return command.argv.length - 5 <= MAX_CHUNKS && inputBytes(command) <= MAX_COMMAND_INPUT_BYTES ? command : undefined;
}

const recordScript =
  'set -eu; file="$1"; n="$2"; shift 2; json=""; for part in "$@"; do json="$json$part"; done; ' +
  `mkdir -p "$(dirname "$file")"; printf '*\\n' > ${REVIEW_DIR}/.gitignore; ` +
  `printf '%s' "$json" > "$file.tmp"; mv "$file.tmp" "$file"; echo written`;

/**
 * The command that records one step of a large run as evidence (design §6.9, §7.6): an area's checked report, the
 * synthesis, or an answered batch. The bytes are evidence, so the validators read the step from here even after a
 * later review has superseded the check that judged it (a validator sees only the newest review). The file lands
 * under `.graphloom/review/<dir>/`. Undefined when it does not fit one command.
 */
export function recordCommand(id: string, dir: string, json: string): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const command: EnvironmentCommand = { id, argv: ["sh", "-c", recordScript, id, `${REVIEW_DIR}/${dir}/${id}.json`, String(parts.length), ...parts] };
  return command.argv.length <= 64 && inputBytes(command) <= MAX_COMMAND_INPUT_BYTES ? command : undefined;
}

/** The JSON a record command's argv wrote. */
export function writtenRecord(argv: readonly string[], id: string): string | undefined {
  const n = Number(argv[5]);
  if (argv[3] !== id || !Number.isSafeInteger(n) || n < 0) return undefined;
  return argv.slice(6, 6 + n).join("");
}

/** The JSON a `necessity-write` argv wrote. */
export function writtenNecessity(argv: readonly string[]): string | undefined {
  const n = Number(argv[4]);
  if (argv[3] !== COMMAND.necessityWrite || !Number.isSafeInteger(n) || n < 0) return undefined;
  return argv.slice(5, 5 + n).join("");
}
