// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckoutSpec, EvidenceRecord, Receipt } from "@graphloom/sdk";
import type { EvidenceFilter, ProbeResult, SupervisorInspection } from "@graphloom/supervisor";
import { admitValidation, AdmissionError, type AdmissionValidator } from "./admit.js";
import { HostObservationError } from "./host-validators.js";
import { hydrateOne } from "./evidence.js";
import { activateRefusal, checkoutSpecRefusal, describeInadmissible } from "./inadmissible.js";
import type { DurableRunState, ProbeRecord } from "./state.js";
import { selectPaths } from "./checkout.js";
import { candidateChange, readWorktreeFile, withGitCancellation } from "./worktree.js";

const execFileAsync = promisify(execFile);

/** Probes one episode may start when the task sets no `budgets.probes`. */
export const DEFAULT_EPISODE_PROBES = 32;

/** Longest one inspection call may run before it is cut off, so a stuck git or validator cannot hold a turn. */
export const INSPECTION_TIMEOUT_MS = 60_000;

/** The stage whose job produced a record, wherever the plugin's payload carries it. */
function producerStage(record: EvidenceRecord): string | undefined {
  return (record.payload as { producer?: { stageId?: string } } | undefined)?.producer?.stageId;
}

export interface InspectionHooks {
  /** The run state as it stands now; probes read a copy and never save it. */
  state(): DurableRunState;
  validators: Record<string, AdmissionValidator>;
  hasRepairHooks: boolean;
  /**
   * Reserve one probe before it runs, durably: charged to the run's probe
   * budget and to the episode's attempts, whether or not the probe then
   * succeeds. The id to cite, or why no probe is left.
   */
  reserveProbe(): Promise<{ id: string } | { refused: string }>;
  /** Record that the reserved probe ran, and what it found, so a proposal may cite its id. */
  recordProbe(id: string, record: ProbeRecord): Promise<void>;
  /** The signal of the decide turn now running; aborted when the run stops. */
  signal(): AbortSignal | undefined;
  /**
   * Replace the plugin host's child after a validator's host call crashed or
   * timed out, as the controller does for a real validate. A failure message
   * when it cannot be replaced.
   */
  recoverHost(code: string): Promise<string | undefined>;
}

export interface SupervisorInspectionHandle {
  inspection: SupervisorInspection;
}

/** Longest probe reason kept durably; the supervisor saw the full text in its turn. */
export const MAX_PROBE_REASON_CHARS = 2_000;
/** Requirement outcomes kept per probe. */
export const MAX_PROBE_REQUIREMENTS = 32;
/** Probe results kept per episode (the latest); an older probe stays citable by id. */
export const MAX_KEPT_PROBE_RESULTS = 64;

const clip = (text: string): string =>
  text.length <= MAX_PROBE_REASON_CHARS ? text : `${text.slice(0, MAX_PROBE_REASON_CHARS)}… [truncated]`;

/** The bounded record of a probe's result that the run keeps. */
export function probeRecord(check: ProbeRecord["check"], result: Omit<ProbeResult, "probeId">): ProbeRecord {
  return {
    check,
    accepted: result.accepted,
    reason: clip(result.reason),
    stateRevision: result.stateRevision,
    ...(result.evaluated !== undefined ? { evaluated: result.evaluated } : {}),
    ...(result.requirements !== undefined
      ? { requirements: result.requirements.slice(0, MAX_PROBE_REQUIREMENTS).map((r) => ({ requirementId: r.requirementId, status: r.status, reason: clip(r.reason) })) }
      : {}),
  };
}

/** `results` with `id` added, keeping only the latest MAX_KEPT_PROBE_RESULTS. */
export function keepProbeResult(results: Record<string, ProbeRecord> | undefined, id: string, record: ProbeRecord): Record<string, ProbeRecord> {
  const entries = [...Object.entries(results ?? {}).filter(([k]) => k !== id), [id, record] as const];
  return Object.fromEntries(entries.slice(-MAX_KEPT_PROBE_RESULTS));
}

/**
 * The probes of the current recovery episode that `refs` cite, as evidence
 * records (ref = probe id, kind "other", payload = what the probe found), so a
 * probe-backed proposal reaches whoever judges it with the probe's output.
 */
