import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CheckoutSpec, EnvironmentCommand, JobSpec } from "@graphloom/sdk";
import { writeScopeAllows } from "@graphloom/sdk";
import type { ExecutorSourceOverride, JobEvidenceItem, JobResult, Runner } from "@graphloom/runner";
import { candidateChange } from "./worktree.js";

const execFileAsync = promisify(execFile);

/** What a checkout job ran against, attached to each of its evidence items. */
export interface CheckoutRecord {
  from: CheckoutSpec["from"];
  /** The pinned base commit the checkout started from. */
  base: string;
  /** The checkout's commit: the base plus the applied paths. */
  commit: string;
  /** Changed paths copied from the worktree. */
  paths: string[];
  /** Whether the graph's preparation commands succeeded without changing tracked files. */
  prepared: boolean;
  /** Files the preparation (phase `prepare`) or the job (phase `run`) changed in the checkout. */
  mutations: string[];
  phase: "prepare" | "run";
}

export function checkoutsDir(stateDir: string): string {
  return path.join(stateDir, "checkouts");
}

/** Remove checkouts a crashed controller left behind; they hold no durable state. */
export async function clearCheckouts(stateDir: string): Promise<void> {
  await removeTree(checkoutsDir(stateDir));
}

/**
 * Run a read-only command job in a disposable checkout of the pinned base
 * commit plus (part of) the current workspace change. The checkout is
 * committed with its own identity so Git-aware checks see a clean tree. The
 * graph's environment checks and preparation run on the untouched base before
 * a base checkout takes its paths, and on the committed change in a candidate
 * checkout. The job's commands then run one at a time; after each, every file
 * that differs from the checkout's commit is recorded, and stays on record for
 * the commands after it. The checkout is removed afterwards.
 */
