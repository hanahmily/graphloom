// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Fixtures for the doctor, setup, and first-run tests (docs/design-release.md
 * §4.4, §4.5, phase R4). Each environment is a temporary `HOME` whose `PATH`
 * holds a stub directory first, then the host's tools without Node, its
 * package managers, and the real `claude`, `codex`, `gh`, and `bwrap`. The
 * stubs answer `--version`, `--help` (the capability probe), and the login
 * status commands as the real CLIs do, by mode; the stub `claude` hands every
 * other invocation to the fake Claude Code the executor tests use. The Pi
 * credential is a stub provider variable or a stub auth store entry. Nothing
 * here reads or writes the real `~/.config/graphloom` or `~/.graphloom`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CODE_ADAPTER_FLAGS, CODEX_ADAPTER_FLAGS } from "@graphloom/executor-coding-agent";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const cli = path.join(repoRoot, "apps", "graphloom", "dist", "main.js");
const fakeClaude = path.join(repoRoot, "executors", "coding-agent", "test", "fake-claude.mjs");

/** Values the stubs hold that no output or written file may contain. */
export const STUB_SECRETS = {
  minimax: "stub-minimax-key-7f3a9c",
  stored: "sk-stub-stored-key-4b2e81",
  email: "operator-secret@example.com",
  org: "org-secret-5d1c",
  github: "ghp_stubGithubToken000000000000000000",
} as const;

export type ClaudeMode = "ok" | "missing" | "badprobe" | "loggedout" | "noauth";
export type CodexMode = "ok" | "missing" | "badprobe" | "loggedout" | "unverifiable";
export type GhMode = "ok" | "missing" | "loggedout" | "noaccess";

export interface DoctorEnvOptions {
  claude?: ClaudeMode;
  codex?: CodexMode;
  gh?: GhMode;
  /** "ok": the real bwrap (or, without one, a probe that passes); "fail": cannot create a namespace; "missing": none on PATH. */
  bwrap?: "ok" | "fail" | "missing";
  /** Set MINIMAX_CN_API_KEY to a stub value. */
  piEnv?: boolean;
  /** Write a stub deepseek entry into Pi's auth store. */
  piStore?: boolean;
}

