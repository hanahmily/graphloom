// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What this machine can run (docs/design-release.md §4.4): the host tools,
 * each agent harness whether or not it is configured, the GitHub CLI, and the
 * operator's configuration as `run` reads it. `graphloom doctor` reports it
 * and `graphloom setup` offers only what it finds working.
 *
 * Discovery never prints or returns a secret value and never spends a model
 * call: it runs each CLI's `--version`, `--help` (the capability probe), and
 * login status command; for Pi it asks Pi's own registry and auth store
 * whether a credential is present. It never reads Claude Code's or Codex's
 * credential files. It does not look for a host Node: GraphLoom runs on its
 * bundled runtime.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPiModelRuntime } from "@graphloom/agent-harness/pi";
import { CLAUDE_BIN_ENV, CODEX_BIN_ENV, PI_AGENT_DIR_ENV, PI_MODEL_ENV, PI_PROVIDER_ENV } from "@graphloom/executor-coding-agent";
import { confinementUnsupported, digestExecutorSource } from "@graphloom/runner";
import { DEFAULT_SUPERVISOR_MODEL, DEFAULT_SUPERVISOR_PROVIDER, piDefaultModelId, providerCredentialEnvVars } from "@graphloom/supervisor";
import { DISABLE_AUTOUPDATE_ENV, RELEASE_REPO } from "./auto-update.js";
import { probeHarnessCommand } from "./capability-probe.js";
import { selfInstall, type SelfInstall } from "./ownership.js";
import { enabledHarnesses, loadRunnerConfig, requireRunnerConfig, runnerConfigPath, type HarnessName, type RunnerConfig } from "./runner-config.js";
import {
  enabledSupervisorHarnesses,
  loadSupervisorConfig,
  parseSupervisorConfig,
  probeSupervisorHarness,
  resolveSupervisorSelection,
  supervisorConfigPath,
  type SupervisorConfig,
  type SupervisorSelection,
  type SupervisorSelectionOutcome,
} from "./supervisor-config.js";
import type { SupervisorPreference } from "@graphloom/sdk";
import { installRoot, versionInfo } from "./version.js";

export const HARNESS_ORDER: readonly HarnessName[] = ["claude-code", "codex", "pi"];
export const HARNESS_LABEL: Readonly<Record<HarnessName, string>> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };
/** Harnesses whose agent jobs may write; Codex serves read-only jobs only (`executors/coding-agent/src/codex-harness.ts`). */
export const WRITING_HARNESSES: readonly HarnessName[] = ["claude-code", "pi"];
/** The built-in supervisor order with no plugin preference (docs/design-supervisor-harnesses.md §7.3). */
export const SUPERVISOR_ORDER: readonly HarnessName[] = ["pi", "claude-code", "codex"];
/**
 * The supervisor harnesses this GraphLoom can run (docs/design-release.md
 * §4.4). Each is counted when its CLI, its login, and its supervisor probe pass.
 */
export const SHIPPED_SUPERVISOR_HARNESSES: readonly HarnessName[] = ["pi", "claude-code", "codex"];
/**
 * The Pi model setup falls back to on its provider when nothing is configured
 * and its credential is present (§4.5); any other provider's recommendation is
 * Pi's own default model for it. One option among every provider Pi knows.
 */
export const FALLBACK_PI = { provider: DEFAULT_SUPERVISOR_PROVIDER, modelId: DEFAULT_SUPERVISOR_MODEL } as const;

const PROBE_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 15_000;

export interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start or timed out. */
  error?: string;
}

/** Runs `command` with stdin closed and a bounded wall clock. Never throws. */
export function exec(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): Promise<Exec> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a timeout kills every descendant too.
      child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // Do not wait for pipes a surviving descendant may still hold.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: null, stdout, stderr, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: (err as NodeJS.ErrnoException).code === "ENOENT" ? `${command} was not found` : err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { code, stdout, stderr, error: `timed out after ${timeoutMs} ms` } : { code, stdout, stderr });
    });
  });
}

/** The absolute path `command` runs as: a path made absolute, or the first executable of that name on `PATH`. */
export async function findExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const expanded = command === "~" || command.startsWith("~/") ? path.join(env.HOME ?? os.homedir(), command.slice(1)) : command;
  const candidates = expanded.includes("/")
    ? [path.resolve(expanded)]
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, expanded));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

// ---------------------------------------------------------------- host

export interface ToolDiscovery {
  path?: string;
  version?: string;
}

export interface ConfinementDiscovery {
  ok: boolean;
  /** `confinementUnsupported()`'s reason when the probe fails. */
  reason?: string;
  /** bwrap is on `PATH` but cannot create a namespace. */
  namespaceRefused?: boolean;
  /** `kernel.apparmor_restrict_unprivileged_userns`, when readable. */
  apparmorRestrict?: string;
}

