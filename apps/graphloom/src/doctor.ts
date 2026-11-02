// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom doctor [--task <task.yaml>] [--json]` (docs/design-release.md
 * §4.4): what this machine can run and how to finish setting it up. Each
 * check is `pass`, `warn`, or `fail`; every `warn` and `fail` carries the
 * exact next command as its `fix`. It exits 1 on any `fail`. It never prints
 * a secret value and never spends a model call.
 *
 * Without a task it knows only generic harness capabilities (executor facts,
 * not plugin notions). With `--task` it loads the selected plugin as `check`
 * does and adds the plugin's environment checks, the supervisor selection
 * `run` would make, and each agent role the plugin declares in
 * `GraphDefinition.agentRoles`, whose `role` and `setting` it treats as
 * opaque text.
 */
import path from "node:path";
import type { AgentRoleDeclaration, GraphDefinition, SupervisorPreference } from "@graphloom/sdk";
import {
  HARNESS_LABEL,
  HARNESS_ORDER,
  LOGIN_FIX,
  SHIPPED_SUPERVISOR_HARNESSES,
  SUPERVISOR_ORDER,
  WRITING_HARNESSES,
  availableHarnesses,
  confinementFix,
  isAvailable,
  piCredentialFix,
  selectionOnProbes,
  unavailability,
  type CliHarnessDiscovery,
  type Discovery,
  type SupervisorHarnessCheck,
} from "./discovery.js";
import { enabledHarnesses, type HarnessName } from "./runner-config.js";
import { harnessModels, withModelHints, type SupervisorConfig } from "./supervisor-config.js";
import { SKILL_AGENT_LABEL, duplicateFix } from "./skills.js";
import { SESSION_LAUNCHER_ENV, probeRefusal } from "./session-launcher.js";

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckSection = "host" | "agents" | "configuration" | "setups" | "task";

export interface DoctorCheck {
  section: CheckSection;
  name: string;
  status: CheckStatus;
  detail: string;
  /** The exact next command; present on every warn and fail. */
  fix?: string;
}

export interface ViableSetups {
  /** Available harnesses that can write, recommended first. */
  defaultHarness: HarnessName[];
  /** The other available harnesses worth enabling. */
  enable: HarnessName[];
  /** The supervisor harness §7.3 resolves with no plugin preference, if any. */
  supervisor?: HarnessName;
  /** Every harness that can supervise here, in the built-in order Pi, Claude Code, Codex. */
  supervisors: HarnessName[];
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  available: HarnessName[];
  viable: ViableSetups;
}

const label = (h: string): string => HARNESS_LABEL[h as HarnessName] ?? h;
const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

function check(section: CheckSection, name: string, status: CheckStatus, detail: string, fix?: string): DoctorCheck {
  return { section, name, status, detail, ...(status !== "pass" ? { fix: fix ?? "graphloom doctor" } : {}) };
}

/** The setups the available harnesses allow (§4.4, "Viable setups"). */
export function viableSetups(d: Discovery): ViableSetups {
  const available = availableHarnesses(d);
  const writers = (["claude-code", "pi"] as const).filter((h) => available.includes(h));
  // A supervisor harness counts when this GraphLoom ships it and its own supervisor probe passes.
  const supervisors = SUPERVISOR_ORDER.filter((h) => SHIPPED_SUPERVISOR_HARNESSES.includes(h) && d.supervisorCandidates[h].ok);
  const supervisor = supervisors[0];
  return {
    defaultHarness: writers,
    enable: available.filter((h) => h !== writers[0]),
    ...(supervisor !== undefined ? { supervisor } : {}),
    supervisors,
  };
}

/** The next command for each harness that cannot write yet: what makes an available writer. */
export function missingWriterFixes(d: Discovery): string[] {
  return WRITING_HARNESSES.filter((h) => !isAvailable(d, h)).map((h) => `${label(h)}: ${unavailability(d, h).fix}`);
}

