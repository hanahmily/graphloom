// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom setup [--yes]` (docs/design-release.md §4.5): guided first-run
 * configuration. It runs the doctor's discovery and offers only choices that
 * work on this machine, each with a recommendation, then writes the runner
 * config and the supervisor config that `run` reads, each checked by the
 * parser `run` uses, written with mode 0600 to a temporary file and renamed
 * into place. It never asks for a token and never writes one.
 *
 * - `--yes` accepts every recommendation and counts as the operator's consent
 *   to `allowUnrestricted`. A file that exists is left unchanged; its
 *   differences from the recommendation are printed.
 * - Re-running shows the current configuration next to the recommendation and
 *   offers each change. A file is replaced only after the operator confirms,
 *   and the old one is kept as `<name>.bak-<UTC timestamp>`. Unchanged
 *   answers write nothing.
 *
 * The supervisor file lists the available supervisor harnesses the operator
 * keeps, in the built-in order Pi, Claude Code (docs/design-supervisor-harnesses.md
 * §7.2), with no `select`. Pi alone is written in the flat Pi form, which the
 * per-harness parser keeps accepting; any other choice in the per-harness form.
 * A Codex supervisor is reported but not written until the release that ships it.
 *
 * The Pi model is any provider Pi has a credential for (built-in or a
 * models.json custom provider), chosen from what discovery found; setup can
 * also add a custom provider of any API type Pi speaks to the agent dir's
 * models.json, its key referenced by the NAME of an environment variable.
 */
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { FALLBACK_PI, HARNESS_LABEL, LOGIN_FIX, SHIPPED_SUPERVISOR_HARNESSES, availableHarnesses, discover, type Discovery } from "./discovery.js";
import { missingWriterFixes, supervisorRoutes, viableSetups } from "./doctor.js";
import { CUSTOM_PI_APIS, addCustomPiProvider, customProviderProblem, type CustomPiApi, type CustomPiProvider } from "./pi-models.js";
import { enabledHarnesses, parseRunnerConfig, type HarnessName } from "./runner-config.js";
import { enabledSupervisorHarnesses, parseSupervisorConfig } from "./supervisor-config.js";
import { SKILL_AGENT_LABEL, installSkills } from "./skills.js";

/** How setup talks to the operator. */
export interface Prompter {
  say(line: string): void;
  /** The operator's answer, or undefined at end of input. */
  ask(question: string): Promise<string | undefined>;
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** Accept every recommendation without prompting. */
  yes?: boolean;
  /** Required unless `yes`. */
  prompter?: Prompter;
  /** Output for `--yes` and for what setup reports; default the prompter's, else stdout. */
  say?: (line: string) => void;
  discovery?: Discovery;
  now?: () => Date;
}

export type FileOutcome = "written" | "unchanged" | "none";

export interface SetupResult {
  exitCode: 0 | 1;
  runner: FileOutcome;
  supervisor: FileOutcome;
  runnerFile: string;
  supervisorFile: string;
  /** Why setup wrote nothing, when it exits 1. */
  reason?: string;
}

type Raw = Record<string, unknown>;

interface Existing {
  raw?: Raw;
  /** Why the file does not parse with the parser `run` uses. */
  error?: string;
}

interface PiChoice {
  provider: string;
  modelId: string;
  /** A custom provider setup adds to Pi's models.json for this choice. */
  custom?: CustomPiProvider;
}

/** The answer that adds a custom provider instead of choosing a discovered one. */
const NEW_PROVIDER = "new";

const label = (h: string) => HARNESS_LABEL[h as HarnessName] ?? h;