export interface IntegrityDiscovery {
  status: "pass" | "warn" | "fail";
  detail: string;
  problems: string[];
}

export interface HostDiscovery {
  platform: { ok: boolean; actual: string; expected: string };
  git: ToolDiscovery;
  flock: ToolDiscovery;
  confinement: ConfinementDiscovery;
  integrity: IntegrityDiscovery;
}

async function tool(name: string, env: NodeJS.ProcessEnv): Promise<ToolDiscovery> {
  const found = await findExecutable(name, env);
  if (found === undefined) return {};
  const out = await exec(found, ["--version"], env);
  const version = firstLine(out.stdout || out.stderr);
  return { path: found, ...(version ? { version } : {}) };
}

async function discoverConfinement(env: NodeJS.ProcessEnv): Promise<ConfinementDiscovery> {
  // The same probe the runner uses before it confines an agent (packages/runner/src/confine.ts).
  const reason = await confinementUnsupported();
  if (reason === undefined) return { ok: true };
  let apparmorRestrict: string | undefined;
  try {
    apparmorRestrict = readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim();
  } catch {
    apparmorRestrict = undefined;
  }
  const namespaceRefused = (await findExecutable("bwrap", env)) !== undefined;
  return { ok: false, reason, namespaceRefused, ...(apparmorRestrict !== undefined ? { apparmorRestrict } : {}) };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The version directory is read-only, and its bundled Node and its `release.json` digests match what is installed (§4.4). */
async function discoverIntegrity(root: string, release: Record<string, unknown> | undefined): Promise<IntegrityDiscovery> {
  if (release === undefined) {
    return { status: "pass", detail: `a clone at ${root}: no installed release to check`, problems: [] };
  }
  const problems: string[] = [];
  if (await access(root, constants.W_OK).then(() => true, () => false)) problems.push(`the version directory ${root} is writable`);
  const node = path.join(root, "node", "bin", "node");
  const pinned = (release.node as { version?: unknown } | undefined)?.version;
  let running: string | undefined;
  try {
    running = realpathSync(process.execPath) === realpathSync(node) ? process.versions.node : undefined;
  } catch {
    running = undefined;
  }
  if (!existsSync(node)) problems.push("the bundled node/bin/node is missing");
  else if (running === undefined) problems.push(`GraphLoom is not running on its bundled Node (${node})`);
  else if (typeof pinned === "string" && pinned !== running) problems.push(`the bundled Node is ${running}, but release.json pins ${pinned}`);
  const executors = Array.isArray(release.executors) ? (release.executors as Array<{ package?: unknown; digest?: unknown }>) : [];
  const executorDirs = packageDirs(path.join(root, "executors"));
  for (const entry of executors) {
    const dir = typeof entry.package === "string" ? executorDirs.get(entry.package) : undefined;
    if (dir === undefined) {
      problems.push(`executor ${String(entry.package)} is not installed`);
      continue;
    }
    const digest = await digestExecutorSource(dir).catch(() => undefined);
    if (digest !== entry.digest) problems.push(`executor ${String(entry.package)} does not match its release.json digest`);
  }
  const plugins = Array.isArray(release.plugins) ? (release.plugins as Array<{ graphId?: unknown; manifestSha256?: unknown }>) : [];
  for (const entry of plugins) {
    const manifest = path.join(root, "examples", "plugins", String(entry.graphId), "graphloom.manifest.json");
    let digest: string | undefined;
    try {
      digest = sha256File(manifest);
    } catch {
      digest = undefined;
    }
    if (digest === undefined) problems.push(`plugin ${String(entry.graphId)} is not installed`);
    else if (digest !== entry.manifestSha256) problems.push(`plugin ${String(entry.graphId)}'s manifest does not match release.json`);
  }
  if (problems.length > 0) return { status: "fail", detail: problems.join("; "), problems };
  return {
    status: "pass",
    detail: `read-only; bundled Node ${running}; ${executors.length} executor${executors.length === 1 ? "" : "s"} and ${plugins.length} plugin${plugins.length === 1 ? "" : "s"} match release.json`,
    problems,
  };
}

/** Package directories under `parent`, by package name. */
function packageDirs(parent: string): Map<string, string> {
  const dirs = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return dirs;
  }
  for (const name of names) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(parent, name, "package.json"), "utf8")) as { name?: unknown };
      if (typeof pkg.name === "string") dirs.set(pkg.name, path.join(parent, name));
    } catch {
      continue;
    }
  }
  return dirs;
}

// ---------------------------------------------------------------- agents

export type LoginState = "logged-in" | "logged-out" | "unverified";

