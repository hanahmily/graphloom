// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom <command> --help` (and `-h`) prints that command's usage and
 * exits 0 for every command `graphloom --help` lists; it never runs the
 * command (`rehearse --help` once looked for a task file named `--help`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileAsync, repoRoot } from "./cli-env.js";

const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");

let home: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "graphloom-cli-help-"));
  env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), GRAPHLOOM_RUNNER_CONFIG: path.join(home, "absent.json") };
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The commands `graphloom --help` lists, from its `  graphloom <command> ...` lines. */
function listedCommands(help: string): string[] {
  const commands = new Set<string>();
  for (const line of help.split("\n")) {
    const m = /^ {2}graphloom ([a-z][a-z-]*)\b/.exec(line);
    if (m !== null) commands.add(m[1]!);
  }
  return [...commands].sort();
}

describe("graphloom <command> --help", () => {
  it("prints the usage of every listed command and exits 0", async () => {
    const { stdout: help } = await execFileAsync(process.execPath, [cli, "--help"], { env });
    const commands = listedCommands(help);
    expect(commands).toEqual(expect.arrayContaining(["rehearse", "run", "resume", "check", "hub", "task", "session", "skills", "sandbox", "version", "upgrade", "self"]));
    // Every command with --help; -h on a few, the same path. Four at a time: each is a node start.
    const cases = [...commands.map((command) => [command, "--help"]), ["rehearse", "-h"], ["hub", "-h"], ["resume", "-h"]] as const;
    for (let i = 0; i < cases.length; i += 4) {
      await Promise.all(cases.slice(i, i + 4).map(async ([command, flag]) => {
        const result = await execFileAsync(process.execPath, [cli, command, flag], { env, cwd: home }).catch((err: { code?: number; stdout?: string; stderr?: string }) => err);
        const label = `graphloom ${command} ${flag}: ${result.stderr ?? ""}`;
        expect("code" in result ? result.code : 0, label).toBe(0);
        expect(result.stdout, label).toMatch(new RegExp(`graphloom ${command}\\b`));
        expect(result.stderr, label).not.toMatch(/missing file|unknown command/);
      }));
    }
  }, 120_000);

  it("answers --help after a command's arguments too, running nothing", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cli, "rehearse", "task.yaml", "--help"], { env, cwd: home });
    expect(stdout).toContain("graphloom rehearse <task.yaml>");
    expect(stdout).not.toContain("graphloom run ");
  });

  it("the shim and installer answer upgrade and self --help with their usage, exit 0", async () => {
    const shimEnv = { ...env, GRAPHLOOM_HOME: path.join(home, "install-home") };
    const self = await execFileAsync("sh", [path.join(repoRoot, "scripts/shim.sh"), "self", "--help"], { env: shimEnv });
    expect(self.stdout).toContain("graphloom self list");
    const upgrade = await execFileAsync("sh", [path.join(repoRoot, "scripts/install.sh"), "upgrade", "--help"], { env: shimEnv });
    expect(upgrade.stdout).toContain("install.sh upgrade");
    await expect(execFileAsync("sh", [path.join(repoRoot, "scripts/install.sh"), "upgrade", "--bogus"], { env: shimEnv })).rejects.toMatchObject({ code: 2 });
  });
});