async function readExisting(file: string, parse: (value: unknown, source: string) => unknown): Promise<Existing | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { error: err instanceof Error ? err.message : String(err) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${file}: invalid JSON` };
  }
  try {
    parse(raw, file);
  } catch (err) {
    return { raw: raw as Raw, error: err instanceof Error ? err.message : String(err) };
  }
  return { raw: raw as Raw };
}

/** `2026-10-27T05:17:00.123Z` as `20261027T051700Z`. */
export function backupStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** Validated, written to a temporary file with mode 0600, and renamed into place; an existing file is first kept as `.bak-<stamp>`. */
async function writeConfig(file: string, raw: Raw, parse: (value: unknown, source: string) => unknown, backup: boolean, now: Date): Promise<string | undefined> {
  parse(raw, file);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let kept: string | undefined;
  if (backup) {
    kept = `${file}.bak-${backupStamp(now)}`;
    await copyFile(file, kept, constants.COPYFILE_EXCL);
    await chmod(kept, 0o600);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  return kept;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const same_ = same;
const show = (v: unknown) => (v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));

/** The recommendations for this machine (§4.5). */
export interface Recommendation {
  harness?: HarnessName;
  harnesses: HarnessName[];
  pi?: PiChoice;
  /** The Pi supervisor's model, when Pi is among `supervisors`. */
  supervisor?: PiChoice;
  /** The supervisor harnesses to enable, in the built-in order. */
  supervisors: HarnessName[];
}

/**
 * The Pi model to recommend (§4.5), among providers with a credential: the
 * model already configured for `role` (else for the other role) when its
 * provider has a credential, else the first provider with one, in Pi's
 * registry order. The model is the configured one when it resolves, else
 * FALLBACK_PI's model on its provider, else Pi's own default for the provider.
 */
export function recommendedPi(d: Discovery, provider?: string, role: "runner" | "supervisor" = "runner"): PiChoice | undefined {
  const providers = d.pi.credentials.map((c) => c.provider);
  const isSupervisor = (where: string) => where === "supervisor config";
  const configured = [...d.pi.configured]
    .filter((c) => c.credential && providers.includes(c.provider))
    .sort((a, b) => Number(isSupervisor(b.where) === (role === "supervisor")) - Number(isSupervisor(a.where) === (role === "supervisor")));
  const chosen = provider ?? configured[0]?.provider ?? providers[0];
  if (chosen === undefined || !providers.includes(chosen)) return undefined;
  const models = d.pi.models[chosen] ?? [];
  const mine = configured.find((c) => c.provider === chosen && c.resolves && models.includes(c.modelId));
  const fallback = chosen === FALLBACK_PI.provider && models.includes(FALLBACK_PI.modelId) ? FALLBACK_PI.modelId : undefined;
  const piDefault = d.pi.defaults?.[chosen];
  const modelId = mine?.modelId ?? fallback ?? (piDefault !== undefined && models.includes(piDefault) ? piDefault : models[0]);
  return modelId === undefined ? undefined : { provider: chosen, modelId };
}

export function recommend(d: Discovery): Recommendation {
  const v = viableSetups(d);
  const harnesses = availableHarnesses(d);
  const pi = harnesses.includes("pi") ? recommendedPi(d) : undefined;
  return {
    ...(v.defaultHarness[0] !== undefined ? { harness: v.defaultHarness[0] } : {}),
    harnesses,
    ...(pi !== undefined ? { pi } : {}),
    ...(v.supervisors.includes("pi") && recommendedPi(d, undefined, "supervisor") !== undefined ? { supervisor: recommendedPi(d, undefined, "supervisor")! } : {}),
    supervisors: v.supervisors.filter((h) => h !== "pi" || recommendedPi(d, undefined, "supervisor") !== undefined),
  };
}

/** The runner config's managed fields from the choices; every other field of `base` is kept. */
function runnerRaw(base: Raw | undefined, harness: HarnessName, enabled: HarnessName[], pi: PiChoice | undefined): Raw {
  const out: Raw = { ...(base ?? {}), harness, allowUnrestricted: true };
  const others = enabled.filter((h) => h !== harness);
  if (others.length > 0) out.harnesses = [harness, ...others];
  else delete out.harnesses;
  if (pi !== undefined) out.pi = { ...((base?.pi as Raw | undefined) ?? {}), provider: pi.provider, modelId: pi.modelId };
  return out;
}

function supervisorRaw(base: Raw | undefined, pi: PiChoice): Raw {
  return { ...(base ?? {}), provider: pi.provider, modelId: pi.modelId };
}

/** Settings every supervisor harness shares, at the top level of either form. */
const SHARED_SUPERVISOR_KEYS = ["promptTimeoutMs", "promptTotalTimeoutMs", "quotaRetryMs"];

/**
 * A supervisor.json enabling `harnesses` in order: the flat Pi form for Pi
 * alone, otherwise the per-harness form (`harnesses`, `pi`, `claude`,
 * `codex`; no `select`, so a plugin's preference still applies). `piBase`
 * carries Pi's other settings (such as `agentDir`); `shared` the shared
 * prompt limits.
 */
export function supervisorFile(harnesses: readonly HarnessName[], pi: PiChoice | undefined, claude: Raw, piBase: Raw | undefined, shared: Raw = {}, codex: Raw = {}): Raw {
  if (harnesses.length === 1 && harnesses[0] === "pi" && pi !== undefined) return { ...shared, ...supervisorRaw(piBase, pi) };
  const out: Raw = { ...shared, harnesses: [...harnesses] };
  if (harnesses.includes("pi") && pi !== undefined) out.pi = supervisorRaw(piBase, pi);
  if (harnesses.includes("claude-code")) out.claude = { ...claude };
  if (harnesses.includes("codex")) out.codex = { ...codex };
  return out;
}

const pickShared = (raw: Raw): Raw => Object.fromEntries(SHARED_SUPERVISOR_KEYS.filter((k) => k in raw).map((k) => [k, raw[k]]));

/** Field-by-field differences of two configs, as `name: current -> recommended`. */
function differences(current: Raw | undefined, next: Raw, fields: string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const a = current?.[f];
    const b = next[f];
    if (f === "pi") {
      for (const k of ["provider", "modelId"]) {
        const x = (a as Raw | undefined)?.[k];
        const y = (b as Raw | undefined)?.[k];
        if (y !== undefined && !same(x, y)) out.push(`pi.${k}: ${show(x)} -> ${show(y)}`);
      }
      continue;
    }
    if (!same(a, b)) out.push(`${f}: ${show(a)} -> ${show(b)}`);
  }
  return out;
}

/**
 * Offers the bundled agent skills to each agent discovery found whose copies
 * are missing or outdated (default yes). `--yes` installs nothing outside the
 * config directory: it prints the command instead.
 */
async function offerSkills(d: Discovery, yes: boolean, p: Prompter | undefined, say: (line: string) => void, now: Date): Promise<void> {
  const s = d.skills;
  if (s === undefined || s.bundled.length === 0) return;
  for (const t of s.targets) {
    if (t.agent === "dir" || !t.found) continue;
    const pending = t.skills.filter((c) => s.bundled.includes(c.name) && (c.state === "missing" || c.state === "outdated")).map((c) => c.name);
    if (pending.length === 0) continue;
    const agent = t.agent;
    const label = SKILL_AGENT_LABEL[agent];
    say("");
    say(`GraphLoom ships agent skills for driving it from ${label} (${pending.join(", ")}); they would go to ${t.dir}.`);
    if (yes) {
      say(`  --yes installs nothing there; run graphloom skills install --agent ${agent} to add them`);
      continue;
    }
    if (!(await confirm(p!, `  Install them for ${label}?`, true))) {
      say(`  not installed; graphloom skills install --agent ${agent} adds them later`);
      continue;
    }
    try {
      await installSkills({ agents: [agent], root: d.root, env: d.env, now, say: (line) => say(`  ${line}`) });
    } catch (err) {
      say(`  could not install them: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function confirm(p: Prompter, question: string, def: boolean): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const answer = await p.ask(`${question} [${def ? "Y/n" : "y/N"}] `);
    if (answer === undefined) return false;
    const a = answer.trim().toLowerCase();
    if (a === "") return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
    p.say("  please answer y or n");
  }
  return def;
}

