import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");
const fakeClaude = path.join(repoRoot, "executors/coding-agent/test/fake-claude.mjs");

export const HELLO_REQUEST =
  'Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by one newline. Do not modify other files.';

export interface CliEnv {
  dir: string;
  repo: string;
  stateRoot: string;
  /** Run the built CLI in `dir` with this env's HOME and agent config. */
  graphloom(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  git(...args: string[]): Promise<string>;
  /** Point the agent config at the fake Claude CLI running `script`, installed at `dir/claude`. */
  fakeClaude(script: Record<string, unknown>, options?: { command?: string }): Promise<void>;
  env: NodeJS.ProcessEnv;
}

/** A scratch repo with the hello bundle beside its task file, and a HOME with no operator config. */
export async function makeCliEnv(cleanups: (() => Promise<void>)[]): Promise<CliEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-cli-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "test-repo");
  await mkdir(repo);
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: repo })).stdout.trim();
  await git("init", "-q");
  await git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(repoRoot, "examples/plugins/hello"), path.join(dir, "plugins/hello"));
  await writeFile(path.join(dir, "task.yaml"), `graph: hello\nrepo: ./test-repo\nrequest: ${JSON.stringify(HELLO_REQUEST)}\n`);

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("CLAUDE_")),
  );
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: dir };
  const graphloom = async (...args: string[]) =>
    execFileAsync(process.execPath, [cli, ...args], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (err: { stdout?: string; stderr?: string; code?: number }) => ({
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        code: typeof err.code === "number" ? err.code : 1,
      }),
    );

  const fake = async (script: Record<string, unknown>, options: { command?: string } = {}) => {
    const bin = path.join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(dir, "script.json"), JSON.stringify(script));
    const config = {
      harness: "claude-code",
      command: options.command ?? bin,
      configDir: path.join(dir, "claude-config"),
      passEnv: ["FAKE_CLAUDE_SCRIPT", "FAKE_CLAUDE_LOG"],
    };
    await writeFile(path.join(dir, "agent.json"), JSON.stringify(config));
    env.GRAPHLOOM_AGENT_CONFIG = path.join(dir, "agent.json");
    env.FAKE_CLAUDE_SCRIPT = path.join(dir, "script.json");
    env.FAKE_CLAUDE_LOG = path.join(dir, "claude-log.jsonl");
  };

  return { dir, repo, stateRoot: path.join(repo, "graphloom-state"), graphloom, git, fakeClaude: fake, env };
}
