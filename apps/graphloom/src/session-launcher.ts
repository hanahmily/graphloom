// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_BIN_ENV, CODEX_BIN_ENV } from "@graphloom/executor-coding-agent";
import type { RunnerConfig } from "./runner-config.js";

export type SessionHarness = "claude-code" | "codex";

/** `GRAPHLOOM_CLAUDE_SESSION_LAUNCHER` and `GRAPHLOOM_CODEX_SESSION_LAUNCHER` replace the configured launcher for one invocation. */
export const SESSION_LAUNCHER_ENV: Record<SessionHarness, string> = {
  "claude-code": "GRAPHLOOM_CLAUDE_SESSION_LAUNCHER",
  codex: "GRAPHLOOM_CODEX_SESSION_LAUNCHER",
};

/** The flags a launcher must pass through to Claude Code for `session open` (`<launcher> --help` lists them). */
export const CLAUDE_FORK_FLAGS: readonly string[] = ["--resume", "--fork-session", "--session-id", "--append-system-prompt"];

/**
 * Split `text` into words as a shell would, honoring single quotes, double quotes and backslashes, and
 * expanding nothing: no variables, globs, tildes or substitutions, so an override cannot run anything but the
 * command it names.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) word += text[(i += 1)]!;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[(i += 1)]!;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || word !== "") words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote !== undefined) throw new Error("unterminated quote");
  if (started || word !== "") words.push(word);
  return words;
}

export interface SessionSetup {
  harness: SessionHarness;
  /** The agent's own command (`claude.command`, `GRAPHLOOM_CLAUDE_BIN`, or `claude`). */
  command: string;
  /** The argv prefix `session open` starts: the launcher when one is set, else the command. */
  argv: string[];
  /** Where the prefix came from: the environment override, the runner config, or the plain command. */
  source: "environment" | "runner config" | "command";
  /** Directories the launcher keeps its own state in. */
  stateDirs: string[];
  /** Claude Code's config dir, or the Codex home: the store a session is restored into. */
  store: string;
  passEnv: string[];
}

const envNames = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");

/** What starts the agent for `session open`, from the runner config (may be absent) and the environment. */
export function sessionSetup(harness: SessionHarness, config: RunnerConfig | undefined, env: NodeJS.ProcessEnv): SessionSetup {
  const section = harness === "claude-code" ? config?.claude : config?.codex;
  const command = section?.command ?? (env[harness === "claude-code" ? CLAUDE_BIN_ENV : CODEX_BIN_ENV] || (harness === "claude-code" ? "claude" : "codex"));
  const overrideName = SESSION_LAUNCHER_ENV[harness];
  const override = env[overrideName];
  let argv: string[];
  let source: SessionSetup["source"];
  if (override !== undefined && override.trim() !== "") {
    try {
      argv = splitWords(override);
    } catch (err) {
      throw new Error(`${overrideName}: ${(err as Error).message}`);
    }
    if (argv.length === 0) throw new Error(`${overrideName} names no command`);
    source = "environment";
  } else if (section?.sessionLauncher !== undefined) {
    argv = [...section.sessionLauncher];
    source = "runner config";
  } else {
    argv = [command];
    source = "command";
  }
  const store =
    harness === "claude-code"
      ? ((config?.claude?.configDir ?? (env.GRAPHLOOM_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR)) || path.join(os.homedir(), ".claude"))
      : ((config?.codex?.codexHome ?? (env.GRAPHLOOM_CODEX_HOME || env.CODEX_HOME)) || path.join(os.homedir(), ".codex"));
  const passEnv = section?.passEnv ?? envNames(env[harness === "claude-code" ? "GRAPHLOOM_CLAUDE_PASS_ENV" : "GRAPHLOOM_CODEX_PASS_ENV"]);
  return { harness, command, argv, source, stateDirs: [...(section?.sessionLauncherStateDirs ?? [])], store, passEnv };
}

/** The first word's file: a path as given, or the name found on PATH. */
export async function resolveExecutable(word: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const expanded = word === "~" || word.startsWith("~/") ? path.join(os.homedir(), word.slice(1)) : word;
  const candidates = expanded.includes("/") ? [path.resolve(expanded)] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, expanded));
  for (const c of candidates) {
    if (await access(c, constants.X_OK).then(() => true, () => false)) return c;
  }
  return undefined;
}

