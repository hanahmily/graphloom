// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepo, createScope, execFileAsync, exampleBundle, startHttpsGit, type GitRepo } from "@graphloom/testkit";
import { parseTaskNewArgs, taskNew, type TaskNewOptions } from "../src/task-new.js";
import { check } from "../src/rehearsal.js";

const scope = createScope();
afterEach(() => scope.dispose());

const STUB_SOURCE = `
export function createGraph() {
  return {
    describe: () => ({ graphId: "stub", version: "1", stages: [{ id: "s", name: "S", requirementIds: [] }], requirements: [], defaultValidators: [] }),
    advance: () => ({ action: { type: "stop", stop: { reason: "complete" } }, reason: "x" }),
    prepareTask(input) {
      const [mode, json] = input.args;
      if (mode === "refuse") return { refused: "no such thing: " + json };
      if (mode === "throw") throw new Error("boom");
      if (mode === "echo") return { summary: "echo", steps: [{ kind: "writeTask", path: "echo/task.yaml", fields: { request: JSON.stringify(input) } }] };
      return JSON.parse(json);
    },
  };
}
`;
const NO_HOOK_SOURCE = STUB_SOURCE.replace("    prepareTask(input) {", "    notPrepare(input) {");

async function stubBundle(out: string, graph: string, source = STUB_SOURCE): Promise<string> {
  const dir = path.join(out, "plugins", graph);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.mjs"), source);
  await writeFile(path.join(dir, "graphloom.manifest.json"), JSON.stringify({ graphId: graph, version: "1", sdkProtocol: 1, entryPoints: { createGraph: "./index.mjs" } }));
  return dir;
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => void lines.push(l), err: (l: string) => void errors.push(l) };
}

async function run(options: Partial<TaskNewOptions> & { graph: string; args: string[] }, io = output()) {
  const code = await taskNew({ env: process.env, ...options }, io.out, io.err);
  return { code, ...io };
}

interface World {
  dir: string;
  out: string;
  repo: GitRepo;
  /** The bare repository the fixture serves, with the pull request's head at refs/pull/7/head. */
  bare: string;
  head: string;
  base: string;
  url: string;
}

/** A clone whose https remote is served by a local smart-HTTPS git, and a pull request 7 whose head is two commits past the base. */
async function world(): Promise<World> {
  const dir = await scope.tempDir("gl-tasknew-");
  const serve = path.join(dir, "serve");
  await mkdir(serve, { recursive: true });
  const origin = await createGitRepo(path.join(dir, "origin"), { files: { "a.txt": "one\n" } });
  const base = await origin.git("rev-parse", "HEAD");
  await origin.git("checkout", "-q", "-b", "feature");
  await origin.write({ "b.txt": "two\n" });
  await origin.commit("feature one");
  await origin.write({ "c.txt": "three\n" });
  await origin.commit("feature two");
  const head = await origin.git("rev-parse", "HEAD");
  const bare = path.join(serve, "widgets.git");
  await execFileAsync("git", ["clone", "-q", "--bare", origin.path, bare]);
  await execFileAsync("git", ["update-ref", "refs/pull/7/head", head], { cwd: bare });
  const server = await startHttpsGit(scope, serve);
  const repo = await createGitRepo(path.join(dir, "clone"), { files: { "a.txt": "one\n" } });
  const url = server.url("widgets.git");
  await repo.git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  // The fixture stands in for GitHub: this repository's own config rewrites the URL and trusts the test certificate.
  await repo.git("config", `url.${url}.insteadOf`, "https://github.com/acme/widgets.git");
  await repo.git("config", "http.sslCAInfo", server.caFile);
  const out = path.join(dir, "ws");
  await mkdir(out, { recursive: true });
  return { dir, out, repo, bare, head, base, url };
}

