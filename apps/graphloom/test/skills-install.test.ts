// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom skills` (docs/design-agent-skills.md §3) in a temporary HOME:
 * install for the agents found, the marker and its digest (equal to the sh
 * pipeline the design gives), list, update of outdated and retired copies,
 * edit detection, directories GraphLoom did not write, --force, --dir and the
 * agents' own directory variables, remove; and setup's offer and doctor's row.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Discovery } from "../src/discovery.js";
import { doctorReport } from "../src/doctor.js";
import { runSetup, type Prompter } from "../src/setup.js";
import { SKILL_MARKER, skillDigest, skillsStatus, type SkillMarker, type SkillsStatus } from "../src/skills.js";
import { versionInfo } from "../src/version.js";
import { repoRoot } from "./cli-env.js";
import { fakeDiscovery } from "./discovery-fixture.js";

const execFileAsync = promisify(execFile);
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");
const SKILLS = ["graphloom-deliver", "graphloom-issue", "graphloom-run", "graphloom-setup", "graphloom-triage", "graphloom-watch"];
const version = versionInfo(repoRoot).version;

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A HOME with no agent and a PATH with neither claude nor codex. */
async function sandbox() {
  const home = await mkdtemp(path.join(os.tmpdir(), "gl-skills-"));
  dirs.push(home);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const graphloom = (...args: string[]) =>
    execFileAsync(process.execPath, [cli, "skills", ...args], { env, cwd: home }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (err: { stdout?: string; stderr?: string; code?: number }) => ({ stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 }),
    );
  const list = async (...args: string[]) => JSON.parse((await graphloom("list", "--json", ...args)).stdout) as SkillsStatus;
  const states = async (agent: string, ...args: string[]) =>
    Object.fromEntries((await list(...args)).targets.find((t) => t.agent === agent)!.skills.map((c) => [c.name, c.state]));
  return { home, env, graphloom, list, states, claude: path.join(home, ".claude", "skills"), codex: path.join(home, ".codex", "skills") };
}

const marker = (dir: string) => JSON.parse(readFileSync(path.join(dir, SKILL_MARKER), "utf8")) as SkillMarker;