async function choose(p: Prompter, question: string, options: readonly string[], def: string): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const answer = await p.ask(`${question} [${options.join("/")}] (recommended: ${def}) `);
    if (answer === undefined) return undefined;
    const a = answer.trim();
    if (a === "") return def;
    if (options.includes(a)) return a;
    p.say(`  choose one of ${options.join(", ")}`);
  }
  return def;
}

async function ask(p: Prompter, question: string, check: (answer: string) => string | undefined): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const answer = await p.ask(question);
    if (answer === undefined) return undefined;
    const a = answer.trim();
    const problem = check(a);
    if (problem === undefined) return a;
    p.say(`  ${problem}`);
  }
  return undefined;
}

/**
 * A custom Pi provider of any API type Pi speaks: its id, API type, base URL,
 * model id, and the NAME of the environment variable holding its key. The key
 * itself is never asked for.
 */
async function askCustomProvider(p: Prompter, d: Discovery, what: string): Promise<PiChoice | undefined> {
  const known = d.pi.known ?? d.pi.credentials.map((c) => c.provider);
  // Each answer is checked alone, against valid placeholders for the rest.
  const draft: CustomPiProvider = { id: "graphloom-placeholder", api: "openai-completions", baseUrl: "https://example.invalid", modelId: "m", envVar: "KEY" };
  const problem = (patch: Partial<CustomPiProvider>) => customProviderProblem({ ...draft, ...patch }, known);
  p.say(`${what}: a custom provider is added to ${d.pi.agentDir}/models.json in Pi's own format; its apiKey names an environment variable, never the key.`);
  const id = await ask(p, `${what}: provider id (for example my-endpoint) `, (a) => problem({ id: a }));
  if (id === undefined) return undefined;
  const api = (await choose(p, `${what}: API type`, CUSTOM_PI_APIS, "openai-completions")) as CustomPiApi | undefined;
  if (api === undefined) return undefined;
  const baseUrl = await ask(p, `${what}: base URL (for example https://api.example.com/v1) `, (a) => problem({ baseUrl: a }));
  if (baseUrl === undefined) return undefined;
  const modelId = await ask(p, `${what}: model id `, (a) => problem({ modelId: a }));
  if (modelId === undefined) return undefined;
  const envVar = await ask(p, `${what}: NAME of the environment variable that holds the key (not the key itself) `, (a) => problem({ envVar: a }));
  if (envVar === undefined) return undefined;
  const custom: CustomPiProvider = { id, api, baseUrl, modelId, envVar };
  return { provider: id, modelId, custom };
}

