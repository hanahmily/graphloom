// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  IntakeError,
  MAX_TASK_CONFIG_BYTES,
  parseTaskYaml,
  resolveBundleEntryFromManifest,
  resolveUnderBase,
} from "@graphloom/controller";
import { createChildPluginHost } from "@graphloom/plugin-host";
import {
  PROTOCOL_VERSION,
  isTaskPlanRefusal,
  refFormatProblem,
  substitutePlan,
  taskPlanNamespace,
  validateTaskPlan,
  TaskPlanError,
  type PrepareTaskInput,
  type TaskPlanStep,
} from "@graphloom/sdk";

const execFileAsync = promisify(execFile);

export const TASK_NEW_USAGE =
  "graphloom task new <graph> <args...> [--repo <dir>] [--profile <name|path>] [--out <dir>] [--dry-run] [--force]";

const ZERO_OID = "0".repeat(40);
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

/** Every git command of a plan: hooks, the user's and the system's configuration and prompts are off (docs/design-typescript-core.md section 16). */
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
  "-c", "core.sshCommand=/bin/false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
];

export interface TaskNewOptions {
  graph: string;
  /** The plugin's own arguments, verbatim. */
  args: string[];
  repo?: string;
  profile?: string;
  out?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Environment for the git commands and the plugin host. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Wall clock for the plugin hook (ms). */
  hookTimeoutMs?: number;
}

/** A failure of a plan step (exit 1), as opposed to a refusal (exit 2). */
class StepFailed extends Error {}
/** A usage error, a refusal or an invalid plan (exit 2). */
class Refused extends Error {}

/** The CLI's own flags; everything else after `<graph>` is the plugin's. */
export function parseTaskNewArgs(argv: string[]): { options: Omit<TaskNewOptions, "env" | "cwd" | "hookTimeoutMs">; error?: string } {
  const [graph, ...rest] = argv;
  const options: TaskNewOptions = { graph: graph ?? "", args: [] };
  if (graph === undefined || graph.startsWith("-")) return { options, error: "task new needs a graph id" };
  const valued = new Set(["--repo", "--profile", "--out"]);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === "--") {
      options.args.push(...rest.slice(i + 1));
      break;
    }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (valued.has(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : rest[(i += 1)];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) return { options, error: `${name} needs a value` };
      if (name === "--repo") options.repo = value;
      else if (name === "--profile") options.profile = value;
      else options.out = value;
    } else if (token === "--dry-run") {
      options.dryRun = true;
    } else if (token === "--force") {
      options.force = true;
    } else {
      options.args.push(token);
    }
  }
  return { options };
}