export interface CliHarnessDiscovery {
  harness: "claude-code" | "codex";
  /** The command as configured or defaulted. */
  command: string;
  /** Where the command was given: the runner config, an environment variable, or the default name. */
  commandSource: string;
  path?: string;
  version?: string;
  probe?: { status: "passed" | "failed" | "unverified"; notes: string[] };
  login?: LoginState;
  available: boolean;
  /** Why it is not available, or why its login is not verified. */
  reason?: string;
  /** The next command for the operator. */
  fix?: string;
}

const INSTALL_FIX: Record<"claude-code" | "codex", string> = {
  "claude-code": "curl -fsSL https://claude.ai/install.sh | bash   (then: claude, to log in)",
  codex: "npm install -g @openai/codex   (then: codex login)",
};
export const LOGIN_FIX: Record<"claude-code" | "codex", string> = { "claude-code": "claude", codex: "codex login" };

async function discoverCli(
  harness: "claude-code" | "codex",
  config: RunnerConfig | undefined,
  env: NodeJS.ProcessEnv,
  confinement: ConfinementDiscovery,
): Promise<CliHarnessDiscovery> {
  const configured = harness === "claude-code" ? config?.claude?.command : config?.codex?.command;
  const envName = harness === "claude-code" ? CLAUDE_BIN_ENV : CODEX_BIN_ENV;
  const defaultName = harness === "claude-code" ? "claude" : "codex";
  const command = configured ?? (env[envName] || defaultName);
  const commandSource = configured !== undefined ? (harness === "claude-code" ? "claude.command" : "codex.command") : env[envName] ? envName : "PATH";
  const base: CliHarnessDiscovery = { harness, command, commandSource, available: false };
  const found = await findExecutable(command, env);
  if (found === undefined) {
    return { ...base, reason: `${command} was not found${commandSource === "PATH" ? " on PATH" : ` (from ${commandSource})`}`, fix: INSTALL_FIX[harness] };
  }
  const versionOut = await exec(found, ["--version"], env);
  const version = firstLine(versionOut.stdout || versionOut.stderr) || undefined;
  const probe = await probeHarnessCommand(harness, found);
  const result: CliHarnessDiscovery = { ...base, path: found, ...(version !== undefined ? { version } : {}), probe: { status: probe.status, notes: probe.notes } };
  if (probe.status !== "passed") {
    return {
      ...result,
      reason: probe.status === "failed" ? `the capability probe failed: ${probe.notes.join("; ")}` : `the capability probe could not read ${command}'s help`,
      fix: harness === "claude-code" ? "claude update" : "npm install -g @openai/codex@latest",
    };
  }
  const login = await discoverLogin(harness, found, probe.help ?? "", config, env);
  const withLogin = { ...result, login: login.state };
  if (login.state === "logged-out") return { ...withLogin, reason: login.detail, fix: LOGIN_FIX[harness] };
  if (!confinement.ok) return { ...withLogin, reason: `confinement is not available: ${confinement.reason}`, fix: confinementFix(confinement) };
  // A login GraphLoom cannot verify still counts: run never reads it either (§4.4, as implemented).
  if (login.state === "unverified") return { ...withLogin, available: true, reason: login.detail, fix: LOGIN_FIX[harness] };
  return { ...withLogin, available: true };
}

/** The CLI's own status command; never its credential files. */
async function discoverLogin(
  harness: "claude-code" | "codex",
  command: string,
  help: string,
  config: RunnerConfig | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ state: LoginState; detail: string }> {
  if (harness === "claude-code") {
    if (!/^\s+auth\b/m.test(help)) return { state: "unverified", detail: "login not verified: claude --help lists no auth command" };
    const childEnv = config?.claude?.configDir !== undefined ? { ...env, CLAUDE_CONFIG_DIR: config.claude.configDir } : env;
    const out = await exec(command, ["auth", "status", "--json"], childEnv);
    let loggedIn: unknown;
    try {
      loggedIn = (JSON.parse(out.stdout) as { loggedIn?: unknown }).loggedIn;
    } catch {
      loggedIn = undefined;
    }
    if (loggedIn === true) return { state: "logged-in", detail: "logged in (claude auth status)" };
    if (loggedIn === false) return { state: "logged-out", detail: "not logged in (claude auth status)" };
    return { state: "unverified", detail: `login not verified: claude auth status ${out.error ?? `exited ${out.code}`} without a loggedIn answer` };
  }
  const childEnv = config?.codex?.codexHome !== undefined ? { ...env, CODEX_HOME: config.codex.codexHome } : env;
  const out = await exec(command, ["login", "status"], childEnv);
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.code === 0 && !/not logged in/i.test(text)) return { state: "logged-in", detail: "logged in (codex login status)" };
  if (/not logged in/i.test(text) || out.code === 1) return { state: "logged-out", detail: "not logged in (codex login status)" };
  return { state: "unverified", detail: `login not verified: codex login status ${out.error ?? `exited ${out.code}`}` };
}

