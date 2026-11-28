// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROTOCOL_VERSION, type GraphBudgetDefaults, type GraphDefinition } from "@graphloom/sdk";
import { assertSafeGraphId } from "./ids.js";
import { resolveBundleEntryFromManifest } from "./bundle.js";
import { IntakeError } from "./intake-error.js";
import { createPrivateRepository, PRIVATE_REPOSITORY_COMMIT } from "./private-repository.js";

const execFileAsync = promisify(execFile);

/** Default time a run may spend waiting out executor retry timing (15 minutes). */
export const DEFAULT_WAIT_BUDGET_MS = 15 * 60_000;

/** Default execution time a run may spend while a controller is running it (4 hours). */
export const DEFAULT_ACTIVE_BUDGET_MS = 4 * 60 * 60_000;

/**
 * The controller's own budgets, used for whatever neither the graph's
 * `defaultBudgets` nor the task's `budgets` sets. Small on purpose: a graph
 * whose runs need more says so (see docs/budgets.md).
 */
export const CONTROLLER_DEFAULT_BUDGETS = {
  agentInvocations: 64,
  jobs: 128,
  decisions: 512,
  corrections: 8,
  waitMs: DEFAULT_WAIT_BUDGET_MS,
  activeMs: DEFAULT_ACTIVE_BUDGET_MS,
};

/** The recovery reserve when no layer sets one: max(8, 5% of agentInvocations). */
export function defaultRecoveryReserve(agentInvocations: number): number {
  return Math.max(8, Math.ceil(agentInvocations * 0.05));
}