export function citedProbeEvidence(state: DurableRunState, refs: readonly string[] | undefined): EvidenceRecord[] {
  const episodeId = state.recoveryEpisodeId;
  if (episodeId === undefined || state.probeLog?.episodeId !== episodeId) return [];
  const ran = new Set(state.probeLog.ids);
  return [...new Set(refs ?? [])]
    .filter((ref) => ran.has(ref))
    .map((ref) => {
      const found = state.probeLog!.results?.[ref];
      return {
        ref,
        kind: "other" as const,
        payload: { probe: found ?? { reason: "this probe ran in the episode, but its result is no longer kept" } },
      };
    });
}

/** Probes that ran in `episodeId`, across its turns and a resume: the only probe ids a proposal may cite. */
export function episodeProbeIds(state: DurableRunState, episodeId: string): ReadonlySet<string> {
  return new Set(state.probeLog?.episodeId === episodeId ? state.probeLog.ids : []);
}

/** The kept probe results of `episodeId`, as a spreadable `{ results }` (empty for another episode). */
export function episodeProbeResults(state: DurableRunState, episodeId: string): { results?: Record<string, ProbeRecord> } {
  const results = state.probeLog?.episodeId === episodeId ? state.probeLog.results : undefined;
  return results !== undefined ? { results } : {};
}

/** Probes started in `episodeId`, including any that failed. */
export function episodeProbeAttempts(state: DurableRunState, episodeId: string): number {
  return state.probeLog?.episodeId === episodeId ? state.probeLog.attempts : 0;
}

/** Runs git with `input` on stdin; a broken pipe is reported through the rejection, never as an uncaught error. */
function gitWithInput(args: string[], cwd: string, input: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, signal, timeout: INSPECTION_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(out),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

/** The paths a patch touches (both sides of a rename). */
async function patchPaths(patch: string, cwd: string, signal: AbortSignal): Promise<string[]> {
  const out = await gitWithInput(["apply", "--numstat", "-z", "-"], cwd, patch, signal);
  const entries = out.split("\0").filter((e) => e !== "");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    // A rename is "added\tdeleted\t" followed by the old and the new path.
    if (/^\S+\t\S+\t$/.test(entry)) {
      paths.push(entries[i + 1]!, entries[i + 2]!);
      i += 2;
    } else {
      paths.push(entry.replace(/^\S+\t\S+\t/, ""));
    }
  }
  return paths;
}

/** Paths the patch deletes; reversed, it creates them. */
async function deletedByPatch(patch: string, cwd: string, signal: AbortSignal): Promise<Set<string>> {
  const out = await gitWithInput(["apply", "--summary", "-"], cwd, patch, signal);
  const deleted = new Set<string>();
  for (const line of out.split("\n")) {
    const match = /^ delete mode \d+ (.+)$/.exec(line);
    if (match !== null) deleted.add(match[1]!);
  }
  return deleted;
}

