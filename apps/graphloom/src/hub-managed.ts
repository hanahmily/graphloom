// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import path from "node:path";
import { assertHubGrant } from "@graphloom/hub";
import { createController, managedCommandApplied, readManagedBinding, resolveStateDir, type ManagedRunGrant } from "@graphloom/controller";
import type { HubLaunch, HubLaunchReport, HubResumeRemedy, HubSubmission } from "@graphloom/sdk";
import { refusalOf, writeLaunchReport } from "./hub-launch-report.js";
import { boundedText, materializeHubTask } from "./hub-input.js";
import { verifyHubExecutionInput } from "./hub-runtime.js";
import { hubRequest } from "./hub-client.js";
import { approvalFlags } from "./approval-flags.js";
import { dropStandInVariables, rehearsalArgs } from "./hub-rehearsal.js";

export interface ManagedExecution {
  grant: ManagedRunGrant;
  created(run: { runId: string; stateDir: string }): Promise<void>;
}

/** No graph or runner is opened until fd 3 grants this exact durable launch. */
export async function managedMain(args: string[], run: (argv: string[], context: ManagedExecution) => Promise<void>): Promise<void> {
  const [directory, id] = args;
  if (directory === undefined || id === undefined || args.length !== 2 || !path.isAbsolute(directory) || !/^s-[a-f0-9-]{36}$/.test(id)) throw new Error("invalid managed bootstrap arguments");
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  channel.setEncoding("utf8");
  let buffer = "";
  let closed = false;
  let stopping = false;
  let created = false;
  let grantReceived = false;
  let pendingStop: { commandId?: string; reason?: string; disconnected?: boolean } | undefined;
  let grant: ManagedRunGrant | undefined;
  const stateDirFor = (runId: string) => path.join(directory, "runs", runId);
  let rejectGrant: (error: Error) => void = () => {};
  let receiveGrant: (value: Record<string, unknown>) => void = () => {};
  const granted = new Promise<Record<string, unknown>>((resolve, reject) => { receiveGrant = resolve; rejectGrant = reject; });
  const stop = async (): Promise<void> => {
    if (!grant || !created || !pendingStop || stopping) return;
    stopping = true;
    const request = pendingStop;
    try {
      await createController().stop(stateDirFor(grant.runId), {
        managed: { ...grant, verify: () => assertHubGrant(directory, grant!, { allowStopping: true }) },
        ...(request.reason === "service-interruption" && request.commandId !== undefined ? { interruptionId: request.commandId } : {}),
        ...(request.disconnected ? { managedDisconnect: true } : {}),
      });
    } catch (error) { console.error(`managed stop: ${error instanceof Error ? error.message : String(error)}`); }
    finally { stopping = false; }
  };
  const recoverStop = async () => {
    try {
      const stored = await readStoredSubmission(directory, id);
      if (stored.launch?.id === grant?.launchId && stored.launch?.stopReason && stored.launch.stopCommandId) {
        pendingStop = { reason: stored.launch.stopReason, commandId: stored.launch.stopCommandId };
      }
    } catch { /* A missing/corrupt scheduler keeps the conservative disconnected stop. */ }
    pendingStop ??= { disconnected: true };
    await stop();
  };
  const disconnected = () => {
    closed = true;
    rejectGrant(new Error("managed control channel closed before start grant"));
    void recoverStop();
  };
  channel.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, newline)) > 16_384) { channel.destroy(new Error("oversized managed control message")); return; }
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.protocolVersion !== 1) throw new Error("unsupported managed protocol");
        if (message.type === "grant" && !grantReceived) { grantReceived = true; receiveGrant(message); }
        else if (message.type === "stop") {
          if (!["pause", "cancel", "service-interruption"].includes(String(message.reason)) || typeof message.commandId !== "string") throw new Error("invalid managed stop");
          pendingStop = { reason: String(message.reason), commandId: message.commandId }; void stop();
        } else throw new Error("unexpected managed control message");
      } catch (error) { channel.destroy(error instanceof Error ? error : new Error(String(error))); return; }
    }
    if (Buffer.byteLength(buffer) > 16_384) channel.destroy(new Error("oversized managed control message"));
  });
  channel.on("end", disconnected);
  channel.on("error", disconnected);
  const signal = () => {
    if (!grant) { disconnected(); channel.destroy(); }
    else void recoverStop();
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    const message = await granted;
    const submission = await readStoredSubmission(directory, id);
    const launch = submission.launch;
    if (!launch || message.hubId !== submission.hubId || message.submissionId !== id || message.runId !== submission.runId || message.launchId !== launch.id || message.generation !== launch.generation) throw new Error("managed start grant does not match its reservation");
    // From here the launch reports how it ended (docs/design-run-hub.md §6.1): refused, failed, or completed.
    let ended: Pick<HubLaunchReport, "outcome" | "refusal" | "error"> = { outcome: "completed" };
    try {
      if (launch.automatic && launch.command?.remedy !== undefined) throw new Error("automatic managed continuation cannot carry operator remedies");
      grant = {
        protocolVersion: 1, hubId: submission.hubId, hubStateDir: directory, submissionId: id,
        runId: submission.runId, generation: launch.generation, launchId: launch.id,
        automatic: launch.automatic,
        ...(launch.continuationFingerprint !== undefined ? { continuationFingerprint: launch.continuationFingerprint } : {}),
        ...(launch.command !== undefined ? { commandId: launch.command.id, ...(launch.command.kind === "service-interruption" ? { interruptionCommandId: launch.command.id } : {}) } : {}),
        verify: async () => {
          if (closed || pendingStop) throw new Error("managed execution grant was withdrawn");
          await assertHubGrant(directory, grant!);
        },
      };
      await grant.verify();
      await verifyHubExecutionInput(submission, {
        initial: launch.mode === "initial", upgrade: launch.command?.remedy?.upgrade === true, requireCurrent: true,
      });
      const pinned = submission.input.runtimeConfig;
      if (pinned?.runner) process.env.GRAPHLOOM_RUNNER_CONFIG = pinned.runner.path;
      if (pinned?.supervisor) process.env.GRAPHLOOM_SUPERVISOR_CONFIG = pinned.supervisor.path;
      else {
        // Suppress a newly created default supervisor config which was absent at submission.
        process.env.GRAPHLOOM_HUB_NO_SUPERVISOR = "1";
      }
      // Stand-ins answer only inside a rehearsal launch, which sets their variables itself
      // (rehearsal.ts); no launch keeps any it inherited from the hub's environment.
      // The mode is the captured input's, never a client's: a real submission never runs
      // on stand-ins, and a rehearsal submission never on real harnesses.
      const rehearsal = submission.input.rehearsal;
      dropStandInVariables(process.env, { keepRehearsalToken: rehearsal !== undefined });
      const remedies = remedyArgs(launch.command?.remedy);
      const command = launch.mode === "initial"
        ? [rehearsal !== undefined ? "rehearse" : "run", await materializeHubTask(submission.input), "--state-root", path.join(directory, "runs"), ...(rehearsal !== undefined ? rehearsalArgs(rehearsal) : [])]
        : launch.mode === "reconcile" ? ["__hub-reconcile", stateDirFor(submission.runId), ...(rehearsal !== undefined ? ["--rehearsal"] : [])]
        : ["resume", stateDirFor(submission.runId), ...(rehearsal !== undefined ? ["--rehearsal"] : []), ...remedies];
      // Every launch's log starts with what it runs, so `hub logs` shows the current launch at once (§8).
      console.error(launchStartLine({ runId: submission.runId, launchId: launch.id, generation: launch.generation, mode: launch.mode, automatic: launch.automatic, remedies }));
      if (launch.mode !== "initial") { created = true; await stop(); }
      await grant.verify();
      await run(command, {
        grant,
        async created(value) {
          created = true;
          if (!closed) channel.write(`${JSON.stringify({ protocolVersion: 1, type: "created", ...value, launchId: launch.id, generation: launch.generation })}\n`);
          await stop();
        },
      });
    } catch (error) {
      const refusal = refusalOf(error);
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 1024) || "unknown error";
      ended = refusal !== undefined ? { outcome: "refused", refusal } : { outcome: "error", error: reason };
      // The launch's log ends with how it ended, like a run's last line (§8).
      console.error(launchEndLine({ runId: submission.runId, status: refusal !== undefined ? "refused" : "error", stopReason: reason, ...(refusal !== undefined ? { stopRetryable: false } : {}) }));
      throw error;
    } finally {
      const commandId = launch.command?.id;
      const applied = commandId === undefined ? undefined
        : ended.outcome === "completed" || await managedCommandApplied(stateDirFor(submission.runId), commandId).catch(() => false);
      await writeLaunchReport(directory, id, {
        protocolVersion: 1, launchId: launch.id, generation: launch.generation, ...ended,
        ...(commandId !== undefined ? { command: { id: commandId, applied: applied === true } } : {}), endedAt: new Date().toISOString(),
      }).catch((error: unknown) => console.error(`managed launch report: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (!closed) channel.write(`${JSON.stringify({ protocolVersion: 1, type: "settled", runId: submission.runId, launchId: launch.id, generation: launch.generation })}\n`);
  } finally {
    process.off("SIGTERM", signal); process.off("SIGINT", signal);
    channel.removeAllListeners(); channel.destroy();
  }
}

/**
 * Refuses a managed launch whose command does not match its submission's
 * captured mode: a rehearsal command for a real submission, or a real one for
 * a rehearsal submission. Returns the rehearsal settings of a rehearsal.
 */
export async function assertManagedMode(grant: ManagedRunGrant, rehearsal: boolean): Promise<HubSubmission["input"]["rehearsal"]> {
  const settings = (await readStoredSubmission(grant.hubStateDir, grant.submissionId)).input.rehearsal;
  if (rehearsal && settings === undefined) throw new Error(`hub submission ${grant.submissionId} is a real submission; it never runs as a rehearsal`);
  if (!rehearsal && settings !== undefined) throw new Error(`hub submission ${grant.submissionId} is a rehearsal submission; it runs only on its stand-ins`);
  return settings;
}

export async function readStoredSubmission(directory: string, id: string): Promise<HubSubmission> {
  const snapshot = JSON.parse(await boundedText(path.join(directory, "scheduler.json"), 16 * 1024 * 1024)) as { schemaVersion?: number; submissions?: Record<string, HubSubmission> };
  const submission = snapshot.submissions?.[id];
  if (snapshot.schemaVersion !== 1 || !submission || submission.id !== id) throw new Error("unknown managed submission");
  return submission;
}

export function remedyArgs(remedy: HubResumeRemedy | undefined): string[] {
  if (remedy === undefined) return [];
  return [
    ...(remedy.reconciled ? ["--reconciled"] : []), ...(remedy.updatePlugin ? ["--update-plugin"] : []),
    ...(remedy.updateExecutors ? ["--update-executors"] : []), ...(remedy.upgrade ? ["--upgrade"] : []),
    ...(remedy.approve ? ["--approve", remedy.approve] : []), ...(remedy.decline ? ["--decline", remedy.decline] : []),
    ...(remedy.supervisor ? ["--supervisor", remedy.supervisor] : []), ...(remedy.reason ? ["--reason", remedy.reason] : []),
    ...Object.entries(remedy.inputs ?? {}).flatMap(([key, value]) => ["--input", `${key}=${value}`]),
  ];
}

export function parseRemedy(args: string[]): HubResumeRemedy | undefined {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const result = args[index + 1];
    if (result === undefined || result.startsWith("--")) throw new Error(`${name} needs a value`);
    return result;
  };
  const approval = approvalFlags(args);
  const supervisor = value("--supervisor");
  const reason = value("--reason");
  if (approval && supervisor && reason) throw new Error("--reason cannot answer both approval and supervisor transition");
  const result: HubResumeRemedy = {
    ...(args.includes("--reconciled") ? { reconciled: true } : {}), ...(args.includes("--update-plugin") ? { updatePlugin: true } : {}),
    ...(args.includes("--update-executors") ? { updateExecutors: true } : {}), ...(args.includes("--upgrade") ? { upgrade: true } : {}),
    ...(value("--approve") !== undefined ? { approve: value("--approve")! } : {}),
    ...(value("--decline") !== undefined ? { decline: value("--decline")! } : {}),
    ...(approval?.inputs !== undefined ? { inputs: approval.inputs } : {}),
    ...(supervisor !== undefined ? { supervisor } : {}), ...(reason !== undefined ? { reason } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** Route mutation before owner-version dispatch, so a plain resume cannot bypass capacity. */
export async function routeManagedCommand(cmd: string, args: string[]): Promise<boolean> {
  if (!["resume", "stop", "delete"].includes(cmd) || args[1] === undefined) return false;
  const at = args.indexOf("--state-root");
  let stateDir: string;
  try { stateDir = await resolveStateDir(args[1], at >= 0 ? args[at + 1] : undefined); }
  catch { return false; }
  const binding = await readManagedBinding(stateDir);
  if (!binding) return false;
  if (cmd === "delete") throw new Error(`a managed run cannot be deleted; cancel or finish it, archive it (graphloom hub archive ${binding.submissionId}), then remove its run files with graphloom hub purge ${binding.submissionId}`);
  if (args.includes("--on-stop")) throw new Error("managed resume does not accept --on-stop; use hub inspect or hub watch for monitoring");
  if (cmd === "resume") {
    // A hub rehearsal resumes only as a rehearsal, and a real hub run never as one.
    const rehearsal = (await readStoredSubmission(binding.hubStateDir, binding.submissionId).catch(() => undefined))?.input.rehearsal !== undefined;
    if (args.includes("--rehearsal") && !rehearsal) throw new Error(`run ${binding.runId} is a real hub submission (${binding.submissionId}); it never resumes as a rehearsal: drop --rehearsal`);
    if (!args.includes("--rehearsal") && rehearsal) throw new Error(`run ${binding.runId} is a hub rehearsal submission (${binding.submissionId}); it resumes only as a rehearsal: add --rehearsal, or use graphloom hub resume ${binding.submissionId}`);
  }
  const endpoint = JSON.parse(await boundedText(path.join(binding.hubStateDir, "endpoint.json"), 4096)) as { hubId?: string; socket?: string };
  if (endpoint.hubId !== binding.hubId || typeof endpoint.socket !== "string" || !path.isAbsolute(endpoint.socket)) throw new Error("managed hub endpoint is unavailable; start its hub before controlling this run");
  const remedy = cmd === "resume" ? parseRemedy(args) : undefined;
  const commandAt = args.indexOf("--command-id");
  const commandId = commandAt >= 0 ? args[commandAt + 1] : randomUUID();
  if (!commandId || commandId.startsWith("--")) throw new Error("--command-id needs a value");
  console.error(`hub command ID: ${commandId}`);
  const result = await hubRequest("POST", `/v1/submissions/${binding.submissionId}/${cmd === "stop" ? "pause" : "resume"}`, { commandId, ...(remedy !== undefined ? { remedy } : {}) }, endpoint.socket);
  console.log(JSON.stringify(result, null, 2));
  return true;
}

/** The first line a managed launch writes to its stderr log: which launch of which run, and what it runs. */
export function launchStartLine(launch: { runId: string; launchId: string; generation: number; mode: HubLaunch["mode"]; automatic: boolean; remedies: string[] }): string {
  const what = launch.mode === "initial" ? "starting" : launch.mode === "reconcile" ? "reconciling" : launch.automatic ? "resuming automatically" : "resuming";
  return `graphloom: run ${launch.runId} ${what} (launch ${launch.launchId}, generation ${launch.generation})${launch.remedies.length > 0 ? `: ${launch.remedies.join(" ").replace(/\s+/g, " ").slice(0, 1000)}` : ""}`;
}

/**
 * The last line a managed launch writes to its stderr log, so `hub logs` shows
 * how the launch ended: the run's status, its stop reason, the blocker when it
 * says more, and whether a resume runs the graph again.
 */
export function launchEndLine(report: { runId: string; status: string; stopReason?: string; blocker?: string; stopRetryable?: boolean }): string {
  if (report.status === "succeeded") return `graphloom: run ${report.runId} succeeded`;
  const one = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 2000);
  const reason = report.stopReason !== undefined ? one(report.stopReason) : undefined;
  const blocker = report.blocker !== undefined ? one(report.blocker) : undefined;
  return `graphloom: run ${report.runId} ${report.status}${reason ? `: ${reason}` : ""}${blocker && blocker !== reason ? `; blocker: ${blocker}` : ""}${report.stopRetryable !== undefined ? ` (${report.stopRetryable ? "retryable" : "final"})` : ""}`;
}