const NS = "refs/graphloom/stub";
function fetchPlan(w: World, extra: object[] = [], fields: Record<string, string> = { request: "Do it." }): string {
  return JSON.stringify({
    summary: "stub plan",
    steps: [
      { kind: "fetch", remote: "origin", refspec: "refs/pull/7/head", intoRef: `${NS}/7/head` },
      { kind: "fetch", remote: "origin", refspec: "refs/heads/main", intoRef: `${NS}/7/base` },
      { kind: "resolve", name: "headSha", revParse: `${NS}/7/head` },
      { kind: "updateRef", from: "${headSha}", to: `${NS}/7/heads/\${headSha}` },
      { kind: "resolve", name: "mergeBase", mergeBase: [`${NS}/7/head`, `${NS}/7/base`] },
      ...extra,
      { kind: "writeTask", path: "t/task.yaml", fields },
    ],
  });
}

/** A world whose served repository also has a `main` branch at the base. */
async function worldWithMain(): Promise<World> {
  const w = await world();
  await execFileAsync("git", ["update-ref", "refs/heads/main", w.base], { cwd: w.bare });
  return w;
}

describe("graphloom task new: the plan runs as the plan says", () => {
  it("fetches over https into the graph's refs, binds the ids, pins the head, and writes the task with a plugins link", async () => {
    const w = await worldWithMain();
    const bundle = await stubBundle(w.out, "stub");
    const before = {
      head: await w.repo.git("rev-parse", "HEAD"),
      branch: await w.repo.git("symbolic-ref", "HEAD"),
      status: await w.repo.git("status", "--porcelain"),
      index: await w.repo.git("ls-files", "-s"),
      refs: await w.repo.git("for-each-ref", "--format=%(refname)", "refs/heads"),
    };
    const fields = { base: "${mergeBase}", request: "Report on acme/widgets#7 at ${headSha}." };
    const r = await run({ graph: "stub", args: ["plan", fetchPlan(w, [], fields)], repo: w.repo.path, out: w.out });
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(await w.repo.git("rev-parse", `${NS}/7/head`)).toBe(w.head);
    expect(await w.repo.git("rev-parse", `${NS}/7/base`)).toBe(w.base);
    expect(await w.repo.git("rev-parse", `${NS}/7/heads/${w.head}`)).toBe(w.head);
    // The configured remote's own fetch mapping did not also write refs/remotes/origin/*: only the plan's refs changed.
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/remotes")).toBe("");
    const task = await readFile(path.join(w.out, "t", "task.yaml"), "utf8");
    // The clone is outside the task's directory, so the task names it through a link beside it (intake refuses a path that leaves it).
    expect(task).toBe(`graph: stub\nrepo: repo\nbase: ${w.base}\nrequest: "Report on acme/widgets#7 at ${w.head}."\n`);
    expect(await realpath(path.join(w.out, "t", "repo"))).toBe(await realpath(w.repo.path));
    expect(path.isAbsolute(await readlink(path.join(w.out, "t", "repo")))).toBe(false);
    // The task's directory is not --out, so `run` finds the same bundle through the link beside it.
    const link = path.join(w.out, "t", "plugins", "stub");
    expect(await realpath(link)).toBe(await realpath(bundle));
    expect(path.isAbsolute(await readlink(link))).toBe(false);
    // Nothing was checked out, staged or moved.
    expect(await w.repo.git("rev-parse", "HEAD")).toBe(before.head);
    expect(await w.repo.git("symbolic-ref", "HEAD")).toBe(before.branch);
    expect(await w.repo.git("status", "--porcelain")).toBe(before.status);
    expect(await w.repo.git("ls-files", "-s")).toBe(before.index);
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe(before.refs);
    // One line per step, the task's path, the next command.
    expect(r.lines.filter((l) => l.startsWith("step "))).toHaveLength(6);
    expect(r.lines.at(-1)).toMatch(/^next: graphloom check /);
  }, 60_000);

  it("runs no hook and reads no user configuration: reference-transaction, post-checkout and a global hooks path leave no marker", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    const marker = path.join(w.dir, "marker");
    const script = `#!/bin/sh\necho "$0" >> ${marker}\nexit 0\n`;
    for (const hook of ["reference-transaction", "post-checkout", "post-merge", "post-fetch", "pre-auto-gc"]) {
      const file = path.join(w.repo.path, ".git", "hooks", hook);
      await writeFile(file, script);
      await chmod(file, 0o755);
    }
    // A user-level configuration that would run hooks and a credential helper, if it were read.
    const home = path.join(w.dir, "home");
    await mkdir(path.join(home, ".config", "git"), { recursive: true });
    const globalHooks = path.join(w.dir, "global-hooks");
    await mkdir(globalHooks);
    for (const hook of ["reference-transaction", "post-checkout"]) {
      await writeFile(path.join(globalHooks, hook), script);
      await chmod(path.join(globalHooks, hook), 0o755);
    }
    const config = `[core]\n\thooksPath = ${globalHooks}\n[credential]\n\thelper = !sh -c 'echo helper >> ${marker}'\n`;
    await writeFile(path.join(home, ".gitconfig"), config);
    await writeFile(path.join(home, ".config", "git", "config"), config);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
    // Even a repository-level hooks path is overridden.
    await w.repo.git("config", "core.hooksPath", path.join(w.repo.path, ".git", "hooks"));
    const r = await run({ graph: "stub", args: ["plan", fetchPlan(w)], repo: w.repo.path, out: w.out, env });
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(await stat(marker).catch(() => undefined)).toBeUndefined();
    expect(await w.repo.git("rev-parse", `${NS}/7/head`)).toBe(w.head);
  }, 60_000);

  it("a real criss-cross history is refused: exactly one merge base is required", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    const r0 = await createGitRepo(path.join(w.dir, "cc"), { files: { f: "0\n" } });
    const root = await r0.git("rev-parse", "HEAD");
    await r0.git("checkout", "-q", "-b", "a");
    await r0.write({ a: "a\n" });
    await r0.commit("a1");
    await r0.git("checkout", "-q", "-b", "b", root);
    await r0.write({ b: "b\n" });
    await r0.commit("b1");
    // a2 = merge of b1 into a; b2 = merge of a1 into b: each side contains the other's first commit.
    await r0.git("checkout", "-q", "a");
    await r0.git("merge", "-q", "--no-edit", "b");
    await r0.git("checkout", "-q", "b");
    await r0.git("merge", "-q", "--no-edit", "a~1");
    const aTip = await r0.git("rev-parse", "a");
    const bTip = await r0.git("rev-parse", "b");
    expect((await r0.git("merge-base", "--all", "a", "b")).split("\n").length).toBe(2);
    await execFileAsync("git", ["fetch", "-q", r0.path, "a:refs/heads/ca", "b:refs/heads/cb"], { cwd: w.repo.path });
    await w.repo.git("update-ref", `${NS}/a`, aTip);
    await w.repo.git("update-ref", `${NS}/b`, bTip);
    const plan = JSON.stringify({
      summary: "criss",
      steps: [
        { kind: "resolve", name: "mb", mergeBase: [`${NS}/a`, `${NS}/b`] },
        { kind: "writeTask", path: "t/task.yaml", fields: { base: "${mb}", request: "x" } },
      ],
    });
    const r = await run({ graph: "stub", args: ["plan", plan], repo: w.repo.path, out: w.out });
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/2 merge bases/);
    expect(await stat(path.join(w.out, "t", "task.yaml")).catch(() => undefined)).toBeUndefined();
  }, 60_000);

  it("updateRef creates, accepts the same value, and fails on a moved ref", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    const pin = (target: string) =>
      JSON.stringify({
        summary: "pin",
        steps: [
          { kind: "resolve", name: "t", revParse: target },
          { kind: "updateRef", from: "${t}", to: `${NS}/pinned` },
          { kind: "writeTask", path: "t/task.yaml", fields: { request: "x" } },
        ],
      });
    const first = await w.repo.git("rev-parse", "HEAD");
    await w.repo.git("update-ref", `${NS}/one`, first);
    await w.repo.write({ extra: "x\n" });
    await w.repo.commit("second");
    await w.repo.git("update-ref", `${NS}/two`, await w.repo.git("rev-parse", "HEAD"));
    expect((await run({ graph: "stub", args: ["plan", pin(`${NS}/one`)], repo: w.repo.path, out: w.out })).code).toBe(0);
    expect(await w.repo.git("rev-parse", `${NS}/pinned`)).toBe(await w.repo.git("rev-parse", `${NS}/one`));
    // The same value again is left as is (the task file needs --force the second time).
    const again = await run({ graph: "stub", args: ["plan", pin(`${NS}/one`)], repo: w.repo.path, out: w.out, force: true });
    expect(again.code).toBe(0);
    expect(again.lines.join("\n")).toMatch(/already at/);
    const moved = await run({ graph: "stub", args: ["plan", pin(`${NS}/two`)], repo: w.repo.path, out: w.out, force: true });
    expect(moved.code).toBe(1);
    expect(moved.errors.join("\n")).toMatch(/pinned ref moved/);
  }, 60_000);

  it("a failing step stops the plan: no task, and the refs written before it stay", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    // The served repository has no branch "nope", so the second fetch fails after the first one wrote its ref.
    const r = await run({ graph: "stub", args: ["plan", fetchPlan(w).replace("refs/heads/main", "refs/heads/nope")], repo: w.repo.path, out: w.out });
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/fetch/);
    expect(await stat(path.join(w.out, "t", "task.yaml")).catch(() => undefined)).toBeUndefined();
    expect(await w.repo.git("rev-parse", `${NS}/7/head`)).toBe(w.head);
  }, 60_000);

  it("refuses a remote that is not https and a plan outside the namespace before any step runs", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    await w.repo.git("remote", "add", "local", w.bare);
    const plan = (remote: string, intoRef = `${NS}/h`) =>
      JSON.stringify({ summary: "x", steps: [{ kind: "fetch", remote, refspec: "refs/pull/7/head", intoRef }, { kind: "writeTask", path: "t/task.yaml", fields: { request: "x" } }] });
    const viaName = await run({ graph: "stub", args: ["plan", plan("local")], repo: w.repo.path, out: w.out });
    expect(viaName.code).toBe(2);
    expect(viaName.errors.join("\n")).toMatch(/must be https/);
    const viaFile = await run({ graph: "stub", args: ["plan", plan(`file://${w.bare}`)], repo: w.repo.path, out: w.out });
    expect(viaFile.code).toBe(2);
    expect(viaFile.errors.join("\n")).toMatch(/only https/);
    const outside = await run({ graph: "stub", args: ["plan", plan("origin", "refs/heads/main")], repo: w.repo.path, out: w.out });
    expect(outside.code).toBe(2);
    expect(await w.repo.git("rev-parse", "--verify", "--quiet", `${NS}/h`).catch(() => "")).toBe("");
  }, 60_000);
});

