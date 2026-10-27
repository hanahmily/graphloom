// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom skills list|install|update|remove` (docs/design-agent-skills.md
 * §3): copies of the bundled agent skills (`<root>/skills/<name>/SKILL.md`)
 * in the skill directories of Claude Code, Codex and opencode. Each copy carries a
 * marker with the version and a digest of its files, so a refresh replaces
 * only copies GraphLoom installed and the user has not edited, and never
 * touches a directory GraphLoom did not write.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installRoot, versionInfo } from "./version.js";

export const SKILL_MARKER = ".graphloom-skill.json";
export const SKILL_AGENTS = ["claude-code", "codex", "opencode"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];
export const SKILL_AGENT_LABEL: Record<SkillAgent, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "opencode" };

export interface SkillTarget {
  agent: SkillAgent | "dir";
  dir: string;
  /** Whether the agent is found on this machine: its CLI or its home directory. */
  found: boolean;
}

export interface BundledSkill {
  name: string;
  dir: string;
  digest: string;
}

export type SkillState =
  /** The copy's files equal this version's bundle. */
  | "current"
  /** Unedited, from another version. */
  | "outdated"
  /** Its files differ from its marker's digest: the user changed it. */
  | "edited"
  /** A directory of that name GraphLoom did not write. */
  | "foreign"
  | "missing"
  /** A GraphLoom copy of a skill this version no longer ships. */
  | "retired";

export interface SkillMarker {
  product: "graphloom";
  skill: string;
  version: string;
  digest: string;
  installedAt: string;
}

export interface SkillCopy {
  name: string;
  state: SkillState;
  path: string;
  installedVersion?: string;
}

export interface TargetStatus extends SkillTarget {
  skills: SkillCopy[];
}

/**
 * GraphLoom copies in a shared directory an agent also reads besides its own
 * skill directory, duplicating copies of the same names there.
 */
export interface SharedSkillDuplicate {
  /** The shared directory (`~/.agents/skills`, or `~/.claude/skills` for opencode). */
  dir: string;
  /** The agent that reads both. */
  agent: SkillAgent;
  /** That agent's own skill directory. */
  ownDir: string;
  /** Skill names with a GraphLoom copy in both. */
  skills: string[];
}

export interface SkillsStatus {
  version: string;
  source: string;
  bundled: string[];
  targets: TargetStatus[];
  /** GraphLoom copies an agent would load twice (absent with `--dir`). */
  duplicates?: SharedSkillDuplicate[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const home = (env: NodeJS.ProcessEnv): string => env.HOME ?? os.homedir();
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Where the bundled skills live in an installation (a release tree or a clone). */
export function bundledSkillsDir(root: string = installRoot()): string {
  return path.join(root, "skills");
}

/** Files under `dir`, relative, sorted bytewise as `LC_ALL=C sort` sorts them; the marker is left out. */
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (sub === SKILL_MARKER) continue;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, sub)));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(sub);
  }
  return rel === "" ? out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) : out;
}

/**
 * The SHA-256 of the `sha256sum`-style listing of `dir`'s files (`<sha256>  <path>`
 * lines, sorted), the marker excluded: in sh,
 * `find . -type f ! -name .graphloom-skill.json | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done | sha256sum`.
 */
export async function skillDigest(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const rel of await listFiles(dir)) lines.push(`${sha256(await readFile(path.join(dir, rel)))}  ${rel}\n`);
  return sha256(lines.join(""));
}

export async function bundledSkills(root: string = installRoot()): Promise<BundledSkill[]> {
  const base = bundledSkillsDir(root);
  if (!existsSync(base)) return [];
  const out: BundledSkill[] = [];
  for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !existsSync(path.join(base, entry.name, "SKILL.md"))) continue;
    const dir = path.join(base, entry.name);
    out.push({ name: entry.name, dir, digest: await skillDigest(dir) });
  }
  return out;
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(":").some((d) => d !== "" && isFile(path.join(d, name)));
}

/** opencode's global config directory: `$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode` (`opencode debug paths`). */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home(env), ".config"), "opencode");
}

/** Where opencode's installer puts its binary when it is not on `PATH`. */
export const opencodeDefaultBin = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), ".opencode", "bin", "opencode");

