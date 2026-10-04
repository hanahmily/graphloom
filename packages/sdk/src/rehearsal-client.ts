/**
 * Shared client for a GraphLoom rehearsal stand-in (docs/design-graph-rehearsal.md
 * §4.1/§4.2): resolves the scenario a `rehearse` run handed this executor
 * process, serves one reply per request in declaration order (repeating the
 * last), and is the seam guard — a stand-in refuses to impersonate a real
 * executor unless it was actually handed a scenario. Shared by every
 * stand-in package (coding-agent's three harnesses, the command executor's
 * quick-mode stub): the env var names and the cursor file's shape are a
 * cross-process invariant between whichever process wrote the scenario
 * (`rehearse`) and whichever reads it, so this lives once, not per package.
 *
 * Every agent or command job is a fresh child process (these executor
 * packages are `isolation: "unrestricted"`, spawned per dispatch), so "in
 * order" cannot be in-memory state: cursors are small files beside the
 * scenario, read-modify-written on each call. Dispatches within one
 * rehearsal are sequential (the graph waits for one job before deciding the
 * next), so this needs no locking.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RehearsalReply, RehearsalScenario } from "./rehearsal.js";

/** Names the scenario file this process rehearses with; absent means "not a rehearsal". */
export const REHEARSAL_SCENARIO_ENV = "GRAPHLOOM_REHEARSAL_SCENARIO";
/** Root directory for a stand-in's isolated HOME/config/agent dirs (§4.6). */
export const REHEARSAL_HOME_ENV = "GRAPHLOOM_REHEARSAL_HOME";
/** `--synthesized` (§4.4): set to `"1"` to make every agent stand-in ignore scripted replies and always synthesize from the contract's own schema. */
export const REHEARSAL_SYNTHESIZED_ENV = "GRAPHLOOM_REHEARSAL_SYNTHESIZED";
/** `--adversarial` (§4.4): set to `"1"` to make every agent stand-in corrupt its reply via `mutateAdversarially` before submitting it. */
export const REHEARSAL_ADVERSARIAL_ENV = "GRAPHLOOM_REHEARSAL_ADVERSARIAL";

/** Whether this process should ignore scripted replies and always synthesize (`--synthesized`, §4.4). */
export function synthesizedRepliesOnly(): boolean {
  return process.env[REHEARSAL_SYNTHESIZED_ENV] === "1";
}

/** Whether this process should corrupt its reply before submitting it (`--adversarial`, §4.4). */
export function adversarialMutationOnly(): boolean {
  return process.env[REHEARSAL_ADVERSARIAL_ENV] === "1";
}

let cached: RehearsalScenario | undefined;
let cachedFile: string | undefined;

/**
 * The scenario this process must answer from, or a refusal naming this
 * stand-in. Called at the first request a stand-in receives, not at module
 * load, so a harness or executor the rehearsal did not enable never needs one.
 */
export function requireScenario(standInName: string): RehearsalScenario {
  if (cached !== undefined) return cached;
  const file = process.env[REHEARSAL_SCENARIO_ENV];
  if (!file) {
    throw new Error(
      `the ${standInName} rehearsal stand-in refuses to impersonate the real thing: ${REHEARSAL_SCENARIO_ENV} does not name a scenario file`,
    );
  }
  const raw = readFileSync(file, "utf8");
  cached = JSON.parse(raw) as RehearsalScenario;
  cachedFile = file;
  return cached;
}

/** Only for tests: forces a fresh read of `REHEARSAL_SCENARIO_ENV` and clears every cursor. */
export function resetRehearsalScenarioCache(): void {
  cached = undefined;
  cachedFile = undefined;
}

function sidecarFile(scenarioFile: string, suffix: string): string {
  return path.join(path.dirname(scenarioFile), `${path.basename(scenarioFile)}.${suffix}`);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * The scenario's next reply for `contractName` (`""` when the job named
 * none), repeating the last once exhausted. `undefined` when the scenario
 * declares no reply at all for this contract — the caller synthesizes one.
 */
export function nextReply(scenario: RehearsalScenario, contractName: string | undefined): RehearsalReply | undefined {
  const key = contractName ?? "";
  const replies = scenario.results[key];
  if (replies === undefined || replies.length === 0) return undefined;
  if (cachedFile === undefined) return replies[0];
  const file = sidecarFile(cachedFile, "cursors.json");
  const cursors = readJson<Record<string, number>>(file, {});
  const index = Math.min(cursors[key] ?? 0, replies.length - 1);
  cursors[key] = Math.min(index + 1, replies.length - 1);
  writeFileSync(file, JSON.stringify(cursors), "utf8");
  return replies[index];
}

/** Isolated HOME-rooted directory for this stand-in's own state, so it never touches an operator's real login or config. */
export function rehearsalHomeDir(child: string): string | undefined {
  const root = process.env[REHEARSAL_HOME_ENV];
  if (!root) return undefined;
  return `${root}/${child}`;
}

export interface RecordedAssignment {
  assignment: string;
  /** The harness that actually carried this contract, so `probe` (§3.4) dispatches to the same one. */
  harness: string;
}

