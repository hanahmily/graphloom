import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@graphloom/sdk";
import { assertSafeGraphId } from "./ids.js";
import { resolveBundleEntryFromManifest } from "./bundle.js";

const execFileAsync = promisify(execFile);

/** Default time a run may spend waiting out executor retry timing (15 minutes). */
export const DEFAULT_WAIT_BUDGET_MS = 15 * 60_000;

/** Default execution time a run may spend while a controller is running it (4 hours). */
export const DEFAULT_ACTIVE_BUDGET_MS = 4 * 60 * 60_000;

export interface TaskFile {
  graph: string;
  repo: string;
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
}

const BUDGET_KEYS: ReadonlySet<string> = new Set([
  "agentInvocations",
  "jobs",
  "decisions",
  "corrections",
  "waitMs",
  "activeMs",
  "recoveryReserve",
]);

export interface RepairGrants {
  sourceRepair: boolean;
  validatorSubstitution: boolean;
  /** Qualify and activate run-local copies of executor packages. */
  executorRepair?: boolean;
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
  };
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

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

/** Parse minimal task.yaml (graph / repo / request [, grants] [, budgets]). */
export function parseTaskYaml(text: string): TaskFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let graph: string | undefined;
  let repo: string | undefined;
  let request: string | undefined;
  let config: string | undefined;
  let sourceRepair: boolean | undefined;
  let validatorSubstitution: boolean | undefined;
  let executorRepair: boolean | undefined;
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

  if (!graph || !repo || request === undefined || request === "") {
    throw new IntakeError("task.yaml must declare graph, repo, and request");
  }
  try {
    assertSafeGraphId(graph);
  } catch (err) {
    throw new IntakeError(err instanceof Error ? err.message : String(err));
  }
  const task: TaskFile = { graph, repo, request };
  if (sourceRepair !== undefined || validatorSubstitution !== undefined || executorRepair !== undefined) {
    task.grants = {
      sourceRepair: sourceRepair ?? false,
      validatorSubstitution: validatorSubstitution ?? false,
      ...(executorRepair !== undefined ? { executorRepair } : {}),
    };
  }
  if (Object.keys(budgets).length > 0) task.budgets = budgets;
  if (config !== undefined) {
    if (config === "") throw new IntakeError("config must name a JSON file relative to the task file");
    task.config = config;
  }
  return task;
}

function parseBoolYaml(value: string): boolean {
  if (value === "true" || value === "yes" || value === "1") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  throw new IntakeError(`grants value must be boolean, got ${JSON.stringify(value)}`);
}

export async function intakeTask(taskPath: string): Promise<IntakePin> {
  const absoluteTask = path.resolve(taskPath);
  await assertExists(absoluteTask, "file");
  const taskDir = path.dirname(absoluteTask);
  const task = parseTaskYaml(await readFile(absoluteTask, "utf8"));

  const repoPath = resolveUnderBase(taskDir, task.repo, "repo");
  await assertExists(repoPath, "directory");

  const bundlePath = resolveUnderBase(
    path.join(taskDir, "plugins"),
    task.graph,
    "graph bundle",
  );
  await assertExists(bundlePath, "directory");

  const manifestPath = path.join(bundlePath, "graphloom.manifest.json");
  await assertExists(manifestPath, "file");
  const manifestRaw = await readFile(manifestPath, "utf8");
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
  if (manifest.graphId !== task.graph) {
    throw new IntakeError(
      `manifest graphId ${JSON.stringify(manifest.graphId)} does not match task graph ${JSON.stringify(task.graph)}`,
    );
  }
  if (typeof manifest.version !== "string" || typeof manifest.sdkProtocol !== "number") {
    throw new IntakeError("manifest missing version or sdkProtocol");
  }
  if (manifest.sdkProtocol !== PROTOCOL_VERSION) {
    throw new IntakeError(
      `manifest sdkProtocol ${manifest.sdkProtocol} != host ${PROTOCOL_VERSION}`,
    );
  }
  manifestRepairContract(manifestRaw);
  const config = task.config !== undefined ? await pinTaskConfig(taskDir, task.config) : undefined;
  if (manifestRequiresConfig(manifestRaw) && config === undefined) {
    throw new IntakeError(`graph ${task.graph} needs a task config: name a JSON file with config: in the task file`);
  }

  const pinnedHead = await gitRevParse(repoPath, "HEAD");
  const entryPath = resolveBundleEntryFromManifest(bundlePath, manifestRaw);
  let entryBytes: Buffer;
  try {
    entryBytes = await readFile(entryPath);
  } catch {
    throw new IntakeError(`missing bundle entry: ${entryPath}`);
  }

  const agentInvocations = task.budgets?.agentInvocations ?? 64;
  const budgets = {
    agentInvocations,
    jobs: 128,
    decisions: 512,
    corrections: 8,
    waitMs: DEFAULT_WAIT_BUDGET_MS,
    activeMs: DEFAULT_ACTIVE_BUDGET_MS,
    recoveryReserve: Math.max(8, Math.ceil(agentInvocations * 0.05)),
    ...task.budgets,
  };
  // A reserve that is not strictly smaller than the total leaves no room for
  // even one normal-mode agent call: children.ts's own floor (0 in recovery,
  // this reserve otherwise) would then refuse the run's very first dispatch.
  // Unreachable from the 5%-with-an-8-floor default alone once agentInvocations
  // is large enough, but task.yaml's own explicit budgets (either number) are
  // not bound by that formula, so this is checked after merging both.
  if (budgets.recoveryReserve >= budgets.agentInvocations) {
    throw new IntakeError(
      `budgets.recoveryReserve (${budgets.recoveryReserve}) must be less than budgets.agentInvocations (${budgets.agentInvocations}), leaving room for at least one normal-mode agent call`,
    );
  }

  return {
    taskPath: absoluteTask,
    taskDir,
    task,
    repoPath,
    pinnedHead,
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

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function assertExists(p: string, _kind: "file" | "directory"): Promise<void> {
  try {
    await access(p);
  } catch {
    throw new IntakeError(`missing ${_kind}: ${p}`);
  }
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
