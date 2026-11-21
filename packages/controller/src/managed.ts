// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash, randomUUID } from "node:crypto";
import { access, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { HubContinuation, HubObservation } from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import type { IntakePin } from "./intake.js";
import { isClaimStale, readOwnerClaim } from "./owner.js";
import type { DurableRunState } from "./state.js";
import { loadRunState, saveRunState } from "./state.js";
import { withDirectoryLock } from "./lock.js";
import { reconcileChildOperations } from "./children.js";
import { isUnsettled, reconcilePendingDispatch } from "./reconcile.js";

/** The hub binding is deliberately separate from mutable execution state. */
export interface ManagedRunBinding {
  protocolVersion: 1;
  hubId: string;
  hubStateDir: string;
  submissionId: string;
  runId: string;
  generation: number;
  launchId: string;
  intakeDigest?: string;
}

/** Only the trusted CLI bootstrap constructs a grant, after the hub grants fd 3. */
export interface ManagedRunGrant extends ManagedRunBinding {
  /** Recheck the hub's durable current grant and previous execution drainage. */
  verify(): Promise<void>;
  automatic?: boolean;
  continuationFingerprint?: string;
  interruptionCommandId?: string;
  commandId?: string;
}

const BINDING_FILE = "managed-run.json";

export async function readManagedBinding(stateDir: string): Promise<ManagedRunBinding | undefined> {
  let raw: string;
  try { raw = await readFile(path.join(stateDir, BINDING_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (raw.length > 16_384) throw new Error("managed binding exceeds size limit");
  const binding = JSON.parse(raw) as ManagedRunBinding;
  validateBinding(binding);
  return binding;
}

function validateBinding(binding: ManagedRunBinding): void {
  if (binding === null || binding.protocolVersion !== 1 || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
    [binding.hubId, binding.hubStateDir, binding.submissionId, binding.runId, binding.launchId].some((value) => typeof value !== "string" || value.length === 0 || value.length > 4096) ||
    !path.isAbsolute(binding.hubStateDir)) throw new Error("invalid managed run binding");
}

function sameBinding(a: ManagedRunBinding, b: ManagedRunBinding): boolean {
  return a.hubId === b.hubId && a.hubStateDir === b.hubStateDir && a.submissionId === b.submissionId && a.runId === b.runId;
}

/** Must be called under the run's intake/exec lock, before loading any plugin. */
export async function authorizeManagedRun(stateDir: string, grant?: ManagedRunGrant, intake?: IntakePin): Promise<void> {
  const binding = await readManagedBinding(stateDir);
  if (grant === undefined) {
    if (binding !== undefined) throw new Error(`run is managed by hub ${binding.hubId}; use graphloom hub resume/stop ${binding.submissionId}`);
    return;
  }
  validateBinding(grant);
  if (path.basename(stateDir) !== grant.runId) throw new Error("managed grant run ID does not match state directory");
  if (binding !== undefined && !sameBinding(binding, grant)) throw new Error("managed run belongs to a different hub submission");
  if (binding === undefined) {
    const stateExists = await access(path.join(stateDir, "state.json")).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (stateExists) throw new Error("cannot bind an existing standalone run");
  }
  if (binding !== undefined && (grant.generation < binding.generation || (grant.generation === binding.generation && grant.launchId !== binding.launchId))) {
    throw new Error("stale managed launch generation");
  }
  await grant.verify();
  const digest = intake === undefined ? undefined : createHash("sha256").update(JSON.stringify({
    task: intake.task, config: intake.config, repoPath: intake.repoPath, pinnedHead: intake.pinnedHead, bundle: intake.bundle,
  })).digest("hex");
  if (digest !== undefined && binding?.intakeDigest !== undefined && digest !== binding.intakeDigest) throw new Error("managed intake inputs changed");
  if (binding === undefined && intake === undefined) throw new Error("cannot bind an existing standalone run through resume");
  const owner = await readOwnerClaim(stateDir);
  if (owner !== undefined && !isClaimStale(owner)) throw new Error("managed run still has a live controller owner");
  const next: ManagedRunBinding = {
    protocolVersion: 1, hubId: grant.hubId, hubStateDir: grant.hubStateDir, submissionId: grant.submissionId,
    runId: grant.runId, generation: grant.generation, launchId: grant.launchId,
    ...((digest ?? binding?.intakeDigest) !== undefined ? { intakeDigest: digest ?? binding!.intakeDigest! } : {}),
  };
  await atomicManagedFile(stateDir, BINDING_FILE, next);
}

/** Stop is allowed only to the current launch; it must not advance its fence. */
export async function authorizeManagedStop(stateDir: string, grant?: ManagedRunGrant): Promise<void> {
  const binding = await readManagedBinding(stateDir);
  if (binding === undefined) {
    if (grant !== undefined) throw new Error("managed stop has no run binding");
    return;
  }
  if (grant === undefined || !sameBinding(binding, grant) || binding.generation !== grant.generation || binding.launchId !== grant.launchId) {
    throw new Error(`run is managed by hub ${binding.hubId}; stop through submission ${binding.submissionId}`);
  }
  await grant.verify();
}

/** Read-only preflight also fences terminal fast paths, without changing a generation. */
export async function authorizeManagedResume(stateDir: string, grant?: ManagedRunGrant): Promise<void> {
  const binding = await readManagedBinding(stateDir);
  if (binding === undefined && grant === undefined) return;
  if (binding === undefined || grant === undefined) throw new Error("managed run requires its hub launch grant");
  validateBinding(grant);
  if (!sameBinding(binding, grant) || grant.generation < binding.generation || (grant.generation === binding.generation && grant.launchId !== binding.launchId)) throw new Error("stale or conflicting managed launch grant");
  await grant.verify();
}

export async function atomicManagedFile(stateDir: string, name: string, value: unknown): Promise<void> {
  const temporary = path.join(stateDir, `.${name}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(stateDir, name));
    const directory = await open(stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** A runner must explicitly account for external execution; missing support is unknown. */
export async function assertManagedRunner(runner: Runner, stateDir?: string): Promise<void> {
  if (runner.managed === undefined) throw new Error("runner does not support verified managed execution cleanup");
  const problem = await runner.managed.check(stateDir);
  if (problem !== undefined) throw new Error(`managed execution refused: ${problem}`);
}

export async function releaseManagedRun(runner: Runner, runId: string, stateDir?: string): Promise<{ drained: boolean; resources: string[] }> {
  if (runner.managed === undefined) return { drained: false, resources: ["runner has no managed cleanup contract"] };
  try { return await runner.managed.drain(runId, stateDir); }
  catch (error) { return { drained: false, resources: [error instanceof Error ? error.message : String(error)] }; }
}

/** Closed controller classifications: operator retryability never implies automation. */
export function observeContinuation(state: DurableRunState): HubContinuation {
  if (state.status === "succeeded") return { kind: "complete" };
  if (state.status === "failed") return { kind: "terminal", cause: "failed" };
  const operator = (cause: "reconciliation" | "budget" | "operator-stop" | "pin-drift" | "approval" | "unknown"): HubContinuation =>
    ({ kind: "operator", cause, evidenceRefs: state.stopEvidenceRefs ?? [] });
  if (state.reconciliationRequired !== undefined || (state.childOperations ?? []).some((child) => ["pending", "ambiguous"].includes(child.status))) return operator("reconciliation");
  const pending = state.pendingDispatch;
  if (pending?.status === "pending" && pending.job.readOnly !== true) return operator("reconciliation");
  const continuation = state.managedContinuation;
  if (continuation !== undefined && state.status === "stopped" && state.stopReason === "managed scheduling yield") {
    if (!["provider-cooldown", "executor-retry", "transient-provider", "service-interruption", "controller-crash"].includes(continuation.cause) ||
      (continuation.notBefore !== undefined && !Number.isFinite(Date.parse(continuation.notBefore))) ||
      (continuation.cause === "service-interruption" && (typeof continuation.interruptionCommandId !== "string" || continuation.interruptionCommandId.length === 0))) return operator("unknown");
    return { kind: "automatic", cause: continuation.cause, fingerprint: continuationFingerprint(state, continuation.cause),
      stateRevision: state.stateRevision, ...(continuation.notBefore !== undefined ? { notBefore: continuation.notBefore } : {}),
      ...(continuation.interruptionCommandId !== undefined ? { interruptionCommandId: continuation.interruptionCommandId } : {}) };
  }
  if (state.status === "running") return { kind: "automatic", cause: "controller-crash", fingerprint: continuationFingerprint(state, "controller-crash"), stateRevision: state.stateRevision };
  if (/budget.*exhausted|budgets exhausted/.test(state.stopReason ?? "")) return operator("budget");
  if (state.stopReason === "operator stop") return operator("operator-stop");
  if (/pin mismatch|worktree mismatch|repair rehydration/.test(state.stopReason ?? "")) return operator("pin-drift");
  if (state.stopReason === "reconcile required") return operator("reconciliation");
  return operator("unknown");
}

function continuationFingerprint(state: DurableRunState, cause: string): string {
  const job = state.pendingDispatch?.job ?? state.executorRetry?.job;
  return createHash("sha256").update(JSON.stringify({
    cause, stage: state.current.stageId, executor: job?.executor, purpose: job?.purpose,
    instruction: job?.instruction, activeVersion: state.activeVersion, bundle: state.intake.bundle,
    config: state.intake.config?.sha256, pinnedHead: state.intake.pinnedHead,
  })).digest("hex");
}

export function managedObservation(state: DurableRunState): HubObservation {
  return { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: state.stateRevision,
    progressRevision: state.receipts.length, status: state.status, continuation: observeContinuation(state),
    ...(state.blocker !== undefined ? { blocker: state.blocker } : {}) };
}

/** Reconcile existing dispatch journals in a reservation, without loading graph code or executing a job. */
export async function reconcileManagedRun(stateDir: string, grant: ManagedRunGrant, runner: Runner): Promise<HubObservation> {
  return withDirectoryLock(stateDir, "run.exec.lock", async () => {
    await authorizeManagedRun(stateDir, grant);
    await assertManagedRunner(runner, stateDir);
    let state = await loadRunState(stateDir);
    const cleanup = await releaseManagedRun(runner, state.runId, stateDir);
    if (!cleanup.drained) throw new Error(`managed external cleanup pending: ${cleanup.resources.join(", ")}`);
    if (state.status === "succeeded" || state.status === "failed") return managedObservation(state);
    const children = reconcileChildOperations(state);
    state = children.state;
    let reason = children.settled ? undefined : children.reason;
    if (reason === undefined && state.pendingDispatch !== undefined && isUnsettled(state.pendingDispatch)) {
      const pending = await reconcilePendingDispatch(state);
      state = pending.state;
      if (!pending.settled) reason = pending.reason;
    }
    if (state.reconciliationRequired !== undefined) reason = state.reconciliationRequired.reason;
    const resumable = state.status === "running" || state.stopReason === "managed scheduling yield";
    if (reason !== undefined) state = { ...state, status: "stopped", stopReason: "reconcile required", blocker: reason, stateRevision: state.stateRevision + 1 };
    else if (resumable) state = { ...state, status: "stopped", stopReason: "managed scheduling yield", managedContinuation: state.managedContinuation ?? { cause: "controller-crash" }, stateRevision: state.stateRevision + 1 };
    await saveRunState(state);
    return managedObservation(state);
  });
}

export function assertAutomaticContinuation(state: DurableRunState, grant?: ManagedRunGrant): void {
  if (grant?.automatic !== true) return;
  const continuation = observeContinuation(state);
  if (continuation.kind !== "automatic") throw new Error(`automatic resume requires operator action (${continuation.kind})`);
  if (grant.continuationFingerprint !== undefined && continuation.fingerprint !== grant.continuationFingerprint) throw new Error("automatic continuation changed since admission");
  if (continuation.notBefore !== undefined && Date.now() < Date.parse(continuation.notBefore)) throw new Error("automatic resume before controller notBefore");
}

/** Reserve a remedy before applying it. An interrupted application requires reconciliation, never replay. */
export async function beginManagedCommand(stateDir: string, id: string): Promise<"new" | "applied"> {
  if (id.length === 0 || id.length > 256) throw new Error("invalid managed command ID");
  const name = `managed-command-${createHash("sha256").update(id).digest("hex")}.json`;
  const existing = await readFile(path.join(stateDir, name), "utf8").then((raw) => JSON.parse(raw) as { id: string; applied: boolean }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing !== undefined) {
    if (existing.id !== id || existing.applied !== true) throw new Error("managed remedy application is unsettled; operator reconciliation required");
    return "applied";
  }
  await atomicManagedFile(stateDir, name, { id, applied: false });
  return "new";
}

export async function managedCommandApplied(stateDir: string, id: string): Promise<boolean> {
  const name = `managed-command-${createHash("sha256").update(id).digest("hex")}.json`;
  const existing = await readFile(path.join(stateDir, name), "utf8").then((raw) => JSON.parse(raw) as { id: string; applied: boolean }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  return existing?.id === id && existing.applied === true;
}

export async function finishManagedCommand(stateDir: string, id: string): Promise<void> {
  const name = `managed-command-${createHash("sha256").update(id).digest("hex")}.json`;
  await atomicManagedFile(stateDir, name, { id, applied: true });
}
