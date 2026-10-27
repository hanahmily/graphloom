// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `release.sh prepare` and `publish` (docs/design-release.md §3, §6 steps 1,
 * 2, 9, and 10, phase R5), and the helpers in `scripts/release/prepare.mjs`.
 * Each end-to-end test runs the real release.sh in a small fixture
 * repository with its own bare remote, a stub `gh` (`scripts/release/stub-gh.sh`)
 * in place of GitHub, and a throwaway signing key. Nothing here touches the
 * network, the real repository, its remote, or a real release.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const prepareModule = path.join(repoRoot, "scripts", "release", "prepare.mjs");
const HEADER = "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 Hongtao Gao and the GraphLoom contributors\n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let P: any;
beforeAll(async () => {
  P = await import(pathToFileURL(prepareModule).href);
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", dir]);
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-release-publish-")));
  dirs.push(dir);
  return dir;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function must(r: SpawnSyncReturns<string>, what: string): string {
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return r.stdout;
}

const COMPLETE_SECTION = (version: string) => `## [${version}] - 2026-10-27

The release.

### Added

- Something an operator notices.

### Upgrade notes

- **State format:** 1, no migrations.
- **Configuration:** unchanged.
- **SDK protocol:** 1.
- **Node:** ${process.versions.node}.
- **Digests:** none changed.
`;

describe("prepare.mjs helpers (§3, §6 step 2)", () => {
  it("bumps the lockstep versions and the dependencies on them, never a file: link, an executor, a plugin, or testkit", async () => {
    const root = await tempDir();
    await writeJson(path.join(root, "package.json"), { name: "graphloom", version: "0.0.0", workspaces: ["packages/*", "executors/*", "apps/*", "examples/plugins/*"] });
    await writeJson(path.join(root, "packages/sdk/package.json"), { name: "@graphloom/sdk", version: "0.0.0" });
    await writeJson(path.join(root, "packages/runner/package.json"), { name: "@graphloom/runner", version: "0.0.0", dependencies: { "@graphloom/sdk": "0.0.0", other: "^1.0.0" } });
    await writeJson(path.join(root, "packages/testkit/package.json"), { name: "@graphloom/testkit", version: "0.0.0", devDependencies: { "@graphloom/runner": "0.0.0" } });
    await writeJson(path.join(root, "apps/graphloom/package.json"), { name: "@graphloom/cli", version: "0.0.0", dependencies: { "@graphloom/sdk": "0.0.0", "@graphloom/executor-command": "0.1.0" } });
    await writeJson(path.join(root, "executors/command/package.json"), { name: "@graphloom/executor-command", version: "0.1.0", dependencies: { "@graphloom/sdk": "0.0.0" } });
    await writeJson(path.join(root, "examples/plugins/hello/package.json"), { name: "@graphloom/plugin-hello", version: "0.1.0", dependencies: { "@graphloom/sdk": "file:../../../packages/sdk" } });
    await writeJson(path.join(root, "examples/plugins/hello/package-lock.json"), {
      name: "@graphloom/plugin-hello",
      lockfileVersion: 3,
      packages: { "": { name: "@graphloom/plugin-hello", version: "0.1.0" }, "../../../packages/sdk": { name: "@graphloom/sdk", version: "0.0.0" }, "node_modules/@graphloom/sdk": { resolved: "../../../packages/sdk", link: true } },
    });
    const changed = P.bumpVersions(root, "0.1.0");
    expect(changed.sort()).toEqual(
      ["package.json", "packages/sdk/package.json", "packages/runner/package.json", "packages/testkit/package.json", "apps/graphloom/package.json", "executors/command/package.json", "examples/plugins/hello/package-lock.json"].sort(),
    );
    const read = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    expect(read("package.json").version).toBe("0.1.0");
    expect(read("packages/runner/package.json")).toMatchObject({ version: "0.1.0", dependencies: { "@graphloom/sdk": "0.1.0", other: "^1.0.0" } });
    expect(read("packages/testkit/package.json")).toMatchObject({ version: "0.0.0", devDependencies: { "@graphloom/runner": "0.1.0" } });
    expect(read("apps/graphloom/package.json").dependencies).toEqual({ "@graphloom/sdk": "0.1.0", "@graphloom/executor-command": "0.1.0" });
    expect(read("executors/command/package.json")).toMatchObject({ version: "0.1.0", dependencies: { "@graphloom/sdk": "0.1.0" } });
    expect(read("examples/plugins/hello/package.json").dependencies["@graphloom/sdk"]).toBe("file:../../../packages/sdk");
    expect(read("examples/plugins/hello/package-lock.json").packages["../../../packages/sdk"].version).toBe("0.1.0");
    expect(P.bumpVersions(root, "0.1.0")).toEqual([]);
  });

  it("drafts a section with TODO markers, which the check refuses until each upgrade note is filled in", () => {
    const draft = P.insertSection("# Changelog\n\nPreamble.\n", P.draftSection("0.2.0", "2026-11-01", ["feat(cli): a new flag", "fix: a crash", "docs: a page"], { node: "24.22.1" }));
    expect(draft).toMatch(/^# Changelog\n\nPreamble\.\n\n## \[0\.2\.0\] - 2026-11-01\n/);
    expect(draft).toContain("### Added\n\n- a new flag\n");
    expect(draft).toContain("### Fixed\n\n- a crash\n");
    expect(draft).toContain("### Changed\n\n- docs: a page\n");
    expect(draft).toContain("- **Node:** 24.22.1 (bundled).");
    expect(P.checkSection(draft, "0.2.0")).toContain("the 0.2.0 section still has a TODO marker");

    const older = `# Changelog\n\n${COMPLETE_SECTION("0.1.0")}`;
    const both = P.insertSection(older, COMPLETE_SECTION("0.2.0"));
    expect(both.indexOf("## [0.2.0]")).toBeLessThan(both.indexOf("## [0.1.0]"));
    expect(P.checkSection(both, "0.2.0")).toEqual([]);
    expect(P.checkSection(both, "0.3.0")).toEqual(['CHANGELOG.md has no "## [0.3.0]" section']);
    const noNode = both.replace(/^- \*\*Node:\*\*.*$/m, "");
    expect(P.checkSection(noNode, "0.2.0")).toEqual(['the 0.2.0 upgrade notes have no "- **Node:**" entry']);
    const noEntries = COMPLETE_SECTION("0.2.0").replace("### Added", "### Other");
    expect(P.checkSection(noEntries, "0.2.0")).toContain("the 0.2.0 section has no Added, Changed, or Fixed entries");
    expect(P.checkSection(COMPLETE_SECTION("0.2.0").replace(/### Upgrade notes[\s\S]*/, ""), "0.2.0")).toContain('the 0.2.0 section has no "### Upgrade notes"');
  });

  it("writes the components table into the section, replaces it in place, and matches it against release.json", () => {
    const release = {
      executors: [{ package: "@graphloom/executor-github", version: "0.1.0", digest: "a" }, { package: "@graphloom/executor-command", version: "0.2.0", digest: "b" }],
      plugins: [{ graphId: "issue-fix", version: "0.15.0" }, { graphId: "hello", version: "0.1.0" }],
    };
    const table = P.componentsTable(release);
    expect(table.split("\n").slice(1, -1)).toEqual([
      "| Component | Kind | Version |",
      "|---|---|---|",
      "| @graphloom/executor-command | executor | 0.2.0 |",
      "| @graphloom/executor-github | executor | 0.1.0 |",
      "| hello | plugin | 0.1.0 |",
      "| issue-fix | plugin | 0.15.0 |",
    ]);
    const text = `# Changelog\n\n${COMPLETE_SECTION("0.2.0")}\n${COMPLETE_SECTION("0.1.0")}`;
    const once = P.withTable(text, "0.2.0", table);
    expect(once.indexOf("### Components")).toBeLessThan(once.indexOf("## [0.1.0]"));
    expect(P.checkSection(once, "0.2.0", table)).toEqual([]);
    const changed = P.componentsTable({ ...release, plugins: [{ graphId: "hello", version: "0.2.0" }] });
    expect(P.checkSection(once, "0.2.0", changed)).toEqual(["the 0.2.0 components table does not match the components this tree or release.json records"]);
    const twice = P.withTable(once, "0.2.0", changed);
    expect(twice.match(/### Components/g)).toHaveLength(1);
    expect(P.checkSection(twice, "0.2.0", changed)).toEqual([]);
    expect(P.findSection(twice, "0.1.0").body).not.toContain("### Components");
  });

  it("applies the bump rule: a changed digest needs a new version, a new state format a migrator and a fixture, a new protocol a breaking release", () => {
    const previous = {
      version: "0.1.0",
      stateFormat: 1,
      sdk: { sdkProtocol: 1 },
      executors: [{ package: "@graphloom/executor-github", version: "0.1.0", digest: "aaa" }, { package: "@graphloom/executor-command", version: "0.1.0", digest: "bbb" }],
      plugins: [{ graphId: "hello", version: "0.1.0", manifestSha256: "m1", sourceTree: "s1" }],
    };
    const same = structuredClone(previous);
    expect(P.componentProblems(previous, { ...same, version: "0.1.1" })).toEqual([]);
    const changed = {
      ...structuredClone(previous),
      version: "0.1.1",
      executors: [{ package: "@graphloom/executor-github", version: "0.1.0", digest: "ccc" }, { package: "@graphloom/executor-command", version: "0.1.1", digest: "ddd" }, { package: "@graphloom/executor-new", version: "0.1.0", digest: "e" }],
      plugins: [{ graphId: "hello", version: "0.1.0", manifestSha256: "m2", sourceTree: "s1" }],
    };
    expect(P.componentProblems(previous, changed)).toEqual([
      "executor @graphloom/executor-github: its digest changed since 0.1.0, but its version is still 0.1.0; bump it",
      "plugin hello: its manifest changed since 0.1.0, but its version is still 0.1.0; bump it",
    ]);
    const format2 = { ...same, version: "0.2.0", stateFormat: 2 };
    expect(P.componentProblems(previous, format2, { migrates: () => false, fixtures: [] })).toEqual([
      "stateFormat changed from 1 to 2, but there is no migration path from format 1 (§5.2)",
      "stateFormat changed from 1 to 2, but no committed fixture under packages/controller/test/fixtures/state-formats/ is in format 1 (§6 step 8.8)",
    ]);
    expect(P.componentProblems(previous, format2, { migrates: (from: number) => from === 1, fixtures: [{ dir: "v0.1", stateFormat: 1 }] })).toEqual([]);
    expect(P.componentProblems({ ...previous, stateFormat: 2 }, { ...same, version: "0.2.0" })).toEqual(["stateFormat 1 is older than 0.1.0's 2"]);
    expect(P.componentProblems(previous, { ...same, version: "0.1.1", sdk: { sdkProtocol: 2 } })).toEqual([
      "sdkProtocol changed from 1 to 2, which is a breaking change, but 0.1.1 is not a breaking release after 0.1.0 (§3)",
    ]);
    expect(P.componentProblems(previous, { ...same, version: "0.2.0", sdkProtocol: 2 })).toEqual([]);
  });

  it("finds the newest release tag, optionally below a version", () => {
    const tags = ["v0.1.0", "v0.10.0", "v0.9.3", "release-1", "v1.0.0-rc.1", "0.11.0", ""];
    expect(P.latestVersion(tags)).toBe("0.10.0");
    expect(P.latestVersion(tags, "0.10.0")).toBe("0.9.3");
    expect(P.latestVersion(tags, "0.1.0")).toBeUndefined();
    expect(P.latestVersion([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------- fixture repository

interface Fixture {
  base: string;
  repo: string;
  remote: string;
  releases: string;
  ghLog: string;
  gateLog: string;
  nodeDir: string;
  key: string;
  otherKey: string;
  signers: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  releaseSh(args: string[], extra?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  ghCalls(): string[];
}

const LOCKSTEP_PACKAGES = ["sdk", "agent-harness", "controller", "plugin-host", "supervisor", "runner"];

const GENERATE_MANIFEST = `${HEADER}import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tree = createHash("sha256").update(readFileSync("package.json")).update(readFileSync("package-lock.json")).digest("hex");
writeFileSync("graphloom.manifest.json", JSON.stringify({ graphId: "hello", version: pkg.version, digests: { sourceTree: tree } }, null, 2) + "\\n");
`;

const GATE_MARK = `${HEADER}import { appendFileSync } from "node:fs";
appendFileSync(process.env.FIXTURE_GATE_LOG, process.argv[2] + " " + process.cwd() + "\\n");
`;

/**
 * A small GraphLoom-shaped repository: the real `scripts/`, lockstep package
 * stubs whose committed `dist/` re-exports the real runner's digest, an
 * executor, a plugin with its own lockfile and manifest script, and a gate
 * that records where it ran. `main` is pushed to a bare remote.
 */
async function makeFixture(): Promise<Fixture> {
  const base = await tempDir();
  const repo = path.join(base, "repo");
  const remote = path.join(base, "remote.git");
  const releases = path.join(base, "releases");
  const stubBin = path.join(base, "stub-bin");
  const home = path.join(base, "home");
  const ghLog = path.join(base, "gh.log");
  const gateLog = path.join(base, "gate.log");
  for (const d of [repo, releases, stubBin, home]) await mkdir(d, { recursive: true });
  await writeFile(ghLog, "");
  await writeFile(gateLog, "");
  await copyFile(path.join(repoRoot, "scripts", "release", "stub-gh.sh"), path.join(stubBin, "gh"));
  await chmod(path.join(stubBin, "gh"), 0o755);
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Release Test\n\temail = release-test@example.invalid\n[init]\n\tdefaultBranch = main\n");

  // The pinned Node of the fixture is the Node running the tests, with its own npm.
  const nodeDir = path.join(base, "node");
  await mkdir(path.join(nodeDir, "bin"), { recursive: true });
  await symlink(process.execPath, path.join(nodeDir, "bin", "node"));
  const npm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
  await symlink(await realpath(npm), path.join(nodeDir, "bin", "npm"));

  const keys = path.join(base, "keys");
  await mkdir(keys);
  for (const n of ["release", "other"]) must(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", n, "-f", path.join(keys, n)], { encoding: "utf8" }), "ssh-keygen");
  const signers = `graphloom-release namespaces="graphloom-release,git" ${(await readFile(path.join(keys, "release.pub"), "utf8")).trim()}\n`;

  await cp(path.join(repoRoot, "scripts"), path.join(repo, "scripts"), { recursive: true });
  await writeFile(path.join(repo, "scripts", "gate-mark.mjs"), GATE_MARK);
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\nrelease-out/\n");
  await writeJson(path.join(repo, "package.json"), {
    name: "graphloom",
    private: true,
    version: "0.0.0",
    license: "Apache-2.0",
    type: "module",
    workspaces: ["packages/*", "executors/*", "apps/*", "examples/plugins/*"],
    scripts: { build: "node scripts/gate-mark.mjs build", typecheck: "node scripts/gate-mark.mjs typecheck", test: "node scripts/gate-mark.mjs test" },
  });
  const runnerDist = pathToFileURL(path.join(repoRoot, "packages", "runner", "dist", "index.js")).href;
  for (const p of LOCKSTEP_PACKAGES) {
    await writeJson(path.join(repo, "packages", p, "package.json"), { name: `@graphloom/${p}`, version: "0.0.0", type: "module", ...(p === "sdk" ? {} : { dependencies: { "@graphloom/sdk": "0.0.0" } }) });
  }
  await mkdir(path.join(repo, "packages/sdk/dist"), { recursive: true });
  await mkdir(path.join(repo, "packages/runner/dist"), { recursive: true });
  await mkdir(path.join(repo, "packages/controller/dist"), { recursive: true });
  await writeFile(path.join(repo, "packages/sdk/dist/index.js"), "export const PROTOCOL_VERSION = 1;\n");
  await writeFile(path.join(repo, "packages/runner/dist/index.js"), `export { digestExecutorSource } from ${JSON.stringify(runnerDist)};\n`);
  await writeFile(
    path.join(repo, "packages/controller/dist/index.js"),
    "export const CURRENT_STATE_FORMAT = 1;\nexport function migrationPath(from) { if (from !== 1) throw new Error(`no migrator from ${from}`); return []; }\n",
  );
  await writeJson(path.join(repo, "packages/testkit/package.json"), { name: "@graphloom/testkit", version: "0.0.0", private: true, dependencies: { "@graphloom/sdk": "0.0.0" } });
  await writeJson(path.join(repo, "apps/graphloom/package.json"), { name: "@graphloom/cli", version: "0.0.0", dependencies: { "@graphloom/sdk": "0.0.0", "@graphloom/executor-command": "0.1.0" } });
  await writeJson(path.join(repo, "executors/command/package.json"), { name: "@graphloom/executor-command", version: "0.1.0", type: "module", dependencies: { "@graphloom/sdk": "0.0.0" } });
  await writeFile(path.join(repo, "executors/command/index.js"), `${HEADER}export const command = true;\n`);
  const hello = path.join(repo, "examples/plugins/hello");
  await writeJson(path.join(hello, "package.json"), {
    name: "@graphloom/plugin-hello",
    version: "0.1.0",
    type: "module",
    scripts: { manifest: "node ./scripts/generate-manifest.mjs" },
    dependencies: { "@graphloom/sdk": "file:../../../packages/sdk" },
  });
  await writeJson(path.join(hello, "package-lock.json"), {
    name: "@graphloom/plugin-hello",
    version: "0.1.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "@graphloom/plugin-hello", version: "0.1.0", dependencies: { "@graphloom/sdk": "file:../../../packages/sdk" } },
      "../../../packages/sdk": { name: "@graphloom/sdk", version: "0.0.0" },
      "node_modules/@graphloom/sdk": { resolved: "../../../packages/sdk", link: true },
    },
  });
  await mkdir(path.join(hello, "scripts"), { recursive: true });
  await writeFile(path.join(hello, "scripts", "generate-manifest.mjs"), GENERATE_MANIFEST);
  must(spawnSync(process.execPath, ["scripts/generate-manifest.mjs"], { cwd: hello, encoding: "utf8" }), "generate-manifest");
  await writeJson(path.join(repo, "release", "node.json"), { version: process.versions.node, platform: "linux-x64", sha256: "0".repeat(64) });

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    LANG: "C.UTF-8",
    TMPDIR: base,
    GRAPHLOOM_RELEASE_REPO: "stub/graphloom",
    GRAPHLOOM_STUB_GH_RELEASES: releases,
    GRAPHLOOM_STUB_GH_LOG: ghLog,
    FIXTURE_GATE_LOG: gateLog,
    npm_config_cache: path.join(base, "npm-cache"),
  };
  const git = (...args: string[]) => must(spawnSync("git", args, { cwd: repo, env, encoding: "utf8" }), `git ${args.join(" ")}`).trim();
  must(spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], { cwd: repo, env, encoding: "utf8" }), "npm install --package-lock-only");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  must(spawnSync("git", ["init", "-q", "--bare", remote], { env, encoding: "utf8" }), "git init --bare");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "origin");

  return {
    base,
    repo,
    remote,
    releases,
    ghLog,
    gateLog,
    nodeDir,
    key: path.join(keys, "release"),
    otherKey: path.join(keys, "other"),
    signers,
    env,
    git,
    releaseSh: (args, extra = {}) => spawnSync(path.join(repo, "scripts", "release.sh"), args, { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 }),
    ghCalls: () => readFileSync(ghLog, "utf8").split("\n").filter(Boolean),
  };
}

describe("release.sh prepare (§6 steps 1-2)", () => {
  it("refuses another branch, a dirty tree, an existing tag, and a version not above the latest release", async () => {
    const fx = await makeFixture();
    fx.git("checkout", "-q", "-b", "elsewhere");
    let r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("prepare runs on main, not elsewhere");
    fx.git("checkout", "-q", "main");

    await writeFile(path.join(fx.repo, "package.json"), readFileSync(path.join(fx.repo, "package.json"), "utf8").replace('"private": true', '"private": false'));
    r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the tree is not clean (only CHANGELOG.md may differ from main)");
    fx.git("checkout", "-q", "--", "package.json");

    fx.git("tag", "v0.1.0");
    r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.stderr).toContain("tag v0.1.0 already exists");
    fx.git("tag", "-d", "v0.1.0");

    await mkdir(path.join(fx.releases, "v0.2.0"));
    await writeJson(path.join(fx.releases, "v0.2.0", "release.json"), { version: "0.2.0" });
    r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("0.1.0 is not greater than the latest release 0.2.0");
    r = fx.releaseSh(["prepare", "0.3.0", "--first", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.stderr).toContain("--first, but 0.2.0 is already released");
    expect(fx.git("branch", "--list", "release/*")).toBe("");
  }, 60_000);

  it("writes a changelog draft and stops, then refuses the draft until its TODOs are filled in", async () => {
    const fx = await makeFixture();
    let r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("wrote a draft 0.1.0 section into CHANGELOG.md");
    const draft = readFileSync(path.join(fx.repo, "CHANGELOG.md"), "utf8");
    expect(draft).toContain("## [0.1.0] - ");
    expect(draft).toContain("- fixture");
    expect(draft).toContain(`- **Node:** ${process.versions.node} (bundled).`);
    expect(fx.git("status", "--porcelain")).toBe("?? CHANGELOG.md");
    r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the 0.1.0 section still has a TODO marker");
    expect(fx.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  }, 60_000);

  it("bumps, refreshes lockfiles and manifests, commits on release/v<version>, gates the commit in a staged clone, and prints the PR commands", async () => {
    const fx = await makeFixture();
    const manifestBefore = readFileSync(path.join(fx.repo, "examples/plugins/hello/graphloom.manifest.json"), "utf8");
    await writeFile(path.join(fx.repo, "CHANGELOG.md"), `# Changelog\n\n${COMPLETE_SECTION("0.1.0")}`);
    const r = fx.releaseSh(["prepare", "0.1.0", "--no-pr", "--node-dir", fx.nodeDir]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fx.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("release/v0.1.0");
    expect(fx.git("status", "--porcelain")).toBe("");
    expect(fx.git("log", "-1", "--format=%s")).toBe("release: v0.1.0");
    const files = fx.git("diff", "--name-only", "main", "HEAD").split("\n").sort();
    expect(files).toEqual(
      [
        "CHANGELOG.md",
        "apps/graphloom/package.json",
        "examples/plugins/hello/graphloom.manifest.json",
        "examples/plugins/hello/package-lock.json",
        "executors/command/package.json",
        "package-lock.json",
        "package.json",
        ...LOCKSTEP_PACKAGES.map((p) => `packages/${p}/package.json`),
        "packages/testkit/package.json",
      ].sort(),
    );
    const lock = JSON.parse(fx.git("show", "HEAD:package-lock.json"));
    expect(lock.version).toBe("0.1.0");
    expect(lock.packages["packages/sdk"].version).toBe("0.1.0");
    expect(readFileSync(path.join(fx.repo, "examples/plugins/hello/graphloom.manifest.json"), "utf8")).not.toBe(manifestBefore);
    const changelog = readFileSync(path.join(fx.repo, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("| @graphloom/executor-command | executor | 0.1.0 |\n| hello | plugin | 0.1.0 |");

    // The manifests were regenerated on a built copy, and the gate ran in a clean clone of the release commit; neither in the repository.
    const gate = readFileSync(fx.gateLog, "utf8").trim().split("\n");
    expect(gate.map((l) => l.split(" ")[0])).toEqual(["build", "build", "typecheck", "test"]);
    expect(gate[0]!.endsWith("/manifests")).toBe(true);
    const staged = gate[1]!.split(" ")[1]!;
    expect(staged).not.toBe(fx.repo);
    expect(staged.endsWith("/src")).toBe(true);
    expect(gate.slice(1).every((l) => l.endsWith(` ${staged}`))).toBe(true);
    expect(r.stdout).toContain("components: no previous release to compare with");
    expect(r.stdout).toContain(`git push -u origin release/v0.1.0`);
    expect(r.stdout).toMatch(/gh pr create -R stub\/graphloom --base main --head release\/v0\.1\.0 --title release:\\ v0\.1\.0 --body-file /);
    expect(fx.ghCalls().some((c) => c.startsWith("pr create"))).toBe(false);
    expect(spawnSync("git", ["ls-remote", "--heads", fx.remote, "release/v0.1.0"], { encoding: "utf8" }).stdout).toBe("");
  }, 120_000);

  it("pushes the branch and opens the PR, and enforces the bump rule against the previous release", async () => {
    const fx = await makeFixture();
    await writeFile(path.join(fx.repo, "CHANGELOG.md"), `# Changelog\n\n${COMPLETE_SECTION("0.1.0")}`);
    let r = fx.releaseSh(["prepare", "0.1.0", "--node-dir", fx.nodeDir]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(spawnSync("git", ["ls-remote", "--heads", fx.remote, "release/v0.1.0"], { encoding: "utf8" }).stdout).toContain("refs/heads/release/v0.1.0");
    const pr = fx.ghCalls().find((c) => c.startsWith("pr create"));
    expect(pr).toContain("--base main --head release/v0.1.0 --title release: v0.1.0");

    // "Merge" it, publish 0.1.0 as recorded with another executor digest, and prepare 0.1.1 without a bump.
    fx.git("checkout", "-q", "main");
    fx.git("merge", "-q", "--ff-only", "release/v0.1.0");
    fx.git("push", "-q", "origin", "main");
    await mkdir(path.join(fx.releases, "v0.1.0"));
    await writeJson(path.join(fx.releases, "v0.1.0", "release.json"), {
      version: "0.1.0",
      stateFormat: 1,
      sdk: { sdkProtocol: 1 },
      executors: [{ package: "@graphloom/executor-command", version: "0.1.0", digest: "f".repeat(64) }],
      plugins: [],
    });
    const changelog = readFileSync(path.join(fx.repo, "CHANGELOG.md"), "utf8");
    await writeFile(path.join(fx.repo, "CHANGELOG.md"), P.insertSection(changelog, COMPLETE_SECTION("0.1.1")));
    r = fx.releaseSh(["prepare", "0.1.1", "--node-dir", fx.nodeDir]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("previous release: 0.1.0");
    expect(r.stderr).toContain("executor @graphloom/executor-command: its digest changed since 0.1.0, but its version is still 0.1.0; bump it");
    expect(fx.ghCalls().filter((c) => c.startsWith("pr create"))).toHaveLength(1);
  }, 180_000);
});

// ---------------------------------------------------------------- publish

interface Assets {
  dir: string;
  commit: string;
}

/** A fake release tree whose CLI answers `version` and `doctor`, packed with the real install.sh and launcher. */
async function makeAssets(fx: Fixture, version: string, options: { signWith?: "release" | "other"; reproduced?: boolean; stateFormat?: number } = {}): Promise<Assets> {
  const commit = fx.git("rev-parse", "HEAD");
  const name = `graphloom-${version}-linux-x64`;
  const work = path.join(fx.base, `assets-${version}-${Math.random().toString(16).slice(2)}`);
  const tree = path.join(work, "tree", name);
  const dir = path.join(work, "out");
  for (const d of [path.join(tree, "bin"), path.join(tree, "node", "bin"), path.join(tree, "apps", "graphloom", "dist"), path.join(tree, "release"), dir]) await mkdir(d, { recursive: true });
  await writeFile(path.join(dir, `graphloom-sdk-${version}.tgz`), `sdk ${version}\n`);
  const release = {
    product: "graphloom",
    version,
    license: "Apache-2.0",
    platform: "linux-x64",
    git: { tag: `v${version}`, commit, sourceDateEpoch: 0 },
    node: { version: process.versions.node },
    sdk: { version, sdkProtocol: 1, sha256: sha256(`sdk ${version}\n`) },
    stateFormat: options.stateFormat ?? 1,
    executors: [{ package: "@graphloom/executor-command", version: "0.1.0", digest: "d".repeat(64) }],
    plugins: [{ graphId: "hello", version: "0.1.0", manifestSha256: "m", sourceTree: "s" }],
  };
  await writeJson(path.join(tree, "release.json"), release);
  await copyFile(path.join(fx.repo, "scripts", "release", "launcher.sh"), path.join(tree, "bin", "graphloom"));
  await chmod(path.join(tree, "bin", "graphloom"), 0o755);
  await symlink(process.execPath, path.join(tree, "node", "bin", "node"));
  for (const f of ["install.sh", "shim.sh"]) await copyFile(path.join(fx.repo, "scripts", f), path.join(tree, f));
  await writeFile(path.join(tree, "release", "allowed_signers"), fx.signers);
  await writeFile(path.join(tree, "apps", "graphloom", "package.json"), `{"type":"module"}\n`);
  await writeFile(
    path.join(tree, "apps", "graphloom", "dist", "main.js"),
    `const [cmd] = process.argv.slice(2);\nif (cmd === "version") console.log(${JSON.stringify(`graphloom ${version} (${commit.slice(0, 7)})`)});\nelse if (cmd === "doctor") console.log("doctor: stub");\n`,
  );
  // The shipped controller's migrators: a path from format 1 to the release's format.
  await mkdir(path.join(tree, "packages", "controller", "dist"), { recursive: true });
  await writeFile(path.join(tree, "packages", "controller", "package.json"), `{"type":"module"}\n`);
  await writeFile(
    path.join(tree, "packages", "controller", "dist", "index.js"),
    `export const CURRENT_STATE_FORMAT = ${options.stateFormat ?? 1};\nexport function migrationPath(from) { if (from !== 1) throw new Error("no migrator from " + from); return []; }\n`,
  );
  must(spawnSync("tar", ["-czf", path.join(dir, `${name}.tar.gz`), "-C", path.join(work, "tree"), name], { encoding: "utf8" }), "tar");
  await writeJson(path.join(dir, "release.json"), release);
  await copyFile(path.join(fx.repo, "scripts", "install.sh"), path.join(dir, "install.sh"));
  const names = [`${name}.tar.gz`, `graphloom-sdk-${version}.tgz`, "release.json", "install.sh"];
  const sums = names.map((n) => `${sha256(readFileSync(path.join(dir, n)))}  ${n}`).join("\n") + "\n";
  await writeFile(path.join(dir, "SHA256SUMS"), sums);
  must(
    spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-f", options.signWith === "other" ? fx.otherKey : fx.key, "-n", "graphloom-release", path.join(dir, "SHA256SUMS")], { encoding: "utf8" }),
    "ssh-keygen -Y sign",
  );
  if (options.reproduced !== false) {
    const assets = Object.fromEntries(names.map((n) => [n, sha256(readFileSync(path.join(dir, n)))]));
    await writeJson(path.join(dir, "reproduced.json"), { commit, comparedTo: "/elsewhere", assets });
  }
  return { dir, commit };
}

/** Commits the release key's allowed_signers and a complete 0.1.0 changelog with the assets' components, and pushes main. */
async function releasableFixture(): Promise<Fixture> {
  const fx = await makeFixture();
  await writeFile(path.join(fx.repo, "release", "allowed_signers"), fx.signers);
  const table = P.componentsTable({
    executors: [{ package: "@graphloom/executor-command", version: "0.1.0" }],
    plugins: [{ graphId: "hello", version: "0.1.0" }],
  });
  await writeFile(path.join(fx.repo, "CHANGELOG.md"), P.withTable(`# Changelog\n\n${COMPLETE_SECTION("0.1.0")}`, "0.1.0", table));
  fx.git("add", "-A");
  fx.git("commit", "-q", "-m", "release key and changelog");
  fx.git("push", "-q", "origin", "main");
  return fx;
}

const ASSET_NAMES = ["graphloom-0.1.0-linux-x64.tar.gz", "graphloom-sdk-0.1.0.tgz", "release.json", "install.sh", "SHA256SUMS", "SHA256SUMS.sig"];

describe("release.sh publish (§6 steps 9-10)", () => {
  it("--dry-run checks everything, signs the tag only in a scratch clone, prints the commands, and installs through a stub gh", async () => {
    const fx = await releasableFixture();
    const assets = await makeAssets(fx, "0.1.0");
    const r = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir, "--signing-key", fx.key, "--dry-run"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain(`signature: SHA256SUMS.sig verifies against release/allowed_signers at ${assets.commit}`);
    expect(r.stdout).toContain("reproduced: /elsewhere");
    expect(r.stdout).toContain("previous release: none; 0.1.0 is the first release");
    expect(r.stdout).toContain('Good "git" signature for graphloom-release');
    expect(r.stdout).toMatch(new RegExp(`git -C ${fx.repo} -c gpg.format=ssh -c user.signingKey=${fx.key} tag -s -a -m GraphLoom\\\\ v0\\.1\\.0 v0\\.1\\.0 ${assets.commit}`));
    expect(r.stdout).toContain(`git -C ${fx.repo} push origin refs/tags/v0.1.0`);
    expect(r.stdout).toContain(`gh release create v0.1.0 -R stub/graphloom --verify-tag --title GraphLoom\\ v0.1.0 --notes-file `);
    for (const a of ASSET_NAMES) expect(r.stdout).toContain(`${assets.dir}/${a}`);
    expect(r.stdout).toContain("signature: verified");
    expect(r.stdout).toContain(`installed through gh in a fresh HOME: graphloom 0.1.0 (${assets.commit.slice(0, 7)})`);
    expect(r.stdout).toContain("nothing was tagged, pushed, or released");
    // Nothing shared changed.
    expect(fx.git("tag", "-l")).toBe("");
    expect(spawnSync("git", ["ls-remote", "--tags", fx.remote], { encoding: "utf8" }).stdout).toBe("");
    expect(await readdir(fx.releases)).toEqual([]);
    expect(fx.ghCalls().some((c) => c.startsWith("release create"))).toBe(false);
  }, 120_000);

  it("tags, pushes the signed tag, creates the release with every asset and the changelog section, re-verifies it, and installs it through gh", async () => {
    const fx = await releasableFixture();
    const assets = await makeAssets(fx, "0.1.0");
    const r = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir], { GRAPHLOOM_RELEASE_SIGNING_KEY: fx.key });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fx.git("rev-parse", "v0.1.0^{commit}")).toBe(assets.commit);
    expect(fx.git("cat-file", "-t", "v0.1.0")).toBe("tag");
    expect(spawnSync("git", ["ls-remote", "--tags", fx.remote], { encoding: "utf8" }).stdout).toContain("refs/tags/v0.1.0");
    const signersFile = path.join(fx.base, "verify_signers");
    await writeFile(signersFile, fx.signers);
    expect(spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${signersFile}`, "verify-tag", "v0.1.0"], { cwd: fx.repo, env: fx.env, encoding: "utf8" }).status).toBe(0);
    const published = (await readdir(path.join(fx.releases, "v0.1.0"))).filter((f) => !f.startsWith("."));
    expect(published.sort()).toEqual([...ASSET_NAMES].sort());
    for (const a of ASSET_NAMES) expect(readFileSync(path.join(fx.releases, "v0.1.0", a))).toEqual(readFileSync(path.join(assets.dir, a)));
    const notes = readFileSync(path.join(fx.releases, "v0.1.0", ".notes"), "utf8");
    expect(notes.startsWith("The release.\n")).toBe(true);
    expect(notes).toContain("### Upgrade notes");
    expect(notes).toContain("| hello | plugin | 0.1.0 |");
    expect(r.stdout).toContain("published: v0.1.0 re-downloaded; SHA256SUMS and its signature verify");
    expect(r.stdout).toContain(`installed through gh in a fresh HOME: graphloom 0.1.0 (${assets.commit.slice(0, 7)})`);
    expect(fx.ghCalls()).toContainEqual(expect.stringMatching(/^release download v0\.1\.0 -R stub\/graphloom -D .*-p graphloom-0\.1\.0-linux-x64\.tar\.gz -p SHA256SUMS$/));

    // A second publish of the same version is refused: the release exists.
    const again = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir, "--signing-key", fx.key, "--dry-run"]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("stub/graphloom already has a release v0.1.0");
  }, 120_000);

  it("refuses assets signed by another key, without reproduction evidence, of a commit not on main, or tampered with", async () => {
    const fx = await releasableFixture();
    const publish = (dir: string) => fx.releaseSh(["publish", "0.1.0", "--assets", dir, "--signing-key", fx.key, "--dry-run"]);

    let r = publish((await makeAssets(fx, "0.1.0", { signWith: "other" })).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SHA256SUMS.sig does not verify against release/allowed_signers at");

    r = publish((await makeAssets(fx, "0.1.0", { reproduced: false })).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("has no reproduced.json; build again with --compare-to");

    const tampered = await makeAssets(fx, "0.1.0");
    await writeFile(path.join(tampered.dir, "install.sh"), "#!/bin/sh\necho tampered\n");
    r = publish(tampered.dir);
    expect(r.stderr).toContain("an asset does not match SHA256SUMS");

    r = fx.releaseSh(["publish", "0.1.0", "--assets", (await makeAssets(fx, "0.1.0")).dir, "--signing-key", fx.otherKey, "--dry-run"]);
    expect(r.stderr).toContain("is not the one release/allowed_signers names");

    fx.git("commit", "-q", "--allow-empty", "-m", "unpushed");
    r = publish((await makeAssets(fx, "0.1.0")).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/the release commit [0-9a-f]{40} is not on origin\/main/);
    expect(fx.git("tag", "-l")).toBe("");
    expect(await readdir(fx.releases)).toEqual([]);
  }, 120_000);

  it("--dry-run accepts a tag an earlier attempt left at the commit, verifying it as it is", async () => {
    const fx = await releasableFixture();
    const assets = await makeAssets(fx, "0.1.0");
    fx.git("-c", "gpg.format=ssh", "-c", `user.signingKey=${fx.key}`, "tag", "-s", "-a", "-m", "GraphLoom v0.1.0", "v0.1.0", assets.commit);
    const before = fx.git("rev-parse", "v0.1.0");
    const r = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir, "--signing-key", fx.key, "--dry-run"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).not.toContain("tag -s -a");
    expect(r.stdout).toContain(`push origin refs/tags/v0.1.0`);
    expect(fx.git("rev-parse", "v0.1.0")).toBe(before);
    expect(spawnSync("git", ["ls-remote", "--tags", fx.remote], { encoding: "utf8" }).stdout).toBe("");
  }, 60_000);

  it("checks a new state format against the shipped migrators and the fixtures committed at the release commit", async () => {
    const fx = await releasableFixture();
    await mkdir(path.join(fx.releases, "v0.1.0"));
    await writeJson(path.join(fx.releases, "v0.1.0", "release.json"), {
      version: "0.1.0",
      stateFormat: 1,
      sdk: { sdkProtocol: 1 },
      executors: [{ package: "@graphloom/executor-command", version: "0.1.0", digest: "d".repeat(64) }],
      plugins: [{ graphId: "hello", version: "0.1.0", manifestSha256: "m", sourceTree: "s" }],
    });
    const table = P.componentsTable({ executors: [{ package: "@graphloom/executor-command", version: "0.1.0" }], plugins: [{ graphId: "hello", version: "0.1.0" }] });
    const changelog = readFileSync(path.join(fx.repo, "CHANGELOG.md"), "utf8");
    await writeFile(path.join(fx.repo, "CHANGELOG.md"), P.withTable(P.insertSection(changelog, COMPLETE_SECTION("0.2.0")), "0.2.0", table));
    fx.git("commit", "-q", "-am", "0.2.0 changelog");
    fx.git("push", "-q", "origin", "main");
    const publish = (dir: string) => fx.releaseSh(["publish", "0.2.0", "--assets", dir, "--signing-key", fx.key, "--dry-run"]);
    let r = publish((await makeAssets(fx, "0.2.0", { stateFormat: 2 })).dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stateFormat changed from 1 to 2, but no committed fixture under packages/controller/test/fixtures/state-formats/ is in format 1");

    await writeJson(path.join(fx.repo, "packages/controller/test/fixtures/state-formats/v0.1/fixture.json"), { stateFormat: 1 });
    fx.git("add", "-A");
    fx.git("commit", "-q", "-m", "format 1 fixture");
    fx.git("push", "-q", "origin", "main");
    r = publish((await makeAssets(fx, "0.2.0", { stateFormat: 2 })).dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("components: the bump rule holds against 0.1.0");
    expect(r.stdout).toContain("dry run: would also install 0.1.0 in a fresh HOME, run graphloom upgrade, and require graphloom 0.2.0");
  }, 90_000);

  it("refuses a release commit with no committed allowed_signers, naming how to create the key", async () => {
    const fx = await makeFixture();
    await writeFile(path.join(fx.repo, "CHANGELOG.md"), `# Changelog\n\n${COMPLETE_SECTION("0.1.0")}`);
    fx.git("add", "-A");
    fx.git("commit", "-q", "-m", "changelog");
    fx.git("push", "-q", "origin", "main");
    const assets = await makeAssets(fx, "0.1.0");
    const r = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir, "--signing-key", fx.key, "--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ssh-keygen -t ed25519 -C graphloom-release -f ~/.ssh/graphloom-release");
    expect(r.stderr).toContain("release/allowed_signers is not committed at");
    expect(existsSync(path.join(fx.repo, "release", "allowed_signers"))).toBe(false);
    const none = fx.releaseSh(["publish", "0.1.0", "--assets", assets.dir, "--dry-run"]);
    expect(none.stderr).toContain("no signing key: pass --signing-key <file> or set GRAPHLOOM_RELEASE_SIGNING_KEY");
  }, 60_000);
});
