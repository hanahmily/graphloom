// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * pr-review's measured coverage under real Docker (design-pr-review-graph.md §12.2, §18 P1): the plugin's own
 * coverage state machine drives the real command executor and the real docker confinement, against a Go module
 * and a vitest project built as temporary fixtures. Skipped (with a warning) where Docker, an image, the Go
 * toolchain, or an offline npm cache is missing; nothing here pulls on its own initiative except test setup,
 * which pulls the pinned images once, as a run's Fetch does.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuiltinExecutorRunner, type JobContext, type Runner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import type { EvidenceRecord, JobSpec } from "@graphloom/sdk";
import { exampleBundle, execFileAsync, repoRoot } from "@graphloom/testkit";

const bundle = exampleBundle("pr-review");

/** The plugin's built modules, as far as this test uses them. */
interface Plugin {
  coverage: { coverageState(input: Record<string, unknown>): unknown; DEFAULT_TS_IMAGE: string };
  graph: { coverageJob(plan: unknown, root: string): JobSpec; sandboxProbeJob(stageId: string, commands: unknown): JobSpec };
  profile: { parseProfile(config: unknown): unknown };
  banyandb: Record<string, unknown>;
}
let plugin: Plugin;
let tmp: string;
let runner: Runner;
let runs = 0;
const runId = `covtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function dockerUp(): boolean {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 30_000 });
  return info.error === undefined && info.status === 0;
}
/** Setup is the one place an image is pulled; a job never pulls. */
function haveImage(image: string): boolean {
  if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0) return true;
  return spawnSync("docker", ["pull", image], { stdio: "ignore", timeout: 600_000 }).status === 0;
}

const hasDocker = dockerUp();
const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const hasNpm = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
let goImage: string | undefined;
let tsImage: string | undefined;
let goReady = false;
let tsReady = false;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-pr-review"], { cwd: repoRoot });
  const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(bundle, "dist", rel)).href)) as T;
  const [coverage, graph, profile] = await Promise.all([load<Plugin["coverage"]>("coverage.js"), load<Plugin["graph"]>("graph.js"), load<Plugin["profile"]>("profile.js")]);
  const banyandb = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8")) as Record<string, unknown>;
  plugin = { coverage, graph, profile, banyandb };
  tmp = await mkdtemp(path.join(os.tmpdir(), "gl-cover-docker-"));
  runner = createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: { runJob: async () => { throw new Error("not served"); } },
    stopGraceMs: 3_000,
  });
  if (hasDocker) {
    goImage = (banyandb.metrics as { sandbox: { go: { image: string } } }).sandbox.go.image;
    tsImage = coverage.DEFAULT_TS_IMAGE;
    goReady = hasGo && haveImage(goImage);
    tsReady = hasNpm && haveImage(tsImage);
  }
  if (!hasDocker) console.warn("pr-review coverage docker tests skipped: Docker is not available");
  else if (!goReady || !tsReady) console.warn(`pr-review coverage docker tests: go ${goReady ? "ready" : "skipped (no Go toolchain or image)"}, typescript ${tsReady ? "ready" : "skipped (no npm or image)"}`);
}, 900_000);

afterAll(async () => {
  spawnSync("sh", ["-c", `docker ps -aq --filter label=graphloom.run=${runId} | xargs -r docker rm -f`], { stdio: "ignore" });
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the pull request's evidence, as the graph's loop gathers it

let n = 0;
const asRecord = (item: { kind: string; payload?: unknown }): EvidenceRecord => ({ ref: `e${(n += 1)}`, kind: item.kind as EvidenceRecord["kind"], candidateDigest: "d1", payload: item.payload } as EvidenceRecord);

function ctxFor(work: string, scratch: string): JobContext {
  runs += 1;
  return { runId, operationId: `op-${runs}`, generation: 1, worktreePath: work, artifactDir: path.join(tmp, "artifacts"), scratchDir: scratch };
}

interface Measured {
  /** The state the loop ended in. */
  state: { state: string; outcomes?: Map<string, { reason: string } | { source: string; covered: number; total: number }>; facts?: { runs: Array<{ language: string; ran: boolean; exit?: number; reason?: string; tests: string[]; changed: string[] }> } };
  evidence: EvidenceRecord[];
  /** Jobs the loop sent to the runner, by instruction. */
  jobs: JobSpec[];
}

/**
 * The loop of `measureAndWrite` for coverage, against a real checkout directory: the probe, observed files, and the
 * coverage job, until the state is done. The checkout of the controller is a disposable copy; here it is `work`.
 */
async function measure(input: { work: string; scratch: string; records: unknown[]; index: Map<string, unknown>; files: Array<{ path: string; language: "go" | "typescript" }>; profile: unknown; env?: Record<string, string> }): Promise<Measured> {
  const diff = asRecord({ kind: "command", payload: { command: { id: "metrics-diff", argv: [], exitCode: 0, stdoutTail: "", stderrTail: "" } } });
  const evidence: EvidenceRecord[] = [diff];
  const jobs: JobSpec[] = [];
  const saved = { ...process.env };
  Object.assign(process.env, input.env ?? {});
  try {
    for (let step = 0; step < 12; step += 1) {
      const state = plugin.coverage.coverageState({ evidence, records: input.records as never, index: input.index as never, files: input.files, profile: input.profile as never, afterRef: diff.ref }) as Measured["state"] & { commands?: Array<{ id: string; argv: string[] }>; paths?: string[]; plan?: unknown };
      if (state.state === "done" || state.state === "failed") return { state, evidence, jobs };
      let job: JobSpec;
      if (state.state === "observe") {
        for (const p of state.paths!) {
          const bytes = await readFile(path.join(input.work, p), "utf8").catch(() => undefined);
          evidence.push(asRecord({ kind: "file", payload: { path: p, bytes: bytes ?? "" } }));
          if (bytes === undefined) evidence[evidence.length - 1]!.fingerprint = "missing";
        }
        continue;
      }
      if (state.state === "probe") job = plugin.graph.sandboxProbeJob("fetch", state.commands as never);
      else {
        const { checkout: _checkout, ...sandboxed } = plugin.graph.coverageJob(state.plan as never, bundle);
        void _checkout;
        job = sandboxed;
      }
      jobs.push(job);
      const result = await runner.runJob(job, ctxFor(input.work, input.scratch));
      if (result.status !== "ok") {
        evidence.push(asRecord({ kind: "other", payload: { executorFailure: { summary: result.summary } } }));
        continue;
      }
      for (const item of result.evidence ?? []) evidence.push(asRecord(item));
    }
    throw new Error("the coverage loop did not settle");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const git = (cwd: string, ...args: string[]): string => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).stdout;

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  }
}

// ---------------------------------------------------------------- Go

const CALC = `package calc