export function confinementFix(c: ConfinementDiscovery): string {
  return c.namespaceRefused
    ? "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   (or allow bwrap in an AppArmor profile)"
    : "sudo apt-get install bubblewrap";
}

export interface PiProviderCredential {
  provider: string;
  /** Where the credential is: an environment variable's name, `auth store`, or a models.json entry. Never the value. */
  source: string;
  /** The Pi API types its models speak (`openai-completions`, `anthropic-messages`, ...). */
  apis?: string[];
}

export interface PiModelCheck {
  /** Where it is configured: `runner config pi`, `supervisor config`, or the environment. */
  where: string;
  provider: string;
  modelId: string;
  resolves: boolean;
  credential: boolean;
}

export interface PiDiscovery {
  agentDir: string;
  /** Providers with a credential present, in Pi's registry order. */
  credentials: PiProviderCredential[];
  /** The configured Pi models (runner and supervisor) and whether each resolves and has a credential. */
  configured: PiModelCheck[];
  /** Model ids Pi's registry knows for each provider with a credential. */
  models: Record<string, string[]>;
  /** Pi's own default model for each provider with a credential, when Pi names one. */
  defaults?: Record<string, string>;
  /** Every provider id in Pi's registry (built-in and models.json), credential or not. */
  known?: string[];
  available: boolean;
  reason?: string;
  fix?: string;
  /** Pi's registry could not be read. */
  error?: string;
}

/** The provider's credential presence through Pi's registry and auth store; never the value (§4.4). */
async function discoverPi(config: RunnerConfig | undefined, supervisor: SupervisorConfig | undefined, env: NodeJS.ProcessEnv): Promise<PiDiscovery> {
  const home = env.HOME ?? os.homedir();
  const agentDir = config?.pi?.agentDir ?? env[PI_AGENT_DIR_ENV] ?? path.join(home, ".pi", "agent");
  const base: PiDiscovery = { agentDir, credentials: [], configured: [], models: {}, available: false };
  let runtime: Awaited<ReturnType<typeof defaultPiModelRuntime>>;
  const saved = swapEnv(env);
  try {
    runtime = await defaultPiModelRuntime(agentDir);
    base.known = runtime.getProviders().map((p) => p.id);
    base.defaults = {};
    for (const provider of runtime.getProviders()) {
      const source = await credentialSource(runtime, provider.id);
      if (source === undefined) continue;
      const models = runtime.getModels(provider.id);
      base.credentials.push({ provider: provider.id, source, apis: [...new Set(models.map((m) => String(m.api)))] });
      base.models[provider.id] = models.map((m) => m.id);
      const preferred = await piDefaultModelId(provider.id, base.models[provider.id] ?? []);
      if (preferred !== undefined) base.defaults[provider.id] = preferred;
    }
    const checks: Array<{ where: string; provider: string | undefined; modelId: string | undefined }> = [];
    if (config !== undefined && enabledHarnesses(config).includes("pi")) {
      checks.push({ where: config.pi?.provider !== undefined ? "runner config pi" : PI_PROVIDER_ENV, provider: config.pi?.provider ?? env[PI_PROVIDER_ENV], modelId: config.pi?.modelId ?? env[PI_MODEL_ENV] });
    }
    for (const c of checks) {
      if (c.provider === undefined || c.modelId === undefined) continue;
      base.configured.push({
        where: c.where,
        provider: c.provider,
        modelId: c.modelId,
        resolves: runtime.getModel(c.provider, c.modelId) !== undefined,
        credential: base.credentials.some((p) => p.provider === c.provider),
      });
    }
    if (supervisor !== undefined && enabledSupervisorHarnesses(supervisor).includes("pi")) {
      // The supervisor reads its own agent dir (supervisor.json agentDir, else ~/.pi/agent), not the runner's.
      const supervisorDir = supervisor.agentDir ?? path.join(home, ".pi", "agent");
      const supRuntime = supervisorDir === agentDir ? runtime : await defaultPiModelRuntime(supervisorDir);
      base.configured.push({
        where: "supervisor config",
        provider: supervisor.provider,
        modelId: supervisor.modelId,
        resolves: supRuntime.getModel(supervisor.provider, supervisor.modelId) !== undefined,
        credential:
          supervisorDir === agentDir ? base.credentials.some((p) => p.provider === supervisor.provider) : (await credentialSource(supRuntime, supervisor.provider)) !== undefined,
      });
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err), reason: "Pi's model registry could not be read", fix: `check ${path.join(agentDir, "models.json")} and ${path.join(agentDir, "auth.json")}` };
  } finally {
    restoreEnv(saved);
  }
  const runnerPi = base.configured.find((c) => c.where !== "supervisor config");
  if (runnerPi !== undefined) {
    if (!runnerPi.resolves) return { ...base, reason: `${runnerPi.provider}/${runnerPi.modelId} (${runnerPi.where}) is not in Pi's model registry`, fix: "graphloom setup" };
    if (!runnerPi.credential) return { ...base, reason: `no credential for ${runnerPi.provider}`, fix: piCredentialFix(runnerPi.provider) };
    return { ...base, available: true };
  }
  if (base.credentials.length === 0) return { ...base, reason: "no Pi provider has a credential", fix: NO_PI_CREDENTIAL_FIX };
  return { ...base, available: true };
}