/** Each value a layer sets must name a budget and be a finite positive integer; checked per layer, on its own. */
function assertBudgetValues(layer: string, values: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!BUDGET_KEYS.has(key)) throw new IntakeError(`unknown ${layer} key: ${key}`);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new IntakeError(`${layer} ${key} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  }
}

/**
 * The checks that relate one budget to another. They hold only for the final
 * budgets, once every layer is merged: a task that sets only
 * `recoveryReserve` is judged against the graph's agentInvocations, not the
 * controller's. (Long `waitMs`/`activeMs` need no limit here: timers are
 * armed in steps no longer than MAX_TIMER_MS, #138.)
 */
function assertFinalBudgets(budgets: { agentInvocations: number; recoveryReserve: number }): void {
  // A reserve that is not strictly smaller than the total leaves no room for
  // even one normal-mode agent call: children.ts's own floor (0 in recovery,
  // this reserve otherwise) would then refuse the run's very first dispatch.
  // Unreachable from the 5%-with-an-8-floor default alone once agentInvocations
  // is large enough, but explicit layers (either number) are not bound by that
  // formula, so this is checked after merging them all.
  if (budgets.recoveryReserve >= budgets.agentInvocations) {
    throw new IntakeError(
      `budgets.recoveryReserve (${budgets.recoveryReserve}) must be less than budgets.agentInvocations (${budgets.agentInvocations}), leaving room for at least one normal-mode agent call`,
    );
  }
}

type ResolvedBudgets = IntakePin["budgets"] & { waitMs: number; activeMs: number; recoveryReserve: number };

function mergeBudgets(taskBudgets?: Partial<RunBudgets>, graphDefaults?: GraphBudgetDefaults): ResolvedBudgets {
  assertBudgetValues("graph defaultBudgets", graphDefaults as Record<string, unknown> | undefined);
  assertBudgetValues("task budgets", taskBudgets as Record<string, unknown> | undefined);
  const merged = { ...CONTROLLER_DEFAULT_BUDGETS, ...graphDefaults, ...taskBudgets };
  return { ...merged, recoveryReserve: merged.recoveryReserve ?? defaultRecoveryReserve(merged.agentInvocations) };
}

/**
 * A run's final starting budgets, by layer: the controller's defaults, then
 * the graph's `defaultBudgets` (what its `describe(config)` declared, so a
 * task config such as a repository profile can carry them), then the task's
 * own `budgets`. `recoveryReserve` defaults from the resulting
 * agentInvocations. Every value is a finite positive integer, and the
 * cross-budget checks run once, on the merged result.
 */
export function resolveRunBudgets(taskBudgets?: Partial<RunBudgets>, graphDefaults?: GraphBudgetDefaults): ResolvedBudgets {
  const budgets = mergeBudgets(taskBudgets, graphDefaults);
  assertFinalBudgets(budgets);
  return budgets;
}

/**
 * The intake with its final budgets: the graph's declared `defaultBudgets`
 * applied under the task's own, and the cross-budget checks run on the
 * result. Called once, after the plugin first describes itself, whether or
 * not it declares any; a resumed run keeps the budgets it was intaken with.
 */
export function applyGraphDefaultBudgets<T extends Pick<IntakePin, "task" | "budgets">>(intake: T, definition: Pick<GraphDefinition, "defaultBudgets">): T & Pick<IntakePin, "graphDefaultBudgets"> {
  const defaults = definition.defaultBudgets;
  const declared = defaults !== undefined && Object.keys(defaults).length > 0;
  const budgets = resolveRunBudgets(intake.task.budgets, declared ? defaults : undefined);
  return { ...intake, ...(declared ? { graphDefaultBudgets: { ...defaults } } : {}), budgets };
}

export interface TaskFile {
  graph: string;
  /**
   * The task repository: any directory inside a git repository. Required by a
   * graph whose manifest declares `repository: "required"` (the default),
   * refused for one that declares `"none"`; parsing alone does not decide.
   */
  repo?: string;
  request: string;
  /** Operator-authorized repair grants (plugin metadata alone is not authority). */
  grants?: RepairGrants;
  /** Operator limits that replace the defaults; each stays finite. */
  budgets?: Partial<RunBudgets>;
  /**
   * A JSON file, relative to the task file, handed to the plugin as its
   * opaque config (`GraphPlugin.describe(config)`, `RunView.config`,
   * `ValidationInput.config`). Intake pins its bytes and digest; the
   * controller never reads a field of it.
   */
  config?: string;
  /**
   * A commit of the task repository to pin instead of its `HEAD`: the run's
   * worktree starts there and every change is measured against it. Intake
   * checks it names a commit; absent means `HEAD`.
   */
  base?: string;
}

/** Largest task config intake accepts: it travels on every plugin call. */
export const MAX_TASK_CONFIG_BYTES = 256 * 1024;

/**
 * The task config as intake pinned it. A run, its resume, its rehearsal and
 * every plugin host it opens use `text`, never the file on disk.
 */
export interface TaskConfigPin {
  /** The task's `config` value, relative to the task file. */
  path: string;
  /** SHA-256 of the file's bytes at intake. */
  sha256: string;
  /** The file's exact UTF-8 text at intake; valid JSON. */
  text: string;
}

export interface RunBudgets {
  agentInvocations: number;
  jobs: number;
  decisions: number;
  corrections: number;
  waitMs: number;
  activeMs: number;
  /** Agent invocations reserved for recovery-mode calls once normal-mode dispatch is denied. Default: max(8, 5% of agentInvocations). */
  recoveryReserve?: number;
  /** Dry-run probes the supervisor may run in total. Absent: probes are not metered, only capped per episode. */
  probes?: number;
}

const BUDGET_KEYS: ReadonlySet<string> = new Set([
  "agentInvocations",
  "jobs",
  "decisions",
  "corrections",
  "waitMs",
  "activeMs",
  "recoveryReserve",
  "probes",
]);

export interface RepairGrants {
  sourceRepair: boolean;
  validatorSubstitution: boolean;
  /** Qualify and activate run-local copies of executor packages. */
  executorRepair?: boolean;
  /**
   * Let jobs the supervisor originates change the operator's machine outside
   * the run's worktree and run-scoped directories. Off by default.
   */
  hostRepair?: boolean;
}

/**
 * The `sdkProtocol` levels a bundle's manifest may state
 * (docs/design-graph-topology.md §11.1). Level 1 describes a stage list,
 * which runs as the implicit chain; level 2 may also describe a topology
 * (`edges`, `start`, `terminal`, a node's `entry` or `maxVisits`). The wire
 * envelope's `protocolVersion` stays `PROTOCOL_VERSION`.
 */
export const SDK_PROTOCOLS: readonly number[] = [PROTOCOL_VERSION, 2];
/** The level a bundle that describes a topology must state. */
export const TOPOLOGY_SDK_PROTOCOL = 2;

/** Why a manifest's `sdkProtocol` is not one this controller accepts, or undefined. */
export function sdkProtocolProblem(level: unknown): string | undefined {
  if (typeof level === "number" && SDK_PROTOCOLS.includes(level)) return undefined;
  return `manifest sdkProtocol ${String(level)} is not one this host accepts (${SDK_PROTOCOLS.join(", ")})`;
}

/**
 * Why a plugin update from a bundle at `pinned` to one at `installed` is
 * refused, or undefined: a run keeps its protocol level
 * (docs/design-graph-topology.md §11.1), so an update cannot carry a chain run
 * to the level that may describe a topology, or back. A run whose level this
 * host no longer accepts moves to the installed bundle's (`resume --upgrade
 * --update-plugin` across a protocol change).
 */
export function protocolLevelChange(pinned: number, installed: number): string | undefined {
  if (installed === pinned || !SDK_PROTOCOLS.includes(pinned)) return undefined;
  return `the installed bundle states sdkProtocol ${installed}, the run's bundle ${pinned}: a plugin update keeps the run's protocol level; a plugin that adopts a topology needs a new run`;
}

/**
 * Why `definition` may not be described by a bundle at `level`, or undefined:
 * a level-1 bundle that describes a topology is refused, at intake and on
 * every describe() check, so it never runs as a list by mistake.
 */
export function topologyLevelProblem(definition: GraphDefinition, level: number): string | undefined {
  if (level >= TOPOLOGY_SDK_PROTOCOL) return undefined;
  const fields = [
    ...(["edges", "start", "terminal"] as const).filter((key) => definition[key] !== undefined),
    ...(definition.stages.some((s) => s.entry !== undefined) ? ["entry"] : []),
    ...(definition.stages.some((s) => s.maxVisits !== undefined) ? ["maxVisits"] : []),
  ];
  if (fields.length === 0) return undefined;
  return `the bundle states sdkProtocol ${level} but describes ${fields.join(", ")}: a topology needs sdkProtocol ${TOPOLOGY_SDK_PROTOCOL}`;
}

/** How far a bundle's code may be repaired; grants decide whether it may be at all. */
export type RepairContract = "source-repairable" | "opaque";

/**
 * The manifest's repair contract. A bundle that declares none is opaque:
 * metadata can limit repair but never extends it.
 */
export function manifestRepairContract(manifestRaw: string): RepairContract {
  const declared = (JSON.parse(manifestRaw) as { repairContract?: unknown }).repairContract;
  if (declared === undefined) return "opaque";
  if (declared === "source-repairable" || declared === "opaque") return declared;
  throw new IntakeError(`manifest repairContract must be "source-repairable" or "opaque", got ${JSON.stringify(declared)}`);
}

export interface BundlePin {
  graphId: string;
  version: string;
  bundlePath: string;
  sdkProtocol: number;
  digests: Record<string, unknown>;
  manifestRaw: string;
  manifestDigest: string;
  /** SHA-256 of the resolved createGraph entry module bytes. */
  entryDigest: string;
}

export interface IntakePin {
  taskPath: string;
  taskDir: string;
  task: TaskFile;
  repoPath: string;
  pinnedHead: string;
  bundle: BundlePin;
  /** The task's config, pinned; absent when the task names none. */
  config?: TaskConfigPin;
  grants: RepairGrants;
  /**
   * As intakeTask returns them, provisional: controller defaults under the
   * task's budgets, each value checked. A run's are final once
   * applyGraphDefaultBudgets has added the graph's layer and run the
   * cross-budget checks.
   */
  budgets: {
    agentInvocations: number;
    jobs: number;
    decisions: number;
    corrections: number;
    /** Time the controller may spend waiting out executor retry timing; absent means none. */
    waitMs?: number;
    /** Execution time left while a controller is running the run; absent in runs saved before it existed. */
    activeMs?: number;
    /** Agent invocations reserved for recovery-mode calls; absent in runs saved before it existed. */
    recoveryReserve?: number;
    /** Supervisor dry-run probes left; absent when the task sets none. */
    probes?: number;
  };
  /**
   * The budgets the graph's definition declared (`defaultBudgets`) and intake
   * applied under the task's own; absent when it declared none, and in runs
   * saved before graphs could.
   */
  graphDefaultBudgets?: GraphBudgetDefaults;
  /**
   * The gate in `run` (docs/design-graph-rehearsal.md §3.5): whether this run
   * was checked/rehearsed before it was intaken, and what that found. Absent
   * in runs saved before the gate existed, or whenever a caller runs
   * un-gated (the controller never requires or runs the gate itself).
   */
  rehearsalGate?: {
    fingerprint: string;
    verdict: "ready" | "not-ready" | "inconclusive" | "skipped";
    notes: string[];
  };
}

export { IntakeError };

/** Parse minimal task.yaml (graph / request [, repo] [, grants] [, budgets]); whether `repo` is needed is the bundle's say (`manifestRepository`). */
export function parseTaskYaml(text: string): TaskFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let graph: string | undefined;
  let repo: string | undefined;
  let request: string | undefined;
  let config: string | undefined;
  let base: string | undefined;
  let sourceRepair: boolean | undefined;
  let validatorSubstitution: boolean | undefined;
  let executorRepair: boolean | undefined;
  let hostRepair: boolean | undefined;
  let inGrants = false;
  let inBudgets = false;
  const budgets: Partial<RunBudgets> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || line.trim() === "") {
      continue;
    }

    if (/^grants:\s*$/.test(line)) {
      inGrants = true;
      inBudgets = false;
      continue;
    }
    if (/^budgets:\s*$/.test(line)) {
      inBudgets = true;
      inGrants = false;
      continue;
    }

    if (inBudgets) {
      const indented = /^( {2}|\t)(\w+):\s*(.+?)\s*$/.exec(line);
      if (indented) {
        const key = indented[2]!;
        if (!BUDGET_KEYS.has(key)) throw new IntakeError(`unknown budgets key: ${key}`);
        const raw = unquote(indented[3]!);
        const value = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(value)) throw new IntakeError(`budgets ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
        budgets[key as keyof RunBudgets] = value;
        continue;
      }
      inBudgets = false;
    }

    if (inGrants) {
      const indented = /^( {2}|\t)(\w+):\s*(.+?)\s*$/.exec(line);
      if (indented) {
        const key = indented[2]!;
        const value = parseBoolYaml(unquote(indented[3]!));
        if (key === "sourceRepair") sourceRepair = value;
        else if (key === "validatorSubstitution") validatorSubstitution = value;
        else if (key === "executorRepair") executorRepair = value;
        else if (key === "hostRepair") hostRepair = value;
        else throw new IntakeError(`unknown grants key: ${key}`);
        continue;
      }
      // Non-indented line ends the grants block; fall through to parse it.
      inGrants = false;
    }

    const graphMatch = /^graph:\s*(.+?)\s*$/.exec(line);
    if (graphMatch) {
      graph = unquote(graphMatch[1]!);
      continue;
    }
    const repoMatch = /^repo:\s*(.+?)\s*$/.exec(line);
    if (repoMatch) {
      repo = unquote(repoMatch[1]!);
      continue;
    }
    const baseMatch = /^base:\s*(.+?)\s*$/.exec(line);
    if (baseMatch) {
      base = unquote(baseMatch[1]!);
      continue;
    }
    const configMatch = /^config:\s*(.+?)\s*$/.exec(line);
    if (configMatch) {
      config = unquote(configMatch[1]!);
      continue;
    }

    if (/^request:\s*\|\s*$/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        if (bodyLine.length === 0) {
          body.push("");
          i += 1;
          continue;
        }
        if (/^[^\s]/.test(bodyLine)) {
          i -= 1;
          break;
        }
        body.push(bodyLine.replace(/^ {2}/, "").replace(/^\t/, ""));
        i += 1;
      }
      request = body.join("\n").replace(/\n+$/, "");
      continue;
    }

    const requestInline = /^request:\s*(.+?)\s*$/.exec(line);
    if (requestInline) {
      request = unquote(requestInline[1]!);
    }
  }

  if (!graph || request === undefined || request === "") {
    throw new IntakeError("task.yaml must declare graph and request");
  }
  try {
    assertSafeGraphId(graph);
  } catch (err) {
    throw new IntakeError(err instanceof Error ? err.message : String(err));
  }
  // Key order is the task's wire shape (the managed intake digest hashes it unsorted): graph, repo, request, ...
  // An empty or blank `repo:` names nothing, so it reads as no `repo:` at all, for a graph that
  // needs a repository (refused as "needs a repository") and for one that needs none alike.
  const task: TaskFile = { graph, ...(repo !== undefined && repo.trim() !== "" ? { repo } : {}), request };
  if (sourceRepair !== undefined || validatorSubstitution !== undefined || executorRepair !== undefined || hostRepair !== undefined) {
    task.grants = {
      sourceRepair: sourceRepair ?? false,
      validatorSubstitution: validatorSubstitution ?? false,
      ...(executorRepair !== undefined ? { executorRepair } : {}),
      ...(hostRepair !== undefined ? { hostRepair } : {}),
    };
  }
  if (Object.keys(budgets).length > 0) task.budgets = budgets;
  if (config !== undefined) {
    if (config === "") throw new IntakeError("config must name a JSON file relative to the task file");
    task.config = config;
  }
  if (base !== undefined) {
    if (base === "" || base.startsWith("-") || /\s/.test(base)) {
      throw new IntakeError(`base must name a commit of the repository (a hash, tag or branch), got ${JSON.stringify(base)}`);
    }
    task.base = base;
  }
  return task;
}