function cliCheck(c: CliHarnessDiscovery): DoctorCheck {
  const name = c.harness;
  if (c.path === undefined) return check("agents", name, "warn", c.reason ?? "not found", c.fix);
  const version = c.version !== undefined ? `${c.version}; ` : "";
  if (c.probe?.status !== "passed") return check("agents", name, "warn", `${version}${c.reason}`, c.fix);
  if (c.login === "logged-out") return check("agents", name, "warn", `${version}${c.reason}`, c.fix);
  if (!c.available) return check("agents", name, "warn", `${version}${c.reason}`, c.fix);
  if (c.login === "unverified") return check("agents", name, "warn", `${version}available; ${c.reason}`, c.fix);
  return check("agents", name, "pass", `${version}${c.path}; capability probe passed; logged in`);
}

/** The doctor's checks of this machine (§4.4), without a task. */
export function machineChecks(d: Discovery): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const { host } = d;
  checks.push(
    host.platform.ok
      ? check("host", "platform", "pass", host.platform.actual)
      : check("host", "platform", "fail", `${host.platform.actual}, but this GraphLoom is built for ${host.platform.expected}`, "install the GraphLoom release built for this platform"),
  );
  for (const [name, t, pkg] of [["git", host.git, "git"], ["flock", host.flock, "util-linux"]] as const) {
    checks.push(t.path !== undefined ? check("host", name, "pass", `${t.version ?? "version unknown"} (${t.path})`) : check("host", name, "fail", `${name} is not on PATH`, `sudo apt-get install ${pkg}`));
  }
  checks.push(dockerCheck(host.docker));
  checks.push(
    host.confinement.ok
      ? check("host", "confinement", "pass", "bwrap can create a namespace")
      : check(
          "host",
          "confinement",
          "fail",
          host.confinement.namespaceRefused
            ? `${host.confinement.reason}; check the AppArmor setting kernel.apparmor_restrict_unprivileged_userns${host.confinement.apparmorRestrict !== undefined ? ` (now ${host.confinement.apparmorRestrict})` : ""}`
            : (host.confinement.reason ?? "bubblewrap is not available"),
          confinementFix(host.confinement),
        ),
  );
  checks.push(check("host", "install integrity", host.integrity.status, host.integrity.detail, "sh install.sh --version <version> --home <a fresh directory>   (an installed version is never overwritten in place)"));

  checks.push(cliCheck(d.claude), cliCheck(d.codex));
  checks.push(piCheck(d));
  checks.push(
    d.gh.available
      ? check("agents", "gh", "pass", `${d.gh.version ?? "gh"}; logged in; can read ${d.gh.repo}`)
      : check("agents", "gh", "warn", `${d.gh.reason}; install, upgrade, and automatic updates need it`, d.gh.fix),
  );

  checks.push(...configurationChecks(d));
  checks.push(...setupChecks(d));
  return checks;
}

const ROOTLESS_DOCS = "https://docs.docker.com/engine/security/rootless/";

/**
 * The docker sandbox's prerequisites. Optional, so never a fail: a graph that runs contributor code
 * in a container reports "not run" without it. A rootful daemon works, but a user who can reach it
 * (the `docker` group) is root-equivalent on the host, which is why rootless is recommended.
 */
function dockerCheck(docker: Discovery["host"]["docker"]): DoctorCheck {
  if (docker.path === undefined) {
    return check("host", "docker", "warn", "the docker CLI is not on PATH; graphs that run untrusted code in a container (a docker sandbox) will report \"not run\"", `install Docker Engine, rootless preferred: ${ROOTLESS_DOCS}`);
  }
  if (docker.daemonError !== undefined) {
    return check("host", "docker", "warn", `${docker.path}: the daemon is not reachable by this user (${docker.daemonError}); docker sandbox jobs will report "not run"`, `start the daemon, or set up rootless Docker: ${ROOTLESS_DOCS}`);
  }
  const server = `docker ${docker.serverVersion ?? "(version unknown)"} at ${docker.path}`;
  if (docker.rootless === true) return check("host", "docker", "pass", `${server}; daemon reachable; rootless`);
  const known = docker.rootless === false ? "the daemon is not rootless" : "whether the daemon is rootless could not be read";
  return check(
    "host",
    "docker",
    "warn",
    `${server}; daemon reachable; ${known}. Membership in the docker group is root-equivalent on this host; rootless Docker is recommended`,
    `set up rootless Docker: ${ROOTLESS_DOCS}`,
  );
}