describe("graphloom task new: dry runs, overwrites and refusals", () => {
  it("--dry-run runs only read-only git commands and writes nothing", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    // A git on PATH that records its argv and runs the real one.
    const bin = path.join(w.dir, "bin");
    await mkdir(bin);
    const log = path.join(w.dir, "git.log");
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    await writeFile(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${realGit} "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const fields = { base: "${mergeBase}", request: "Report at ${headSha}." };
    const r = await run({ graph: "stub", args: ["plan", fetchPlan(w, [], fields)], repo: w.repo.path, out: w.out, dryRun: true, env });
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(0);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    for (const call of calls) expect(call, call).toMatch(/\b(rev-parse|remote)\b/);
    expect(calls.join("\n")).not.toMatch(/fetch|update-ref|merge-base/);
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/graphloom")).toBe("");
    expect(await stat(path.join(w.out, "t")).catch(() => undefined)).toBeUndefined();
    // The plan and the task with its references unresolved.
    const text = r.lines.join("\n");
    expect(text).toContain("plan: stub plan");
    expect(text).toContain("fetch refs/pull/7/head from origin");
    expect(text).toContain("base: \"${mergeBase}\"");
    expect(text).toContain("Report at ${headSha}.");
  }, 60_000);

  it("refuses a plan whose task cannot be composed before any step runs, in a dry run too", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    for (const dryRun of [false, true]) {
      const r = await run({ graph: "stub", args: ["plan", fetchPlan(w, [], {})], repo: w.repo.path, out: w.out, dryRun });
      expect(r.code).toBe(2);
      expect(r.errors.join("\n")).toMatch(/must declare graph, repo, and request|cannot be written/);
    }
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/graphloom")).toBe("");
  }, 60_000);

  it("refuses a symbolic fetch destination, and a generated link whose parent leaves --out, before anything is written", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    // A destination that is a symbolic ref to a branch: a fetch would move the branch.
    await w.repo.git("branch", "victim");
    const victim = await w.repo.git("rev-parse", "victim");
    await w.repo.git("symbolic-ref", `${NS}/7/head`, "refs/heads/victim");
    const symbolic = await run({ graph: "stub", args: ["plan", fetchPlan(w)], repo: w.repo.path, out: w.out });
    expect(symbolic.code).toBe(2);
    expect(symbolic.errors.join("\n")).toMatch(/is a symbolic ref/);
    expect(await w.repo.git("rev-parse", "victim")).toBe(victim);
    await w.repo.git("symbolic-ref", "--delete", `${NS}/7/head`);
    // The task directory's plugins/ is a link out of --out: the bundle link would be written, and --force would delete, outside.
    const elsewhere = path.join(w.dir, "elsewhere");
    await mkdir(path.join(elsewhere, "stub"), { recursive: true });
    await mkdir(path.join(w.out, "t"), { recursive: true });
    await symlink(elsewhere, path.join(w.out, "t", "plugins"));
    for (const force of [false, true]) {
      const escaped = await run({ graph: "stub", args: ["plan", fetchPlan(w)], repo: w.repo.path, out: w.out, force });
      expect(escaped.code).toBe(2);
      expect(escaped.errors.join("\n")).toMatch(/symbolic link that leaves --out/);
    }
    expect(await stat(path.join(elsewhere, "stub")).catch(() => undefined)).toBeDefined();
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/graphloom")).toBe("");
  }, 60_000);

  it("refuses to replace an existing task before any step runs, and replaces it with --force", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    const taskPath = path.join(w.out, "t", "task.yaml");
    await mkdir(path.dirname(taskPath), { recursive: true });
    await writeFile(taskPath, "graph: stub\nrepo: x\nrequest: old\n");
    const refused = await run({ graph: "stub", args: ["plan", fetchPlan(w)], repo: w.repo.path, out: w.out });
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toMatch(/already exists; --force replaces it/);
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/graphloom")).toBe("");
    expect(await readFile(taskPath, "utf8")).toContain("request: old");
    const forced = await run({ graph: "stub", args: ["plan", fetchPlan(w)], repo: w.repo.path, out: w.out, force: true });
    expect(forced.code).toBe(0);
    expect(await readFile(taskPath, "utf8")).toContain('request: "Do it."');
  }, 60_000);

  it("writes a request that needs quoting as a block scalar intake reads back", async () => {
    const w = await worldWithMain();
    await stubBundle(w.out, "stub");
    const request = 'Say "hi" \\ there\nsecond line';
    const r = await run({ graph: "stub", args: ["plan", fetchPlan(w, [], { request })], repo: w.repo.path, out: w.out });
    expect(r.code).toBe(0);
    const { parseTaskYaml } = await import("@graphloom/controller");
    expect(parseTaskYaml(await readFile(path.join(w.out, "t", "task.yaml"), "utf8")).request).toBe(request);
  }, 60_000);

  it("exits 2 with the plugin's message for a bundle without the hook, a hook that throws, a refusal and a malformed plan", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    await stubBundle(w.out, "nohook", NO_HOOK_SOURCE);
    const exits = async (graph: string, args: string[]) => run({ graph, args, repo: w.repo.path, out: w.out });
    const none = await exits("nohook", ["plan", "{}"]);
    expect(none.code).toBe(2);
    expect(none.errors.join("\n")).toContain("graph nohook does not prepare tasks; write task.yaml by hand");
    const thrown = await exits("stub", ["throw"]);
    expect(thrown.code).toBe(2);
    expect(thrown.errors.join("\n")).toMatch(/prepareTask failed.*boom/);
    const refused = await exits("stub", ["refuse", "this"]);
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toContain("no such thing: this");
    const malformed = await exits("stub", ["plan", JSON.stringify({ summary: "x", steps: [{ kind: "run", argv: ["id"] }] })]);
    expect(malformed.code).toBe(2);
    expect(malformed.errors.join("\n")).toMatch(/step 1 \(run\)/);
    const timeout = await run({ graph: "stub", args: ["plan", "{"], repo: w.repo.path, out: w.out });
    expect(timeout.code).toBe(2);
    expect(await w.repo.git("for-each-ref", "--format=%(refname)", "refs/graphloom")).toBe("");
  }, 60_000);

  it("hands the hook what the CLI read: the arguments verbatim, the remotes, HEAD and the profile", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    await mkdir(path.join(w.out, "profiles"), { recursive: true });
    await writeFile(path.join(w.out, "profiles", "p.json"), '{"name":"p"}');
    const r = await run({ graph: "stub", args: ["echo", "--base", "dev", "--review"], repo: w.repo.path, out: w.out, profile: "p" });
    expect(r.code).toBe(0);
    const task = await readFile(path.join(w.out, "echo", "task.yaml"), "utf8");
    const { parseTaskYaml } = await import("@graphloom/controller");
    const input = JSON.parse(parseTaskYaml(task).request) as { args: string[]; repo: { remotes: Array<{ name: string; url: string }>; head: string }; profile: unknown; options: unknown };
    expect(input.args).toEqual(["echo", "--base", "dev", "--review"]);
    expect(input.repo.head).toBe(await w.repo.git("rev-parse", "HEAD"));
    expect(input.repo.remotes).toEqual([{ name: "origin", url: w.url }]);
    expect(input.profile).toEqual({ name: "p" });
    expect(input.options).toEqual({ dryRun: false });
    expect(task).toContain("config: profile.json");
    expect(await realpath(path.join(w.out, "echo", "profile.json"))).toBe(await realpath(path.join(w.out, "profiles", "p.json")));
  }, 60_000);

  it("resolves a graph only under --out/plugins, and a profile by path or name", async () => {
    const w = await world();
    await stubBundle(w.out, "stub");
    expect((await run({ graph: "../stub", args: ["echo"], repo: w.repo.path, out: w.out })).code).toBe(2);
    expect((await run({ graph: "missing", args: ["echo"], repo: w.repo.path, out: w.out })).errors.join("\n")).toMatch(/no graph bundle missing/);
    expect((await run({ graph: "stub", args: ["echo"], repo: w.repo.path, out: w.out, profile: "nope" })).errors.join("\n")).toMatch(/profile nope was not found/);
    expect((await run({ graph: "stub", args: ["echo"], repo: w.repo.path, out: w.out, profile: "../x.json" })).errors.join("\n")).toMatch(/was not found/);
    await writeFile(path.join(w.dir, "prof.json"), '{"name":"by-path"}');
    const byPath = await run({ graph: "stub", args: ["echo"], repo: w.repo.path, out: w.out, profile: path.join(w.dir, "prof.json") });
    expect(byPath.code).toBe(0);
    // A symlinked directory that leaves --out is refused.
    await symlink(w.dir, path.join(w.out, "echo2"));
    await rm(path.join(w.out, "echo"), { recursive: true, force: true });
    const escape = JSON.stringify({ summary: "x", steps: [{ kind: "writeTask", path: "echo2/task.yaml", fields: { request: "x" } }] });
    const escaped = await run({ graph: "stub", args: ["plan", escape], repo: w.repo.path, out: w.out });
    expect(escaped.code).toBe(2);
    expect(escaped.errors.join("\n")).toMatch(/leaves --out/);
    expect(await lstat(path.join(w.dir, "task.yaml")).catch(() => undefined)).toBeUndefined();
  }, 60_000);
});