export interface DoctorEnv {
  root: string;
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  /** The fake Claude Code script file and log, for runs. */
  claudeScript: string;
  claudeLog: string;
  run(args: string[], extra?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Runs `cmd` under a pseudo-terminal (`script`), writing `input` line by line as the prompts arrive. */
  runTty(args: string[], input: string[], extra?: NodeJS.ProcessEnv): Promise<{ output: string; code: number }>;
  runnerFile: string;
  supervisorFile: string;
}

let systemBin: Promise<string> | undefined;
let base: Promise<string> | undefined;

/** One temporary base for the test file. */
export function doctorBase(): Promise<string> {
  base ??= mkdtemp(path.join(os.tmpdir(), "gl-doctor-")).then((dir) => realpath(dir));
  return base;
}

export async function removeDoctorBase(): Promise<void> {
  if (base === undefined) return;
  const dir = await base;
  spawnSync("chmod", ["-R", "u+w", dir]);
  await rm(dir, { recursive: true, force: true });
  base = undefined;
  systemBin = undefined;
}

const STUBBED = new Set(["node", "nodejs", "npm", "npx", "corepack", "pnpm", "yarn", "claude", "codex", "gh", "bwrap"]);

/** The host's tools, linked, without Node and without the CLIs the stubs stand in for. */
function systemPath(): Promise<string> {
  systemBin ??= (async () => {
    const dir = path.join(await doctorBase(), "system-bin");
    await mkdir(dir, { recursive: true });
    const linked = new Set<string>();
    for (const from of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      let names: string[];
      try {
        names = readdirSync(from);
      } catch {
        continue;
      }
      for (const name of names) {
        if (linked.has(name) || STUBBED.has(name)) continue;
        const file = path.join(from, name);
        try {
          if (!statSync(file).isFile()) continue;
        } catch {
          continue;
        }
        linked.add(name);
        await symlink(file, path.join(dir, name)).catch(() => undefined);
      }
    }
    return dir;
  })();
  return systemBin;
}

function hostBinary(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export const realBwrap = hostBinary("bwrap");

function claudeStub(script: string, log: string): string {
  return `#!/bin/sh
# Stub Claude Code: answers the doctor's questions by $FAKE_CLAUDE_MODE; anything else is the fake Claude Code.
mode=\${FAKE_CLAUDE_MODE:-ok}
case "$1" in
  --version) echo "2.1.300 (Claude Code)"; exit 0 ;;
  --help)
    if [ "$mode" = badprobe ]; then echo "Usage: claude -p --model"; exit 0; fi
    echo "Usage: claude [options] ${CLAUDE_CODE_ADAPTER_FLAGS.join(" ")}"
    if [ "$mode" != noauth ]; then printf 'Commands:\\n  auth                                  Manage authentication\\n'; fi
    exit 0 ;;
  auth)
    if [ "$mode" = loggedout ]; then echo '{"loggedIn": false, "email": "${STUB_SECRETS.email}"}'; exit 1; fi
    echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "${STUB_SECRETS.email}", "orgId": "${STUB_SECRETS.org}"}'; exit 0 ;;
esac
FAKE_CLAUDE_SCRIPT='${script}' FAKE_CLAUDE_LOG='${log}' exec '${process.execPath}' '${fakeClaude}' "$@"
`;
}

const CODEX_STUB = `#!/bin/sh
# Stub Codex: answers the doctor's questions by $FAKE_CODEX_MODE.
mode=\${FAKE_CODEX_MODE:-ok}
if [ "$1" = --version ]; then echo "codex-cli 0.162.1"; exit 0; fi
case "$1 $2" in
  "exec --help")
    if [ "$mode" = badprobe ]; then echo "Usage: codex exec --json"; exit 0; fi
    echo "Usage: codex exec [options] ${CODEX_ADAPTER_FLAGS.join(" ")}"; exit 0 ;;
  "login status")
    case "$mode" in
      loggedout) echo "Not logged in" >&2; exit 1 ;;
      unverifiable) echo "error: unrecognized subcommand 'status'" >&2; exit 2 ;;
    esac
    echo "Logged in using ChatGPT" >&2; exit 0 ;;
esac
echo "stub codex: unsupported: $*" >&2
exit 2
`;

const GH_STUB = `#!/bin/sh
# Stub gh: answers the doctor's questions by $FAKE_GH_MODE.
mode=\${FAKE_GH_MODE:-ok}
if [ "$1" = --version ]; then echo "gh version 2.45.0 (2024-03-04)"; exit 0; fi
case "$1 $2" in
  "auth status") if [ "$mode" = loggedout ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi; echo "Logged in to github.com account operator (keyring)"; exit 0 ;;
  "repo view") if [ "$mode" = noaccess ]; then echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; fi; echo '{"name":"graphloom"}'; exit 0 ;;
esac
echo "stub gh: unsupported: $*" >&2
exit 1
`;

function bwrapStub(mode: "ok" | "fail"): string {
  if (mode === "fail") return "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n";
  return realBwrap !== undefined ? `#!/bin/sh\nexec '${realBwrap}' "$@"\n` : "#!/bin/sh\nexit 0\n";
}

export async function makeDoctorEnv(options: DoctorEnvOptions = {}): Promise<DoctorEnv> {
  const root = await mkdtemp(path.join(await doctorBase(), "env-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "stub-bin");
  const tmp = path.join(root, "tmp");
  for (const dir of [home, bin, tmp]) await mkdir(dir, { recursive: true });
  const claudeScript = path.join(root, "claude-script.json");
  const claudeLog = path.join(root, "claude-log.jsonl");
  await writeFile(claudeScript, "{}");
  const claude = options.claude ?? "ok";
  const codex = options.codex ?? "ok";
  const gh = options.gh ?? "ok";
  const bwrap = options.bwrap ?? "ok";
  if (claude !== "missing") await writeFile(path.join(bin, "claude"), claudeStub(claudeScript, claudeLog), { mode: 0o755 });
  if (codex !== "missing") await writeFile(path.join(bin, "codex"), CODEX_STUB, { mode: 0o755 });
  if (gh !== "missing") await writeFile(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
  if (bwrap !== "missing") await writeFile(path.join(bin, "bwrap"), bwrapStub(bwrap), { mode: 0o755 });
  if (options.piStore) {
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: STUB_SECRETS.stored } }));
  }
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Doctor Test\n\temail = doctor@example.invalid\n");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:${await systemPath()}`,
    LANG: "C.UTF-8",
    TMPDIR: tmp,
    FAKE_CLAUDE_MODE: claude,
    FAKE_CODEX_MODE: codex,
    FAKE_GH_MODE: gh,
    ...(options.piEnv ? { MINIMAX_CN_API_KEY: STUB_SECRETS.minimax } : {}),
  };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  const runTty = (args: string[], input: string[], extra: NodeJS.ProcessEnv = {}) =>
    ttyRun([process.execPath, cli, ...args], input, { ...env, ...extra }, root);
  return {
    root,
    home,
    bin,
    env,
    claudeScript,
    claudeLog,
    run,
    runTty,
    runnerFile: path.join(home, ".config", "graphloom", "runner.json"),
    supervisorFile: path.join(home, ".config", "graphloom", "supervisor.json"),
  };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `argv` under a real pseudo-terminal with util-linux `script`, so its
 * stdin and stdout are terminals. Each line of `input` is written when the
 * output shows a new prompt (a line ending in "] " or ") "), so answers are
 * never read ahead of their question. Resolves with the terminal output and
 * the command's exit status (`script -e`).
 */
export function ttyRun(argv: string[], input: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 120_000): Promise<{ output: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qefc", argv.map(shellQuote).join(" "), "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let answered = 0;
    let answeredAt = -1;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out under the pseudo-terminal; output so far:\n${output}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      output += d.toString("utf8");
      // A prompt is a question waiting at the end of the output; answer each once.
      if (output.length > answeredAt && /(\] |\) )$/.test(output.replace(/\r/g, "")) && answered < input.length) {
        child.stdin.write(`${input[answered]}\n`);
        answered += 1;
        answeredAt = output.length;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: output.replace(/\r/g, ""), code: code ?? 1 });
    });
  });
}

export function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export async function removeIfExists(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}