function piCheck(d: Discovery): DoctorCheck {
  const pi = d.pi;
  if (pi.error !== undefined) return check("agents", "pi", "warn", `${pi.reason}: ${pi.error}`, pi.fix);
  const creds = pi.credentials.map((c) => `${c.provider} (${c.source})`);
  const configured = pi.configured.map((c) => `${c.where}: ${c.provider}/${c.modelId}${c.resolves ? "" : " (not in Pi's model registry)"}${c.credential ? "" : " (no credential)"}`);
  const detail = `in-process; credentials present for: ${list(creds)}${configured.length > 0 ? `; ${configured.join("; ")}` : ""}`;
  const unresolved = pi.configured.find((c) => !c.resolves);
  if (unresolved !== undefined) return check("agents", "pi", "warn", detail, unresolved.where === "supervisor config" ? "graphloom setup   (choose a supervisor model Pi knows)" : "graphloom setup   (choose a Pi model Pi knows)");
  if (!pi.available) return check("agents", "pi", "warn", `${detail}; ${pi.reason}`, pi.fix);
  return check("agents", "pi", "pass", detail);
}

function configurationChecks(d: Discovery): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const r = d.runner;
  if (r.config === undefined && r.error === undefined) {
    checks.push(check("configuration", "runner config", r.explicit ? "fail" : "warn", r.explicit ? `${r.file} does not exist` : `none at ${r.file}; run and resume refuse without one`, "graphloom setup"));
  } else if (r.error !== undefined) {
    checks.push(check("configuration", "runner config", "fail", `${r.error}; run would refuse it`, "graphloom setup"));
  } else {
    const enabled = enabledHarnesses(r.config!);
    const missing = enabled.filter((h) => !isAvailable(d, h));
    if (missing.length > 0) {
      const why = missing.map((h) => `${h}: ${unavailability(d, h).reason}`);
      checks.push(check("configuration", "runner config", "fail", `${r.file} enables ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not available (${why.join("; ")})`, missing.map((h) => unavailability(d, h).fix).join("; ") + "; or graphloom setup"));
    } else {
      checks.push(check("configuration", "runner config", "pass", `${r.file}: default ${r.config!.harness}; enabled ${enabled.join(", ")}`));
    }
  }

  const s = d.supervisor;
  if (s.error !== undefined) {
    checks.push(check("configuration", "supervisor config", "fail", `${s.error}; run would refuse it`, "graphloom setup"));
  } else if (s.config === undefined) {
    checks.push(check("configuration", "supervisor config", s.explicit ? "fail" : "warn", s.explicit ? `${s.file} does not exist` : `none at ${s.file}: no automatic recovery`, "graphloom setup"));
  } else {
    const form = s.config.harnesses === undefined ? "the flat Pi form" : "the per-harness form";
    const parts = d.supervisorEnabled.map((c) => `${c.harness}${c.harness === "pi" ? ` (${s.config!.provider}/${s.config!.modelId})` : ""}${c.ok ? "" : `: not available, ${c.reason}`}`);
    const missing = d.supervisorEnabled.filter((c) => !c.ok);
    const detail = `${s.file} (${form}): ${parts.join("; ")}; the repair reviewer uses the same agent`;
    // A listed harness that is not available warns: selection falls back past it. A `select` run refuses fails.
    if (d.supervisorSelectionError !== undefined) checks.push(check("configuration", "supervisor config", "fail", `${detail}; run refuses: ${d.supervisorSelectionError}`, missing.map((c) => c.fix ?? "graphloom setup").join("; ") || "graphloom setup"));
    else checks.push(missing.length === 0 ? check("configuration", "supervisor config", "pass", detail) : check("configuration", "supervisor config", "warn", detail, missing.map((c) => c.fix ?? "graphloom setup").join("; ")));
    // One row per enabled harness: its own probe() (design-supervisor-harnesses.md §7.3, S6).
    for (const c of d.supervisorEnabled) checks.push(supervisorHarnessRow(c, s.config));
  }

  const tokenEnv = r.config?.github?.tokenEnv;
  if (tokenEnv !== undefined) {
    checks.push(
      d.env[tokenEnv]
        ? check("configuration", "github token", "pass", `${tokenEnv} is set`)
        : check("configuration", "github token", "warn", `github.tokenEnv names ${tokenEnv}, which is not set`, `export ${tokenEnv}=<token>   (for example "$(gh auth token)")`),
    );
  }

  const writeTokenEnv = r.config?.github?.writeTokenEnv;
  if (writeTokenEnv !== undefined) {
    checks.push(
      d.env[writeTokenEnv]
        ? check("configuration", "github write token", "pass", `${writeTokenEnv} is set: graphs may post to GitHub (pr-review posts its review)`)
        : check("configuration", "github write token", "warn", `github.writeTokenEnv names ${writeTokenEnv}, which is not set: a graph that posts to GitHub will fail at its write`, `export ${writeTokenEnv}=<token>   (a token with "Pull requests: read and write" on the one repository)`),
    );
  }

  for (const l of d.sessionLaunchers ?? []) {
    const name = `session launcher ${l.harness}`;
    const where = l.setup.source === "environment" ? SESSION_LAUNCHER_ENV[l.harness] : `${l.harness === "claude-code" ? "claude" : "codex"}.sessionLauncher`;
    checks.push(
      l.probe.ok
        ? check("configuration", name, "pass", `${l.setup.argv.join(" ")} (${where}) passes GraphLoom's session arguments through (probe \`${l.probe.command}\`)`)
        : check("configuration", name, "warn", l.setup.argv.length === 0 ? l.probe.output : probeRefusal(l.setup, l.probe), `remove ${where} (graphloom session open then starts plain ${l.harness === "claude-code" ? "claude" : "codex"}), or use the launcher's own resume outside GraphLoom`),
    );
  }

  checks.push(updatesCheck(d));
  checks.push(...skillsChecks(d));
  return checks;
}