describe("graphloom task new: argument parsing", () => {
  it("takes its own flags and leaves the plugin's arguments verbatim, `--` ends the CLI's", () => {
    const parsed = parseTaskNewArgs(["pr-review", "a/b#1", "--base", "dev", "--repo", "r", "--profile=p", "--dry-run", "--review", "--", "--force", "--out"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({ graph: "pr-review", repo: "r", profile: "p", dryRun: true, args: ["a/b#1", "--base", "dev", "--review", "--force", "--out"] });
    expect(parsed.options.force).toBeUndefined();
    expect(parseTaskNewArgs([]).error).toMatch(/graph id/);
    expect(parseTaskNewArgs(["g", "--out"]).error).toMatch(/--out needs a value/);
  });
});

describe("pr-review: graphloom task new, end to end against a fixture remote", () => {
  const profile = { name: "widgets", project: "acme/widgets", environment: { checks: [] } };

  async function prWorld(): Promise<World & { profilePath: string }> {
    const w = await worldWithMain();
    await mkdir(path.join(w.out, "plugins"), { recursive: true });
    await symlink(exampleBundle("pr-review"), path.join(w.out, "plugins", "pr-review"));
    const profilePath = path.join(w.out, "profiles", "widgets.json");
    await mkdir(path.dirname(profilePath), { recursive: true });
    await writeFile(profilePath, JSON.stringify(profile));
    return { ...w, profilePath };
  }

  it("fetches the pull request's head and base, pins heads/<sha>, writes the task with base and the request, and the task passes check", async () => {
    const w = await prWorld();
    const r = await run({ graph: "pr-review", args: ["acme/widgets#7"], repo: w.repo.path, out: w.out, profile: "widgets" });
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(0);
    const R = "refs/graphloom/pr-review/acme/widgets/7";
    expect(await w.repo.git("rev-parse", `${R}/head`)).toBe(w.head);
    expect(await w.repo.git("rev-parse", `${R}/base`)).toBe(w.base);
    expect(await w.repo.git("rev-parse", `${R}/heads/${w.head}`)).toBe(w.head);
    const taskPath = path.join(w.out, "reviews", "widgets-7", "task.yaml");
    const task = await readFile(taskPath, "utf8");
    expect(task).toContain("graph: pr-review");
    expect(task).toContain(`base: ${w.base}`);
    expect(task).toContain(`request: "Review on acme/widgets#7 at ${w.head}."`);
    expect(task).toContain("config: profile.json");
    expect(r.lines[0]).toBe("plan: review of acme/widgets#7 against main");
    const checked = await check(taskPath);
    expect(checked.problems).toEqual([]);
    // A rerun without --force refuses; the pinned head is created once.
    expect((await run({ graph: "pr-review", args: ["acme/widgets#7"], repo: w.repo.path, out: w.out, profile: "widgets" })).code).toBe(2);
    expect((await run({ graph: "pr-review", args: ["https://github.com/acme/widgets/pull/7"], repo: w.repo.path, out: w.out, profile: "widgets", force: true })).code).toBe(0);
    expect(await w.repo.git("rev-parse", `${R}/heads/${w.head}`)).toBe(w.head);
  }, 120_000);

  it("--base names another branch and --review is accepted (every run reviews); a wrong project, a missing profile and a malformed argument are refused", async () => {
    const w = await prWorld();
    await execFileAsync("git", ["update-ref", "refs/heads/release", w.base], { cwd: w.bare });
    const r = await run({ graph: "pr-review", args: ["acme/widgets#7", "--base", "release", "--review"], repo: w.repo.path, out: w.out, profile: "widgets" });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("plan: review of acme/widgets#7 against release");
    expect(await readFile(path.join(w.out, "reviews", "widgets-7", "task.yaml"), "utf8")).toContain(`request: "Review on acme/widgets#7 at ${w.head}."`);
    const refused = async (args: string[], extra: Partial<TaskNewOptions> = { profile: "widgets" }) => run({ graph: "pr-review", args, repo: w.repo.path, out: w.out, ...extra });
    expect((await refused(["other/thing#7"])).errors.join("\n")).toMatch(/not this profile's project \(acme\/widgets\)/);
    expect((await refused(["acme/widgets#7"], {})).errors.join("\n")).toMatch(/needs a task config/);
    expect((await refused(["acme/widgets"])).errors.join("\n")).toMatch(/not a pull request/);
    expect((await refused(["acme/widgets#0"])).errors.join("\n")).toMatch(/not a pull request/);
    expect((await refused([])).errors.join("\n")).toMatch(/exactly one pull request/);
    expect((await refused(["acme/widgets#7", "--bogus"])).errors.join("\n")).toMatch(/unknown argument/);
    expect((await refused(["acme/widgets#7", "--base", "a..b"])).errors.join("\n")).toMatch(/not a branch name/);
  }, 120_000);
});
