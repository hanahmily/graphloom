import {
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  type ExecutorInputShape,
  type ExecutorPin,
  type JobSpec,
  type ExecutorView,
} from "@graphloom/sdk";
import {
  digestExecutorSource,
  type ExecutorDescriptor,
  type ExecutorSourceOverride,
  type Runner,
} from "@graphloom/runner";
import { newEvidenceRef } from "./admit.js";
import type { DurableRunState, ExecutorCatalogEntry } from "./state.js";

/** Pin every executor the runner serves, with the digest of the code it would run. */
export async function pinExecutorCatalog(runner: Runner): Promise<ExecutorCatalogEntry[] | undefined> {
  const described = await runner.describeExecutors?.();
  if (described === undefined) return undefined;
  const seen = new Set<string>();
  return described.flatMap((d) => {
    if (seen.has(d.id)) return [];
    seen.add(d.id);
    return [
      {
        id: d.id,
        digest: d.digest,
        source: d.source,
        ...(d.entryModule !== undefined ? { entryModule: d.entryModule } : {}),
        isolation: d.isolation,
        builtin: d.builtin,
        ...(d.inputShape !== undefined ? { inputShape: d.inputShape } : {}),
      },
    ];
  });
}

/** The declared input shapes of the run's pinned executors, for the supervisor to compose dispatch input against. */
export function executorViews(state: DurableRunState): ExecutorView[] | undefined {
  const views = (state.executorCatalog ?? []).flatMap((e) =>
    e.inputShape !== undefined ? [{ id: e.id, inputShape: structuredClone(e.inputShape) }] : [],
  );
  return views.length > 0 ? views : undefined;
}

/** A declared input shape as JSON, cut to `limit` characters. */
export function describeInputShape(shape: ExecutorInputShape, limit: number): string {
  const text = JSON.stringify(shape);
  return text.length <= limit ? text : `${text.slice(0, limit)}... (cut)`;
}

/** One executor the operator moved onto the installed code with `--update-executors`. */
export interface ExecutorRepin {
  id: string;
  fromDigest: string;
  toDigest: string;
}

/** What checking the pinned catalog found: a blocker, or the catalog to continue with and the executors re-pinned in it. */
export type ExecutorCatalogCheck = { blocker: string } | { catalog: ExecutorCatalogEntry[]; repins: ExecutorRepin[] };

/** Appended to a digest mismatch so the operator knows the way forward. */
export const UPDATE_EXECUTORS_HINT = "resume with --update-executors to pin the installed executor";

/**
 * Check the executors a run pinned against what the runner serves now. An
 * activated repair is checked against its run-local copy. Returns a blocker,
 * or the catalog to continue with. With `update`, an executor whose installed
 * bytes (or source location) changed is re-pinned to the installed descriptor
 * instead of blocking; one whose isolation or built-in status changed, that is
 * no longer installed, or whose active repair the installed bytes moved past
 * is refused.
 */
export async function verifyExecutorCatalog(
  state: DurableRunState,
  runner: Runner,
  update = false,
): Promise<ExecutorCatalogCheck | undefined> {
  const pinned = state.executorCatalog;
  if (pinned === undefined || pinned.length === 0) return undefined;
  const live = await runner.describeExecutors?.();
  if (live === undefined) return { blocker: "the runner cannot describe the executors this run pinned" };
  const byId = new Map(live.map((d) => [d.id, d]));
  const repins: ExecutorRepin[] = [];
  const catalog: ExecutorCatalogEntry[] = [];
  for (const entry of pinned) {
    const current = byId.get(entry.id);
    if (entry.repair !== undefined) {
      const digest = await digestExecutorSource(entry.repair.root).catch(() => undefined);
      if (digest !== entry.digest) {
        return { blocker: `run-local repair ${entry.repair.artifactId} of executor ${entry.id} is missing or changed` };
      }
      if (current === undefined) return { blocker: `pinned executor ${entry.id} is no longer served` };
      // The copy runs under the runner's current configuration for that executor.
      const changed = changedAttribute(entry, current, ["isolation", "builtin"]);
      if (changed) return { blocker: `pinned executor ${entry.id} changed: ${changed}` };
      // The installed bytes moved past what the repair was made from: the qualified copy stays, and only a repair replaces it.
      if (update && current.digest !== entry.repair.baseDigest) {
        return {
          blocker: `pinned executor ${entry.id} has an active repair ${entry.repair.artifactId}; --update-executors does not replace it (installed digest ${current.digest.slice(0, 12)} != its base ${entry.repair.baseDigest.slice(0, 12)})`,
        };
      }
      catalog.push(entry);
      continue;
    }
    if (current === undefined) return { blocker: `pinned executor ${entry.id} is no longer installed` };
    const kept = changedAttribute(entry, current, ["isolation", "builtin"]);
    if (kept) return { blocker: `pinned executor ${entry.id} changed: ${kept}` };
    const moved =
      current.digest !== entry.digest ? `digest ${current.digest.slice(0, 12)} != pinned ${entry.digest.slice(0, 12)}` : changedAttribute(entry, current, ["source", "entryModule"]);
    if (moved === undefined) {
      catalog.push(entry);
      continue;
    }
    if (!update) return { blocker: `pinned executor ${entry.id} changed: ${moved}; ${UPDATE_EXECUTORS_HINT}` };
    catalog.push(installedEntry(current));
    if (current.digest !== entry.digest) repins.push({ id: entry.id, fromDigest: entry.digest, toDigest: current.digest });
  }
  return { catalog, repins };
}