/**
 * What an enabled supervisor harness starts on, as the operator configured it
 * (or as the plugin's hints reordered it); empty for a CLI on its own default model.
 */
function startingModel(config: SupervisorConfig, harness: string): string {
  if (harness === "pi") return `${config.provider}/${config.modelId}`;
  if (harness !== "claude-code" && harness !== "codex") return "";
  const first = harnessModels(config, harness)[0];
  return first === undefined || first.modelId === "default" ? "" : `${first.modelId}${first.thinkingLevel !== undefined ? `, ${first.thinkingLevel}` : ""}`;
}

function supervisorHarnessRow(c: SupervisorHarnessCheck, config: SupervisorConfig): DoctorCheck {
  const model = startingModel(config, c.harness);
  const on = model !== "" ? ` on ${model}` : " on its default model";
  return c.ok
    ? check("configuration", `supervisor ${c.harness}`, "pass", `enabled; its probe passed${on} (no provider call)`)
    : check("configuration", `supervisor ${c.harness}`, "warn", `enabled, not available${on}: ${c.reason ?? "its probe failed"}`, c.fix ?? "graphloom setup");
}

/** The effective automatic-update mode, and why automatic updates would be a no-op (§4.4, §5.4). */
export function updatesCheck(d: Discovery): DoctorCheck {
  const u = d.updates;
  const facts: string[] = [`${u.mode} (from ${u.source})`];
  if (u.lastCheck !== undefined) facts.push(`last check ${u.lastCheck.time ?? "at an unknown time"}${u.lastCheck.action !== undefined ? `: ${u.lastCheck.action}` : ""}${u.lastCheck.newest !== undefined ? ` (newest ${u.lastCheck.newest})` : ""}`);
  else if (u.home !== undefined) facts.push("no check yet");
  if (u.skip !== undefined) facts.push(`skipping ${u.skip}`);
  const facts_ = facts.join("; ");
  if (u.mode === "off") {
    return check("configuration", "updates", "warn", `${facts_}: automatic updates are off`, u.source.startsWith("GRAPHLOOM_") ? "unset GRAPHLOOM_DISABLE_AUTOUPDATE to turn them on (graphloom upgrade updates by hand)" : `set "autoUpdate": "auto" in ${u.source} (graphloom upgrade updates by hand)`);
  }
  if (u.home === undefined) {
    return check("configuration", "updates", "warn", `${facts_}: this GraphLoom is not an installed release, so nothing updates it`, "install a release with install.sh, then use the graphloom shim");
  }
  if (!d.gh.available) {
    return check("configuration", "updates", "warn", `${facts_}: a no-op, because ${d.gh.reason}`, d.gh.fix);
  }
  if (u.lastFailure !== undefined) {
    return check("configuration", "updates", "warn", `${facts_}; the last attempt failed${u.lastFailure.version !== undefined ? ` for ${u.lastFailure.version}` : ""}${u.lastFailure.time !== undefined ? ` at ${u.lastFailure.time}` : ""}: ${u.lastFailure.reason ?? "unknown reason"}`, "graphloom upgrade");
  }
  if (u.mode === "auto" && (!u.sshKeygen || !u.canVerify)) {
    return check("configuration", "updates", "warn", `${facts_}: releases are only announced, not installed, because ${!u.sshKeygen ? "ssh-keygen is not installed" : "the current version carries no release/allowed_signers"} to verify their signature`, !u.sshKeygen ? "sudo apt-get install openssh-client" : "graphloom upgrade   (installs by hand)");
  }
  return check("configuration", "updates", "pass", facts_);
}