/** What to do when no Pi provider has a credential: any provider Pi supports will do. */
export const NO_PI_CREDENTIAL_FIX =
  "export the API key variable of any provider Pi supports (for example ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, MINIMAX_CN_API_KEY), store a key with pi (/login), or define a custom provider in Pi's models.json with its apiKey set to \"$<VARIABLE>\" (docs/design-pi-supervisor.md, Choosing a supervisor model)";

/** How to give `provider` a credential: Pi's own variable for it, or its models.json reference. */
export function piCredentialFix(provider: string): string {
  const names = providerCredentialEnvVars(provider);
  // Anthropic's first variables are OAuth tokens; an API key is what a supervisor uses.
  const name = names.find((n) => n.endsWith("_API_KEY")) ?? names[0];
  return name !== undefined
    ? `export ${name}=<key>   (or store it with pi: /login)`
    : `export the variable ${provider}'s apiKey references in Pi's models.json, or store a key with pi (/login)`;
}

async function credentialSource(runtime: Awaited<ReturnType<typeof defaultPiModelRuntime>>, provider: string): Promise<string | undefined> {
  // Stored and models.json credentials are known without resolving them (no credential command runs).
  const status = runtime.getProviderAuthStatus(provider);
  if (status.configured) return status.source === "stored" ? "auth store" : status.source === "environment" ? (status.label ?? "environment") : `models.json`;
  const check = await withTimeout(runtime.checkAuth(provider), 2_000).catch(() => undefined);
  if (check === undefined) return undefined;
  return check.source === "stored credential" ? "auth store" : check.source;
}

/** Pi reads the process environment; discovery's `env` stands in for it while the registry is asked. */
function swapEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (env === process.env) return undefined;
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  return saved;
}

function restoreEnv(saved: NodeJS.ProcessEnv | undefined): void {
  if (saved === undefined) return;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}

export interface GhDiscovery {
  repo: string;
  path?: string;
  version?: string;
  loggedIn?: boolean;
  access?: boolean;
  available: boolean;
  reason?: string;
  fix?: string;
}

async function discoverGh(env: NodeJS.ProcessEnv): Promise<GhDiscovery> {
  const repo = env.GRAPHLOOM_RELEASE_REPO || RELEASE_REPO;
  const found = await findExecutable("gh", env);
  if (found === undefined) return { repo, available: false, reason: "gh is not on PATH", fix: "sudo apt-get install gh   (then: gh auth login)" };
  const version = firstLine((await exec(found, ["--version"], env)).stdout) || undefined;
  const base = { repo, path: found, ...(version !== undefined ? { version } : {}) };
  const auth = await exec(found, ["auth", "status"], env, GH_TIMEOUT_MS);
  if (auth.code !== 0) return { ...base, loggedIn: false, available: false, reason: "gh is not logged in", fix: "gh auth login" };
  const view = await exec(found, ["repo", "view", repo, "--json", "name"], env, GH_TIMEOUT_MS);
  if (view.code !== 0) return { ...base, loggedIn: true, access: false, available: false, reason: `gh cannot read ${repo}`, fix: `ask a maintainer for read access to ${repo}, then gh auth refresh` };
  return { ...base, loggedIn: true, access: true, available: true };
}

// ---------------------------------------------------------------- configuration

export interface RunnerDiscovery {
  file: string;
  explicit: boolean;
  exists: boolean;
  config?: RunnerConfig;
  /** The parse error, or the refusal `run` would make before any job. */
  error?: string;
}

export interface SupervisorDiscovery {
  file: string;
  explicit: boolean;
  exists: boolean;
  config?: SupervisorConfig;
  error?: string;
}

export interface UpdatesDiscovery {
  mode: "auto" | "notify" | "off";
  source: string;
  /** The install home, when this CLI is an installed version. */
  home?: string;
  lastCheck?: { time?: string; action?: string; newest?: string };
  skip?: string;
  lastFailure?: { version?: string; reason?: string; time?: string };
  /** Whether `current` carries the release key that unattended installs need. */
  canVerify: boolean;
  sshKeygen: boolean;
}