describe("graphloom skills install, list, update, remove", { timeout: 60_000 }, () => {
  it("installs for the agents found here only, with a marker whose digest the sh pipeline reproduces", async () => {
    const s = await sandbox();
    const none = await s.graphloom("install");
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("no Claude Code or Codex found here");
    expect(existsSync(s.claude)).toBe(false);

    await mkdir(path.join(s.home, ".claude"));
    const installed = await s.graphloom("install");
    expect(installed.stdout).toContain(`6 skill(s) written, 0 unchanged (version ${version})`);
    expect(readdirSync(s.claude).sort()).toEqual(SKILLS);
    expect(existsSync(s.codex)).toBe(false);
    for (const name of SKILLS) {
      const dir = path.join(s.claude, name);
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8"));
      const m = marker(dir);
      expect(m).toMatchObject({ product: "graphloom", skill: name, version });
      expect(m.digest).toBe(await skillDigest(path.join(repoRoot, "skills", name)));
      const sh = spawnSync("sh", ["-c", `find . -type f ! -name ${SKILL_MARKER} | sed 's|^\\./||' | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done | sha256sum | cut -d' ' -f1`], { cwd: dir, encoding: "utf8" });
      expect(sh.stdout.trim()).toBe(m.digest);
    }
    expect(Object.values(await s.states("claude-code"))).toEqual(SKILLS.map(() => "current"));
    expect(Object.values(await s.states("codex"))).toEqual(SKILLS.map(() => "missing"));
    // A second install changes nothing.
    expect((await s.graphloom("install")).stdout).toContain("0 skill(s) written, 6 unchanged");
    const text = (await s.graphloom("list")).stdout;
    expect(text).toContain(`GraphLoom ${version} ships 6 skill(s)`);
    expect(text).toMatch(/Codex \(.*\) — agent not found here/);
  });

  it("keeps edited copies on update and install, replaces them only with --force, and never touches a foreign directory", async () => {
    const s = await sandbox();
    await s.graphloom("install", "--agent", "claude-code");
    await appendFile(path.join(s.claude, "graphloom-run", "SKILL.md"), "\nMy own note.\n");
    await rm(path.join(s.claude, "graphloom-watch"), { recursive: true });
    await mkdir(path.join(s.claude, "graphloom-watch"));
    await writeFile(path.join(s.claude, "graphloom-watch", "SKILL.md"), "---\nname: graphloom-watch\ndescription: mine\n---\n");
    expect(await s.states("claude-code")).toMatchObject({ "graphloom-run": "edited", "graphloom-watch": "foreign", "graphloom-setup": "current" });

    const update = await s.graphloom("update");
    expect(update.stdout).toContain(`kept ${path.join(s.claude, "graphloom-run")} (you edited it)`);
    expect(readFileSync(path.join(s.claude, "graphloom-run", "SKILL.md"), "utf8")).toContain("My own note.");

    const install = await s.graphloom("install", "--agent", "claude-code");
    expect(install.stdout).toContain("you edited it; graphloom skills install graphloom-run --force replaces it");
    expect(install.stdout).toContain("a directory GraphLoom did not write");
    expect(readFileSync(path.join(s.claude, "graphloom-watch", "SKILL.md"), "utf8")).toContain("description: mine");

    await s.graphloom("install", "graphloom-run", "--agent", "claude-code", "--force");
    expect(await s.states("claude-code")).toMatchObject({ "graphloom-run": "current", "graphloom-watch": "foreign" });
    expect((await s.graphloom("install", "graphloom-nope", "--agent", "claude-code")).stderr).toContain("no bundled skill named graphloom-nope");
  });

  it("updates outdated copies to this version, removes retired ones, and never installs a missing one", async () => {
    const s = await sandbox();
    await s.graphloom("install", "--agent", "codex");
    // As an older version would have left them: other content, a marker matching it.
    const old = path.join(s.codex, "graphloom-triage");
    await writeFile(path.join(old, "SKILL.md"), "---\nname: graphloom-triage\ndescription: older\n---\n# old\n");
    await writeFile(path.join(old, SKILL_MARKER), JSON.stringify({ ...marker(old), version: "0.0.1", digest: await skillDigest(old) }));
    const retired = path.join(s.codex, "graphloom-gone");
    await mkdir(retired);
    await writeFile(path.join(retired, "SKILL.md"), "---\nname: graphloom-gone\ndescription: x\n---\n");
    await writeFile(path.join(retired, SKILL_MARKER), JSON.stringify({ product: "graphloom", skill: "graphloom-gone", version: "0.0.1", digest: await skillDigest(retired), installedAt: "x" }));
    await rm(path.join(s.codex, "graphloom-issue"), { recursive: true });
    const before = await s.list("--agent", "codex");
    expect(before.targets[0]!.skills.map((c) => [c.name, c.state, c.installedVersion])).toEqual(
      expect.arrayContaining([["graphloom-triage", "outdated", "0.0.1"], ["graphloom-gone", "retired", "0.0.1"], ["graphloom-issue", "missing", undefined]]),
    );

    const updated = await s.graphloom("update", "--quiet");
    expect(updated.stdout).toContain(`graphloom skills: 1 updated to ${version}, 1 no longer shipped removed`);
    expect(marker(old)).toMatchObject({ version });
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(path.join(s.codex, "graphloom-issue"))).toBe(false);
    // Nothing to do: --quiet says nothing.
    expect((await s.graphloom("update", "--quiet")).stdout).toBe("");
  });

  it("removes unedited copies, keeps edited ones without --force, and leaves foreign directories", async () => {
    const s = await sandbox();
    await s.graphloom("install", "--agent", "claude-code", "--agent", "codex");
    await appendFile(path.join(s.codex, "graphloom-run", "SKILL.md"), "edit\n");
    await mkdir(path.join(s.claude, "my-skill"));
    const removed = await s.graphloom("remove");
    expect(removed.stdout).toContain(`kept ${path.join(s.codex, "graphloom-run")}: you edited it`);
    expect(readdirSync(s.claude)).toEqual(["my-skill"]);
    expect(readdirSync(s.codex)).toEqual(["graphloom-run"]);
    await s.graphloom("remove", "graphloom-run", "--force");
    expect(readdirSync(s.codex)).toEqual([]);
    expect((await s.graphloom("remove")).stdout).toContain("no GraphLoom skills installed");
  });

  it("honours --dir, the agents' own directory variables, and GraphLoom's overrides", async () => {
    const s = await sandbox();
    const custom = path.join(s.home, "elsewhere");
    await s.graphloom("install", "graphloom-run", "--dir", custom);
    expect(readdirSync(custom)).toEqual(["graphloom-run"]);
    expect((await s.list("--dir", custom)).targets.map((t) => [t.agent, t.dir])).toEqual([["dir", custom]]);

    s.env.CODEX_HOME = path.join(s.home, "codex-home");
    s.env.CLAUDE_CONFIG_DIR = path.join(s.home, "claude-config");
    const targets = (await s.list()).targets.map((t) => [t.agent, t.dir, t.found]);
    expect(targets).toEqual([
      ["claude-code", path.join(s.home, "claude-config", "skills"), false],
      ["codex", path.join(s.home, "codex-home", "skills"), false],
    ]);
    s.env.GRAPHLOOM_CODEX_SKILLS_DIR = path.join(s.home, "override");
    s.env.GRAPHLOOM_CODEX_BIN = "/stub/codex";
    await s.graphloom("install");
    expect(readdirSync(path.join(s.home, "override")).sort()).toEqual(SKILLS);
    expect(existsSync(path.join(s.home, "claude-config"))).toBe(false);
  });

  it("refuses an unknown agent, option, or subcommand", async () => {
    const s = await sandbox();
    expect((await s.graphloom("install", "--agent", "cursor")).stderr).toContain("--agent must be claude-code or codex");
    expect((await s.graphloom("install", "--bogus")).stderr).toContain("unknown option --bogus");
    const bare = await s.graphloom();
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("usage: graphloom skills list|install|update|remove");
  });
});