/**
 * How each vendor's models can supervise here (docs/design-supervisor-harnesses.md
 * §6.2): Claude through the Claude Code harness (your Claude Code login, never an
 * API key) or through Pi with an Anthropic API key; OpenAI through the Codex
 * harness (your Codex login, never an API key) or through Pi with an OpenAI API key; every other vendor
 * through Pi, on whichever providers have a credential.
 */
export function supervisorRoutes(d: Discovery): string[] {
  const piCred = (provider: string): string | undefined => d.pi.credentials.find((c) => c.provider === provider)?.source;
  const viaPi = (provider: string, envVar: string): string => {
    const source = piCred(provider);
    if (d.pi.error !== undefined) return `via Pi (${provider}: Pi's registry could not be read)`;
    return source !== undefined ? `via Pi (${provider}: ${source} present)` : `via Pi (${provider}: no ${envVar})`;
  };
  const claude = d.supervisorCandidates["claude-code"];
  const claudeRoute = claude.ok ? "via Claude Code (logged in)" : `via Claude Code (not available: ${claude.reason ?? "unknown"})`;
  const codexCheck = d.supervisorCandidates.codex;
  const codex = codexCheck.ok ? "via Codex (logged in)" : `via Codex (not available: ${codexCheck.reason ?? "unknown"})`;
  const others = d.pi.credentials.filter((c) => c.provider !== "anthropic" && c.provider !== "openai").map((c) => `${c.provider} (${c.source})`);
  return [
    `Claude: ${claudeRoute} or ${viaPi("anthropic", "ANTHROPIC_API_KEY")}`,
    `OpenAI: ${codex} or ${viaPi("openai", "OPENAI_API_KEY")}`,
    `Gemini, DeepSeek, MiniMax, Kimi, and every other provider: via Pi (${others.length > 0 ? `credentials present for ${others.join(", ")}` : "no other provider has a credential"})`,
  ];
}

function setupChecks(d: Discovery): DoctorCheck[] {
  const v = viableSetups(d);
  const checks: DoctorCheck[] = [];
  if (v.defaultHarness.length === 0) {
    checks.push(check("setups", "default harness", "warn", "no available harness can write (Claude Code or Pi)", missingWriterFixes(d).join("; ")));
  } else {
    checks.push(check("setups", "default harness", "pass", `${v.defaultHarness.map((h, i) => (i === 0 ? `${h} (recommended)` : h)).join(", ")}`));
  }
  const enable = v.enable.map((h) => (h === "codex" ? "codex (read-only jobs)" : h));
  checks.push(check("setups", "also enable", "pass", enable.length > 0 ? `${enable.join(", ")}, so a plugin role such as a Codex reviewer can run` : "no other harness is available"));
  checks.push(check("setups", "supervisor routes", "pass", supervisorRoutes(d).join("; ")));
  if (v.supervisor !== undefined) {
    checks.push(check("setups", "supervisor", "pass", `${v.supervisors.join(", ")} (recommended: ${v.supervisor}; order ${SUPERVISOR_ORDER.join(", ")}); the repair reviewer uses the same agent; a plugin's preference chooses among the enabled ones`));
  } else {
    const fixes = SHIPPED_SUPERVISOR_HARNESSES.map((h) => `${label(h)}: ${d.supervisorCandidates[h].fix ?? "graphloom doctor"}`);
    checks.push(check("setups", "supervisor", "warn", `no supervisor harness this GraphLoom runs is available (${SHIPPED_SUPERVISOR_HARNESSES.map((h) => `${h}: ${d.supervisorCandidates[h].reason}`).join("; ")}): no automatic recovery`, fixes.join("; ")));
  }
  return checks;
}