/** The file a launcher's first word is, resolved through links, and the directories to bind read-only with it. */
export function launcherPaths(file: string): string[] {
  const out = new Set<string>([file, path.dirname(file)]);
  if (existsSync(file)) {
    const real = realpathSync(file);
    out.add(real);
    out.add(path.dirname(real));
  }
  return [...out];
}

export interface ProbeResult {
  ok: boolean;
  /** What was run, as the operator would type it. */
  command: string;
  /** The tail of its output, for the refusal. */
  output: string;
  /** Codex: whether `resume --help` lists `--sandbox`. */
  sandboxFlag?: boolean;
}

function run(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, output: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const take = (chunk: Buffer): void => {
      if (output.length < 256 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Probe what `session open` will start, with no model call and no session. Claude Code: `<launcher> --help`
 * must succeed and list `--resume`, `--fork-session`, `--session-id` and `--append-system-prompt`. Codex:
 * `<launcher> resume --help` must succeed and describe `resume`. A wrapper that does not pass these through
 * is refused before anything launches.
 */
export async function probeLauncher(harness: SessionHarness, argv: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<ProbeResult> {
  const probe = harness === "claude-code" ? [...argv, "--help"] : [...argv, "resume", "--help"];
  const result = await run(probe, env, timeoutMs);
  const text = result.output.replace(/\u001b\[[0-9;]*m/g, "");
  const command = probe.join(" ");
  const tail = text.trim().split("\n").slice(-6).join("\n").slice(-600);
  if (result.code !== 0) return { ok: false, command, output: result.code === null ? tail : `exit ${result.code}: ${tail}` };
  if (harness === "claude-code") {
    const missing = CLAUDE_FORK_FLAGS.filter((f) => !text.includes(f));
    if (missing.length > 0) return { ok: false, command, output: `its --help does not list ${missing.join(", ")}` };
    return { ok: true, command, output: tail };
  }
  if (!/resume/i.test(text)) return { ok: false, command, output: "its resume --help does not describe resume" };
  return { ok: true, command, output: tail, sandboxFlag: text.includes("--sandbox") };
}

/** The refusal for a failed probe: it names the launcher, the probe and its output, and never falls back to a fresh session. */
export function probeRefusal(setup: SessionSetup, probe: ProbeResult): string {
  const name = setup.harness === "claude-code" ? "Claude Code" : "Codex";
  if (setup.source === "command") {
    return `${setup.argv.join(" ")} cannot open a ${name} session: its probe \`${probe.command}\` failed (${probe.output}); install a ${name} that supports resume, or set the command in the runner config`;
  }
  const where = setup.source === "environment" ? SESSION_LAUNCHER_ENV[setup.harness] : `${setup.harness === "claude-code" ? "claude" : "codex"}.sessionLauncher`;
  return `session launcher ${JSON.stringify(setup.argv.join(" "))} (${where}) failed its probe \`${probe.command}\`: ${probe.output}. It does not pass GraphLoom's arguments through. Remove ${where} to start plain ${setup.command}, or use the launcher's own resume outside GraphLoom; GraphLoom never starts a fresh session in its place`;
}

/** The probes `doctor` runs: only for a launcher that is set (the plain agent commands have their own capability probe). */
export async function probeConfiguredLaunchers(config: RunnerConfig | undefined, env: NodeJS.ProcessEnv): Promise<Array<{ harness: SessionHarness; setup: SessionSetup; probe: ProbeResult }>> {
  const out: Array<{ harness: SessionHarness; setup: SessionSetup; probe: ProbeResult }> = [];
  for (const harness of ["claude-code", "codex"] as const) {
    let setup: SessionSetup;
    try {
      setup = sessionSetup(harness, config, env);
    } catch (err) {
      out.push({ harness, setup: { harness, command: "", argv: [], source: "environment", stateDirs: [], store: "", passEnv: [] }, probe: { ok: false, command: SESSION_LAUNCHER_ENV[harness], output: (err as Error).message } });
      continue;
    }
    if (setup.source === "command") continue;
    out.push({ harness, setup, probe: await probeLauncher(harness, setup.argv, env) });
  }
  return out;
}