describe("setup and doctor", { timeout: 60_000 }, () => {
  async function discovered(home: string, found: { claude?: boolean; codex?: boolean }): Promise<Discovery> {
    const env = { HOME: home, PATH: "" };
    const skills = await skillsStatus({ env, root: repoRoot });
    const base = path.join(home, ".config", "graphloom");
    return {
      ...fakeDiscovery({ runnerFile: path.join(base, "runner.json"), supervisorFile: path.join(base, "supervisor.json"), available: ["claude-code"] }),
      root: repoRoot,
      env,
      skills: { ...skills, targets: skills.targets.map((t) => ({ ...t, found: (t.agent === "claude-code" && found.claude === true) || (t.agent === "codex" && found.codex === true) })) },
    };
  }

  /** Answers each question by what it asks: `skills` for the skill offer, `y` for consent, the default otherwise. */
  function prompter(skills: string): Prompter & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      say: (l) => void lines.push(l),
      ask: async (q) => {
        lines.push(q);
        return q.includes("Install them for") ? skills : q.includes("Allow coding agents") ? "y" : "";
      },
    };
  }

  it("setup offers the skills for each agent found, installs on yes, and --yes only prints the command", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "gl-skills-setup-"));
    dirs.push(home);
    const yes = await runSetup({ yes: true, discovery: await discovered(home, { claude: true, codex: true }), say: () => undefined, env: { HOME: home } });
    expect(yes.exitCode).toBe(0);
    expect(existsSync(path.join(home, ".claude", "skills"))).toBe(false);

    // Yes for Claude Code; Codex is not found, so it is not offered.
    const p = prompter("");
    const result = await runSetup({ prompter: p, discovery: await discovered(home, { claude: true }), env: { HOME: home } });
    expect(result.exitCode).toBe(0);
    expect(p.lines.join("\n")).toContain("GraphLoom ships agent skills for driving it from Claude Code");
    expect(p.lines.some((l) => l.includes("Install them for Codex"))).toBe(false);
    expect(readdirSync(path.join(home, ".claude", "skills")).sort()).toEqual(SKILLS);

    // A rerun with everything current asks nothing about skills.
    const again = prompter("n");
    await runSetup({ prompter: again, discovery: await discovered(home, { claude: true }), env: { HOME: home } });
    expect(again.lines.some((l) => l.includes("agent skills"))).toBe(false);
  });

  it("doctor reports each found agent's skills: missing, outdated, current with edits kept", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "gl-skills-doctor-"));
    dirs.push(home);
    const row = async () => doctorReport(await discovered(home, { claude: true })).checks.filter((c) => c.name.startsWith("skills ("));
    expect(await row()).toEqual([
      expect.objectContaining({ name: "skills (claude-code)", status: "warn", fix: "graphloom skills install --agent claude-code", detail: expect.stringContaining("none of the 6 GraphLoom skills") }),
    ]);
    const env = { HOME: home, PATH: "" };
    await execFileAsync(process.execPath, [cli, "skills", "install", "--agent", "claude-code"], { env });
    expect(await row()).toEqual([expect.objectContaining({ status: "pass", detail: expect.stringContaining(`6 current (${version})`) })]);
    const dir = path.join(home, ".claude", "skills", "graphloom-run");
    await appendFile(path.join(dir, "SKILL.md"), "edit\n");
    expect((await row())[0]).toMatchObject({ status: "pass", detail: expect.stringContaining("edited by you, kept: graphloom-run") });
    await writeFile(path.join(dir, "SKILL.md"), "older\n");
    await writeFile(path.join(dir, SKILL_MARKER), JSON.stringify({ ...marker(dir), version: "0.0.1", digest: await skillDigest(dir) }));
    expect((await row())[0]).toMatchObject({ status: "warn", fix: "graphloom skills update --agent claude-code", detail: expect.stringContaining("from another version") });
  });
});
