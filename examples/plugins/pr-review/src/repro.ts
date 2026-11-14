// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Reproducing tests (design §8.2): the contract of a behavioral comment's `repro`, the command that runs its test in the
 * Docker sandbox, the `graphloom-repro-v1` report that command writes, and what the report means for a finding. The
 * reviewer is read-only and never runs the test: its text travels in the result, the graph runs it, and everything
 * here is a pure function of the recorded text and the recorded report, so `proofOf` and the `findings-proven`
 * validator recompute the same answer and never trust the reviewer's claim.
 *
 * A run is one command with two runs of the test inside (Go: `go test -overlay ... -count=2 -json`; TypeScript: vitest on a
 * scratch file under `/tmp/repro`, twice). The test file is never written into the checkout.
 */
import { createHash } from "node:crypto";
import type { EnvironmentCommand } from "@graphloom/sdk";
import { MAX_EXECUTOR_INPUT_BYTES } from "@graphloom/sdk";
import { reportText, type CommandRun } from "./evidence.js";
import { secretFindings } from "./secrets.js";
import { toolchainMismatch, toolchainSentence } from "./toolchain.js";
import { writeChunks } from "./write.js";

export const REPRO_REPORT = "graphloom-repro-v1";
/** The command id of a finding's run: findings have one id across the review, so one run per finding (the correction run is a later part). */
export const reproCommandId = (finding: string): string => `repro-${finding}`;
export const REPRO_ID_PREFIX = "repro-";
/** The longest failure message a record keeps (design §8.2). */
export const MAX_MESSAGE_CHARS = 2_048;
const MAX_ORACLE_CHARS = 600;
const MAX_NAME_CHARS = 120;
/** Argv elements the command may carry (64) less `sh`, the script and the count. */
const MAX_SPEC_CHUNKS = 58;

export const EXPECTS = ["assertion", "panic"] as const;
export type ReproExpect = (typeof EXPECTS)[number];
export type ReproLanguage = "go" | "typescript";

/** A behavioral comment's test, as the reviewer wrote it (empty `text` means it wrote none). */
export interface Repro {
  dir: string;
  name: string;
  text: string;
  expect: ReproExpect;
  oracle: string;
}

export const NO_REPRO: Repro = { dir: "", name: "", text: "", expect: "assertion", oracle: "" };

/** The JSON-schema fragment of `comments[].repro`. */
export const REPRO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dir", "name", "text", "expect", "oracle"],
  properties: {
    dir: { type: "string" },
    name: { type: "string" },
    text: { type: "string" },
    expect: { type: "string", enum: [...EXPECTS] },
    oracle: { type: "string" },
  },
};