/** The skill directory an agent reads personal skills from. */
export function agentSkillsDir(agent: SkillAgent, env: NodeJS.ProcessEnv = process.env): string {
  if (agent === "claude-code") {
    if (env.GRAPHLOOM_CLAUDE_SKILLS_DIR) return path.resolve(env.GRAPHLOOM_CLAUDE_SKILLS_DIR);
    return path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home(env), ".claude"), "skills");
  }
  if (agent === "opencode") {
    if (env.GRAPHLOOM_OPENCODE_SKILLS_DIR) return path.resolve(env.GRAPHLOOM_OPENCODE_SKILLS_DIR);
    return path.join(opencodeConfigDir(env), "skills");
  }
  if (env.GRAPHLOOM_CODEX_SKILLS_DIR) return path.resolve(env.GRAPHLOOM_CODEX_SKILLS_DIR);
  return path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home(env), ".codex"), "skills");
}

/** opencode's boolean flags (`OPENCODE_DISABLE_*`) as it parses them. */
const flagOn = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes|on|y)$/i.test(value.trim());

/**
 * Shared directories an agent reads skills from besides its own: Codex and
 * opencode read `~/.agents/skills`; opencode also reads `~/.claude/skills`
 * (literally under HOME, whatever `CLAUDE_CONFIG_DIR` says) unless
 * `OPENCODE_DISABLE_EXTERNAL_SKILLS` or `OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS)` is set.
 */