// ---------------------------------------------------------------- --task

export interface TaskInputs {
  taskPath: string;
  /** The task's `config:` as given, for the role fixes. */
  profile?: string;
  definition?: GraphDefinition;
  /** Why the plugin could not be described. */
  error?: string;
  /** The plugin's environment checks: each id with its failure, if any. */
  environment: Array<{ id: string; argv: string[]; stdout?: string; error?: string }>;
  /**
   * The enabled supervisor harnesses probed as `run` would probe them for this
   * task: on their models reordered by the plugin's hints
   * (`probeEnabledSupervisors` with the preference). Absent: the doctor's own
   * probes, on the operator's first models.
   */
  supervisorEnabled?: SupervisorHarnessCheck[];
}

/**
 * The supervisor selection `run` would make for this task
 * (docs/design-supervisor-harnesses.md §7.3): the operator's config and the
 * plugin's `GraphDefinition.supervisor`, on the doctor's probes, through the
 * same `resolveSupervisorSelection` that `run` and `check` use. `run
 * --supervisor` is a per-invocation flag, so it is not reported.
 */
export function supervisorSelection(d: Discovery, preference?: SupervisorPreference, probed?: readonly SupervisorHarnessCheck[]): DoctorCheck[] {
  const s = d.supervisor;
  if (s.error !== undefined) return [check("task", "supervisor selection", "fail", `run refuses: ${s.error}`, "graphloom setup")];
  if (s.config === undefined) {
    const v = viableSetups(d);
    const wants = preference !== undefined ? `; the plugin prefers ${preference.harnesses.join(", ")}${preference.required === true ? " (required)" : ""}` : "";
    return [check("task", "supervisor selection", "warn", `none: no supervisor config, so the run has no automatic recovery${wants}${v.supervisor !== undefined ? `; ${v.supervisor} is available` : ""}`, "graphloom setup")];
  }
  const enabled = probed ?? d.supervisorEnabled;
  const { outcome, error } = selectionOnProbes(s.config, enabled, preference);
  const fixes = enabled.filter((c) => !c.ok).map((c) => c.fix ?? "graphloom setup").join("; ") || "graphloom setup";
  if (error !== undefined) {
    const fix = /plugin requires/.test(error) ? `${fixes}; or enable one of ${preference!.harnesses.join(", ")} in ${s.file}` : fixes;
    return [check("task", "supervisor selection", "fail", `run refuses: ${error}`, fix)];
  }
  const hints = (outcome!.warnings ?? []).map((w) => check("task", "supervisor model hints", "warn", w, `add the model to the harness's models in ${s.file}, or leave it: the operator's own order applies`));
  const sel = outcome!.selection;
  if (sel === undefined) {
    return [check("task", "supervisor selection", "warn", `none: ${outcome!.none ?? "no enabled supervisor harness is available"}, so the run has no automatic recovery`, fixes), ...hints];
  }
  const mine = enabled.find((c) => c.harness === sel.harness);
  const model = startingModel(withModelHints(s.config, sel.harness, preference), sel.harness);
  const on = model !== "" ? ` (${model})` : "";
  if (mine !== undefined && !mine.ok) {
    // The flat Pi form selects Pi unprobed, as run does; its recovery episode would then fail.
    return [check("task", "supervisor selection", "warn", `${sel.harness}${on} (${sel.source}: ${sel.reason}), which is not available (${mine.reason}), so a recovery episode would fail`, mine.fix ?? "graphloom setup"), ...hints];
  }
  return [check("task", "supervisor selection", "pass", `${sel.harness}${on} (${sel.source}: ${sel.reason}, from ${s.file}); the repair reviewer uses the same agent`), ...hints];
}

/** Each harness that could take `role` instead: available, able to give its access, and distinct where required. */
export function roleAlternatives(d: Discovery, role: AgentRoleDeclaration, roles: readonly AgentRoleDeclaration[]): HarnessName[] {
  const avoid = distinctHarnesses(role, roles);
  return availableHarnesses(d).filter((h) => h !== role.harness && (role.access === "read" || WRITING_HARNESSES.includes(h)) && !avoid.has(h));
}

