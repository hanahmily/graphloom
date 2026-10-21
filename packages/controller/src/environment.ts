import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { EnvironmentDeclaration, JobSpec } from "@graphloom/sdk";
import { builtinPinForKind } from "@graphloom/sdk";
import type { JobEvidenceItem, Runner } from "@graphloom/runner";
import { commandOutcome, describeFailure, identityMismatch } from "./checkout.js";
import { commandSpec } from "./prepare-cache.js";
import { resolveExecutorPin } from "./executor-catalog.js";
import type { DurableRunState } from "./state.js";
import { changedPaths, worktreeChangeFingerprints } from "./worktree.js";

const execFileAsync = promisify(execFile);

export type EnvironmentOutcome =
  | { kind: "ready"; operationId: string; evidence: JobEvidenceItem[] }
  /** A tool is missing or preparation failed: the run stops, naming it. */
  | { kind: "failed"; operationId: string; evidence: JobEvidenceItem[]; stopReason: string; blocker: string }
  /** A pinned file changed: the declaration may be stale and needs a qualified repair. */
  | { kind: "changed"; operationId: string; evidence: JobEvidenceItem[]; reason: string };

export function declaresEnvironment(env: EnvironmentDeclaration | undefined): env is EnvironmentDeclaration {
  return env !== undefined && ((env.checks?.length ?? 0) > 0 || (env.prepare?.length ?? 0) > 0 || (env.pinnedFiles?.length ?? 0) > 0);
}

/**
 * Check the run's environment against the graph's declaration: pinned files
 * first (at the pinned base commit), then the tool checks and preparation in
 * the worktree through the built-in command executor. The controller never
 * installs anything; a failure names what is missing.
 */
export async function checkEnvironment(args: {
  state: DurableRunState;
  env: EnvironmentDeclaration;
  runner: Runner;
  signal: AbortSignal;
}): Promise<EnvironmentOutcome> {
  const { state, env } = args;
  const operationId = `env-${state.stateRevision}-${randomUUID().slice(0, 8)}`;
  const evidence: JobEvidenceItem[] = [];

  const pinned = await pinnedFileDrift(state.worktreePath, state.intake.pinnedHead, env.pinnedFiles ?? []);
  if (pinned.length > 0) {
    evidence.push({ kind: "other", payload: { environment: { pinnedFiles: pinned } } });
    const changed = pinned.filter((p) => p.actual !== p.expected);
    if (changed.length > 0) {
      const names = changed.map((p) => (p.actual === "missing" ? `${p.path} (missing)` : p.path)).join(", ");
      return {
        kind: "changed",
        operationId,
        evidence,
        reason: `${names} changed since the graph's environment declaration was written; update the declaration through a qualified repair`,
      };
    }
  }

  const checks = env.checks ?? [];
  const prepare = env.prepare ?? [];
  if (checks.length + prepare.length === 0) return { kind: "ready", operationId, evidence };

  const resolved = resolveExecutorPin(state, builtinPinForKind("command"));
  if ("error" in resolved) {
    return { kind: "failed", operationId, evidence, stopReason: "environment check failed", blocker: resolved.error };
  }
  const job: JobSpec = {
    stageId: state.current.stageId,
    kind: "command",
    purpose: "diagnostic",
    instruction: "Check the environment the graph declares",
    readOnly: true,
    executor: resolved.pin,
    input: { commands: [...checks, ...prepare].map(commandSpec) },
  };
  const before = await worktreeChangeFingerprints(state.worktreePath);
  const expected = { runId: state.runId, operationId, generation: state.generation };
  const result = await args.runner.runJob(job, {
    ...expected,
    worktreePath: state.worktreePath,
    artifactDir: state.artifactDir,
    signal: args.signal,
    ...(resolved.source !== undefined ? { executorSource: resolved.source } : {}),
  });
  const mismatch = identityMismatch(result, expected);
  if (mismatch !== undefined) return { kind: "failed", operationId, evidence, stopReason: "stale job result identity", blocker: mismatch };
  evidence.push(...(result.evidence ?? []).map((item) => withEnvironment(item)));
  if (result.status !== "ok") {
    return { kind: "failed", operationId, evidence, stopReason: "environment check failed", blocker: `${result.status}: ${result.summary}` };
  }
  const checkIds = new Set(checks.map((c) => c.id));
  for (const item of result.evidence ?? []) {
    const command = commandOutcome(item);
    if (command === undefined) continue;
    if (command.exitCode === 0 && command.timedOut !== true && command.aborted !== true && command.spawnError === undefined) continue;
    return {
      kind: "failed",
      operationId,
      evidence,
      stopReason: checkIds.has(command.id) ? "environment check failed" : "environment preparation failed",
      blocker: describeFailure(command),
    };
  }
  const ran = new Set((result.evidence ?? []).map((item) => commandOutcome(item)?.id).filter((id) => id !== undefined));
  const skipped = [...checks, ...prepare].filter((c) => !ran.has(c.id)).map((c) => c.id);
  if (skipped.length > 0) {
    return { kind: "failed", operationId, evidence, stopReason: "environment check failed", blocker: `no result for ${skipped.join(", ")}` };
  }
  const changed = changedPaths(before, await worktreeChangeFingerprints(state.worktreePath));
  if (changed.length > 0) {
    return {
      kind: "failed",
      operationId,
      evidence,
      stopReason: "environment preparation failed",
      blocker: `preparation changed files Git tracks or does not ignore: ${changed.slice(0, 10).join(", ")}`,
    };
  }
  return { kind: "ready", operationId, evidence };
}

async function pinnedFileDrift(
  worktreePath: string,
  pinnedHead: string,
  files: NonNullable<EnvironmentDeclaration["pinnedFiles"]>,
): Promise<Array<{ path: string; expected: string; actual: string }>> {
  const out: Array<{ path: string; expected: string; actual: string }> = [];
  for (const file of files) {
    let actual: string;
    try {
      const { stdout } = await execFileAsync("git", ["show", `${pinnedHead}:${file.path}`], {
        cwd: worktreePath,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      actual = createHash("sha256").update(stdout).digest("hex");
    } catch {
      actual = "missing";
    }
    out.push({ path: file.path, expected: file.sha256, actual });
  }
  return out;
}

function withEnvironment(item: JobEvidenceItem): JobEvidenceItem {
  const payload = item.payload;
  const base = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : { value: payload ?? null };
  return { ...item, payload: { ...base, environment: { phase: "preflight" } } };
}