import "github.com/google/uuid"

// Classify names the sign of n.
func Classify(n int) string {
	if n < 0 {
		return "negative"
	}
	if n == 0 {
		return "zero"
	}
	return "positive"
}

// Apply calls f on each item, through a closure.
func Apply(items []int, f func(int) int) []int {
	out := make([]int, 0, len(items))
	add := func(v int) {
		out = append(out, f(v))
	}
	for _, it := range items {
		add(it)
	}
	return out
}

// Unused is never called by a test.
func Unused(n int) int {
	if n > 10 {
		return n * 2
	}
	return n
}

// ID is the nil UUID, from a dependency in the module cache.
func ID() string { return uuid.Nil.String() }
`;

const CALC_TEST = `package calc

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	if Classify(-1) != "negative" || Classify(0) != "zero" {
		t.Fatal("wrong")
	}
}

func TestApply(t *testing.T) {
	got := Apply([]int{1, 2}, func(v int) int { return v + 1 })
	if len(got) != 2 || got[1] != 3 {
		t.Fatal("wrong")
	}
	if ID() != "00000000-0000-0000-0000-000000000000" {
		t.Fatal("id")
	}
}

// The sandbox has no network: dialing out must fail.
func TestNetworkIsOff(t *testing.T) {
	c, err := net.DialTimeout("tcp", "1.1.1.1:53", 2*time.Second)
	if err == nil {
		c.Close()
		t.Fatal("the sandbox reached the network")
	}
}

// The module cache is read-only, the build cache writable (in the run's scratch), the root read-only, /tmp and the checkout writable.
func TestMounts(t *testing.T) {
	if err := os.WriteFile(filepath.Join(os.Getenv("GOMODCACHE"), "x"), []byte("x"), 0o600); err == nil {
		t.Fatal("the module cache is writable")
	}
	if err := os.WriteFile("/usr/local/go/x", []byte("x"), 0o600); err == nil {
		t.Fatal("the root filesystem is writable")
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("GOCACHE"), "probe"), []byte("x"), 0o600); err != nil {
		t.Fatalf("the build cache is not writable: %v", err)
	}
	if err := os.WriteFile("/tmp/probe", []byte("x"), 0o600); err != nil {
		t.Fatalf("/tmp is not writable: %v", err)
	}
	if err := os.WriteFile("../../probe", []byte("x"), 0o600); err != nil {
		t.Fatalf("the checkout is not writable: %v", err)
	}
	os.Remove("../../probe")
}
`;

const BAD = `package bad