export interface Discovery {
  self: SelfInstall;
  root: string;
  host: HostDiscovery;
  claude: CliHarnessDiscovery;
  codex: CliHarnessDiscovery;
  pi: PiDiscovery;
  gh: GhDiscovery;
  runner: RunnerDiscovery;
  supervisor: SupervisorDiscovery;
  updates: UpdatesDiscovery;
  /** Each harness as a supervisor for a new supervisor config: what setup can write and the viable setups count. */
  supervisorCandidates: Record<HarnessName, SupervisorHarnessCheck>;
  /** The `claude` section setup writes for a Claude Code supervisor: the runner's Claude Code command and config dir. */
  claudeSupervisorSection: Record<string, unknown>;
  /** The `codex` section setup writes for a Codex supervisor: the runner's Codex command and home. */
  codexSupervisorSection: Record<string, unknown>;
  /** The existing supervisor config's enabled harnesses, each probed as `run` probes it. */
  supervisorEnabled: SupervisorHarnessCheck[];
  /** The harness `run` would select from the existing supervisor config (no `--supervisor`), if any. */
  supervisorSelection?: SupervisorSelection;
  /** Why `run` would refuse the existing supervisor config's selection (a `select` that is not available). */
  supervisorSelectionError?: string;
  env: NodeJS.ProcessEnv;
}

export function isAvailable(d: Discovery, harness: string): boolean {
  if (harness === "claude-code") return d.claude.available;
  if (harness === "codex") return d.codex.available;
  if (harness === "pi") return d.pi.available;
  return false;
}

/** Available harnesses in the built-in order. */
export function availableHarnesses(d: Discovery): HarnessName[] {
  return HARNESS_ORDER.filter((h) => isAvailable(d, h));
}

/** Why `harness` is not available, and the next command. */
export function unavailability(d: Discovery, harness: string): { reason: string; fix: string } {
  const h = harness === "claude-code" ? d.claude : harness === "codex" ? d.codex : harness === "pi" ? d.pi : undefined;
  if (h === undefined) return { reason: `${harness} is not a harness GraphLoom knows`, fix: `use one of ${HARNESS_ORDER.join(", ")}` };
  return { reason: h.reason ?? "not available", fix: h.fix ?? "graphloom doctor" };
}

async function discoverRunner(env: NodeJS.ProcessEnv): Promise<RunnerDiscovery> {
  const { file, explicit } = runnerConfigPath(env);
  const exists = existsSync(file);
  let config: RunnerConfig | undefined;
  try {
    config = await loadRunnerConfig(env);
  } catch (err) {
    return { file, explicit, exists, error: err instanceof Error ? err.message : String(err) };
  }
  if (config === undefined) return { file, explicit, exists };
  // The refusals `run` makes before any job: Pi without a model, a missing command.
  const refused = await requireRunnerConfig(env).then(() => undefined, (err: unknown) => (err instanceof Error ? err.message : String(err)));
  return { file, explicit, exists, config, ...(refused !== undefined ? { error: refused } : {}) };
}

