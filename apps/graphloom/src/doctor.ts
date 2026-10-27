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
import type { AgentRoleDeclaration, GraphDefinition } from "@graphloom/sdk";
import {
  HARNESS_LABEL,
  HARNESS_ORDER,
  LOGIN_FIX,
  RECOMMENDED_PI,
  SHIPPED_SUPERVISOR_HARNESSES,
  SUPERVISOR_ORDER,
  WRITING_HARNESSES,
  availableHarnesses,
  confinementFix,
  isAvailable,
  piCredentialFix,
  unavailability,
  type CliHarnessDiscovery,
  type Discovery,
} from "./discovery.js";
import { enabledHarnesses, type HarnessName } from "./runner-config.js";

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
  /** Available harnesses that could supervise once their supervisor ships (phases S3, S4). */
  supervisorLater: HarnessName[];
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
  const supervisor = SUPERVISOR_ORDER.find((h) => SHIPPED_SUPERVISOR_HARNESSES.includes(h) && available.includes(h));
  return {
    defaultHarness: writers,
    enable: available.filter((h) => h !== writers[0]),
    ...(supervisor !== undefined ? { supervisor } : {}),
    supervisorLater: SUPERVISOR_ORDER.filter((h) => !SHIPPED_SUPERVISOR_HARNESSES.includes(h) && available.includes(h)),
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
    // Today's supervisor.json is the flat Pi form; the per-harness form arrives with phases S3 to S5.
    const model = `${s.config.provider}/${s.config.modelId}`;
    const pi = d.pi.configured.find((c) => c.where === "supervisor config");
    const piOk = pi !== undefined && pi.resolves && pi.credential;
    checks.push(
      piOk
        ? check("configuration", "supervisor config", "pass", `${s.file}: pi (${model}); the repair reviewer uses the same agent`)
        : check(
            "configuration",
            "supervisor config",
            "warn",
            `${s.file}: pi (${model}) is not available: ${pi === undefined ? "Pi's registry could not be read" : !pi.resolves ? "the model is not in Pi's registry" : `no credential for ${s.config.provider}`}`,
            pi !== undefined && pi.resolves ? piCredentialFix(s.config.provider) : "graphloom setup",
          ),
    );
  }

  const tokenEnv = r.config?.github?.tokenEnv;
  if (tokenEnv !== undefined) {
    checks.push(
      d.env[tokenEnv]
        ? check("configuration", "github token", "pass", `${tokenEnv} is set`)
        : check("configuration", "github token", "warn", `github.tokenEnv names ${tokenEnv}, which is not set`, `export ${tokenEnv}=<token>   (for example "$(gh auth token)")`),
    );
  }

  checks.push(updatesCheck(d));
  return checks;
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
  const later = v.supervisorLater.length > 0 ? `; ${v.supervisorLater.map(label).join(" and ")} ${v.supervisorLater.length === 1 ? "supervises" : "supervise"} from the releases that ship them (phases S3, S4)` : "";
  if (v.supervisor !== undefined) {
    checks.push(check("setups", "supervisor", "pass", `${v.supervisor} (order ${SUPERVISOR_ORDER.join(", ")}); the repair reviewer uses the same agent${later}`));
  } else {
    checks.push(check("setups", "supervisor", "warn", `no supervisor harness this GraphLoom runs is available: no automatic recovery${later}`, piCredentialFix(RECOMMENDED_PI.provider)));
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
  environment: Array<{ id: string; argv: string[]; error?: string }>;
}

/** The supervisor selection `run` would make (docs/design-supervisor-harnesses.md §7.3, as this GraphLoom implements it). */
export function supervisorSelection(d: Discovery): DoctorCheck {
  const s = d.supervisor;
  if (s.error !== undefined) return check("task", "supervisor selection", "fail", `run refuses: ${s.error}`, "graphloom setup");
  if (s.config === undefined) {
    const v = viableSetups(d);
    return check("task", "supervisor selection", "warn", `none: no supervisor config, so the run has no automatic recovery${v.supervisor !== undefined ? `; ${v.supervisor} is available` : ""}`, "graphloom setup");
  }
  // This GraphLoom runs a Pi supervisor from the operator's supervisor.json and
  // applies no plugin preference yet (GraphDefinition.supervisor, phase S5).
  const pi = d.pi.configured.find((c) => c.where === "supervisor config");
  const model = `${s.config.provider}/${s.config.modelId}`;
  if (pi === undefined || !pi.resolves || !pi.credential) {
    return check("task", "supervisor selection", "warn", `pi (${model}, from ${s.file}), which is not available, so a recovery episode would fail`, pi?.resolves ? piCredentialFix(s.config.provider) : "graphloom setup");
  }
  return check("task", "supervisor selection", "pass", `pi (${model}, from ${s.file}: operator); the repair reviewer uses the same agent`);
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
    checks.push(
      env.error === undefined
        ? check("task", `environment ${env.id}`, "pass", env.argv.join(" "))
        : check("task", `environment ${env.id}`, "fail", `${env.argv.join(" ")}: ${env.error}`, `make \`${env.argv.join(" ")}\` succeed in the task's repository, then graphloom check ${task.taskPath}`),
    );
  }
  checks.push(supervisorSelection(d));
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

export { LOGIN_FIX };