/**
 * Records the real rendered assignment a job carried for `contractName`, and
 * which harness carried it, so `graphloom probe` (§3.4) can hand a real
 * harness the exact text a rehearsal's dispatch produced (and the same
 * harness it was produced for), instead of guessing either. The latest
 * dispatch for a contract wins; harmless to skip when there is no active
 * scenario (a direct executor call outside a rehearsal).
 */
export function recordAssignment(contractName: string | undefined, assignment: string, harness: string): void {
  if (cachedFile === undefined || contractName === undefined) return;
  const file = sidecarFile(cachedFile, "assignments.json");
  const assignments = readJson<Record<string, RecordedAssignment>>(file, {});
  assignments[contractName] = { assignment, harness };
  writeFileSync(file, JSON.stringify(assignments), "utf8");
}

/** Reads back what `recordAssignment` logged for `contractName`, for the scenario file `rehearse` wrote. */
export function readRecordedAssignment(scenarioFile: string, contractName: string): RecordedAssignment | undefined {
  const assignments = readJson<Record<string, RecordedAssignment>>(sidecarFile(scenarioFile, "assignments.json"), {});
  return assignments[contractName];
}

/** One reply a stand-in gave, with the job identity it was given for it (§4.1, §4.7). */
export interface RecordedCall {
  contractName?: string;
  operationId?: string;
  stageId?: string;
  purpose?: string;
}

/**
 * Logs a reply a stand-in just gave, with the job identity it was given for
 * it, so B3 (§4.7) can later tell a reply that landed under a different job
 * than the one that asked from one that did not. Appends, never overwrites —
 * unlike `recordAssignment` (the latest dispatch per contract, for `probe`),
 * B3 needs the full call history of one rehearsal. Harmless to skip when
 * there is no active scenario (a direct executor call outside a rehearsal).
 */
export function recordCall(call: RecordedCall): void {
  if (cachedFile === undefined) return;
  const file = sidecarFile(cachedFile, "calls.json");
  const calls = readJson<RecordedCall[]>(file, []);
  calls.push(call);
  writeFileSync(file, JSON.stringify(calls), "utf8");
}

/** Reads back every call `recordCall` logged, for the scenario file `rehearse` wrote. */
export function readCallLog(scenarioFile: string): RecordedCall[] {
  return readJson<RecordedCall[]>(sidecarFile(scenarioFile, "calls.json"), []);
}

/**
 * The scenario's next recorded read for `executorId` (offline mode, §4.6),
 * repeating the last once exhausted, `undefined` when the scenario declares
 * no read at all for this executor id — the caller fails the job rather than
 * fabricate a payload, and the evaluator reports the gap under B2.
 */
export function nextRead(scenario: RehearsalScenario, executorId: string): unknown {
  const reads = scenario.reads?.[executorId];
  if (reads === undefined || reads.length === 0) return undefined;
  if (cachedFile === undefined) return reads[0];
  const file = sidecarFile(cachedFile, "read-cursors.json");
  const cursors = readJson<Record<string, number>>(file, {});
  const index = Math.min(cursors[executorId] ?? 0, reads.length - 1);
  cursors[executorId] = Math.min(index + 1, reads.length - 1);
  writeFileSync(file, JSON.stringify(cursors), "utf8");
  return reads[index];
}

/** Records that `executorId` was asked for offline (§4.6) but the scenario had no recorded read left to answer with. */
export function recordUnverifiedRead(executorId: string): void {
  if (cachedFile === undefined) return;
  const file = sidecarFile(cachedFile, "unverified-reads.json");
  const ids = new Set(readJson<string[]>(file, []));
  ids.add(executorId);
  writeFileSync(file, JSON.stringify([...ids]), "utf8");
}

/** Reads back every executor id `recordUnverifiedRead` logged, for the scenario file `rehearse` wrote. */
export function readUnverifiedReads(scenarioFile: string): string[] {
  return readJson<string[]>(sidecarFile(scenarioFile, "unverified-reads.json"), []);
}

/**
 * The stubbed outcome for `commandId`'s next invocation (quick mode, §3.2):
 * `undefined` when the scenario declares none, so the caller defaults to a
 * plain success — a scenario author who does not care about one command
 * only needs to name the ones they do. `failTimes` fails that many
 * invocations of this command id first (a non-zero exit, for the retry-timing
 * path), then gives the declared result from the invocation after.
 */
export function nextCommandOutcome(
  scenario: RehearsalScenario,
  commandId: string,
): { exitCode: number; stdout: string; stderr: string } | undefined {
  const declared = scenario.commands?.[commandId];
  if (declared === undefined) return undefined;
  const failTimes = declared.failTimes ?? 0;
  if (failTimes <= 0 || cachedFile === undefined) {
    return { exitCode: declared.exitCode, stdout: declared.stdout ?? "", stderr: declared.stderr ?? "" };
  }
  const file = sidecarFile(cachedFile, "command-counts.json");
  const counts = readJson<Record<string, number>>(file, {});
  const count = counts[commandId] ?? 0;
  counts[commandId] = count + 1;
  writeFileSync(file, JSON.stringify(counts), "utf8");
  if (count < failTimes) {
    return { exitCode: 1, stdout: "", stderr: `rehearsal stand-in: stubbed failure ${count + 1} of ${failTimes}` };
  }
  return { exitCode: declared.exitCode, stdout: declared.stdout ?? "", stderr: declared.stderr ?? "" };
}