/** The harnesses of the roles `role` must be distinct from, in either direction. */
function distinctHarnesses(role: AgentRoleDeclaration, roles: readonly AgentRoleDeclaration[]): Set<string> {
  const avoid = new Set<string>();
  for (const other of roles) {
    if (other.role === role.role) continue;
    if ((role.distinctFrom ?? []).includes(other.role) || (other.distinctFrom ?? []).includes(role.role)) avoid.add(other.harness);
  }
  return avoid;
}

/** One check per declared agent role (§4.4). */
export function roleChecks(d: Discovery, roles: readonly AgentRoleDeclaration[], profile: string | undefined): DoctorCheck[] {
  const enabled = d.runner.config !== undefined ? enabledHarnesses(d.runner.config) : [];
  const where = profile ?? "the task's config";
  return roles.map((role) => {
    const name = `role ${role.role}`;
    const head = `${role.role}: ${role.harness} (${role.access})`;
    const known = (HARNESS_ORDER as readonly string[]).includes(role.harness);
    const problems: string[] = [];
    let fix: string | undefined;
    const alternatives = roleAlternatives(d, role, roles);
    const change = (why: string) =>
      alternatives.length > 0 && role.setting !== undefined
        ? `set ${role.setting} to ${alternatives.map((a) => `"${a}"`).join(" or ")} in ${where}${why ? `, or ${why}` : ""}`
        : why || (role.setting !== undefined ? `set ${role.setting} in ${where}` : "change the plugin's configuration");
    const conflicts = roles.filter((o) => o.role !== role.role && o.harness === role.harness && ((role.distinctFrom ?? []).includes(o.role)));
    if (!known) {
      problems.push(`${role.harness} is not a harness GraphLoom runs`);
      fix = change("");
    } else if (conflicts.length > 0) {
      problems.push(`it must not share its harness with ${conflicts.map((c) => c.role).join(", ")}`);
      fix = change("");
    } else if (role.access === "write" && !WRITING_HARNESSES.includes(role.harness as HarnessName)) {
      problems.push(`${role.harness} serves read-only jobs only`);
      fix = change("");
    } else if (!isAvailable(d, role.harness)) {
      const u = unavailability(d, role.harness);
      problems.push(`${role.harness} is not available: ${u.reason}`);
      fix = change(u.fix);
    } else if (!enabled.includes(role.harness as HarnessName)) {
      problems.push(d.runner.config === undefined ? "no runner config enables it" : `the runner config does not enable ${role.harness}`);
      fix = d.runner.config === undefined ? "graphloom setup" : `add "${role.harness}" to "harnesses" in ${d.runner.file} (graphloom setup offers it)`;
    }
    const alt = `alternatives: ${list(alternatives)}`;
    if (problems.length === 0) return check("task", name, "pass", `${head}; enabled and available; ${alt}`);
    return check("task", name, "fail", `${head}: ${problems.join("; ")}; ${alt}`, fix);
  });
}

/** The doctor's `--task` checks (§4.4). */
export function taskChecks(d: Discovery, task: TaskInputs): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (task.definition === undefined) {
    checks.push(check("task", "plugin", "fail", `cannot load the task's plugin: ${task.error ?? "unknown error"}`, `graphloom check ${task.taskPath}`));
    return checks;
  }
  checks.push(check("task", "plugin", "pass", `${task.definition.graphId}@${task.definition.version}`));
  for (const env of task.environment) {
    // A check that prints a state (`ready`, `unavailable: …`, a path) is reported by it, so a graph's non-failing
    // probe (a docker sandbox image, say) shows what it found; one that prints nothing shows its command.
    const printed = env.stdout?.trim().split("\n").at(-1)?.trim() ?? "";
    checks.push(
      env.error === undefined
        ? check("task", `environment ${env.id}`, "pass", printed !== "" ? printed : env.argv.join(" "))
        : check("task", `environment ${env.id}`, "fail", `${env.argv.join(" ")}: ${env.error}`, `make \`${env.argv.join(" ")}\` succeed in the task's repository, then graphloom check ${task.taskPath}`),
    );
  }
  checks.push(...supervisorSelection(d, task.definition.supervisor, task.supervisorEnabled));
  const roles = task.definition.agentRoles ?? [];
  if (roles.length === 0) checks.push(check("task", "agent roles", "pass", "the plugin declares none"));
  checks.push(...roleChecks(d, roles, task.profile));
  return checks;
}