/** The language a test for the cited file is written in, or undefined when the graph has no mechanism for it. */
export function reproLanguage(path: string): ReproLanguage | undefined {
  if (/\.go$/.test(path)) return "go";
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return "typescript";
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const hasTest = (r: Repro | undefined): r is Repro => r !== undefined && r.text.trim() !== "";

/** A safe repository-relative directory: no absolute path, no `..`, nothing a shell or a path join could misread. */
export const safeDir = (dir: string): boolean => dir === "." || (/^[A-Za-z0-9._@+/-]+$/.test(dir) && !dir.startsWith("/") && !dir.endsWith("/") && dir.split("/").every((s) => s !== "" && s !== ".." && s !== "."));

/**
 * The problems of one comment's `repro` against the contract, empty when it is usable. A comment with no test (empty text) is
 * allowed: the finding is then `unproven (no test)`. A test belongs to a behavioral comment only.
 */
export function reproProblems(raw: unknown, c: { path: string; kind: string }, at: string, maxBytes: number): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return [`${at}.repro must be an object with dir, name, text, expect and oracle`];
  const r = raw as Record<string, unknown>;
  if (![r.dir, r.name, r.text, r.oracle].every((x) => typeof x === "string") || !EXPECTS.includes(r.expect as ReproExpect)) return [`${at}.repro needs dir, name, text and oracle (text) and expect (assertion or panic)`];
  const repro = r as unknown as Repro;
  if (repro.text.trim() === "") return repro.dir === "" && repro.name === "" ? [] : [`${at}.repro has a dir or a name but no test text: leave all of them empty when you write no test`];
  const out: string[] = [];
  if (c.kind !== "behavioral") out.push(`${at}.repro: only a behavioral comment carries a test; a non-behavioral one claims no wrong behavior`);
  const language = reproLanguage(c.path);
  if (language === undefined) out.push(`${at}.repro: there is no way to run a test for ${JSON.stringify(c.path.slice(0, 80))}; the graph runs Go and TypeScript tests`);
  const bytes = Buffer.byteLength(repro.text, "utf8");
  if (bytes > maxBytes) out.push(`${at}.repro.text is ${bytes} bytes, more than the ${maxBytes} a test may be: write a smaller test of the one behavior`);
  if (!safeDir(repro.dir)) out.push(`${at}.repro.dir must be the repository-relative directory (the Go package, or the directory of the TypeScript module) the test belongs in, with no .. or absolute path`);
  if (repro.oracle.trim() === "" || repro.oracle.length > MAX_ORACLE_CHARS) out.push(`${at}.repro.oracle must say, in at most ${MAX_ORACLE_CHARS} characters, where the expected value comes from (the PR text, the report, a linked issue, documentation or the code's documented contract), never what the head returns`);
  if (language === "go") {
    if (!/^Test(?:[A-Z0-9_][A-Za-z0-9_]*)?$/.test(repro.name)) out.push(`${at}.repro.name must be one Go test function name (Test followed by an upper-case letter, digit or underscore)`);
    else if (!new RegExp(`^func ${repro.name}\\(\\w+ \\*testing\\.T\\)`, "m").test(repro.text)) out.push(`${at}.repro.text must declare func ${repro.name}(t *testing.T)`);
    if (!/^package [A-Za-z_][A-Za-z0-9_]*\s*$/m.test(repro.text)) out.push(`${at}.repro.text must be a whole Go _test.go file starting with its package clause`);
  } else if (language === "typescript") {
    if (repro.name.trim() === "" || repro.name.length > MAX_NAME_CHARS || /[\n\r\u0000]/.test(repro.name)) out.push(`${at}.repro.name must be the name of the one test, one line of at most ${MAX_NAME_CHARS} characters`);
    else if (!repro.text.includes(repro.name)) out.push(`${at}.repro.text must declare the test named ${JSON.stringify(repro.name)}`);
  }
  return out;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------- the command

export interface ReproRunSpec {
  finding: string;
  language: ReproLanguage;
  repro: Repro;
  /** The TypeScript workspace (the directory of the package.json that declares vitest), repository-relative; `.` for Go. */
  workspace: string;
  timeoutSeconds: number;
}

/** The spec the script reads: one `key value` line each, the test as base64 so the bytes run are the bytes recorded. */
export function reproSpec(s: ReproRunSpec): string {
  return [
    `lang ${s.language === "go" ? "go" : "ts"}`,
    `finding ${s.finding}`,
    `dir ${s.repro.dir}`,
    `name ${Buffer.from(s.repro.name, "utf8").toString("base64")}`,
    `expect ${s.repro.expect}`,
    `timeout ${s.timeoutSeconds}`,
    `ws ${s.workspace}`,
    `file ${Buffer.from(s.repro.text, "utf8").toString("base64")}`,
  ].join("\n");
}

/** The spec a repro command's argv carries: `sh <script> <n> <chunks…>`. */
export function reproSpecOf(argv: readonly string[]): string | undefined {
  const n = Number(argv[2]);
  if (!Number.isSafeInteger(n) || n < 0 || argv.length < 3 + n) return undefined;
  return argv.slice(3, 3 + n).join("");
}

/** The command that runs one finding's test: the plugin's fixed `tools/repro/repro.sh` with the spec in chunks, or undefined when it does not fit one command. */
export function reproCommand(s: ReproRunSpec, pluginRoot: string, wallClockMs: number): EnvironmentCommand | undefined {
  const parts = writeChunks(reproSpec(s));
  if (parts.length > MAX_SPEC_CHUNKS) return undefined;
  const command: EnvironmentCommand = { id: reproCommandId(s.finding), argv: ["sh", `${pluginRoot}/tools/repro/repro.sh`, String(parts.length), ...parts], timeoutMs: Math.min(24 * 60 * 60_000, wallClockMs + 60_000) };
  return Buffer.byteLength(JSON.stringify({ commands: [command] }), "utf8") <= MAX_EXECUTOR_INPUT_BYTES - 4_096 ? command : undefined;
}

// ---------------------------------------------------------------- the report

export const RUN_OUTCOMES = ["failed", "passed", "build-failed", "timeout", "killed"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface ReproRunReport {
  outcome: RunOutcome;
  /** Where the failing assertion was reported: `<file>:<line>` in the test's own file. */
  at?: string;
  /** The panic's stack frames in files other than the test's, as `<path>:<line>` (repository-relative). */
  frames: string[];
  message?: string;
}

export interface ReproReport {
  language: ReproLanguage;
  finding: string;
  sha256: string;
  /** The virtual test file's base name. */
  file: string;
  /** Why the run could not start (dependencies that could not be installed offline), when it could not. */
  setupFail?: string;
  runs: ReproRunReport[];
}

const redact = (m: string): string => (secretFindings(m).length > 0 ? "(the failure message looked like a credential and was withheld)" : m);

/** The report a script wrote, or why it is unreadable. The text is `key value` lines after a `graphloom-repro-v1 <language>` line. */
export function parseReproReport(text: string): ReproReport | { error: string } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const head = /^graphloom-repro-v1 (go|typescript)$/.exec(lines[0] ?? "");
  if (head === null) return { error: "the command wrote no graphloom-repro-v1 report" };
  const report: ReproReport = { language: head[1] as ReproLanguage, finding: "", sha256: "", file: "", runs: [] };
  const run = (n: number): ReproRunReport => (report.runs[n - 1] ??= { outcome: "killed", frames: [] });
  for (const line of lines.slice(1)) {
    const m = /^(\w[\w-]*) ?(.*)$/.exec(line);
    if (m === null) continue;
    const [, key, rest] = m as unknown as [string, string, string];
    if (key === "finding") report.finding = rest.trim();
    else if (key === "sha256") report.sha256 = rest.trim();
    else if (key === "file") report.file = rest.trim();
    else if (key === "setup-fail") report.setupFail = redact(rest.trim()).slice(0, MAX_MESSAGE_CHARS);
    else if (key === "run" || key === "at" || key === "frame" || key === "message") {
      const k = /^([12]) ?(.*)$/.exec(rest);
      if (k === null) continue;
      const n = Number(k[1]);
      const value = k[2]!;
      if (key === "run") run(n).outcome = RUN_OUTCOMES.includes(value as RunOutcome) ? (value as RunOutcome) : "killed";
      else if (key === "at") run(n).at = value.trim();
      else if (key === "frame") run(n).frames.push(value.trim());
      else run(n).message = redact(value.replace(/⏎/g, "\n")).slice(0, MAX_MESSAGE_CHARS);
    }
  }
  return report;
}

// ---------------------------------------------------------------- what a run means

/** What the graph recorded of a finding's test and its run, as a finding carries it. */
export interface ReproRecord {
  language: ReproLanguage;
  dir: string;
  name: string;
  expect: ReproExpect;
  /** The SHA-256 of the test text the reviewer wrote, which the run and the verifier must both have had. */
  sha256: string;
  /** The outcome of each of the two runs (empty when none ran). */
  runs: RunOutcome[];
  /** Where the first failing run failed, and its message (at most 2 KiB, secret-scanned). */
  at?: string;
  failure?: string;
  /** The image the run used, as the plan named it. */
  image?: string;
}

export type FindingProof = { state: "proven"; record: ReproRecord } | { state: "unproven"; reason: string; record?: ReproRecord };

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * What the recorded run says of a finding's test, before the verifier's judgment (design §8.2 conditions 1 to 3): `failed` in
 * both runs and attributable to the cited behavior is a candidate proof; anything else is `unproven` with its reason.
 * `path` is the file the comment cites (a `panic` failure must have a frame in it).
 */
export function judgeRun(finding: { id: string; path: string }, repro: Repro, language: ReproLanguage, run: CommandRun | undefined, plannedSpec: string, image: string | undefined): FindingProof {
  const record: ReproRecord = { language, dir: repro.dir, name: repro.name, expect: repro.expect, sha256: sha256(repro.text), runs: [], ...(image !== undefined ? { image } : {}) };
  const unproven = (reason: string): FindingProof => ({ state: "unproven", reason, record });
  if (run === undefined) return unproven("inconclusive (the test was not run)");
  if (reproSpecOf(run.command.argv) !== plannedSpec) return unproven("inconclusive (the run was not of the recorded test)");
  if (run.command.timedOut === true) return unproven("inconclusive (timeout)");
  if (run.command.aborted === true || run.command.spawnError !== undefined) return unproven("inconclusive (killed)");
  const text = reportText(run);
  const parsed = text.truncated ? { error: "the report did not fit one command report" } : parseReproReport(text.text);
  if ("error" in parsed) return unproven(run.command.exitCode !== 0 && run.command.exitCode !== null ? "inconclusive (killed)" : "inconclusive (no report)");
  if (parsed.language !== language || parsed.finding !== finding.id || parsed.sha256 !== record.sha256) return unproven("inconclusive (the report is not of the recorded test)");
  if (parsed.setupFail !== undefined) return unproven(`sandbox unavailable (${parsed.setupFail})`);
  record.runs = parsed.runs.map((r) => r.outcome);
  if (parsed.runs.length !== 2) return unproven("inconclusive (the test did not run twice)");
  const [a, b] = parsed.runs as [ReproRunReport, ReproRunReport];
  const kinds = new Set(record.runs);
  if (kinds.has("build-failed")) {
    // A build that never started because the image's Go is older than go.mod asks for says so, not "build failed" (design §8.2).
    const old = parsed.runs.map((r) => toolchainMismatch(r.message ?? "")).find((t) => t !== undefined);
    return unproven(old !== undefined ? `the sandbox toolchain is older than the repository requires (${toolchainSentence(old)})` : "inconclusive (build failed)");
  }
  if (kinds.has("timeout")) return unproven("inconclusive (timeout)");
  if (kinds.has("killed")) return unproven("inconclusive (killed)");
  if (a.outcome === "passed" && b.outcome === "passed") return unproven("test does not fail");
  if (a.outcome !== b.outcome) return unproven("flaky");
  // Both runs failed. Attribute each failure to the cited behavior.
  const virtual = parsed.file;
  for (const [i, r] of [a, b].entries()) {
    if (repro.expect === "assertion") {
      const file = r.at?.slice(0, r.at.lastIndexOf(":"));
      if (r.at === undefined || file === undefined || basename(file) !== virtual) return unproven(`inconclusive (the failure of run ${i + 1} is not an assertion of the test)`);
    } else if (!r.frames.some((f) => f.slice(0, f.lastIndexOf(":")) === finding.path)) {
      return unproven(`inconclusive (the panic of run ${i + 1} has no frame in ${finding.path})`);
    }
  }
  if (a.at !== undefined) record.at = a.at;
  if (a.message !== undefined) record.failure = a.message;
  return { state: "proven", record };
}
