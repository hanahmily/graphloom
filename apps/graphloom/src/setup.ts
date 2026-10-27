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
 * The supervisor file is today's flat Pi form (`{ provider, modelId }`), which
 * the per-harness form of the supervisor harness design keeps accepting
 * (docs/design-supervisor-harnesses.md §7.2). Claude Code and Codex
 * supervisors are reported but not written until the releases that ship them.
 */
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { HARNESS_LABEL, LOGIN_FIX, RECOMMENDED_PI, availableHarnesses, discover, piCredentialFix, type Discovery } from "./discovery.js";
import { missingWriterFixes, viableSetups } from "./doctor.js";
import { enabledHarnesses, parseRunnerConfig, type HarnessName } from "./runner-config.js";
import { parseSupervisorConfig } from "./supervisor-config.js";

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
}

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
const show = (v: unknown) => (v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));

/** The recommendations for this machine (§4.5). */
export interface Recommendation {
  harness?: HarnessName;
  harnesses: HarnessName[];
  pi?: PiChoice;
  supervisor?: PiChoice;
}

export function recommendedPi(d: Discovery, provider?: string): PiChoice | undefined {
  const providers = d.pi.credentials.map((c) => c.provider);
  const chosen = provider ?? (providers.includes(RECOMMENDED_PI.provider) ? RECOMMENDED_PI.provider : providers[0]);
  if (chosen === undefined) return undefined;
  const models = d.pi.models[chosen] ?? [];
  const modelId = chosen === RECOMMENDED_PI.provider && models.includes(RECOMMENDED_PI.modelId) ? RECOMMENDED_PI.modelId : models[0];
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
    ...(v.supervisor === "pi" && recommendedPi(d) !== undefined ? { supervisor: recommendedPi(d)! } : {}),
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

async function choosePi(p: Prompter, d: Discovery, what: string, start: PiChoice | undefined): Promise<PiChoice | undefined> {
  const providers = d.pi.credentials.map((c) => c.provider);
  const rec = start ?? recommendedPi(d);
  if (rec === undefined) return undefined;
  const provider = providers.length > 1 ? await choose(p, `${what}: Pi provider with a credential`, providers, rec.provider) : rec.provider;
  if (provider === undefined) return undefined;
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
  const supervisorFile = d.supervisor.file;
  const result = (exitCode: 0 | 1, runner: FileOutcome, supervisor: FileOutcome, reason?: string): SetupResult => ({
    exitCode,
    runner,
    supervisor,
    runnerFile,
    supervisorFile,
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
        pi = await choosePi(p!, d, "   Pi", rec.pi);
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
  const existingSup = await readExisting(supervisorFile, parseSupervisorConfig);
  let supNext: Raw | undefined;
  say("");
  say("4. Supervisor: recovers a failing run (investigates, repairs, reenters). The repair reviewer uses the same agent, in a separate read-only session.");
  if (v.supervisorLater.length > 0) say(`   ${v.supervisorLater.map(label).join(" and ")} supervise from the GraphLoom releases that ship them (phases S3, S4); this one supervises with Pi.`);
  if (existingSup === undefined) {
    if (v.supervisor === undefined || rec.supervisor === undefined) {
      say(`   No supervisor harness this GraphLoom runs is available, so none is configured and runs have no automatic recovery. Next: ${piCredentialFix(RECOMMENDED_PI.provider)}`);
    } else if (yes) {
      supNext = supervisorRaw(newSupervisorBase, rec.supervisor);
    } else {
      // The runner's Pi choice, when there is one, is the supervisor's recommendation too.
      const runnerPi = runnerNext?.pi as Raw | undefined;
      const start = runnerPi !== undefined && typeof runnerPi.provider === "string" && typeof runnerPi.modelId === "string" ? { provider: runnerPi.provider, modelId: runnerPi.modelId } : undefined;
      if (start !== undefined) {
        if (await confirm(p!, `   Configure a Pi supervisor on ${start.provider}/${start.modelId}?`, true)) supNext = supervisorRaw(newSupervisorBase, start);
      } else if (await confirm(p!, `   Configure a Pi supervisor (recommended: ${rec.supervisor.provider}/${rec.supervisor.modelId})?`, true)) {
        const pick = await choosePi(p!, d, "   Supervisor", rec.supervisor);
        if (pick === undefined) return result(1, "none", "none", "setup was not completed");
        supNext = supervisorRaw(newSupervisorBase, pick);
      }
      if (supNext === undefined) say("   No supervisor: runs have no automatic recovery.");
    }
  } else if (existingSup.error !== undefined || existingSup.raw === undefined) {
    say(`   ${supervisorFile} exists but run would refuse it: ${existingSup.error}`);
    if (!yes && rec.supervisor !== undefined && (await confirm(p!, `   Replace it with a Pi supervisor on ${rec.supervisor.provider}/${rec.supervisor.modelId}?`, false))) {
      supNext = supervisorRaw(newSupervisorBase, rec.supervisor);
    }
  } else {
    const current = existingSup.raw;
    say(`   ${supervisorFile}: pi ${show(current.provider)}/${show(current.modelId)}`);
    const pi = d.pi.configured.find((c) => c.where === "supervisor config");
    const fine = pi !== undefined && pi.resolves && pi.credential;
    const recRaw = rec.supervisor !== undefined ? supervisorRaw(current, rec.supervisor) : undefined;
    const diffs = recRaw !== undefined ? differences(current, recRaw, ["provider", "modelId"]) : [];
    if (diffs.length === 0 || recRaw === undefined) {
      say(recRaw !== undefined ? "   matches the recommendation; unchanged" : `   ${fine ? "" : "its model is not available here, and "}no supervisor harness this GraphLoom runs is available to recommend; unchanged`);
    } else if (yes) {
      say("   --yes leaves it unchanged; the recommendation differs:");
      for (const line of diffs) say(`     ${line}`);
    } else if (await confirm(p!, `   Change the supervisor model to ${rec.supervisor!.provider}/${rec.supervisor!.modelId}?`, !fine)) {
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
  if (supNext !== undefined) writes.push({ file: supervisorFile, raw: supNext, parse: parseSupervisorConfig, exists: existingSup !== undefined, kind: "supervisor" });
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

  // ---- what remains
  const final = runnerNext ?? existingRunner?.raw;
  const remaining: string[] = [];
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