function parseBoolYaml(value: string): boolean {
  if (value === "true" || value === "yes" || value === "1") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  throw new IntakeError(`grants value must be boolean, got ${JSON.stringify(value)}`);
}

/** Where a task's run gets its repository: the one `repo:` names, or (mode `none`) a private one the controller makes. */
export type TaskRepository =
  | { mode: "git"; repoPath: string; pinnedHead: string }
  | { mode: "none"; pinnedHead: typeof PRIVATE_REPOSITORY_COMMIT };

/** What intake reads from a task file, its bundle and its repository; nothing is written. */
export interface TaskIntakeRead extends Omit<IntakePin, "repoPath" | "pinnedHead"> {
  repository: TaskRepository;
}

/**
 * The bundle manifest as read once for the whole intake: its bytes (pinned
 * later) and the repository mode they declare. `raw` is undefined when the
 * manifest cannot be read, and the mode is then `required`, so the checks that
 * follow report the problem in their usual order; so it is for bytes that are
 * not a JSON object. An invalid `repository` declaration is refused.
 */
async function readManifestOnce(taskDir: string, graph: string): Promise<{ raw: string | undefined; mode: RepositoryMode }> {
  let raw: string;
  try {
    raw = await readFile(path.join(resolveUnderBase(path.join(taskDir, "plugins"), graph, "graph bundle"), "graphloom.manifest.json"), "utf8");
  } catch {
    return { raw: undefined, mode: "required" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw, mode: "required" };
  }
  if (!isJsonObject(parsed)) return { raw, mode: "required" };
  return { raw, mode: manifestRepository(raw) };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a task: parse it, resolve its repository (or note that the run needs a
 * private one), pin its bundle and config, check its budgets. Writes nothing,
 * so the gate, the hub, rehearsal and `check` use it too.
 */
export async function readTaskIntake(taskPath: string): Promise<TaskIntakeRead> {
  const absoluteTask = path.resolve(taskPath);
  await assertExists(absoluteTask, "file");
  const taskDir = path.dirname(absoluteTask);
  const task = parseTaskYaml(await readFile(absoluteTask, "utf8"));

  // The mode comes from the very bytes pinned below: one read, so a bundle swapped meanwhile cannot give the
  // gate and the hub one mode and the controller another.
  const { raw: manifestRead, mode } = await readManifestOnce(taskDir, task.graph);
  let repoPath: string | undefined;
  if (mode === "none") {
    if (task.repo !== undefined) throw new IntakeError(`graph ${task.graph} works without a repository; remove repo: from the task file`);
    if (task.base !== undefined) throw new IntakeError(`graph ${task.graph} works without a repository, so base: names nothing; remove it`);
  } else {
    if (task.repo === undefined) throw new IntakeError(`graph ${task.graph} needs a repository: name it with repo: in the task file`);
    const named = resolveUnderBase(taskDir, task.repo, "repo");
    await assertExists(named, "directory");
    // `repo` may name any directory inside the repository (e.g. `repo: .` from
    // a task file in a subdirectory); the run works on the whole repository, and
    // a `git clone` of a subdirectory fails, so pin its top level.
    repoPath = await gitTopLevel(named);
  }

  const bundlePath = resolveUnderBase(
    path.join(taskDir, "plugins"),
    task.graph,
    "graph bundle",
  );
  await assertExists(bundlePath, "directory");

  const manifestPath = path.join(bundlePath, "graphloom.manifest.json");
  await assertExists(manifestPath, "file");
  // Unreadable at the first look (so the mode defaulted to required) but present now: the bytes are read again
  // and must still say so.
  const manifestRaw = manifestRead ?? await readFile(manifestPath, "utf8");
  let manifest: {
    graphId?: string;
    version?: string;
    sdkProtocol?: number;
    digests?: Record<string, unknown>;
  };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    throw new IntakeError("manifest is not valid JSON");
  }
  if (!isJsonObject(manifest)) throw new IntakeError("manifest is not valid JSON");
  if (manifestRead === undefined && manifestRepository(manifestRaw) !== mode) throw new IntakeError("the bundle's manifest changed while the task was read; try again");
  if (manifest.graphId !== task.graph) {
    throw new IntakeError(
      `manifest graphId ${JSON.stringify(manifest.graphId)} does not match task graph ${JSON.stringify(task.graph)}`,
    );
  }
  if (typeof manifest.version !== "string" || typeof manifest.sdkProtocol !== "number") {
    throw new IntakeError("manifest missing version or sdkProtocol");
  }
  const protocolProblem = sdkProtocolProblem(manifest.sdkProtocol);
  if (protocolProblem !== undefined) throw new IntakeError(protocolProblem);
  manifestRepairContract(manifestRaw);
  const config = task.config !== undefined ? await pinTaskConfig(taskDir, task.config) : undefined;
  if (manifestRequiresConfig(manifestRaw) && config === undefined) {
    throw new IntakeError(`graph ${task.graph} needs a task config: name a JSON file with config: in the task file`);
  }

  const repository: TaskRepository = repoPath === undefined
    ? { mode: "none", pinnedHead: PRIVATE_REPOSITORY_COMMIT }
    : { mode: "git", repoPath, pinnedHead: task.base !== undefined ? await resolveBaseCommit(repoPath, task.base) : await gitRevParse(repoPath, "HEAD") };
  const entryPath = resolveBundleEntryFromManifest(bundlePath, manifestRaw);
  let entryBytes: Buffer;
  try {
    entryBytes = await readFile(entryPath);
  } catch {
    throw new IntakeError(`missing bundle entry: ${entryPath}`);
  }

  // Provisional: each value is checked here, but the cross-budget checks wait
  // for the graph's defaultBudgets, which only describe() supplies
  // (applyGraphDefaultBudgets).
  const budgets = mergeBudgets(task.budgets);

  return {
    taskPath: absoluteTask,
    taskDir,
    task,
    repository,
    bundle: {
      graphId: manifest.graphId,
      version: manifest.version,
      bundlePath,
      sdkProtocol: manifest.sdkProtocol,
      digests: manifest.digests ?? {},
      manifestRaw,
      manifestDigest: sha256(manifestRaw),
      entryDigest: sha256Bytes(entryBytes),
    },
    ...(config !== undefined ? { config } : {}),
    grants: task.grants ?? { sourceRepair: false, validatorSubstitution: false },
    budgets,
  };
}