/** `graphloom task new`: prepare a task with the graph's own hook. Exits 0 written (or printed), 1 a step failed, 2 a usage error, a refusal or an invalid plan. */
export async function taskNew(options: TaskNewOptions, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  try {
    await run(options, out);
    return 0;
  } catch (e) {
    if (e instanceof StepFailed) {
      err(`graphloom task new: ${e.message}`);
      return 1;
    }
    if (e instanceof Refused || e instanceof TaskPlanError || e instanceof IntakeError) {
      err(`graphloom task new: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/bin/true";
  return env;
}

async function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...SAFE_GIT_CONFIG, ...args], { cwd, env: gitEnv(env), maxBuffer: GIT_OUTPUT_LIMIT, encoding: "utf8" });
    return stdout;
  } catch (e) {
    const failure = e as { stderr?: string; message: string };
    const rest = [...args];
    while (rest[0] === "-c") rest.splice(0, 2);
    throw new StepFailed(`git ${rest[0] ?? ""} failed: ${(failure.stderr ?? failure.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(() => true, () => false);
}

/** `p` under `root` once links are followed; a path that does not exist yet is judged by its nearest existing parent. */
async function realUnder(root: string, p: string): Promise<boolean> {
  let probe = p;
  while (!(await exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const [r, real] = await Promise.all([realpath(root), realpath(probe)]);
  return real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

interface Loaded {
  bundle: string;
  manifestRaw: string;
  version: string;
  entry: string;
  requiresConfig: boolean;
}

async function loadBundle(out: string, graph: string): Promise<Loaded> {
  const bundle = resolveUnderBase(path.join(out, "plugins"), graph, "graph bundle");
  const manifestRaw = await readFile(path.join(bundle, "graphloom.manifest.json"), "utf8").catch(() => {
    throw new Refused(`no graph bundle ${graph}: ${path.join(bundle, "graphloom.manifest.json")} was not found (the bundle is plugins/${graph}/ in --out ${out})`);
  });
  let manifest: { graphId?: unknown; version?: unknown; sdkProtocol?: unknown; taskConfig?: unknown };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    throw new Refused("the bundle's manifest is not valid JSON");
  }
  if (manifest.graphId !== graph) throw new Refused(`manifest graphId ${JSON.stringify(manifest.graphId)} does not match graph ${JSON.stringify(graph)}`);
  if (typeof manifest.version !== "string") throw new Refused("manifest has no version");
  if (manifest.sdkProtocol !== PROTOCOL_VERSION) throw new Refused(`manifest sdkProtocol ${String(manifest.sdkProtocol)} != host ${PROTOCOL_VERSION}`);
  return {
    bundle,
    manifestRaw,
    version: manifest.version,
    entry: resolveBundleEntryFromManifest(bundle, manifestRaw),
    requiresConfig: manifest.taskConfig === "required",
  };
}

/** `--profile`: a path (contains `/` or ends in `.json`) from the current directory, otherwise a name looked up in `--out` and then in the bundle. */
async function resolveProfile(value: string, cwd: string, out: string, bundle: string): Promise<string> {
  if (value.includes("/") || value.endsWith(".json")) {
    const file = path.resolve(cwd, value);
    if (!(await exists(file))) throw new Refused(`profile ${value} was not found`);
    return file;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Refused(`profile name ${JSON.stringify(value)} is not a plain name`);
  const tried = [path.join(out, "profiles", `${value}.json`), path.join(bundle, "profiles", `${value}.json`)];
  for (const file of tried) if (await exists(file)) return file;
  throw new Refused(`profile ${value} was not found (looked in ${tried.join(" and ")})`);
}

async function readProfile(file: string): Promise<unknown> {
  const bytes = await readFile(file);
  if (bytes.length > MAX_TASK_CONFIG_BYTES) throw new Refused(`profile ${file} is ${bytes.length} bytes, more than ${MAX_TASK_CONFIG_BYTES}`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (e) {
    throw new Refused(`profile ${file} is not valid JSON: ${(e as Error).message}`);
  }
}

async function repoInput(repoDir: string, env: NodeJS.ProcessEnv): Promise<{ top: string; remotes: Array<{ name: string; url: string }>; head: string }> {
  let top: string;
  try {
    top = (await git(repoDir, env, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Refused(`--repo ${repoDir} is not inside a git repository`);
  }
  const remotes: Array<{ name: string; url: string }> = [];
  for (const line of (await git(top, env, ["remote", "-v"])).split("\n")) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    if (m !== null) remotes.push({ name: m[1]!, url: m[2]! });
  }
  const head = (await git(top, env, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "")).trim();
  return { top, remotes, head };
}

/** A new `task.yaml`'s text: `graph`, `repo` and `config` from the CLI, then the plan's fields. */
export function composeTask(graph: string, repo: string, config: string | undefined, fields: Record<string, string>): string {
  const lines = [`graph: ${graph}`, `repo: ${repo}`];
  if (config !== undefined) lines.push(`config: ${config}`);
  const ordered = Object.keys(fields).sort((a, b) => (a === "request" ? 1 : b === "request" ? -1 : a.localeCompare(b)));
  for (const key of ordered) {
    const value = fields[key]!;
    if (key === "request" && (/["\\\n\r]/.test(value) || value !== value.trim())) {
      lines.push("request: |", ...value.replace(/\r\n/g, "\n").split("\n").map((l) => (l === "" ? "" : `  ${l}`)));
    } else if (key === "request") {
      lines.push(`request: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  const text = `${lines.join("\n")}\n`;
  // What intake will read must be what the plan said.
  const parsed = parseTaskYaml(text) as unknown as Record<string, string>;
  for (const [key, value] of Object.entries({ graph, repo, ...(config !== undefined ? { config } : {}), ...fields })) {
    if (parsed[key] !== value.replace(/\r\n/g, "\n").replace(/\n+$/, "")) throw new Refused(`the task's ${key} cannot be written so that intake reads it back unchanged`);
  }
  return text;
}

async function run(options: TaskNewOptions, out: (line: string) => void): Promise<void> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const outDir = path.resolve(cwd, options.out ?? ".");
  const graph = options.graph;
  const loaded = await loadBundle(outDir, graph);

  let profileFile: string | undefined;
  let profile: unknown;
  if (options.profile !== undefined) {
    profileFile = await resolveProfile(options.profile, cwd, outDir, loaded.bundle);
    profile = await readProfile(profileFile);
  } else if (loaded.requiresConfig) {
    throw new Refused(`graph ${graph} needs a task config: name one with --profile <name|path>`);
  }

  const repo = await repoInput(path.resolve(cwd, options.repo ?? "."), env);
  if (repo.head === "") throw new Refused(`the repository ${repo.top} has no commit`);
  const input: PrepareTaskInput = {
    args: options.args,
    repo: { remotes: repo.remotes, head: repo.head },
    ...(profile !== undefined ? { profile } : {}),
    options: { dryRun: options.dryRun === true },
  };

  const reply = await callHook(loaded, graph, input, env, options.hookTimeoutMs);
  if (reply === undefined) throw new Refused(`graph ${graph} does not prepare tasks; write task.yaml by hand`);
  if (isTaskPlanRefusal(reply)) throw new Refused(reply.refused);
  const plan = validateTaskPlan(reply, graph);

  const writeStep = plan.steps.at(-1) as Extract<TaskPlanStep, { kind: "writeTask" }>;
  const taskPath = resolveUnderBase(outDir, writeStep.path, "task path");
  if (!(await realUnder(outDir, path.dirname(taskPath)))) throw new Refused(`task path ${writeStep.path} leaves --out through a symbolic link`);
  const existing = await lstat(taskPath).catch(() => undefined);
  if (existing !== undefined && !existing.isFile()) throw new Refused(`${taskPath} exists and is not a regular file`);
  if (existing !== undefined && options.force !== true) throw new Refused(`${taskPath} already exists; --force replaces it`);

  // Intake refuses a path that leaves the task's directory, so whatever the task names from outside it
  // (the clone, a profile elsewhere, the bundle) is reached through a relative link beside the task.
  const taskDir = path.dirname(taskPath);
  const links: Link[] = [];
  const repoField = await place(taskDir, await realpath(repo.top), "repo", links);
  const configField = profileFile !== undefined ? await place(taskDir, await realpath(profileFile), "profile.json", links) : undefined;
  if (path.resolve(taskDir) !== path.resolve(outDir)) links.push({ path: path.join(taskDir, "plugins", graph), target: await realpath(loaded.bundle) });
  await checkLinks(links, options.force === true);

  out(`plan: ${plan.summary}`);
  if (options.dryRun === true) {
    plan.steps.forEach((step, i) => out(`step ${i + 1}: ${describeStep(step)}`));
    out(`would write ${taskPath}:`);
    out(composeTaskPreview(graph, repoField, configField, writeStep.fields).trimEnd());
    return;
  }

  // Everything is refused up front; from here only a git step can fail.
  const values = new Map<string, string>();
  for (const [i, step] of plan.steps.entries()) {
    if (step.kind === "writeTask") break;
    try {
      out(`step ${i + 1}: ${await execute(step, graph, repo, values, env)}`);
    } catch (e) {
      if (e instanceof StepFailed) throw new StepFailed(`step ${i + 1} (${step.kind}) failed, nothing was written: ${e.message}`);
      throw e;
    }
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(writeStep.fields)) fields[k] = substitutePlan(v, values);
  const text = composeTask(graph, repoField, configField, fields);
  await mkdir(taskDir, { recursive: true });
  for (const line of await applyLinks(links, options.force === true)) out(line);
  await writeTaskFile(taskPath, text, options.force === true);
  out(`step ${plan.steps.length}: wrote ${taskPath}`);
  out(`next: graphloom check ${path.relative(cwd, taskPath) || taskPath}`);
}

async function callHook(loaded: Loaded, graph: string, input: PrepareTaskInput, env: NodeJS.ProcessEnv, timeoutMs: number | undefined): Promise<unknown> {
  const host = await createChildPluginHost({
    entryModule: loaded.entry,
    activeVersion: `${graph}@${loaded.version}`,
    generation: 1,
    cwd: loaded.bundle,
    callbackTimeoutMs: timeoutMs ?? 20_000,
    env,
  }).catch((e: unknown) => {
    throw new Refused(`the graph's plugin did not start: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    const result = await host.prepareTask!({ runId: "task-new", operationId: `op-${randomUUID().slice(0, 8)}`, expectedStateRevision: 0 }, input);
    if (!result.ok) throw new Refused(`the graph's prepareTask failed (${result.observation.code}): ${result.observation.message}`);
    return result.value;
  } finally {
    await host.close();
  }
}

function describeStep(step: TaskPlanStep): string {
  switch (step.kind) {
    case "fetch":
      return `fetch ${step.refspec} from ${step.remote} into ${step.intoRef}`;
    case "resolve":
      return "revParse" in step ? `resolve ${step.name} = ${step.revParse}` : `resolve ${step.name} = merge base of ${step.mergeBase[0]} and ${step.mergeBase[1]}`;
    case "updateRef":
      return `pin ${step.to} at ${step.from}`;
    case "writeTask":
      return `write ${step.path}`;
  }
}

function composeTaskPreview(graph: string, repo: string, config: string | undefined, fields: Record<string, string>): string {
  const lines = [`graph: ${graph}`, `repo: ${repo}`];
  if (config !== undefined) lines.push(`config: ${config}`);
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${JSON.stringify(v)}`);
  return `${lines.join("\n")}\n`;
}

/** Execute one non-write step. Returns the line to print. */
async function execute(step: TaskPlanStep, graph: string, repo: { top: string; remotes: Array<{ name: string; url: string }> }, values: Map<string, string>, env: NodeJS.ProcessEnv): Promise<string> {
  const namespace = taskPlanNamespace(graph);
  const sub = (text: string): string => substitutePlan(text, values);
  const checkRef = async (ref: string): Promise<void> => {
    if (!ref.startsWith(namespace) || refFormatProblem(ref) !== undefined) throw new Refused(`ref ${ref} is outside ${namespace}`);
    await git(repo.top, env, ["check-ref-format", ref]).catch(() => {
      throw new Refused(`ref ${ref} is not a valid ref name`);
    });
  };
  switch (step.kind) {
    case "fetch": {
      const remote = await httpsRemote(step.remote, repo.remotes);
      const into = sub(step.intoRef);
      await checkRef(into);
      await git(repo.top, env, [
        "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always",
        // An empty --refmap: a configured remote's own fetch mapping must not also write refs/remotes/<name>/*.
        "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--",
        remote, `+${step.refspec}:${into}`,
      ]);
      return `fetched ${step.refspec} into ${into}`;
    }
    case "resolve": {
      if ("revParse" in step) {
        const ref = sub(step.revParse);
        const oid = (await git(repo.top, env, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
        values.set(step.name, oid);
        return `${step.name} = ${oid}`;
      }
      const [a, b] = [sub(step.mergeBase[0]), sub(step.mergeBase[1])];
      const bases = (await git(repo.top, env, ["merge-base", "--all", "--", a, b])).trim().split("\n").filter((l) => l !== "");
      if (bases.length !== 1) throw new StepFailed(`${a} and ${b} have ${bases.length} merge bases; expected exactly one`);
      values.set(step.name, bases[0]!);
      return `${step.name} = ${bases[0]!}`;
    }
    case "updateRef": {
      const to = sub(step.to);
      await checkRef(to);
      const from = sub(step.from);
      const oid = /^[0-9a-f]{40}$/.test(from) ? from : (await git(repo.top, env, ["rev-parse", "--verify", "--end-of-options", `${from}^{commit}`])).trim();
      const current = (await git(repo.top, env, ["rev-parse", "--verify", "--quiet", "--end-of-options", to]).catch(() => "")).trim();
      if (current === oid) return `${to} already at ${oid}`;
      if (current !== "") throw new StepFailed(`pinned ref moved: ${to} is at ${current}, not ${oid}`);
      await git(repo.top, env, ["update-ref", "--no-deref", to, oid, ZERO_OID]);
      return `${to} -> ${oid}`;
    }
    case "writeTask":
      return "";
  }
}

/** A remote is a configured one whose fetch URL is https://, or an https:// URL without user information. */
async function httpsRemote(remote: string, remotes: Array<{ name: string; url: string }>): Promise<string> {
  if (remote.includes("://")) return remote;
  const found = remotes.find((r) => r.name === remote);
  if (found === undefined) throw new Refused(`remote ${remote} is not configured in the repository`);
  let url: URL;
  try {
    url = new URL(found.url);
  } catch {
    throw new Refused(`remote ${remote}'s fetch URL ${found.url} must be https:// without user information`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Refused(`remote ${remote}'s fetch URL ${found.url} must be https:// without user information`);
  }
  return remote;
}

/** Write to a temporary sibling renamed into place; without `force` an existing task is never replaced. */
async function writeTaskFile(taskPath: string, text: string, force: boolean): Promise<void> {
  await mkdir(path.dirname(taskPath), { recursive: true });
  const tmp = `${taskPath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, { flag: "wx" });
  try {
    if (force) {
      await rename(tmp, taskPath);
    } else {
      await link(tmp, taskPath).catch((e: NodeJS.ErrnoException) => {
        throw e.code === "EEXIST" ? new Refused(`${taskPath} already exists; --force replaces it`) : e;
      });
      await rm(tmp, { force: true });
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/** A relative symbolic link beside the task, to a path the task names from outside its directory. */
interface Link {
  path: string;
  /** Absolute, real. */
  target: string;
}

/** What the task file says for `real`: a path inside the task's directory as it is, otherwise a link named `linkName` there. */
async function place(taskDir: string, real: string, linkName: string, links: Link[]): Promise<string> {
  const rel = path.relative(taskDir, real);
  if (rel === "") return ".";
  if (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)) return rel;
  links.push({ path: path.join(taskDir, linkName), target: real });
  return linkName;
}

/** A link already in place for the same target is left; any other file there is replaced only with `--force`. */
async function linkConflict(link: Link, force: boolean): Promise<"same" | "replace" | "new"> {
  const current = await lstat(link.path).catch(() => undefined);
  if (current === undefined) return "new";
  if ((await realpath(link.path).catch(() => undefined)) === link.target) return "same";
  if (!force) throw new Refused(`${link.path} already exists and is not ${link.target}; --force replaces it`);
  return "replace";
}

async function checkLinks(links: Link[], force: boolean): Promise<void> {
  for (const link of links) await linkConflict(link, force);
}

async function applyLinks(links: Link[], force: boolean): Promise<string[]> {
  const lines: string[] = [];
  for (const link of links) {
    const state = await linkConflict(link, force);
    if (state === "same") continue;
    if (state === "replace") await rm(link.path, { recursive: true, force: true });
    await mkdir(path.dirname(link.path), { recursive: true });
    const rel = path.relative(path.dirname(link.path), link.target);
    await symlink(rel, link.path);
    lines.push(`linked ${link.path} -> ${rel}`);
  }
  return lines;
}
