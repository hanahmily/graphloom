// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND, REPORT_JSON, REVIEW_DIR, REVIEW_MD } from "./constants.js";

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

const WRITE =
  'set -eu; n="$1"; shift; json=""; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done; md=""; for part in "$@"; do md="$md$part"; done; ' +
  `mkdir -p ${REVIEW_DIR}; printf '*\\n' > ${REVIEW_DIR}/.gitignore; ` +
  `printf '%s' "$json" > ${REPORT_JSON}.tmp; mv ${REPORT_JSON}.tmp ${REPORT_JSON}; ` +
  `printf '%s' "$md" > ${REVIEW_MD}.tmp; mv ${REVIEW_MD}.tmp ${REVIEW_MD}; echo written`;

/**
 * The command that writes `report.json` and `review.md`, or undefined when the
 * JSON alone does not fit one command. The markdown is the readable copy; what
 * does not fit is cut short with a note, the JSON never is.
 */
export function reportWriteCommand(json: string, markdown: string): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const build = (md: string[]): EnvironmentCommand => ({ id: COMMAND.reportWrite, argv: ["sh", "-c", WRITE, COMMAND.reportWrite, String(parts.length), ...parts, ...md] });
  const fits = (c: EnvironmentCommand): boolean => c.argv.length - 5 <= MAX_CHUNKS && inputBytes(c) <= MAX_COMMAND_INPUT_BYTES;
  if (!fits(build([]))) return undefined;
  const md = writeChunks(markdown);
  if (fits(build(md))) return build(md);
  const cut = `\n… (cut short; see ${REPORT_JSON})\n`;
  let kept = 0;
  while (kept < md.length && fits(build([...md.slice(0, kept + 1), cut]))) kept += 1;
  return build(fits(build([...md.slice(0, kept), cut])) ? [...md.slice(0, kept), cut] : md.slice(0, kept));
}

/** The JSON and markdown a `report-write` argv wrote. */
export function writtenReport(argv: readonly string[]): { json: string; markdown: string } | undefined {
  const n = Number(argv[4]);
  if (argv[3] !== COMMAND.reportWrite || !Number.isSafeInteger(n) || n < 0) return undefined;
  return { json: argv.slice(5, 5 + n).join(""), markdown: argv.slice(5 + n).join("") };
}