// Half returns half of n; its test fails.
func Half(n int) int {
	if n%2 == 0 {
		return n / 2
	}
	return n / 2
}
`;

const GO_FILES: Record<string, string> = {
  "go.mod": "module example.com/fx\n\ngo 1.25\n\nrequire github.com/google/uuid v1.2.0\n",
  "pkg/calc/calc.go": CALC,
  "pkg/calc/calc_test.go": CALC_TEST,
  "pkg/bad/bad.go": BAD,
  "pkg/bad/bad_test.go": 'package bad\n\nimport "testing"\n\nfunc TestHalf(t *testing.T) {\n\tif Half(4) != 3 {\n\t\tt.Fatal("a failing test")\n\t}\n}\n',
  "pkg/broken/broken.go": 'package broken\n\nimport "github.com/not/in/the/cache"\n\n// Name needs a module that is not in the cache.\nfunc Name() string { return cache.Name() }\n',
  "pkg/broken/broken_test.go": 'package broken\n\nimport "testing"\n\nfunc TestName(t *testing.T) { _ = Name() }\n',
};

type Fn = [string, number, number];
const GO_INDEX: Record<string, Fn[]> = {
  "pkg/calc/calc.go": [["calc.Classify", 6, 14], ["calc.Apply", 17, 26], ["calc.Apply.func1", 19, 21], ["calc.Unused", 29, 35], ["calc.ID", 37, 37]],
  "pkg/bad/bad.go": [["bad.Half", 4, 9]],
  "pkg/broken/broken.go": [["broken.Name", 6, 6]],
};

const recordsOf = (index: Record<string, Fn[]>): unknown[] =>
  Object.entries(index).flatMap(([p, fns]) => fns.map(([name, startLine, endLine]) => ({ path: p, function: name, startLine, endLine, change: "added", test: false, complexity: 2, decisions: [], nesting: 0, nestingPath: [] })));

function profileWith(over: Record<string, unknown>): unknown {
  return plugin.profile.parseProfile({ ...plugin.banyandb, ...over });
}

describe("measured coverage, Go, under real Docker", () => {
  let work: string;
  let scratch: string;
  let result: Measured;

  beforeAll(async () => {
    if (!goReady) return;
    work = path.join(tmp, "go-work");
    scratch = path.join(tmp, "go-scratch");
    await mkdir(scratch, { recursive: true });
    // go.sum comes from the module cache (offline); `pkg/broken`, which needs a module that is not cached, is added after.
    const { "pkg/broken/broken.go": brokenSource, "pkg/broken/broken_test.go": brokenTest, ...buildable } = GO_FILES;
    await write(work, buildable);
    const tidy = spawnSync("go", ["mod", "tidy"], { cwd: work, encoding: "utf8", env: { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" } });
    if (tidy.status !== 0) {
      goReady = false;
      console.warn(`pr-review coverage docker tests: the go fixture was skipped (go mod tidy offline failed: ${tidy.stderr.split("\n")[0]})`);
      return;
    }
    await write(work, { "pkg/broken/broken.go": brokenSource!, "pkg/broken/broken_test.go": brokenTest! });
    git(work, "init", "-q");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "fixture");
    const profile = profileWith({ metrics: { generated: [], sandbox: { go: { image: goImage, cpus: 2, memory: "2g", pids: 256, tmp: "256m", wallClockMs: 300_000 } } } });
    const files = Object.keys(GO_INDEX).flatMap((p) => [{ path: p, language: "go" as const }, { path: p.replace(/\.go$/, "_test.go"), language: "go" as const }]);
    result = await measure({ work, scratch, records: recordsOf(GO_INDEX), index: new Map(Object.entries(GO_INDEX)), files, profile });
  }, 900_000);

  const key = (p: string, name: string): string => `${p}\u0000${name}\u0000${GO_INDEX[p]!.find((f) => f[0] === name)![1]}`;
  const outcome = (p: string, name: string): unknown => result.state.outcomes!.get(key(p, name));

  it.skipIf(!hasDocker || !hasGo)("checks the image and the module cache first, then runs one Docker job with the plugin's own scripts", () => {
    if (!goReady) return;
    expect(result.state.state).toBe("done");
    expect(result.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker", "Measure the changed"]);
    expect(result.jobs[1]!.confinement).toMatchObject({ kind: "docker", image: goImage });
  });

  it.skipIf(!hasDocker || !hasGo)("attributes the coverprofile by line range, the closure apart from its enclosing function, and keeps a failing test's coverage", () => {
    if (!goReady) return;
    expect(outcome("pkg/calc/calc.go", "calc.Classify")).toMatchObject({ source: "measured", covered: 4, total: 5 });
    expect(outcome("pkg/calc/calc.go", "calc.Apply")).toMatchObject({ source: "measured", covered: 5, total: 5 });
    expect(outcome("pkg/calc/calc.go", "calc.Apply.func1")).toMatchObject({ source: "measured", covered: 1, total: 1 });
    expect(outcome("pkg/calc/calc.go", "calc.Unused")).toMatchObject({ source: "measured", covered: 0, total: 3 });
    expect(outcome("pkg/calc/calc.go", "calc.ID")).toMatchObject({ source: "measured", covered: 1, total: 1 });
    // The package whose test fails still reports what ran.
    expect(outcome("pkg/bad/bad.go", "bad.Half")).toMatchObject({ source: "measured", covered: 2, total: 3 });
    expect(result.state.facts!.runs[0]).toMatchObject({ language: "go", ran: true, exit: 1 });
  });

  it.skipIf(!hasDocker || !hasGo)("records a package that does not build offline as not run, naming the package, and only that package", () => {
    if (!goReady) return;
    expect(outcome("pkg/broken/broken.go", "broken.Name")).toEqual({ reason: "package pkg/broken did not build offline" });
  });

  it.skipIf(!hasDocker || !hasGo)("ran with no network, a read-only module cache, a root that cannot be written and a build cache only in the run's scratch: the fixture's own tests assert each, and pass", () => {
    if (!goReady) return;
    const run = result.evidence.map((e) => (e.payload as { command?: { id: string; report?: { text: string } } }).command).find((c) => c?.id === "cover-go")!;
    const tests = run.report!.text.split("\n").filter((l) => l.startsWith("test "));
    // calc's tests include TestNetworkIsOff (a dial out fails) and TestMounts; the package passing means they all held.
    expect(tests.some((l) => /^test ok\s+example\.com\/fx\/pkg\/calc\b/.test(l))).toBe(true);
    expect(tests.some((l) => /^test FAIL\s+example\.com\/fx\/pkg\/bad\b/.test(l))).toBe(true);
  });

  it.skipIf(!hasDocker || !hasGo)("leaves the checkout exactly as it was: no file changed, none added, and the build cache is in the scratch directory only", async () => {
    if (!goReady) return;
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(await readdir(path.join(scratch, "gocache"))).not.toEqual([]);
    expect((await readdir(work)).sort()).toEqual([".git", "go.mod", "go.sum", "pkg"]);
  });

  it.skipIf(!hasDocker || !hasGo)("leaves no container behind", () => {
    if (!goReady) return;
    expect(spawnSync("docker", ["ps", "-aq", "--filter", `label=graphloom.run=${runId}`], { encoding: "utf8" }).stdout.trim()).toBe("");
  });
});

describe.skipIf(!hasDocker)("the sandbox is never fallen back from, under real Docker", () => {
  const files = [{ path: "pkg/calc/calc.go", language: "go" as const }];
  const idx = { "pkg/calc/calc.go": GO_INDEX["pkg/calc/calc.go"]! };

  it("records a missing image as not run, with the reason, after trying to pull it by digest, and runs no coverage job", async () => {
    const ghost = `golang@sha256:${"0".repeat(64)}`;
    const m = await measure({ work: tmp, scratch: path.join(tmp, "ghost-scratch"), records: recordsOf(idx), index: new Map(Object.entries(idx)), files, profile: profileWith({ metrics: { generated: [], sandbox: { go: { image: ghost, wallClockMs: 60_000 } } } }) });
    expect(m.state.state).toBe("done");
    expect(m.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker"]);
    const reason = (m.state.outcomes!.get(`pkg/calc/calc.go\u0000calc.Classify\u00006`) as { reason: string }).reason;
    expect(reason).toMatch(/^docker unavailable: /);
  }, 300_000);

  it("records an unreachable daemon as not run, with the reason", async () => {
    const m = await measure({ work: tmp, scratch: path.join(tmp, "down-scratch"), records: recordsOf(idx), index: new Map(Object.entries(idx)), files, profile: profileWith({ metrics: { generated: [] , sandbox: { go: { image: `golang@sha256:${"1".repeat(64)}` } } } }), env: { DOCKER_HOST: "unix:///nonexistent/docker.sock" } });
    const reason = (m.state.outcomes!.get(`pkg/calc/calc.go\u0000calc.Classify\u00006`) as { reason: string }).reason;
    expect(reason).toMatch(/^docker unavailable: .*(Cannot connect|nonexistent|daemon)/i);
    expect(m.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker"]);
  }, 120_000);

  it("refuses an image that is a tag, at the runner as well as in the profile", async () => {
    const job: JobSpec = {
      stageId: "report",
      kind: "command",
      purpose: "diagnostic",
      readOnly: true,
      instruction: "x",
      input: { commands: [{ id: "x", argv: ["true"] }] },
      confinement: { kind: "docker", image: "golang:1.26", cpus: 1, memory: "256m", pids: 64, tmp: "16m", wallClockMs: 10_000, writable: ["."], readOnly: [], env: {} },
    };
    const outcome = await runner.runJob(job, ctxFor(tmp, path.join(tmp, "tag-scratch"))).then(
      (r) => (r.status === "ok" ? "ran" : r.summary),
      (e: unknown) => String(e),
    );
    expect(outcome).toMatch(/pinned by digest/);
    expect(() => profileWith({ metrics: { sandbox: { go: { image: "golang:1.26" } } } })).toThrow(/pinned by digest/);
  });
});

// ---------------------------------------------------------------- TypeScript

describe("measured coverage, TypeScript, under real Docker", () => {
  let work: string;
  let scratch: string;
  let ok = false;
  let result: Measured;
  let vitestVersion: string;
  const MATH = "export function classify(n: number): string {\n  if (n < 0) {\n    return \"negative\";\n  }\n  if (n === 0) {\n    return \"zero\";\n  }\n  return \"positive\";\n}\n\nexport function unused(n: number): number {\n  return n * 2;\n}\n";
  const TEST = "import { expect, it } from \"vitest\";\nimport { classify } from \"./math\";\n\nit(\"classifies\", () => {\n  expect(classify(-1)).toBe(\"negative\");\n  expect(classify(5)).toBe(\"positive\");\n});\n";
  const INDEX: Record<string, Fn[]> = { "src/math.ts": [["src/math.classify", 1, 9], ["src/math.unused", 11, 13]] };
  const files = [{ path: "src/math.ts", language: "typescript" as const }];

  const fixture = async (name: string, packageJson: unknown, lock: boolean, extra: Record<string, string> = {}): Promise<string> => {
    const dir = path.join(tmp, name);
    await write(dir, { "package.json": `${JSON.stringify(packageJson)}\n`, "src/math.ts": MATH, "src/math.test.ts": TEST, ".gitignore": "node_modules\n", ...extra });
    if (lock) {
      const r = spawnSync("npm", ["install", "--package-lock-only", "--offline", "--include=dev", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) return "";
    }
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    return dir;
  };

  beforeAll(async () => {
    if (!tsReady) return;
    vitestVersion = (JSON.parse(await readFile(path.join(repoRoot, "node_modules/vitest/package.json"), "utf8")) as { version: string }).version;
    work = await fixture("ts-work", { name: "fx", private: true, type: "module", devDependencies: { vitest: vitestVersion, "@vitest/coverage-v8": vitestVersion } }, true);
    if (work === "") {
      console.warn("pr-review coverage docker tests: the typescript fixture was skipped (the offline npm cache lacks vitest and @vitest/coverage-v8)");
      return;
    }
    ok = true;
    scratch = path.join(tmp, "ts-scratch");
    await mkdir(scratch, { recursive: true });
    const profile = profileWith({ metrics: { generated: [], sandbox: { typescript: { image: tsImage, cpus: 2, memory: "2g", pids: 512, tmp: "512m", wallClockMs: 300_000 } } } });
    result = await measure({ work, scratch, records: recordsOf(INDEX), index: new Map(Object.entries(INDEX)), files, profile });
  }, 900_000);

  const row = (name: string): unknown => result.state.outcomes!.get(`src/math.ts\u0000${name}\u0000${INDEX["src/math.ts"]!.find((f) => f[0] === name)![1]}`);

  it.skipIf(!hasDocker || !hasNpm)("reads the workspace's package.json first, then runs vitest with the repository's own provider, offline, in the sandbox", () => {
    if (!ok) return;
    expect(result.state.state).toBe("done");
    expect(result.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker", "Measure the changed"]);
    expect(result.jobs[1]!.confinement).toMatchObject({ kind: "docker", image: tsImage, writable: ["."] });
  });

  it.skipIf(!hasDocker || !hasNpm)("attributes coverage-final.json statements by function line range, with the provider's version", () => {
    if (!ok) return;
    expect(row("src/math.classify")).toMatchObject({ source: "measured", covered: 7, total: 9, unit: "line-statement", provider: `@vitest/coverage-v8@${vitestVersion}` });
    // The declaration line runs when the module loads (v8 reports whole lines): one of the three statements, though the body never ran.
    expect(row("src/math.unused")).toMatchObject({ source: "measured", covered: 1, total: 3 });
  });

  it.skipIf(!hasDocker || !hasNpm)("changes no tracked file of the checkout: dependencies land in its ignored node_modules only", () => {
    if (!ok) return;
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(spawnSync("docker", ["ps", "-aq", "--filter", `label=graphloom.run=${runId}`], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  it.skipIf(!hasDocker || !hasNpm)("keeps the coverage of the tests that ran when another test fails", async () => {
    if (!ok) return;
    const dir = await fixture("ts-fail", { name: "fx", private: true, type: "module", devDependencies: { vitest: vitestVersion, "@vitest/coverage-v8": vitestVersion } }, true, { "src/fails.test.ts": 'import { expect, it } from "vitest";\n\nit("fails", () => {\n  expect(1).toBe(2);\n});\n' });
    const m = await measure({ work: dir, scratch: path.join(tmp, "fail-scratch"), records: recordsOf(INDEX), index: new Map(Object.entries(INDEX)), files, profile: profileWith({ metrics: { generated: [], sandbox: { typescript: { image: tsImage, cpus: 2, memory: "2g", wallClockMs: 300_000 } } } }) });
    expect(m.state.facts!.runs[0]).toMatchObject({ language: "typescript", ran: true, exit: 1 });
    expect(m.state.outcomes!.get(`src/math.ts\u0000src/math.classify\u00001`)).toMatchObject({ source: "measured", covered: 7, total: 9 });
  }, 300_000);

  it.skipIf(!hasDocker || !hasNpm)("does not start vitest, nor any container, when the repository declares no coverage provider", async () => {
    const dir = await fixture("ts-none", { name: "fx", private: true, devDependencies: { vitest: "3.2.7" } }, false);
    const m = await measure({ work: dir, scratch: path.join(tmp, "none-scratch"), records: recordsOf(INDEX), index: new Map(Object.entries(INDEX)), files, profile: profileWith({ metrics: { generated: [], sandbox: { typescript: { image: tsImage } } } }) });
    expect(m.state.state).toBe("done");
    expect(m.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker"]);
    expect((m.state.outcomes!.get(`src/math.ts\u0000src/math.classify\u00001`) as { reason: string }).reason).toBe("no vitest coverage provider in the repository");
  }, 300_000);

  it.skipIf(!hasDocker || !hasNpm)("does not start vitest when the provider's major does not match vitest's, and names both", async () => {
    const dir = await fixture("ts-mismatch", { name: "fx", private: true, devDependencies: { vitest: "^3.2.4", "@vitest/coverage-v8": "^2.1.0" } }, false);
    const m = await measure({ work: dir, scratch: path.join(tmp, "mismatch-scratch"), records: recordsOf(INDEX), index: new Map(Object.entries(INDEX)), files, profile: profileWith({ metrics: { generated: [], sandbox: { typescript: { image: tsImage } } } }) });
    expect(m.jobs.map((j) => j.instruction.split(" ").slice(0, 3).join(" "))).toEqual(["Check the Docker"]);
    expect((m.state.outcomes!.get(`src/math.ts\u0000src/math.classify\u00001`) as { reason: string }).reason).toBe("@vitest/coverage-v8 ^2.1.0 does not match vitest ^3.2.4");
  }, 300_000);
});