export function sharedSkillDirs(agent: SkillAgent, env: NodeJS.ProcessEnv = process.env): string[] {
  const agentsDir = path.join(home(env), ".agents", "skills");
  if (agent === "codex") return [agentsDir];
  if (agent !== "opencode" || flagOn(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) return [];
  const claudeOff = flagOn(env.OPENCODE_DISABLE_CLAUDE_CODE) || flagOn(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS);
  return [...(claudeOff ? [] : [path.join(home(env), ".claude", "skills")]), agentsDir];
}

/** Whether the agent is on this machine: its CLI (as GraphLoom finds it) or its home directory. */
export function agentFound(agent: SkillAgent, env: NodeJS.ProcessEnv = process.env): boolean {
  if (agent === "claude-code") {
    return Boolean(env.GRAPHLOOM_CLAUDE_BIN) || onPath("claude", env) || existsSync(env.CLAUDE_CONFIG_DIR || path.join(home(env), ".claude"));
  }
  if (agent === "opencode") return onPath("opencode", env) || isFile(opencodeDefaultBin(env)) || existsSync(opencodeConfigDir(env));
  return Boolean(env.GRAPHLOOM_CODEX_BIN) || onPath("codex", env) || existsSync(env.CODEX_HOME || path.join(home(env), ".codex"));
}

export interface TargetOptions {
  agents?: readonly SkillAgent[];
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export function parseSkillAgent(value: string | undefined): SkillAgent {
  if ((SKILL_AGENTS as readonly string[]).includes(value ?? "")) return value as SkillAgent;
  throw new Error(`--agent must be claude-code, codex or opencode, not ${JSON.stringify(value)}`);
}

/** The directories a command acts on: `--dir`, else the named agents, else every agent. */
export function skillTargets(options: TargetOptions = {}): SkillTarget[] {
  const env = options.env ?? process.env;
  if (options.dir !== undefined) return [{ agent: "dir", dir: path.resolve(options.dir), found: true }];
  const agents = options.agents !== undefined && options.agents.length > 0 ? options.agents : SKILL_AGENTS;
  return agents.map((agent) => ({ agent, dir: agentSkillsDir(agent, env), found: agentFound(agent, env) }));
}

async function readMarker(dir: string): Promise<SkillMarker | undefined> {
  const raw = await readFile(path.join(dir, SKILL_MARKER), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const m = JSON.parse(raw) as unknown;
    if (isRecord(m) && m.product === "graphloom" && typeof m.skill === "string" && typeof m.digest === "string" && typeof m.version === "string") return m as unknown as SkillMarker;
  } catch {
    // not ours
  }
  return undefined;
}

async function copyState(dir: string, bundled: BundledSkill | undefined): Promise<{ state: SkillState; marker?: SkillMarker }> {
  if (!existsSync(dir)) return { state: "missing" };
  const marker = await readMarker(dir);
  if (marker === undefined) return { state: "foreign" };
  const digest = await skillDigest(dir);
  if (digest !== marker.digest) return { state: "edited", marker };
  if (bundled === undefined) return { state: "retired", marker };
  return { state: digest === bundled.digest ? "current" : "outdated", marker };
}

/** Each bundled skill's copy in `target`, then GraphLoom copies of skills no longer bundled. */
export async function targetStatus(target: SkillTarget, bundle: readonly BundledSkill[]): Promise<TargetStatus> {
  const skills: SkillCopy[] = [];
  for (const b of bundle) {
    const p = path.join(target.dir, b.name);
    const { state, marker } = await copyState(p, b);
    skills.push({ name: b.name, state, path: p, ...(marker !== undefined ? { installedVersion: marker.version } : {}) });
  }
  const names = new Set(bundle.map((b) => b.name));
  const entries = existsSync(target.dir) ? await readdir(target.dir, { withFileTypes: true }).catch(() => []) : [];
  for (const e of entries) {
    if (!e.isDirectory() || names.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(target.dir, e.name);
    const marker = await readMarker(p);
    if (marker === undefined) continue;
    const { state } = await copyState(p, undefined);
    skills.push({ name: e.name, state, path: p, installedVersion: marker.version });
  }
  return { ...target, skills };
}

/** Names of the directories under `dir` that hold a GraphLoom marker. */
async function markedCopies(dir: string): Promise<string[]> {
  const entries = existsSync(dir) ? await readdir(dir, { withFileTypes: true }).catch(() => []) : [];
  const out: string[] = [];
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && (await readMarker(path.join(dir, e.name))) !== undefined) out.push(e.name);
  return out.sort();
}

/**
 * GraphLoom copies each agent would load twice: from a shared directory it
 * also reads and from its own skill directory. A shared directory that is
 * some agent's own target (`~/.claude/skills` for Claude Code) holds that
 * agent's copies and is not reported.
 */
export async function sharedDuplicates(env: NodeJS.ProcessEnv = process.env, agents: readonly SkillAgent[] = SKILL_AGENTS): Promise<SharedSkillDuplicate[]> {
  const own = new Set(SKILL_AGENTS.map((a) => agentSkillsDir(a, env)));
  const out: SharedSkillDuplicate[] = [];
  for (const agent of agents) {
    const ownDir = agentSkillsDir(agent, env);
    const shared = sharedSkillDirs(agent, env).filter((d) => !own.has(d));
    if (shared.length === 0) continue;
    const mine = new Set(await markedCopies(ownDir));
    if (mine.size === 0) continue;
    for (const dir of shared) {
      const skills = (await markedCopies(dir)).filter((n) => mine.has(n));
      if (skills.length > 0) out.push({ dir, agent, ownDir, skills });
    }
  }
  return out;
}

export async function skillsStatus(options: TargetOptions & { root?: string } = {}): Promise<SkillsStatus> {
  const root = options.root ?? installRoot();
  const env = options.env ?? process.env;
  const bundle = await bundledSkills(root);
  const targets = await Promise.all(skillTargets(options).map((t) => targetStatus(t, bundle)));
  const agents = targets.flatMap((t) => (t.agent === "dir" ? [] : [t.agent]));
  const duplicates = options.dir === undefined ? await sharedDuplicates(env, agents) : undefined;
  return { version: versionInfo(root).version, source: bundledSkillsDir(root), bundled: bundle.map((b) => b.name), targets, ...(duplicates !== undefined ? { duplicates } : {}) };
}

/** Writes `skill` into `target/<name>` through a temporary sibling renamed into place. */
async function writeCopy(targetDir: string, skill: BundledSkill, version: string, now: Date): Promise<void> {
  await mkdir(targetDir, { recursive: true, mode: 0o755 });
  const dest = path.join(targetDir, skill.name);
  const tmp = path.join(targetDir, `.${skill.name}.graphloom-${randomBytes(4).toString("hex")}`);
  try {
    for (const rel of await listFiles(skill.dir)) {
      await mkdir(path.dirname(path.join(tmp, rel)), { recursive: true, mode: 0o755 });
      // Never the release tree's read-only modes: the user may edit (and remove) the copy.
      await writeFile(path.join(tmp, rel), await readFile(path.join(skill.dir, rel)), { mode: 0o644 });
    }
    const digest = await skillDigest(tmp);
    const marker: SkillMarker = { product: "graphloom", skill: skill.name, version, digest, installedAt: now.toISOString() };
    await writeFile(path.join(tmp, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
    if (existsSync(dest)) {
      const old = `${tmp}-old`;
      await rename(dest, old);
      await rename(tmp, dest);
      await rm(old, { recursive: true, force: true });
    } else {
      await rename(tmp, dest);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface SkillsActionOptions extends TargetOptions {
  root?: string;
  /** Skill names to act on; default all. */
  names?: readonly string[];
  force?: boolean;
  now?: Date;
  say?: (line: string) => void;
}

export interface SkillsActionResult {
  changed: Array<{ dir: string; name: string; action: "installed" | "updated" | "removed" }>;
  skipped: Array<{ dir: string; name: string; reason: string }>;
}

function pick<T extends { name: string }>(items: readonly T[], names: readonly string[] | undefined, known: readonly string[]): T[] {
  if (names === undefined || names.length === 0) return [...items];
  for (const n of names) if (!known.includes(n)) throw new Error(`no bundled skill named ${n} (bundled: ${known.join(", ") || "none"})`);
  return items.filter((i) => names.includes(i.name));
}

const where = (t: SkillTarget): string => (t.agent === "dir" ? t.dir : `${SKILL_AGENT_LABEL[t.agent]} (${t.dir})`);

/**
 * Installs missing and outdated copies; skips current ones; replaces an edited
 * copy only with `force`; never touches a foreign directory. Without `--agent`
 * or `--dir` it installs for the agents found here.
 */
export async function installSkills(options: SkillsActionOptions = {}): Promise<SkillsActionResult> {
  const root = options.root ?? installRoot();
  const say = options.say ?? ((l: string) => console.log(l));
  const bundle = await bundledSkills(root);
  if (bundle.length === 0) throw new Error(`this GraphLoom ships no skills (${bundledSkillsDir(root)} is missing)`);
  const version = versionInfo(root).version;
  const now = options.now ?? new Date();
  const explicit = options.dir !== undefined || (options.agents !== undefined && options.agents.length > 0);
  const targets = skillTargets(options).filter((t) => explicit || t.found);
  const result: SkillsActionResult = { changed: [], skipped: [] };
  if (targets.length === 0) {
    say("no Claude Code, Codex or opencode found here; name one with --agent claude-code|codex|opencode or a directory with --dir");
    return result;
  }
  const chosen = pick(bundle, options.names, bundle.map((b) => b.name));
  for (const t of targets) {
    const status = await targetStatus(t, chosen);
    for (const copy of status.skills) {
      const skill = chosen.find((b) => b.name === copy.name);
      if (skill === undefined) continue;
      if (copy.state === "current") {
        result.skipped.push({ dir: t.dir, name: copy.name, reason: "current" });
        continue;
      }
      if (copy.state === "foreign") {
        say(`skipped ${copy.path}: a directory GraphLoom did not write (no ${SKILL_MARKER}); move it to install ${copy.name}`);
        result.skipped.push({ dir: t.dir, name: copy.name, reason: "foreign" });
        continue;
      }
      if (copy.state === "edited" && options.force !== true) {
        say(`skipped ${copy.path}: you edited it; graphloom skills install ${copy.name} --force replaces it`);
        result.skipped.push({ dir: t.dir, name: copy.name, reason: "edited" });
        continue;
      }
      await writeCopy(t.dir, skill, version, now);
      const action = copy.state === "missing" ? "installed" : "updated";
      result.changed.push({ dir: t.dir, name: copy.name, action });
    }
    const done = result.changed.filter((c) => c.dir === t.dir).length;
    say(`${where(t)}: ${done} skill(s) written, ${status.skills.length - done} unchanged (version ${version})`);
  }
  return result;
}

/**
 * Refreshes copies GraphLoom installed to this version: outdated ones are
 * rewritten, edited ones skipped with a notice, retired ones (no longer
 * shipped, unedited) removed. Never installs a missing one.
 */
export async function updateSkills(options: SkillsActionOptions & { quiet?: boolean } = {}): Promise<SkillsActionResult> {
  const root = options.root ?? installRoot();
  const say = options.say ?? ((l: string) => console.log(l));
  const bundle = await bundledSkills(root);
  const version = versionInfo(root).version;
  const now = options.now ?? new Date();
  const result: SkillsActionResult = { changed: [], skipped: [] };
  for (const t of skillTargets(options)) {
    const status = await targetStatus(t, bundle);
    for (const copy of status.skills) {
      if (copy.state === "edited") {
        say(`graphloom skills: kept ${copy.path} (you edited it); graphloom skills install ${copy.name} --force replaces it with ${version}'s`);
        result.skipped.push({ dir: t.dir, name: copy.name, reason: "edited" });
      } else if (copy.state === "outdated") {
        await writeCopy(t.dir, bundle.find((b) => b.name === copy.name)!, version, now);
        result.changed.push({ dir: t.dir, name: copy.name, action: "updated" });
      } else if (copy.state === "retired") {
        await rm(copy.path, { recursive: true, force: true });
        result.changed.push({ dir: t.dir, name: copy.name, action: "removed" });
      }
    }
  }
  if (result.changed.length > 0 || options.quiet !== true) {
    const updated = result.changed.filter((c) => c.action === "updated").length;
    const removed = result.changed.filter((c) => c.action === "removed").length;
    say(`graphloom skills: ${updated} updated to ${version}${removed > 0 ? `, ${removed} no longer shipped removed` : ""}`);
  }
  return result;
}

/** Removes GraphLoom copies (all, or the named ones); an edited one only with `force`; never a foreign directory. */
export async function removeSkills(options: SkillsActionOptions = {}): Promise<SkillsActionResult> {
  const root = options.root ?? installRoot();
  const say = options.say ?? ((l: string) => console.log(l));
  const bundle = await bundledSkills(root);
  const result: SkillsActionResult = { changed: [], skipped: [] };
  for (const t of skillTargets(options)) {
    const status = await targetStatus(t, bundle);
    const copies = options.names !== undefined && options.names.length > 0 ? status.skills.filter((c) => options.names!.includes(c.name)) : status.skills;
    for (const copy of copies) {
      if (copy.state === "missing" || copy.state === "foreign") continue;
      if (copy.state === "edited" && options.force !== true) {
        say(`kept ${copy.path}: you edited it (graphloom skills remove ${copy.name} --force removes it)`);
        result.skipped.push({ dir: t.dir, name: copy.name, reason: "edited" });
        continue;
      }
      await rm(copy.path, { recursive: true, force: true });
      result.changed.push({ dir: t.dir, name: copy.name, action: "removed" });
      say(`removed ${copy.path}`);
    }
  }
  if (result.changed.length === 0 && result.skipped.length === 0) say("no GraphLoom skills installed");
  return result;
}

export function formatSkillsStatus(s: SkillsStatus): string {
  const lines = [`GraphLoom ${s.version} ships ${s.bundled.length} skill(s) from ${s.source}`];
  for (const t of s.targets) {
    lines.push("");
    lines.push(`${where(t)}${t.agent !== "dir" && !t.found ? " — agent not found here" : ""}`);
    for (const c of t.skills) {
      lines.push(`  ${c.name.padEnd(20)} ${c.state}${c.installedVersion !== undefined && c.state !== "current" ? ` (installed ${c.installedVersion})` : ""}`);
    }
  }
  for (const d of s.duplicates ?? []) {
    lines.push("", duplicateNotice(d));
  }
  return lines.join("\n");
}


/** One line naming a duplicate and the command that removes the shared copies. */
export function duplicateNotice(d: SharedSkillDuplicate): string {
  return `${SKILL_AGENT_LABEL[d.agent]} also reads ${d.dir}, whose GraphLoom copies duplicate the ones in ${d.ownDir}: ${d.skills.join(", ")}; graphloom skills remove --dir ${d.dir} removes them there`;
}