async function choosePi(p: Prompter, d: Discovery, what: string, start: PiChoice | undefined): Promise<PiChoice | undefined> {
  const providers = d.pi.credentials.map((c) => c.provider);
  const rec = start ?? recommendedPi(d);
  if (rec === undefined) return undefined;
  const offered = providers.includes(rec.provider) ? providers : [rec.provider, ...providers];
  const provider = await choose(p, `${what}: Pi provider with a credential, or ${NEW_PROVIDER} to add a custom one`, [...offered, NEW_PROVIDER], rec.provider);
  if (provider === undefined) return undefined;
  if (provider === NEW_PROVIDER) return askCustomProvider(p, d, what);
  if (rec.custom !== undefined && provider === rec.provider) return rec;
  const models = d.pi.models[provider] ?? [];
  const def = provider === rec.provider ? rec.modelId : recommendedPi(d, provider)?.modelId;
  if (def === undefined) return undefined;
  for (let i = 0; i < 3; i++) {
    const shown = models.slice(0, 6).join(", ");
    const answer = await p.ask(`${what}: ${provider} model (recommended: ${def}; Pi knows ${shown}${models.length > 6 ? ", ..." : ""}) `);
    if (answer === undefined) return undefined;
    const a = answer.trim();
    if (a === "") return { provider, modelId: def };
    if (models.includes(a)) return { provider, modelId: a };
    p.say(`  ${provider}/${a} is not in Pi's model registry`);
  }
  return { provider, modelId: def };
}