export async function runInCheckout(args: {
  job: JobSpec & { checkout: CheckoutSpec };
  operationId: string;
  generation: number;
  runId: string;
  repoPath: string;
  worktreePath: string;
  pinnedHead: string;
  stateDir: string;
  artifactDir: string;
  checks: EnvironmentCommand[];
  prepare: EnvironmentCommand[];
  runner: Runner;
  signal: AbortSignal;
  source?: ExecutorSourceOverride;
}): Promise<{ result: JobResult; candidateDigest: string; staleIdentity?: string }> {
  const { job, operationId, generation, runId } = args;
  const change = await candidateChange(args.worktreePath, args.pinnedHead);
  const identity = { runId, operationId, generation };
  const failed = (summary: string, evidence?: JobEvidenceItem[]): { result: JobResult; candidateDigest: string } => ({
    result: { status: "failed", summary, ...identity, ...(evidence !== undefined ? { evidence } : {}) },
    candidateDigest: change.digest,
  });
  /** A nested result for another run, operation or generation: the run stops and keeps none of this job's evidence. */
  const stale = (mismatch: string) => ({ ...failed(`stale job result identity: ${mismatch}`), staleIdentity: mismatch });
  const dir = path.join(checkoutsDir(args.stateDir), operationId);
  const { checkout, ...plain } = job;
  const evidence: JobEvidenceItem[] = [];
  let applied: string[];
  let commit = args.pinnedHead;
  const apply = async () => {
    commit = await commitPaths(args.worktreePath, dir, applied);
  };
  try {
    applied = selectPaths(checkout, [...change.fingerprints.keys()]);
    await cloneAt(args.repoPath, args.pinnedHead, dir);
    if (checkout.from === "candidate") await apply();
  } catch (err) {
    await removeTree(dir);
    return failed(`checkout failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const context = (id: string) => ({
      runId,
      operationId: id,
      generation,
      worktreePath: dir,
      artifactDir: args.artifactDir,
      signal: args.signal,
      ...(args.source !== undefined ? { executorSource: args.source } : {}),
    });
    const record = (phase: CheckoutRecord["phase"], prepared: boolean, mutations: string[]): CheckoutRecord => ({
      from: checkout.from,
      base: args.pinnedHead,
      commit,
      paths: applied,
      prepared,
      mutations,
      phase,
    });
    const setup = [...args.checks, ...args.prepare];
    if (setup.length > 0) {
      const prepContext = context(`${operationId}-prepare`);
      const prep = await args.runner.runJob({ ...plain, input: { commands: setup.map((c) => ({ ...c })) } }, prepContext);
      const prepMismatch = identityMismatch(prep, prepContext);
      if (prepMismatch !== undefined) return stale(prepMismatch);
      const mutations = await checkoutMutations(dir, commit);
      const reported = new Set((prep.evidence ?? []).map((item) => commandOutcome(item)?.id).filter((id) => id !== undefined));
      const unreported = setup.filter((c) => !reported.has(c.id)).map((c) => c.id);
      const failures = [
        ...(prep.status === "ok" ? [] : [`${prep.status}: ${prep.summary}`]),
        ...failedCommands(prep.evidence ?? []),
        ...(unreported.length > 0 ? [`no result for ${unreported.join(", ")}`] : []),
        ...(mutations.length > 0 ? [`changed tracked files: ${mutations.slice(0, 10).join(", ")}`] : []),
      ];
      const prepared = failures.length === 0;
      for (const item of prep.evidence ?? []) {
        evidence.push(withCheckout(item, record("prepare", prepared, mutations)));
      }
      if (!prepared) return failed(`preparation failed in the checkout: ${failures.join("; ")}`, evidence);
    }
    if (checkout.from === "base") {
      try {
        await apply();
      } catch (err) {
        return failed(`checkout failed: ${err instanceof Error ? err.message : String(err)}`, evidence);
      }
    }

    const input = plain.input as { commands?: unknown; continueOnFailure?: unknown } | undefined;
    const commands = Array.isArray(input?.commands) ? (input.commands as Array<{ id?: unknown }>) : [undefined];
    const seen = new Set<string>();
    const summaries: string[] = [];
    let status: JobResult["status"] = "ok";
    let ran = 0;
    for (const [i, command] of commands.entries()) {
      if (args.signal.aborted) break;
      const step = command === undefined ? plain : { ...plain, input: { ...input, commands: [command] } };
      const suffix = typeof command?.id === "string" ? command.id : String(i);
      const stepContext = context(commands.length === 1 ? operationId : `${operationId}-${suffix}`);
      const result = await args.runner.runJob(step, stepContext);
      const mismatch = identityMismatch(result, stepContext);
      if (mismatch !== undefined) return stale(mismatch);
      ran += 1;
      for (const rel of await checkoutMutations(dir, commit)) seen.add(rel);
      for (const item of result.evidence ?? []) {
        evidence.push(withCheckout(item, record("run", true, [...seen].sort())));
      }
      const stepFailures = failedCommands(result.evidence ?? []);
      if (result.status !== "ok") {
        status = result.status;
        summaries.push(result.summary);
        break;
      }
      summaries.push(...stepFailures);
      if (stepFailures.length > 0 && input?.continueOnFailure !== true) break;
    }
    const skipped = commands.length - ran;
    const summary =
      status === "ok" && summaries.length === 0 && skipped === 0
        ? `${ran} command(s) succeeded`
        : [...summaries, ...(skipped > 0 ? [`${skipped} not run`] : [])].join("; ");
    return { result: { status, summary, ...identity, evidence }, candidateDigest: change.digest };
  } finally {
    await removeTree(dir);
  }
}

/** Why a runner's result does not belong to the invocation that asked for it, or undefined when it does. */
export function identityMismatch(
  result: Pick<JobResult, "runId" | "operationId" | "generation">,
  expected: { runId: string; operationId: string; generation: number },
): string | undefined {
  if (result.runId === expected.runId && result.operationId === expected.operationId && result.generation === expected.generation) return undefined;
  return `${result.runId}/${result.operationId}/g${result.generation}, expected ${expected.runId}/${expected.operationId}/g${expected.generation}`;
}

/** The changed paths a checkout applies: all of them, or those under the listed paths. */
export function selectPaths(spec: CheckoutSpec, changed: string[]): string[] {
  if (spec.from === "candidate") return changed;
  const unmatched = spec.paths.filter((p) => !changed.some((rel) => writeScopeAllows(rel, [p])));
  if (unmatched.length > 0) {
    throw new Error(`base checkout paths are not part of the workspace change: ${unmatched.join(", ")}`);
  }
  return changed.filter((rel) => writeScopeAllows(rel, spec.paths));
}

/** Clone the repository into `dir`, detached at `pinnedHead`. */
async function cloneAt(repoPath: string, pinnedHead: string, dir: string): Promise<void> {
  await removeTree(dir);
  await mkdir(path.dirname(dir), { recursive: true });
  await git(path.dirname(dir), ["clone", "--quiet", "--no-checkout", "--shared", repoPath, dir]);
  await git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", pinnedHead]);
}

/**
 * Copy `paths` from the worktree into the checkout (a path missing there is
 * deleted) and commit the result with an isolated identity. Returns the commit.
 */
async function commitPaths(worktreePath: string, dir: string, paths: string[]): Promise<string> {
  for (const rel of paths) {
    await applyPath(worktreePath, dir, rel);
  }
  await git(dir, ["add", "--all"]);
  await git(dir, [
    "-c",
    "user.name=GraphLoom",
    "-c",
    "user.email=graphloom@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "-m",
    "GraphLoom candidate",
  ]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Paths that differ from `commit`, including new files Git does not ignore.
 * Compared with the recorded commit, not HEAD, so a check that commits its
 * change still shows it.
 */
export async function checkoutMutations(dir: string, commit: string): Promise<string[]> {
  const [changed, untracked] = await Promise.all([
    git(dir, ["diff", "--name-only", "--no-renames", "-z", commit, "--"]),
    git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(`${changed}\0${untracked}`.split("\0").filter((rel) => rel !== ""))].sort();
}

async function applyPath(from: string, to: string, rel: string): Promise<void> {
  if (path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`unsafe path ${rel}`);
  await assertNoSymlinkParent(to, rel);
  const src = path.join(from, rel);
  const dst = path.join(to, rel);
  const stat = await lstat(src).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  await rm(dst, { recursive: true, force: true });
  if (stat === undefined) return;
  await mkdir(path.dirname(dst), { recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(src), dst);
  } else if (stat.isFile()) {
    await copyFile(src, dst);
    await chmod(dst, stat.mode & 0o777);
  } else {
    throw new Error(`cannot copy ${rel}: not a file or symlink`);
  }
}

/** A path under a symlinked directory would be written outside the checkout. */
async function assertNoSymlinkParent(root: string, rel: string): Promise<void> {
  const parts = rel.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw new Error(`cannot copy ${rel}: ${path.relative(root, current)} is a symlink`);
  }
}

function withCheckout(item: JobEvidenceItem, checkout: CheckoutRecord): JobEvidenceItem {
  const payload = item.payload;
  const base = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : { value: payload ?? null };
  return { ...item, payload: { ...base, checkout } };
}

/** Commands in command-executor evidence that did not exit 0. */
export function failedCommands(evidence: JobEvidenceItem[]): string[] {
  const failures: string[] = [];
  for (const item of evidence) {
    const command = commandOutcome(item);
    if (command === undefined) continue;
    if (command.exitCode !== 0 || command.timedOut === true || command.aborted === true || command.spawnError !== undefined) {
      failures.push(describeFailure(command));
    }
  }
  return failures;
}

export interface CommandOutcomeView {
  id: string;
  argv?: string[];
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  spawnError?: string;
  stderrTail?: string;
}

export function commandOutcome(item: JobEvidenceItem): CommandOutcomeView | undefined {
  if (item.kind !== "command") return undefined;
  const payload = item.payload as { command?: CommandOutcomeView } | undefined;
  const command = payload?.command;
  if (command === undefined || typeof command !== "object" || typeof command.id !== "string") return undefined;
  return command;
}

export function describeFailure(command: CommandOutcomeView): string {
  if (command.spawnError !== undefined) return `${command.id}: ${command.spawnError}`;
  if (command.timedOut === true) return `${command.id}: timed out`;
  if (command.aborted === true) return `${command.id}: aborted`;
  const tail = (command.stderrTail ?? "").trim().split("\n").slice(-3).join(" | ");
  const how = command.exitCode === null ? `killed by ${command.signal ?? "a signal"}` : `exited ${command.exitCode}`;
  return tail.length > 0 ? `${command.id}: ${how}: ${tail.slice(0, 300)}` : `${command.id}: ${how}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Remove a tree, making read-only directories writable first (Go's module cache marks them so). */
async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await makeWritable(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(dir, entry.name));
  }
}