/**
 * Intake a task into a run's pin. A graph that works without a repository
 * (`repository: "none"`) needs `privateRepository`, the path the run's private
 * repository will have (`<stateDir>/repository`, made by `createPrivateRepository`
 * once the run is authorized); intake itself writes nothing.
 */
export async function intakeTask(taskPath: string, options: { privateRepository?: string } = {}): Promise<IntakePin> {
  const read = await readTaskIntake(taskPath);
  const { repository } = read;
  if (repository.mode === "none" && options.privateRepository === undefined) {
    throw new IntakeError(`graph ${read.task.graph} works without a repository, so its runs have no default state root; pass --state-root <dir>`);
  }
  const repoPath = repository.mode === "git" ? repository.repoPath : path.resolve(options.privateRepository!);
  // Key order is the saved state's: it is not reshuffled for runs that have a repository.
  return {
    taskPath: read.taskPath,
    taskDir: read.taskDir,
    task: read.task,
    repoPath,
    pinnedHead: repository.pinnedHead,
    bundle: read.bundle,
    ...(read.config !== undefined ? { config: read.config } : {}),
    grants: read.grants,
    budgets: read.budgets,
  };
}

/** Reads, bounds and pins the task config; it must be JSON, but intake reads no field of it. */
async function pinTaskConfig(taskDir: string, relative: string): Promise<TaskConfigPin> {
  const configPath = resolveUnderBase(taskDir, relative, "config");
  let bytes: Buffer;
  try {
    bytes = await readFile(configPath);
  } catch {
    throw new IntakeError(`missing file: ${configPath}`);
  }
  if (bytes.length > MAX_TASK_CONFIG_BYTES) {
    throw new IntakeError(`config ${relative} is ${bytes.length} bytes, more than ${MAX_TASK_CONFIG_BYTES}`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new IntakeError(`config ${relative} is not UTF-8`);
  try {
    JSON.parse(text);
  } catch (err) {
    throw new IntakeError(`config ${relative} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { path: relative, sha256: sha256Bytes(bytes), text };
}

/**
 * The run's pinned task config as the plugin receives it, or undefined when
 * the task names none. Refuses a pin whose text no longer matches its
 * digest, so an edited state file cannot hand the plugin another config.
 */
export function taskConfigValue(intake: Pick<IntakePin, "config">): unknown {
  const pin = intake.config;
  if (pin === undefined) return undefined;
  if (sha256(pin.text) !== pin.sha256) {
    throw new Error(`pinned task config ${pin.path} does not match its digest`);
  }
  return JSON.parse(pin.text) as unknown;
}

/** A manifest's `taskConfig: "required"`: the graph cannot describe itself without a task config. */
export function manifestRequiresConfig(manifestRaw: string): boolean {
  const declared = (JSON.parse(manifestRaw) as { taskConfig?: unknown }).taskConfig;
  if (declared === undefined || declared === "optional") return false;
  if (declared === "required") return true;
  throw new IntakeError(`manifest taskConfig must be "required" or "optional", got ${JSON.stringify(declared)}`);
}

/** Whether a graph's runs need a git repository: `required` (the default) or `none` (a private one, made by the controller). */
export type RepositoryMode = "required" | "none";

/**
 * A manifest's `repository` key, as `taskConfig` is: `"required"` when absent.
 * `"optional"` (a task's own folder, snapshotted) is not built yet and is
 * refused, so no bundle can depend on it before it exists.
 */
export function manifestRepository(manifestRaw: string): RepositoryMode {
  const parsed: unknown = JSON.parse(manifestRaw);
  if (!isJsonObject(parsed)) throw new IntakeError("manifest is not valid JSON");
  const declared = parsed.repository;
  if (declared === undefined || declared === "required") return "required";
  if (declared === "none") return "none";
  throw new IntakeError(`manifest repository must be "required" or "none", got ${JSON.stringify(declared)}`);
}

/**
 * Why a plugin update to the bundle with `installedManifestRaw` is refused
 * because it changes how the run got its repository, or undefined. A run's
 * repository is fixed at intake; the pinned manifest says which kind it has.
 */
export function repositoryModeChange(pinnedManifestRaw: string, installedManifestRaw: string): string | undefined {
  const started = manifestRepository(pinnedManifestRaw);
  const installed = manifestRepository(installedManifestRaw);
  if (started === installed) return undefined;
  return `the installed bundle declares repository ${JSON.stringify(installed)} but this run was started with ${JSON.stringify(started)}; a plugin update cannot change it`;
}

/** Resolve relative path under base; reject traversal and absolute escapes. */
export function resolveUnderBase(baseDir: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) {
    throw new IntakeError(`${label} must be a relative path`);
  }
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.split(path.sep).includes("..")) {
    throw new IntakeError(`${label} path traversal rejected: ${relative}`);
  }
  const resolved = path.resolve(baseDir, normalized);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new IntakeError(`${label} escapes task directory`);
  }
  return resolved;
}

/**
 * A one-line scalar's value as YAML reads it: a double-quoted scalar has its
 * escapes decoded (YAML 1.2 §5.7: `\"`, `\\`, `\n`, `\t`, `\uXXXX`, ...), a
 * single-quoted one has `''` read as `'`, and a plain scalar is taken as is.
 * A quoted scalar YAML would refuse (an unknown escape, a quote left
 * unescaped inside) is refused, never passed on with its backslashes.
 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (inner.replace(/''/g, "").includes("'")) {
      throw new IntakeError(`single-quoted scalar has an unescaped ' (write it as ''): ${value}`);
    }
    return inner.replace(/''/g, "'");
  }
  return value;
}

/** YAML 1.2 §5.7's one-character escapes, by the character after the backslash. */
const YAML_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " ",
};
/** YAML 1.2 §5.7's hex escapes and their digit counts. */
const YAML_HEX_ESCAPES: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

function unescapeDoubleQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === '"') throw new IntakeError(`double-quoted scalar has an unescaped " (write it as \\"): "${inner}"`);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) throw new IntakeError(`double-quoted scalar ends in a lone \\: "${inner}"`);
    const simple = Object.hasOwn(YAML_SIMPLE_ESCAPES, next) ? YAML_SIMPLE_ESCAPES[next] : undefined;
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }
    const width = Object.hasOwn(YAML_HEX_ESCAPES, next) ? YAML_HEX_ESCAPES[next] : undefined;
    const hex = width === undefined ? "" : inner.slice(i + 2, i + 2 + width);
    if (width === undefined || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
      throw new IntakeError(`double-quoted scalar has an invalid escape \\${next}: "${inner}"`);
    }
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff) throw new IntakeError(`double-quoted scalar escapes a code point out of range \\${next}${hex}: "${inner}"`);
    out += String.fromCodePoint(code);
    i += 1 + width;
  }
  return out;
}

async function assertExists(p: string, _kind: "file" | "directory"): Promise<void> {
  try {
    await access(p);
  } catch {
    throw new IntakeError(`missing ${_kind}: ${p}`);
  }
}

async function gitTopLevel(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return stdout.trim();
  } catch {
    throw new IntakeError(`repo is not inside a git repository: ${dir}`);
  }
}

/** The commit `base` names in the repository, verified; never a tree, blob or missing object. */
async function resolveBaseCommit(repoPath: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd: repoPath });
    const commit = stdout.trim();
    if (commit !== "") return commit;
  } catch {
    /* reported below */
  }
  throw new IntakeError(`base ${JSON.stringify(base)} is not a commit in ${repoPath}; fetch it or name another with base:`);
}

async function gitRevParse(repoPath: string, rev: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", rev], { cwd: repoPath });
  return stdout.trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
