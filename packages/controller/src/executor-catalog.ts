import {
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  type ExecutorPin,
} from "@graphloom/sdk";
import { digestExecutorSource, type ExecutorSourceOverride, type Runner } from "@graphloom/runner";
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
      },
    ];
  });
}

/**
 * Check the executors a run pinned against what the runner serves now. An
 * activated repair is checked against its run-local copy. Returns a blocker,
 * or undefined when every pin still resolves to the same code.
 */
export async function verifyExecutorCatalog(state: DurableRunState, runner: Runner): Promise<string | undefined> {
  const pinned = state.executorCatalog;
  if (pinned === undefined || pinned.length === 0) return undefined;
  const live = await runner.describeExecutors?.();
  if (live === undefined) return "the runner cannot describe the executors this run pinned";
  const byId = new Map(live.map((d) => [d.id, d]));
  for (const entry of pinned) {
    if (entry.repair !== undefined) {
      const digest = await digestExecutorSource(entry.repair.root).catch(() => undefined);
      if (digest !== entry.digest) {
        return `run-local repair ${entry.repair.artifactId} of executor ${entry.id} is missing or changed`;
      }
      if (!byId.has(entry.id)) return `pinned executor ${entry.id} is no longer served`;
      continue;
    }
    const current = byId.get(entry.id);
    if (current === undefined) return `pinned executor ${entry.id} is no longer installed`;
    if (current.digest !== entry.digest) {
      return `pinned executor ${entry.id} changed: digest ${current.digest.slice(0, 12)} != pinned ${entry.digest.slice(0, 12)}`;
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
  if (entry === undefined) return { pin };
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