export function doctorReport(d: Discovery, task?: TaskInputs): DoctorReport {
  const checks = [...machineChecks(d), ...(task !== undefined ? taskChecks(d, task) : [])];
  return { ok: !checks.some((c) => c.status === "fail"), checks, available: availableHarnesses(d), viable: viableSetups(d) };
}

const SECTION_TITLE: Record<CheckSection, string> = { host: "Host", agents: "Agents", configuration: "Configuration", setups: "Viable setups", task: "Task" };

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  const width = Math.max(...report.checks.map((c) => c.name.length));
  let section: CheckSection | undefined;
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      lines.push(`${lines.length > 0 ? "\n" : ""}${SECTION_TITLE[section]}`);
    }
    lines.push(`  ${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix !== undefined) lines.push(`  ${" ".repeat(4)}  ${" ".repeat(width)}  fix: ${c.fix}`);
  }
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push("", fails > 0 ? `${fails} failed, ${warns} warning${warns === 1 ? "" : "s"}` : warns > 0 ? `ok, ${warns} warning${warns === 1 ? "" : "s"}` : "ok");
  return lines.join("\n");
}

export function taskProfile(taskPath: string, config: string | undefined): string | undefined {
  return config === undefined ? undefined : path.resolve(path.dirname(taskPath), config);
}

/**
 * The bundled agent skills per agent found here (docs/design-agent-skills.md
 * §3): current, or what `graphloom skills` would do. Edited copies are kept and
 * named; a directory GraphLoom did not write is the user's own.
 */
export function skillsChecks(d: Discovery): DoctorCheck[] {
  const s = d.skills;
  if (s === undefined || s.bundled.length === 0) return [];
  const checks: DoctorCheck[] = [];
  for (const t of s.targets) {
    if (t.agent === "dir" || !t.found) continue;
    const bundled = t.skills.filter((c) => s.bundled.includes(c.name));
    const by = (state: string) => bundled.filter((c) => c.state === state).map((c) => c.name);
    const [missing, outdated, edited, foreign] = [by("missing"), by("outdated"), by("edited"), by("foreign")];
    const notes = [
      ...(edited.length > 0 ? [`edited by you, kept: ${edited.join(", ")}`] : []),
      ...(foreign.length > 0 ? [`not GraphLoom's (no marker), left alone: ${foreign.join(", ")}`] : []),
    ];
    const tail = notes.length > 0 ? `; ${notes.join("; ")}` : "";
    const name = `skills (${t.agent})`;
    if (missing.length === bundled.length) {
      checks.push(check("configuration", name, "warn", `none of the ${bundled.length} GraphLoom skills are installed in ${t.dir}${tail}`, `graphloom skills install --agent ${t.agent}`));
    } else if (missing.length > 0) {
      checks.push(check("configuration", name, "warn", `not installed in ${t.dir}: ${missing.join(", ")}${tail}`, `graphloom skills install --agent ${t.agent}`));
    } else if (outdated.length > 0) {
      checks.push(check("configuration", name, "warn", `from another version in ${t.dir}: ${outdated.join(", ")} (this is ${s.version})${tail}`, `graphloom skills update --agent ${t.agent}`));
    } else {
      checks.push(check("configuration", name, "pass", `${bundled.length - edited.length - foreign.length} current (${s.version}) in ${t.dir}${tail}`));
    }
  }
  // Copies an agent loads twice: from a shared directory it also reads and its own. Never a failure.
  const found = new Set(s.targets.filter((t) => t.agent !== "dir" && t.found).map((t) => t.agent));
  for (const dup of s.duplicates ?? []) {
    if (!found.has(dup.agent)) continue;
    checks.push(
      check(
        "configuration",
        `skills duplicates (${dup.agent})`,
        "warn",
        `${SKILL_AGENT_LABEL[dup.agent]} also reads ${dup.dir}, whose GraphLoom copies duplicate the ones in ${dup.ownDir}: ${dup.skills.join(", ")}`,
        duplicateFix(dup),
      ),
    );
  }
  return checks;
}

export { LOGIN_FIX };