async function discoverSupervisor(env: NodeJS.ProcessEnv): Promise<SupervisorDiscovery> {
  const { file, explicit } = supervisorConfigPath(env);
  const exists = existsSync(file);
  try {
    const config = await loadSupervisorConfig(env);
    return { file, explicit, exists, ...(config !== undefined ? { config } : {}) };
  } catch (err) {
    return { file, explicit, exists, error: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function discoverUpdates(self: SelfInstall, runner: RunnerDiscovery, env: NodeJS.ProcessEnv): Promise<UpdatesDiscovery> {
  const sshKeygen = (await findExecutable("ssh-keygen", env)) !== undefined;
  let mode: UpdatesDiscovery["mode"] = "auto";
  let source = "the default";
  if (env[DISABLE_AUTOUPDATE_ENV] === "1") {
    mode = "off";
    source = `${DISABLE_AUTOUPDATE_ENV}=1`;
  } else if (runner.config?.autoUpdate !== undefined) {
    mode = runner.config.autoUpdate;
    source = runner.file;
  }
  const home = self.home;
  if (home === undefined) return { mode, source, canVerify: false, sshKeygen };
  const update = path.join(home, "update");
  const last = readJsonFile(path.join(update, "last-check"));
  const failure = readJsonFile(path.join(update, "last-failure"));
  let skip: string | undefined;
  try {
    skip = readFileSync(path.join(update, "skip"), "utf8").split("\n")[0]?.trim() || undefined;
  } catch {
    skip = undefined;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    mode,
    source,
    home,
    ...(last !== undefined ? { lastCheck: { ...(str(last.time) ? { time: str(last.time)! } : {}), ...(str(last.action) ? { action: str(last.action)! } : {}), ...(str(last.newest) ? { newest: str(last.newest)! } : {}) } } : {}),
    ...(skip !== undefined ? { skip } : {}),
    ...(failure !== undefined ? { lastFailure: { ...(str(failure.version) ? { version: str(failure.version)! } : {}), ...(str(failure.reason) ? { reason: str(failure.reason)! } : {}), ...(str(failure.time) ? { time: str(failure.time)! } : {}) } } : {}),
    canVerify: existsSync(path.join(home, "current", "release", "allowed_signers")),
    sshKeygen,
  };
}

/** Everything the doctor and setup need, discovered once. */
export async function discover(env: NodeJS.ProcessEnv = process.env, root: string = installRoot()): Promise<Discovery> {
  const self = selfInstall(root);
  const info = versionInfo(root);
  const expectedPlatform = typeof info.release?.platform === "string" ? info.release.platform : `linux-${process.arch}`;
  const actual = `${process.platform}-${process.arch}`;
  const [git, flock, confinement, integrity, runner, supervisor, gh] = await Promise.all([
    tool("git", env),
    tool("flock", env),
    discoverConfinement(env),
    discoverIntegrity(root, info.release),
    discoverRunner(env),
    discoverSupervisor(env),
    discoverGh(env),
  ]);
  const [claude, codex] = await Promise.all([
    discoverCli("claude-code", runner.config, env, confinement),
    discoverCli("codex", runner.config, env, confinement),
  ]);
  const pi = await discoverPi(runner.config, supervisor.config, env);
  const claudeSupervisorSection: Record<string, unknown> = {
    ...(claude.commandSource !== "PATH" && claude.path !== undefined ? { command: claude.path } : {}),
    ...(runner.config?.claude?.configDir !== undefined ? { configDir: runner.config.claude.configDir } : {}),
  };
  const codexSupervisorSection: Record<string, unknown> = {
    ...(codex.commandSource !== "PATH" && codex.path !== undefined ? { command: codex.path } : {}),
    ...(runner.config?.codex?.codexHome !== undefined ? { codexHome: runner.config.codex.codexHome } : {}),
  };
  const supervisorCandidates = await discoverSupervisorCandidates(claude, codex, pi, claudeSupervisorSection, codexSupervisorSection);
  const { enabled: supervisorEnabled, selection: supervisorSelection, error: supervisorSelectionError } = await discoverSupervisorSelection(supervisor.config, pi);
  const updates = await discoverUpdates(self, runner, env);
  return {
    self,
    root,
    host: { platform: { ok: actual === expectedPlatform, actual, expected: expectedPlatform }, git, flock, confinement, integrity },
    claude,
    codex,
    pi,
    gh,
    runner,
    supervisor,
    updates,
    supervisorCandidates,
    claudeSupervisorSection,
    codexSupervisorSection,
    supervisorEnabled,
    ...(supervisorSelection !== undefined ? { supervisorSelection } : {}),
    ...(supervisorSelectionError !== undefined ? { supervisorSelectionError } : {}),
    env,
  };
}

// ---------------------------------------------------------------- supervisor harnesses

export interface SupervisorHarnessCheck {
  harness: HarnessName;
  ok: boolean;
  reason?: string;
  fix?: string;
}

/** A Pi supervisor needs a provider credential and a model Pi knows. */
function piSupervisorCheck(pi: PiDiscovery, where?: PiModelCheck): SupervisorHarnessCheck {
  if (pi.error !== undefined) return { harness: "pi", ok: false, reason: pi.reason ?? "Pi's registry could not be read", ...(pi.fix !== undefined ? { fix: pi.fix } : {}) };
  if (where !== undefined) {
    if (!where.resolves) return { harness: "pi", ok: false, reason: `${where.provider}/${where.modelId} is not in Pi's model registry`, fix: "graphloom setup" };
    if (!where.credential) return { harness: "pi", ok: false, reason: `no credential for ${where.provider}`, fix: piCredentialFix(where.provider) };
    return { harness: "pi", ok: true };
  }
  if (pi.credentials.length === 0) return { harness: "pi", ok: false, reason: "no Pi provider has a credential", fix: NO_PI_CREDENTIAL_FIX };
  return { harness: "pi", ok: true };
}

/** S3's own probe of the Claude Code supervisor (`probeSupervisorHarness`), behind the doctor's CLI and login check. */
async function claudeSupervisorCheck(claude: CliHarnessDiscovery, config: SupervisorConfig): Promise<SupervisorHarnessCheck> {
  if (!claude.available) return { harness: "claude-code", ok: false, reason: claude.reason ?? "Claude Code is not available", ...(claude.fix !== undefined ? { fix: claude.fix } : {}) };
  const probe = await probeSupervisorHarness(config, "claude-code").catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
  if (probe.ok) return { harness: "claude-code", ok: true };
  const reason = probe.reason ?? "the Claude Code supervisor probe failed";
  return { harness: "claude-code", ok: false, reason, fix: /login/i.test(reason) ? LOGIN_FIX["claude-code"] : /--help/.test(reason) ? "claude update" : "graphloom doctor" };
}

/** S4's own probe of the Codex supervisor (`probeSupervisorHarness`), behind the doctor's CLI and login check. */
async function codexSupervisorCheck(codex: CliHarnessDiscovery, config: SupervisorConfig): Promise<SupervisorHarnessCheck> {
  if (!codex.available) return { harness: "codex", ok: false, reason: codex.reason ?? "Codex is not available", ...(codex.fix !== undefined ? { fix: codex.fix } : {}) };
  const probe = await probeSupervisorHarness(config, "codex").catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
  if (probe.ok) return { harness: "codex", ok: true };
  const reason = probe.reason ?? "the Codex supervisor probe failed";
  return { harness: "codex", ok: false, reason, fix: /login/i.test(reason) ? LOGIN_FIX.codex : /--help/.test(reason) ? "npm install -g @openai/codex@latest" : "graphloom doctor" };
}

async function discoverSupervisorCandidates(
  claude: CliHarnessDiscovery,
  codex: CliHarnessDiscovery,
  pi: PiDiscovery,
  claudeSection: Record<string, unknown>,
  codexSection: Record<string, unknown>,
): Promise<Record<HarnessName, SupervisorHarnessCheck>> {
  return {
    pi: piSupervisorCheck(pi),
    "claude-code": await claudeSupervisorCheck(claude, parseSupervisorConfig({ harnesses: ["claude-code"], claude: claudeSection }, "the Claude Code supervisor setup would write")),
    codex: await codexSupervisorCheck(codex, parseSupervisorConfig({ harnesses: ["codex"], codex: codexSection }, "the Codex supervisor setup would write")),
  };
}

/** The existing supervisor config's harnesses, probed, and the harness `run` would select from them. */
async function discoverSupervisorSelection(config: SupervisorConfig | undefined, pi: PiDiscovery): Promise<{ enabled: SupervisorHarnessCheck[]; selection?: SupervisorSelection; error?: string }> {
  if (config === undefined) return { enabled: [] };
  const claudeDiscovery = (config: SupervisorConfig): CliHarnessDiscovery => ({ harness: "claude-code", command: config.claude?.command ?? "claude", commandSource: "supervisor config", available: true });
  const codexDiscovery = (config: SupervisorConfig): CliHarnessDiscovery => ({ harness: "codex", command: config.codex?.command ?? "codex", commandSource: "supervisor config", available: true });
  const checks = new Map<string, SupervisorHarnessCheck>();
  for (const harness of enabledSupervisorHarnesses(config)) {
    if (harness === "pi") checks.set(harness, piSupervisorCheck(pi, pi.configured.find((c) => c.where === "supervisor config")));
    else if (harness === "claude-code") checks.set(harness, await claudeSupervisorCheck(claudeDiscovery(config), config));
    else if (harness === "codex") checks.set(harness, await codexSupervisorCheck(codexDiscovery(config), config));
    else checks.set(harness, { harness: harness as HarnessName, ok: false, reason: `the ${harness} supervisor is not available in this GraphLoom`, fix: "graphloom setup" });
  }
  const enabled = [...checks.values()];
  const { outcome, error } = selectionOnProbes(config, enabled);
  return { enabled, ...(outcome?.selection !== undefined ? { selection: outcome.selection } : {}), ...(error !== undefined ? { error } : {}) };
}

/**
 * The selection `run` would make from `config` with the plugin's
 * `preference`, on the doctor's probes of the enabled harnesses: the same
 * `resolveSupervisorSelection` that `run`, `resume`, and `check` use
 * (design-supervisor-harnesses.md §7.3). A refusal (a `select` that is not
 * available, a plugin's `required`) is the `error`.
 */
export function selectionOnProbes(
  config: SupervisorConfig,
  enabled: readonly SupervisorHarnessCheck[],
  preference?: SupervisorPreference,
): { outcome?: SupervisorSelectionOutcome; error?: string } {
  try {
    const outcome = resolveSupervisorSelection(
      config,
      (h) => {
        const c = enabled.find((e) => e.harness === h);
        return c?.ok ? { ok: true } : { ok: false, reason: c?.reason ?? "not enabled" };
      },
      preference !== undefined ? { preference } : {},
    );
    return { outcome };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