/** An entry pinned from what the runner serves, as at intake. */
function installedEntry(d: ExecutorDescriptor): ExecutorCatalogEntry {
  return {
    id: d.id,
    digest: d.digest,
    source: d.source,
    ...(d.entryModule !== undefined ? { entryModule: d.entryModule } : {}),
    isolation: d.isolation,
    builtin: d.builtin,
    ...(d.inputShape !== undefined ? { inputShape: d.inputShape } : {}),
  };
}

/**
 * Record an operator's executor update in the run: the new catalog, each
 * old -> new digest at the generation it took effect (state, version history
 * and an evidence record), and the digest on work not yet started. Accepted
 * receipts and the evidence behind them are untouched: they bind the workspace
 * and artifacts they were accepted on, never an executor's digest, so earlier
 * evidence stays valid evidence of what ran then.
 */
export function applyExecutorRepin(
  state: DurableRunState,
  catalog: ExecutorCatalogEntry[],
  repins: ExecutorRepin[],
): DurableRunState {
  if (repins.length === 0) return { ...state, executorCatalog: catalog };
  const at = new Date().toISOString();
  const transitions = repins.map((r) => ({ ...r, generation: state.generation, at }));
  const toDigest = new Map(repins.map((r) => [r.id, r.toDigest]));
  const pin = (p: ExecutorPin): ExecutorPin => {
    const digest = toDigest.get(p.id);
    return digest !== undefined && p.digest !== undefined ? { ...p, digest } : p;
  };
  const job = (j: JobSpec): JobSpec => ({
    ...j,
    ...(j.executor !== undefined ? { executor: pin(j.executor) } : {}),
    ...(j.tools !== undefined ? { tools: j.tools.map((t) => ({ ...t, executor: pin(t.executor) })) } : {}),
  });
  const reason = `operator executor update: ${repins.map((r) => `${r.id} ${r.fromDigest.slice(0, 12)} -> ${r.toDigest.slice(0, 12)}`).join(", ")}`;
  const next: DurableRunState = {
    ...state,
    executorCatalog: catalog,
    executorTransitions: [...(state.executorTransitions ?? []), ...transitions],
    evidence: [
      ...state.evidence,
      { ref: newEvidenceRef(state), kind: "other", generation: state.generation, payload: { executorUpdate: { transitions } } },
    ],
    versionHistory: [...(state.versionHistory ?? []), { activeVersion: state.activeVersion, generation: state.generation, reason, at }],
    stateRevision: state.stateRevision + 1,
  };
  // A dispatch admitted before the stop and not yet started runs on the new bytes.
  if (state.pendingDispatch !== undefined) {
    const { pendingDispatch } = state;
    next.pendingDispatch = {
      ...pendingDispatch,
      job: job(pendingDispatch.job),
      ...(pendingDispatch.executor !== undefined ? { executor: pin(pendingDispatch.executor) } : {}),
    };
  }
  if (state.executorRetry !== undefined) next.executorRetry = { ...state.executorRetry, job: job(state.executorRetry.job) };
  return next;
}

type PinnedAttribute = "source" | "entryModule" | "isolation" | "builtin";

function changedAttribute(
  entry: ExecutorCatalogEntry,
  current: ExecutorDescriptor,
  attributes: PinnedAttribute[],
): string | undefined {
  for (const attribute of attributes) {
    if (entry[attribute] !== current[attribute]) {
      return `${attribute} ${String(current[attribute])} != pinned ${String(entry[attribute])}`;
    }
  }
  return undefined;
}

export function catalogEntry(state: DurableRunState, id: string): ExecutorCatalogEntry | undefined {
  return state.executorCatalog?.find((e) => e.id === id);
}

/** The built-in agent and command executors the controller pins from a job's kind. */
export function isKindDefaultExecutor(id: string): boolean {
  return id === BUILTIN_AGENT_EXECUTOR_ID || id === BUILTIN_COMMAND_EXECUTOR_ID;
}

/**
 * Bind a job's executor pin to the run's catalog: the pinned digest travels
 * with the job, and an activated repair supplies its run-local source.
 */
export function resolveExecutorPin(
  state: DurableRunState,
  pin: ExecutorPin,
): { pin: ExecutorPin; source?: ExecutorSourceOverride } | { error: string } {
  const entry = catalogEntry(state, pin.id);
  if (entry === undefined) {
    // A runner that cannot describe its executors pins nothing to check against.
    if (state.executorCatalog === undefined || isKindDefaultExecutor(pin.id)) return { pin };
    return { error: `executor ${pin.id} is not pinned for this run` };
  }
  if (pin.digest !== undefined && pin.digest !== entry.digest) {
    return { error: `executor ${pin.id} digest ${pin.digest.slice(0, 12)} is not the run's pin ${entry.digest.slice(0, 12)}` };
  }
  return {
    pin: { ...pin, digest: entry.digest },
    ...(entry.repair !== undefined
      ? { source: { root: entry.repair.root, entryModule: entry.repair.entryModule } }
      : {}),
  };
}