async function existsAtBase(cwd: string, pinnedHead: string, file: string, signal: AbortSignal): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${pinnedHead}:${file}`], { cwd, signal, timeout: INSPECTION_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps work a probe starts for the controller (replacing a dead plugin host)
 * from outliving the supervisor turn: once `close()` is called nothing new
 * starts, and `close()` resolves only after what had started has finished, so
 * teardown never races a half-made replacement.
 */
export function createRecoveryFence() {
  const pending = new Set<Promise<unknown>>();
  const byKey = new Map<string, Promise<unknown>>();
  let closed = false;
  return {
    /**
     * Like `run`, but a call made while another with the same key is still
     * under way joins it instead of starting a second: two probes that find the
     * same dead host must not each build (and one overwrite) a replacement.
     */
    runOnce<T>(key: string, work: () => Promise<T>): Promise<T> | undefined {
      const joined = byKey.get(key);
      if (joined !== undefined) return joined as Promise<T>;
      const started = this.run(work);
      if (started === undefined) return undefined;
      byKey.set(key, started);
      const done = () => byKey.delete(key);
      started.then(done, done);
      return started;
    },
    /** Runs `work` unless the fence is closed; `undefined` when it is. */
    run<T>(work: () => Promise<T>): Promise<T> | undefined {
      if (closed) return undefined;
      const started = work();
      pending.add(started);
      const done = () => pending.delete(started);
      started.then(done, done);
      return started;
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}

/** Starts `work` unless `signal` is already aborted; settles with it, or rejects as soon as `signal` aborts. Work that ignores its signal is left to finish alone. */
function raceAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("stopped: the run is stopping or the call timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("stopped: the run is stopping or the call timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The supervisor's read-only view of the run and its dry-run probes. Reads
 * evidence by its recorded fields and never interprets a payload; everything
 * it returns is a copy. A probe runs the controller's own admission code on a
 * copy of the state: it mints no receipt and leaves the state revision as it
 * found it. Each call stops when the run does, when the tool call is aborted,
 * or after INSPECTION_TIMEOUT_MS.
 */
export function createSupervisorInspection(hooks: InspectionHooks): SupervisorInspectionHandle {
  const scope = (callSignal?: AbortSignal): AbortSignal =>
    AbortSignal.any(
      [hooks.signal(), callSignal, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)].filter((s): s is AbortSignal => s !== undefined),
    );
  const probe = async (
    check: ProbeRecord["check"],
    callSignal: AbortSignal | undefined,
    run: (state: DurableRunState, signal: AbortSignal) => Promise<Omit<ProbeResult, "probeId" | "stateRevision">>,
  ): Promise<ProbeResult> => {
    const signal = scope(callSignal);
    if (signal.aborted) throw new Error("the run is stopping");
    const reserved = await hooks.reserveProbe();
    if ("refused" in reserved) throw new Error(`probe refused: ${reserved.refused}`);
    // The revision names the snapshot the result is about, not whatever the run has become since.
    const snapshot = structuredClone(hooks.state());
    const result = await raceAbort(() => run(snapshot, signal), signal);
    const found = { stateRevision: snapshot.stateRevision, ...result };
    await hooks.recordProbe(reserved.id, probeRecord(check, found));
    return { probeId: reserved.id, ...found };
  };

  const inspection: SupervisorInspection = {
    getEvidence: (ref) => {
      const found = hooks.state().evidence.find((e) => e.ref === ref);
      // The supervisor reads a record's content: hydrate its externalized parts (the tool bounds what it shows).
      return found === undefined ? undefined : structuredClone(hydrateOne(hooks.state().stateDir, found));
    },
    listEvidence: (filter: EvidenceFilter) =>
      structuredClone(
        hooks.state().evidence.filter(
          (e) =>
            (filter.stageId === undefined || producerStage(e) === filter.stageId) &&
            (filter.kind === undefined || e.kind === filter.kind) &&
            (filter.generation === undefined || e.generation === filter.generation) &&
            (filter.candidateDigest === undefined || e.candidateDigest === filter.candidateDigest),
        ),
      ),
    listReceipts: (): Receipt[] => structuredClone(hooks.state().receipts),

    async readCandidate(relativePath, callSignal) {
      try {
        const signal = scope(callSignal);
        const text = await raceAbort(() => readWorktreeFile(hooks.state().worktreePath, relativePath), signal);
        return text === undefined ? { error: `${relativePath} is not a file in the workspace` } : { text };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    async diffCandidate(callSignal) {
      const { worktreePath, intake } = hooks.state();
      const signal = scope(callSignal);
      try {
        const git = (args: string[]) =>
          execFileAsync("git", args, { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024, signal, timeout: INSPECTION_TIMEOUT_MS });
        const tracked = (await git(["diff", intake.pinnedHead])).stdout;
        const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean);
        const note = untracked.length > 0 ? `\n# untracked files (read them with read_candidate): ${untracked.join(", ")}\n` : "";
        return { diff: `${tracked}${note}` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    checkValidate: (spec, callSignal) =>
      probe("check_validate", callSignal, async (state, signal) => {
        const stage = state.definition.stages.find((s) => s.id === spec.stageId);
        if (stage === undefined) return { accepted: false, reason: `stage ${spec.stageId} is not in the pinned graph definition`, evaluated: false };
        try {
          const result = await withGitCancellation(signal, () => admitValidation(state, spec, hooks.validators, signal));
          // What the validators reported, in order; admission stops at the first requirement that does not pass.
          const reported = new Map((result.requirements ?? []).map((r) => [r.requirementId, r]));
          return {
            accepted: result.accepted,
            reason: result.reason,
            evaluated: result.evaluated,
            requirements: (spec.requirementIds ?? stage.requirementIds).map((requirementId) => {
              const outcome = reported.get(requirementId);
              return outcome === undefined
                ? { requirementId, status: "not_evaluated" as const, reason: result.accepted ? "not evaluated" : `not evaluated: ${result.reason}` }
                : { requirementId, status: outcome.status as "passed" | "failed" | "inconclusive", reason: outcome.reason };
            }),
          };
        } catch (err) {
          if (err instanceof AdmissionError) return { accepted: false, reason: err.message, evaluated: false };
          if (err instanceof HostObservationError) {
            // A probe the caller has given up on (the run stopped, the call timed out) must not
            // swap the plugin host: nothing would be left to close the replacement.
            if (signal.aborted) return { accepted: false, evaluated: false, reason: `${err.message}; the probe was cancelled, so the plugin host was left as it was` };
            // The same dead child would fail every later probe and the real validate: replace it first.
            const failed = await hooks.recoverHost(err.code);
            return {
              accepted: false,
              evaluated: false,
              reason: `${err.message}; ${failed === undefined ? "the plugin host was replaced" : `the plugin host could not be replaced: ${failed}`}`,
            };
          }
          throw err;
        }
      }),

    checkActivation: (artifactId, callSignal) =>
      probe("check_activation", callSignal, async (state) => {
        const refusal = activateRefusal(state, { qualifiedArtifactId: artifactId, reason: "probe" }, hooks.hasRepairHooks);
        return refusal === undefined
          ? {
              accepted: true,
              reason: "would be admitted; activation re-verifies the candidate and base digests on disk when it runs",
            }
          : { accepted: false, reason: describeInadmissible(refusal) };
      }),

    checkCheckout: (spec: CheckoutSpec, callSignal) =>
      probe("check_checkout", callSignal, async (state, signal) => {
        const refusal = checkoutSpecRefusal(spec);
        if (refusal !== undefined) return { accepted: false, reason: refusal };
        // The paths a real checkout would apply: a base path that is not part of the workspace change fails there.
        let changed: Set<string>;
        try {
          const change = await withGitCancellation(signal, () => candidateChange(state.worktreePath, state.intake.pinnedHead));
          changed = new Set(change.fingerprints.keys());
          selectPaths(spec, [...changed]);
        } catch (err) {
          return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (spec.from === "candidate" && spec.revertPatch !== undefined) {
          // A real checkout holds the pinned base plus the changed paths only; the live worktree also
          // holds ignored files. A patch that touches a path in neither would pass here and fail there.
          try {
            const touched = await patchPaths(spec.revertPatch, state.worktreePath, signal);
            const created = await deletedByPatch(spec.revertPatch, state.worktreePath, signal);
            for (const file of touched) {
              // Applied in reverse, a patch that deletes a file creates it: nothing needs to be there already.
              if (created.has(file)) continue;
              if (changed.has(file) || (await existsAtBase(state.worktreePath, state.intake.pinnedHead, file, signal))) continue;
              return {
                accepted: false,
                reason: `revertPatch touches ${file}, which a candidate checkout does not contain (it is neither in the pinned base nor a changed, unignored path)`,
              };
            }
          } catch (err) {
            return { accepted: false, reason: `revertPatch could not be read: ${err instanceof Error ? err.message : String(err)}` };
          }
          // Applying the patch in reverse is checked, never performed.
          try {
            await new Promise<void>((resolve, reject) => {
              const child = execFile(
                "git",
                ["apply", "-R", "--check", "-"],
                { cwd: state.worktreePath, signal, timeout: INSPECTION_TIMEOUT_MS },
                (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
              );
              // git may exit before it has read the whole patch (a bad patch, an abort, the timeout):
              // the broken pipe is reported through the callback above, never as an uncaught error.
              child.stdin?.on("error", () => undefined);
              child.stdin?.end(spec.revertPatch);
            });
          } catch (err) {
            return { accepted: false, reason: `revertPatch does not apply in reverse to the candidate: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        return { accepted: true, reason: "the checkout spec would apply" };
      }),
  };
  return { inspection };
}