/** Guided setup (§4.5). */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const yes = options.yes === true;
  const p = options.prompter;
  const say = options.say ?? p?.say.bind(p) ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  if (!yes && p === undefined) throw new Error("graphloom setup needs a terminal to ask its questions; run graphloom setup --yes to accept the recommendations");

  say("graphloom setup: discovering what this machine can run (graphloom doctor shows the details)");
  const found = options.discovery ?? (await discover(env));
  // Setup can configure Pi whenever a provider has a credential, even when the
  // current runner config names a model Pi does not know: that is what it repairs.
  const piCandidate = found.pi.error === undefined && found.pi.credentials.length > 0;
  // A new supervisor reads Pi from where discovery found its credentials and models: a non-default agent dir is written too.
  const newSupervisorBase: Raw | undefined = found.pi.agentDir !== path.join(env.HOME ?? os.homedir(), ".pi", "agent") ? { agentDir: found.pi.agentDir } : undefined;
  const d: Discovery = piCandidate && !found.pi.available ? { ...found, pi: { ...found.pi, available: true } } : found;
  const runnerFile = d.runner.file;
  const supervisorFile_ = d.supervisor.file;
  const result = (exitCode: 0 | 1, runner: FileOutcome, supervisor: FileOutcome, reason?: string): SetupResult => ({
    exitCode,
    runner,
    supervisor,
    runnerFile,
    supervisorFile: supervisorFile_,
    ...(reason !== undefined ? { reason } : {}),
  });

  for (const h of ["claude-code", "codex", "pi"] as const) {
    const it = h === "claude-code" ? d.claude : h === "codex" ? d.codex : d.pi;
    say(`  ${label(h).padEnd(11)} ${it.available ? "available" : `not available: ${it.reason ?? "unknown"}`}`);
  }

  const v = viableSetups(d);
  if (v.defaultHarness.length === 0) {
    say("No available harness can write (Claude Code or Pi), so setup writes nothing. Next:");
    for (const fix of missingWriterFixes(d)) say(`  ${fix}`);
    return result(1, "none", "none", "no available harness can write");
  }
  const rec = recommend(d);
  /** Custom Pi providers the operator added, written to models.json with the configs. */
  const customs = new Map<string, CustomPiProvider>();
  const keep = (choice: PiChoice | undefined): PiChoice | undefined => {
    if (choice?.custom !== undefined) customs.set(choice.custom.id, choice.custom);
    return choice;
  };
  const available = availableHarnesses(d);

  // ---- runner config
  const existingRunner = await readExisting(runnerFile, parseRunnerConfig);
  let runnerNext: Raw | undefined;
  let needConsent = false;
  /** Whether replacing the existing file was already confirmed. */
  let runnerConfirmed = false;
  let fresh = existingRunner === undefined;
  if (existingRunner !== undefined && existingRunner.error !== undefined) {
    say(`${runnerFile} exists but run would refuse it: ${existingRunner.error}`);
    if (yes) say("  --yes leaves an existing file unchanged; fix it, or rerun graphloom setup without --yes to replace it");
    else if (await confirm(p!, `Replace ${runnerFile} with a new configuration? (the old file is kept as a .bak- copy)`, false)) {
      fresh = true;
      runnerConfirmed = true;
    }
  }
  if (fresh) {
    let harness = rec.harness!;
    let enabled = [...available];
    let pi = rec.pi;
    if (!yes) {
      say("");
      say("1. Default harness: agent jobs that name no harness run on it. It must be able to write.");
      if (v.defaultHarness.length > 1) {
        const picked = await choose(p!, "   Default harness", v.defaultHarness, rec.harness!);
        if (picked === undefined) return result(1, "none", "none", "setup was not completed");
        harness = picked as HarnessName;
      } else {
        say(`   ${harness} (the only available harness that can write)`);
      }
      say("2. Other harnesses: a job (such as a plugin's Codex reviewer) may choose any enabled one.");
      enabled = [harness];
      for (const h of available.filter((x) => x !== harness)) {
        if (await confirm(p!, `   Also enable ${label(h)}${h === "codex" ? " (read-only jobs only)" : ""}?`, true)) enabled.push(h);
      }
      if (enabled.includes("pi")) {
        say("3. Pi model: a provider whose credential is present.");
        pi = keep(await choosePi(p!, d, "   Pi", rec.pi));
        if (pi === undefined) return result(1, "none", "none", "setup was not completed");
      }
    }
    runnerNext = runnerRaw(undefined, harness, enabled, enabled.includes("pi") ? pi : undefined);
    needConsent = true;
  } else if (existingRunner?.raw !== undefined && existingRunner.error === undefined) {
    const current = existingRunner.raw;
    const currentEnabled = enabledHarnesses(parseRunnerConfig(current, runnerFile));
    const curPi = current.pi as Raw | undefined;
    const recRaw = runnerRaw(current, rec.harness!, rec.harnesses, rec.harnesses.includes("pi") ? rec.pi : undefined);
    const diffs = differences(current, recRaw, ["harness", "harnesses", "pi"]);
    say("");
    say(`Runner config ${runnerFile}: harness ${show(current.harness)}, enabled ${currentEnabled.join(", ")}${curPi !== undefined ? `, pi ${show(curPi.provider)}/${show(curPi.modelId)}` : ""}`);
    say(`  recommended: harness ${rec.harness}, enabled ${rec.harnesses.join(", ")}${rec.harnesses.includes("pi") && rec.pi !== undefined ? `, pi ${rec.pi.provider}/${rec.pi.modelId}` : ""}`);
    if (diffs.length === 0) {
      say("  matches the recommendation; unchanged");
    } else if (yes) {
      say("  --yes leaves it unchanged; the recommendation differs:");
      for (const line of diffs) say(`    ${line}`);
    } else {
      let harness = current.harness as HarnessName;
      if (harness !== rec.harness && (await confirm(p!, `  Change the default harness from ${harness} to ${rec.harness}?`, true))) harness = rec.harness!;
      const wanted = new Set<HarnessName>(currentEnabled);
      for (const h of rec.harnesses.filter((x) => !currentEnabled.includes(x) && x !== harness)) {
        if (await confirm(p!, `  Enable ${label(h)}${h === "codex" ? " (read-only jobs only)" : ""}, which is available?`, true)) wanted.add(h);
      }
      for (const h of currentEnabled.filter((x) => !available.includes(x) && x !== harness)) {
        if (await confirm(p!, `  Disable ${label(h)}, which is not available?`, true)) wanted.delete(h);
      }
      wanted.add(harness);
      const order = (["claude-code", "codex", "pi"] as const).filter((h) => wanted.has(h));
      let pi: PiChoice | undefined = curPi !== undefined && typeof curPi.provider === "string" && typeof curPi.modelId === "string" ? { provider: curPi.provider, modelId: curPi.modelId } : undefined;
      if (order.includes("pi") && rec.pi !== undefined && (pi?.provider !== rec.pi.provider || pi?.modelId !== rec.pi.modelId)) {
        if (await confirm(p!, `  Change the Pi model from ${show(curPi?.provider)}/${show(curPi?.modelId)} to ${rec.pi.provider}/${rec.pi.modelId}?`, true)) pi = rec.pi;
      }
      const next = runnerRaw(current, harness, [...order], undefined);
      if (pi !== undefined && (curPi !== undefined || order.includes("pi"))) next.pi = { ...(curPi ?? {}), provider: pi.provider, modelId: pi.modelId };
      if (!same(next, current)) runnerNext = next;
      else say("  no change chosen; unchanged");
    }
  }

  // ---- supervisor config
  const existingSup = await readExisting(supervisorFile_, parseSupervisorConfig);
  let supNext: Raw | undefined;
  const claudeSection = d.claudeSupervisorSection;
  const codexSection = d.codexSupervisorSection;
  say("");
  say("4. Supervisor: recovers a failing run (investigates, repairs, reenters). The repair reviewer uses the same agent, in a separate read-only session.");
  for (const route of supervisorRoutes(d)) say(`   ${route}`);
  const recFile = rec.supervisors.length > 0 ? supervisorFile(rec.supervisors, rec.supervisor, claudeSection, newSupervisorBase, {}, codexSection) : undefined;
  if (existingSup === undefined) {
    if (recFile === undefined) {
      const fixes = SHIPPED_SUPERVISOR_HARNESSES.map((h) => `${label(h)}: ${d.supervisorCandidates[h].fix ?? "graphloom doctor"}`);
      say(`   No supervisor harness this GraphLoom runs is available, so none is configured and runs have no automatic recovery. Next: ${fixes.join("; ")}`);
    } else if (yes) {
      supNext = recFile;
    } else {
      say(`   Available, in the built-in order: ${rec.supervisors.join(", ")} (recommended: ${rec.supervisors[0]}). A run uses the plugin's preference among the enabled ones, else the first one available.`);
      const chosen: HarnessName[] = [];
      let pi: PiChoice | undefined;
      for (const h of rec.supervisors) {
        if (h === "pi") {
          // The runner's Pi choice, when there is one, is the supervisor's recommendation too.
          const runnerPi = runnerNext?.pi as Raw | undefined;
          const start = runnerPi !== undefined && typeof runnerPi.provider === "string" && typeof runnerPi.modelId === "string" ? { provider: runnerPi.provider, modelId: runnerPi.modelId } : undefined;
          if (start !== undefined) {
            if (await confirm(p!, `   Enable a Pi supervisor on ${start.provider}/${start.modelId}?`, true)) {
              chosen.push("pi");
              pi = start;
            }
          } else if (await confirm(p!, `   Enable a Pi supervisor (recommended: ${rec.supervisor!.provider}/${rec.supervisor!.modelId})?`, true)) {
            pi = keep(await choosePi(p!, d, "   Supervisor", rec.supervisor));
            if (pi === undefined) return result(1, "none", "none", "setup was not completed");
            chosen.push("pi");
          }
        } else if (await confirm(p!, `   Enable a ${label(h)} supervisor (your own ${label(h)} login)?`, true)) {
          chosen.push(h);
        }
      }
      if (chosen.length > 0) supNext = supervisorFile(chosen, pi, claudeSection, newSupervisorBase, {}, codexSection);
      else say("   No supervisor: runs have no automatic recovery.");
    }
  } else if (existingSup.error !== undefined || existingSup.raw === undefined) {
    say(`   ${supervisorFile_} exists but run would refuse it: ${existingSup.error}`);
    if (!yes && recFile !== undefined && (await confirm(p!, `   Replace it with a supervisor on ${rec.supervisors.join(", ")}?`, false))) supNext = recFile;
  } else {
    const current = existingSup.raw;
    const parsed = parseSupervisorConfig(current, supervisorFile_);
    const enabled = enabledSupervisorHarnesses(parsed);
    say(`   ${supervisorFile_}: ${enabled.map((h) => (h === "pi" ? `pi ${parsed.provider}/${parsed.modelId}` : h)).join(", ")}`);
    say(`   recommended: ${rec.supervisors.length > 0 ? rec.supervisors.map((h) => (h === "pi" && rec.supervisor !== undefined ? `pi ${rec.supervisor.provider}/${rec.supervisor.modelId}` : h)).join(", ") : "none available"}`);
    const fine = d.supervisorEnabled.every((c) => c.ok);
    // The Pi recommendation comes from the agent dir discovery read; it applies only to a supervisor that reads the same one.
    const supDir = parsed.agentDir ?? path.join(env.HOME ?? os.homedir(), ".pi", "agent");
    const piComparable = !enabled.includes("pi") || supDir === d.pi.agentDir;
    const currentPi = current.pi !== undefined ? (current.pi as Raw) : current.harnesses === undefined ? current : undefined;
    const piBase = currentPi !== undefined ? Object.fromEntries(Object.entries(currentPi).filter(([k]) => !["provider", "modelId", ...SHARED_SUPERVISOR_KEYS].includes(k))) : newSupervisorBase;
    const claudeBase = (current.claude as Raw | undefined) ?? claudeSection;
    const codexBase = (current.codex as Raw | undefined) ?? codexSection;
    const recRaw = rec.supervisors.length > 0 && piComparable ? supervisorFile(rec.supervisors, rec.supervisor, claudeBase, piBase, pickShared(current), codexBase) : undefined;
    const samePi = !rec.supervisors.includes("pi") || (parsed.provider === rec.supervisor?.provider && parsed.modelId === rec.supervisor?.modelId);
    const same = recRaw === undefined || (same_(enabled, rec.supervisors) && samePi);
    if (same) {
      say(recRaw !== undefined ? "   matches the recommendation; unchanged" : `   ${fine ? "" : "a harness it enables is not available here, and "}no recommendation applies to it; unchanged`);
    } else if (yes) {
      say("   --yes leaves it unchanged; the recommendation differs:");
      if (!same_(enabled, rec.supervisors)) say(`     harnesses: ${enabled.join(", ")} -> ${rec.supervisors.join(", ")}`);
      if (!samePi) say(`     pi: ${parsed.provider}/${parsed.modelId} -> ${rec.supervisor?.provider}/${rec.supervisor?.modelId}`);
    } else if (await confirm(p!, `   Change the supervisor to ${rec.supervisors.map((h) => (h === "pi" && rec.supervisor !== undefined ? `pi ${rec.supervisor.provider}/${rec.supervisor.modelId}` : h)).join(", ")}?`, !fine)) {
      supNext = recRaw;
    } else {
      say("   unchanged");
    }
  }

  // ---- consent
  if (needConsent && runnerNext !== undefined) {
    say("");
    say("5. Consent. Coding agents run shell commands with your user permissions. Confinement (bubblewrap)");
    say("   limits what they write, not everything a shell can do: they can read what you can read and use");
    say('   the network. The runner config records your consent as "allowUnrestricted": true.');
    if (yes) say("   --yes counts as your consent.");
    else if (!(await confirm(p!, "   Allow coding agents to run with your user permissions?", false))) {
      say("Declined: setup wrote nothing.");
      return result(1, "none", "none", "allowUnrestricted was declined");
    }
  }

  // ---- write
  let runnerOutcome: FileOutcome = existingRunner !== undefined ? "unchanged" : "none";
  let supOutcome: FileOutcome = existingSup !== undefined ? "unchanged" : "none";
  const writes: Array<{ file: string; raw: Raw; parse: (v: unknown, s: string) => unknown; exists: boolean; kind: "runner" | "supervisor" }> = [];
  if (runnerNext !== undefined) writes.push({ file: runnerFile, raw: runnerNext, parse: parseRunnerConfig, exists: existingRunner !== undefined, kind: "runner" });
  if (supNext !== undefined) writes.push({ file: supervisorFile_, raw: supNext, parse: parseSupervisorConfig, exists: existingSup !== undefined, kind: "supervisor" });
  const customNotes: string[] = [];
  if (writes.length > 0) {
    for (const custom of customs.values()) {
      try {
        const kept = await addCustomPiProvider(d.pi.agentDir, custom, backupStamp(now()));
        say(`added provider ${custom.id} (${custom.api} at ${custom.baseUrl}, key from $${custom.envVar}) to ${path.join(d.pi.agentDir, "models.json")}${kept !== undefined ? ` (the old file is ${kept})` : ""}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        say(`Could not add provider ${custom.id}: ${reason}; setup wrote nothing.`);
        return result(1, "none", "none", reason);
      }
      if (!env[custom.envVar]) customNotes.push(`export ${custom.envVar}=<key>   (the key of the ${custom.id} provider; Pi's models.json references $${custom.envVar})`);
    }
  }
  for (const w of writes) {
    if (w.exists && !yes && !(w.kind === "runner" && runnerConfirmed)) {
      say("");
      say(`${w.file} would become:`);
      for (const line of JSON.stringify(w.raw, null, 2).split("\n")) say(`  ${line}`);
      if (!(await confirm(p!, `Replace ${w.file}? The old file is kept as a .bak- copy.`, true))) {
        say(`  ${w.file} unchanged`);
        continue;
      }
    }
    const kept = await writeConfig(w.file, w.raw, w.parse, w.exists, now());
    say(`wrote ${w.file}${kept !== undefined ? ` (the old file is ${kept})` : ""}`);
    if (w.kind === "runner") runnerOutcome = "written";
    else supOutcome = "written";
  }

  // ---- agent skills (docs/design-agent-skills.md §3)
  await offerSkills(d, yes, p, say, now());

  // ---- what remains
  const final = runnerNext ?? existingRunner?.raw;
  const remaining: string[] = [...customNotes];
  if (final !== undefined) {
    let enabled: HarnessName[] = [];
    try {
      enabled = enabledHarnesses(parseRunnerConfig(final, runnerFile));
    } catch {
      enabled = [];
    }
    for (const h of enabled) {
      if (h === "pi") {
        if (!d.pi.available && d.pi.fix !== undefined) remaining.push(d.pi.fix);
        continue;
      }
      const it = h === "claude-code" ? d.claude : d.codex;
      if (it.login !== "logged-in") remaining.push(it.path === undefined ? (it.fix ?? LOGIN_FIX[h]) : LOGIN_FIX[h]);
    }
    const tokenEnv = (final.github as Raw | undefined)?.tokenEnv;
    if (typeof tokenEnv === "string" && !env[tokenEnv]) remaining.push(`export ${tokenEnv}=<token>   (github.tokenEnv; for example "$(gh auth token)")`);
  }
  say("");
  if (remaining.length > 0) {
    say("What remains:");
    for (const line of [...new Set(remaining)]) say(`  ${line}`);
  }
  say('Graphs that read GitHub name a token variable in github.tokenEnv (the examples use GRAPHLOOM_GITHUB_LIVE_TOKEN); setup never asks for or writes a token.');
  say("Check the result with graphloom doctor.");
  return result(0, runnerOutcome, supOutcome);
}

/**
 * A prompter on the terminal: questions on `output`, answers from `input`, end
 * of input as no answer. A line typed ahead of its question is kept for it.
 * readline's own prompt is empty, so a redraw never prints a stray default
 * prompt.
 */
export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter & { close(): void } {
  const rl = createInterface({ input, output, terminal: (input as { isTTY?: boolean }).isTTY === true });
  rl.setPrompt("");
  let closed = false;
  const lines: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next !== undefined) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(undefined);
  });
  return {
    say: (line) => output.write(`${line}\n`),
    ask: (question) => {
      output.write(question);
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

/** Whether this invocation may prompt (§4.5): stdin and stdout are terminals, no `--json`, and not inside an `--on-stop` hook. */
export function isInteractive(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !args.includes("--json") && !env.GRAPHLOOM_RUN_ID;
}
