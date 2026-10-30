// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confinementProblem, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { coverageCommand, coverageConfinement, coverageState, DEFAULT_TS_IMAGE, majorOf, measuredSpec, missingProbe, recordKey, sandboxEnvironmentChecks, sandboxProbeCommands, type CoverageInput, type CoverageState } from "../src/coverage.js";
import { withOutcome } from "../src/measurements.js";
import {
  formatSpec,
  goFunctionCoverage,
  goUnseenReason,
  parseCoverageReport,
  parseGoBlock,
  parseSpec,
  reduceIstanbul,
  tsFunctionCoverage,
  type CoverageReport,
} from "../src/metrics/coverage.js";
import type { FunctionIndexEntry, MetricsRecord } from "../src/metrics/record.js";
import { requiredQuestions } from "../src/questions.js";
import { validatorById } from "../src/validators.js";
import { BANYANDB, candidateEvidence, profileOf, simulate } from "./support.js";

const report = (text: string): CoverageReport => {
  const r = parseCoverageReport(text);
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("the coverage report and its attribution", () => {
  it("reads a coverprofile block and nothing else", () => {
    expect(parseGoBlock("pkg/a/a.go:12.30,15.2 3 1")).toEqual({ file: "pkg/a/a.go", startLine: 12, startCol: 30, endLine: 15, endCol: 2, stmts: 3, count: 1 });
    expect(parseGoBlock("mode: set")).toBeUndefined();
    expect(parseGoBlock("pkg/a/a.go:12.30,15.2 3")).toBeUndefined();
  });

  it("refuses text without the header, and ignores facts it does not know", () => {
    expect(parseCoverageReport("pkg/a.go:1.1,2.2 1 1\n")).toMatchObject({ error: expect.stringContaining("does not start with") });
    const r = report("graphloom-coverage-v1 go\nexit 1\nfuture fact\ntest FAIL x [build failed]\nB pkg/a/a.go:1.1,2.2 1 0\nB not a block\n");
    expect(r).toMatchObject({ language: "go", exit: 1, tests: ["FAIL x [build failed]"] });
    expect(r.blocks).toHaveLength(1);
  });

  // func F (lines 3-16) holds a closure (lines 8-12); G is lines 18-20.
  const index: FunctionIndexEntry[] = [["a.F", 3, 16], ["a.F.func1", 8, 12], ["a.G", 18, 20]];

  it("attributes Go blocks to a function by line range, each weighted by its statements, a nested function owning the blocks from its first line to the one before its last", () => {
    const r = report(
      [
        "graphloom-coverage-v1 go",
        "exit 0",
        "seen pkg/a/a.go",
        "B pkg/a/a.go:4.2,6.3 2 1",
        "B pkg/a/a.go:7.2,8.20 1 0",
        // The closure's body block starts on the line of its opening brace.
        "B pkg/a/a.go:8.20,9.3 1 1",
        "B pkg/a/a.go:9.3,10.9 4 1",
        // A block after the closure's closing brace starts on the closure's last line: the enclosing function's.
        "B pkg/a/a.go:12.2,12.9 2 0",
        "B pkg/a/a.go:13.2,15.3 3 0",
        "B pkg/a/a.go:19.2,19.14 1 1",
        "B pkg/b/b.go:4.2,6.3 9 1",
      ].join("\n"),
    );
    expect(goFunctionCoverage(r, "pkg/a/a.go", index[0]!, index)).toMatchObject({ source: "measured", covered: 2, total: 8 });
    expect(goFunctionCoverage(r, "pkg/a/a.go", index[1]!, index)).toMatchObject({ source: "measured", covered: 5, total: 5 });
    expect(goFunctionCoverage(r, "pkg/a/a.go", index[2]!, index)).toMatchObject({ source: "measured", covered: 1, total: 1 });
  });

  it("counts a block once when several test binaries profiled it, covered when any did", () => {
    const r = report(["graphloom-coverage-v1 go", "seen pkg/a/a.go", "B pkg/a/a.go:4.2,6.3 2 0", "B pkg/a/a.go:7.2,8.3 1 0", "B pkg/a/a.go:4.2,6.3 2 1", "B pkg/a/a.go:7.2,8.3 1 0"].join("\n"));
    expect(goFunctionCoverage(r, "pkg/a/a.go", index[0]!, index)).toMatchObject({ covered: 2, total: 3 });
  });

  it("gives a function with no executable statements all it has (coverage 1), and one of an unseen file a reason", () => {
    const r = report("graphloom-coverage-v1 go\nexit 0\nseen pkg/a/a.go\n");
    expect(goFunctionCoverage(r, "pkg/a/a.go", index[2]!, index)).toMatchObject({ source: "measured", covered: 0, total: 0 });
    expect(goFunctionCoverage(r, "pkg/zz/z.go", index[2]!, index)).toEqual({ reason: "no coverage was recorded for pkg/zz/z.go: its package did not build, or no test ran offline" });
  });

  it("names the package that did not build, or has no test files, as the test command said", () => {
    const r = report("graphloom-coverage-v1 go\nexit 1\ntest FAIL example.com/m/pkg/a [build failed]\ntest ?   example.com/m/pkg/c [no test files]\ntest ok example.com/m/pkg/b 0.1s\n");
    expect(goUnseenReason(r, "pkg/a/a.go")).toBe("package pkg/a did not build offline");
    expect(goUnseenReason(r, "pkg/c/c.go")).toBe("package pkg/c has no test files");
    expect(goUnseenReason(r, "pkg/ab/x.go")).toMatch(/no coverage was recorded/);
  });

  it("attributes TypeScript statements to a function by the line they start on, nested functions excluded, and says what it did not see", () => {
    // The closure is lines 8 to 12: its interior is 9 to 11, and both boundary lines are statements of F.
    const r = report(["graphloom-coverage-v1 typescript", "exit 1", "provider @vitest/coverage-v8@3.2.7", "seen src/m.ts", "S src/m.ts 4 1", "S src/m.ts 5 0", "S src/m.ts 8 1", "S src/m.ts 9 1", "S src/m.ts 10 0", "S src/m.ts 12 1", "S src/m.ts 14 3", "S src/other.ts 4 1"].join("\n"));
    expect(tsFunctionCoverage(r, "src/m.ts", index[0]!, index)).toEqual({ source: "measured", covered: 4, total: 5, unit: "line-statement", provider: "@vitest/coverage-v8@3.2.7" });
    expect(tsFunctionCoverage(r, "src/m.ts", index[1]!, index)).toMatchObject({ covered: 1, total: 2 });
    expect(tsFunctionCoverage(r, "src/none.ts", index[0]!, index)).toEqual({ reason: "vitest reported no coverage for src/none.ts" });
  });

  it("reduces Istanbul's coverage-final.json to the wanted files and ranges, with the checkout's paths made relative", () => {
    const json = {
      "/work/src/m.ts": { statementMap: { "0": { start: { line: 4 } }, "1": { start: { line: 5 } }, "2": { start: { line: 30 } } }, s: { "0": 1, "1": 0, "2": 2 } },
      "/work/src/skipped.ts": { statementMap: { "0": { start: { line: 1 } } }, s: { "0": 1 } },
    };
    expect(reduceIstanbul(json, "/work", new Map([["src/m.ts", [{ start: 3, end: 16 }]]]))).toEqual(["seen src/m.ts", "S src/m.ts 4 1", "S src/m.ts 5 0"]);
    expect(reduceIstanbul(json, "/work", new Map([["src/untested.ts", [{ start: 1, end: 9 }]]]))).toEqual([]);
  });

  it("round-trips the spec a command carries", () => {
    const text = formatSpec({ workspace: "ui", packages: ["pkg/a"], files: ["ui/src/m.ts"], functions: [{ path: "ui/src/m.ts", start: 3, end: 16 }] });
    expect(parseSpec(text)).toEqual({ workspace: "ui", packages: ["pkg/a"], files: ["ui/src/m.ts"], functions: [{ path: "ui/src/m.ts", start: 3, end: 16 }], setup: [] });
  });

  it("carries setup commands in the spec with every argument intact (spaces, quotes, newlines, the empty string), in order", () => {
    const setup = [
      { id: "proto", argv: ["sh", "-c", "set -eu\ncd api; echo \"it's $HOME\" | tr a b"] },
      { id: "empty", argv: ["tool", "", "--flag=a b", "ünï"] },
    ];
    const text = formatSpec({ packages: ["pkg/a"], functions: [{ path: "pkg/a/a.go", start: 3, end: 16 }], setup });
    expect(text.split("\n").filter((l) => l.startsWith("setup "))).toHaveLength(2);
    expect(text).not.toMatch(/set -eu/);
    expect(parseSpec(text).setup).toEqual(setup);
  });

  it("reads the setup facts of a report: the ones that passed, and the one that failed with its exit status and tail", () => {
    const ok = report("graphloom-coverage-v1 go\nsetup proto ok\nsetup mocks ok\nexit 0\n");
    expect(ok).toMatchObject({ setup: ["proto", "mocks"], setupFail: undefined });
    const bad = report("graphloom-coverage-v1 go\nsetup proto ok\nsetup-fail mocks 2 go: no such tool\n");
    expect(bad).toMatchObject({ setup: ["proto"], setupFail: { id: "mocks", exit: 2, text: "go: no such tool" } });
  });

  it("reads the major version of the ranges a package.json declares", () => {
    expect([majorOf("^3.2.4"), majorOf("~3"), majorOf("3.x"), majorOf(">=2 <4"), majorOf("3.2.7"), majorOf("latest"), majorOf("workspace:*")]).toEqual([3, 3, 3, 2, 3, undefined, undefined]);
  });
});

describe("CRAP from measured coverage, and the question it asks", () => {
  const rec = (over: Partial<MetricsRecord> = {}): MetricsRecord => ({ path: "pkg/a/a.go", function: "a.F", startLine: 3, endLine: 16, change: "modified", test: false, complexity: 6, decisions: [], nesting: 1, nestingPath: [], ...over });

  it("recomputes CRAP from the measured fraction, and keeps the upper bound for a function not run", () => {
    expect(withOutcome(rec(), { source: "measured", covered: 3, total: 6 })).toMatchObject({ coverage: { source: "measured", covered: 3, total: 6 }, crap: 10.5 });
    expect(withOutcome(rec(), { source: "measured", covered: 0, total: 0 })).toMatchObject({ crap: 6 });
    expect(withOutcome(rec(), { reason: "docker unavailable: no daemon" })).toMatchObject({ coverage: { source: "unknown", reason: "not run (docker unavailable: no daemon)" }, crap: 42 });
    expect(withOutcome(rec({ test: true }), { reason: "x" })).toEqual(rec({ test: true }));
  });

  it("asks complexity-coverage for measured CRAP of 30 or more, and nothing for measured CRAP below it", () => {
    const ask = (r: MetricsRecord) =>
      requiredQuestions({ view: { items: [{ id: "R1", section: "features", text: "x", cites: [{ path: r.path, side: "head", start: r.startLine, end: r.endLine, symbol: "" }], facts: [] }], records: [r] }, groundwork: { symbols: [], testMap: new Map() } as never }, new Map())
        .filter((q) => q.type === "complexity-coverage");
    const worst = withOutcome(rec({ complexity: 9 }), { source: "measured", covered: 0, total: 10 });
    expect(worst.crap).toBe(90);
    expect(ask(worst)).toHaveLength(1);
    expect(ask(worst)[0]!.text).toContain("measured coverage 0/10");
    expect(ask(withOutcome(rec({ complexity: 9 }), { source: "measured", covered: 9, total: 10 }))).toHaveLength(0);
    // Unknown coverage alone asks nothing below complexity 10 (the upper bound of 90 reflects the missing measurement).
    expect(ask(withOutcome(rec({ complexity: 9 }), { reason: "docker unavailable" }))).toHaveLength(0);
    expect(ask(withOutcome(rec({ complexity: 10 }), { reason: "docker unavailable" }))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the state, from hand-made evidence

const profile = profileOf();
const goRecord: MetricsRecord = { path: "pkg/a/a.go", function: "a.F", startLine: 3, endLine: 16, change: "added", test: false, complexity: 6, decisions: [], nesting: 1, nestingPath: [] };
const goIndex = new Map<string, FunctionIndexEntry[]>([["pkg/a/a.go", [["a.F", 3, 16]]]]);
const tsRecord = (p: string): MetricsRecord => ({ path: p, function: `${p.replace(/\.ts$/, "")}.f`, startLine: 1, endLine: 6, change: "added", test: false, complexity: 3, decisions: [], nesting: 0, nestingPath: [] });

let n = 0;
const command = (id: string, stdout: string, over: { argv?: string[]; exit?: number; report?: { text: string; truncated: boolean }; payload?: Record<string, unknown>; stderr?: string } = {}): EvidenceRecord => ({
  ref: `e${(n += 1)}`,
  kind: "command",
  candidateDigest: "d1",
  payload: { ...(over.payload ?? {}), command: { id, argv: over.argv ?? ["sh", "-c", "x", id], exitCode: over.exit ?? 0, stdoutTail: stdout, stderrTail: over.stderr ?? "", ...(over.report !== undefined ? { report: over.report } : {}) } },
});
const manifest = (p: string, bytes: string | undefined): EvidenceRecord => ({ ref: `e${(n += 1)}`, kind: "file", candidateDigest: "d1", ...(bytes === undefined ? { fingerprint: "missing" } : {}), payload: { path: p, bytes: bytes ?? "" } });
const diff = command("metrics-diff", "");
const ready = (language: "go" | "typescript"): EvidenceRecord[] => [
  command(`sandbox-${language}`, "ready\n"),
  command(language === "go" ? "host-go-modcache" : "host-npm-cache", language === "go" ? "/gomodcache\n" : "/npm-cache\n"),
  ...(language === "go" ? [command("host-mounts-go", "ok /opt/tools\nok /opt/bufcache\n")] : []),
];

const input = (over: Partial<CoverageInput> & { evidence: EvidenceRecord[] }): CoverageInput => ({
  records: [goRecord],
  index: goIndex,
  files: [{ path: "pkg/a/a.go", language: "go" }, { path: "pkg/a/a_test.go", language: "go" }],
  profile,
  afterRef: diff.ref,
  ...over,
});

const goSpec = formatSpec({ packages: ["pkg/a"], functions: [{ path: "pkg/a/a.go", start: 3, end: 16 }], setup: profile.metrics.sandbox!.go!.setup! });
const goRun = (text: string, over: Parameters<typeof command>[2] = {}): EvidenceRecord => command("cover-go", "", { argv: coverageCommand({ id: "cover-go", script: "go.sh", spec: goSpec }, "/plugin", 60_000).argv, report: { text, truncated: false }, ...over });
const doneOf = (s: CoverageState): Extract<CoverageState, { state: "done" }> => {
  expect(s.state).toBe("done");
  return s as Extract<CoverageState, { state: "done" }>;
};

describe("coverageState", () => {
  it("asks for the image check first, from the profile's images by digest, and only then for the run", () => {
    const s = coverageState(input({ evidence: [diff] }));
    expect(s).toMatchObject({ state: "probe" });
    const ids = (s as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    expect(ids).toEqual(["sandbox-go", "host-mounts-go", "host-go-modcache", "sandbox-typescript", "host-npm-cache"]);
    const pull = (s as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(pull.at(-1)).toBe(profile.metrics.sandbox!.go!.image);
    expect(pull[2]).toContain("graphloom sandbox pull");
    expect(missingProbe([command("sandbox-go", "ready"), command("host-mounts-go", "ok /a\nok /b"), command("host-go-modcache", "/g")], profile).map((c) => c.id)).toEqual(["sandbox-typescript", "host-npm-cache"]);
    expect(sandboxProbeCommands(profileOf({ metrics: { coverage: false } }))).toEqual([]);
  });

  it("plans one Go command over the touched packages, with the spec in its argv, and a Docker confinement that the SDK accepts", () => {
    const s = coverageState(input({ evidence: [diff, ...ready("go")] }));
    expect(s.state).toBe("run");
    const { plan } = s as Extract<CoverageState, { state: "run" }>;
    expect(plan.commands).toEqual([{ id: "cover-go", script: "go.sh", spec: goSpec }]);
    const confinement = coverageConfinement(plan, "/plugin");
    expect(confinementProblem(confinement)).toBeUndefined();
    expect(confinement).toMatchObject({
      kind: "docker",
      image: profile.metrics.sandbox!.go!.image,
      cpus: 4,
      memory: "8g",
      pids: 512,
      tmp: "1g",
      writable: [".", "@scratch/gocache"],
      readOnly: ["/plugin", "/gomodcache", "/opt/tools", "/opt/bufcache"],
      env: { GRAPHLOOM_MOUNT_TOOLS: "/opt/tools", GRAPHLOOM_MOUNT_BUF_CACHE: "/opt/bufcache", GOFLAGS: "-mod=readonly", GOPROXY: "off", GOTOOLCHAIN: "local", GOCACHE: "@scratch/gocache", GOMODCACHE: "/gomodcache", HOME: "/tmp" },
    });
    expect(Object.keys((confinement as { env: object }).env).sort()).toEqual(["GOCACHE", "GOFLAGS", "GOMODCACHE", "GOPROXY", "GOTOOLCHAIN", "GRAPHLOOM_MOUNT_BUF_CACHE", "GRAPHLOOM_MOUNT_TOOLS", "HOME"]);
    const cmd = coverageCommand(plan.commands[0]!, "/plugin", 1_800_000);
    expect(cmd.argv.slice(0, 2)).toEqual(["sh", "/plugin/tools/cover/go.sh"]);
    expect(measuredSpec(cmd.argv)).toBe(goSpec);
    // The executor takes at most a day per command, whatever wall clock the profile allows.
    expect(cmd.timeoutMs).toBe(1_860_000);
    expect(coverageCommand(plan.commands[0]!, "/plugin", 24 * 60 * 60_000).timeoutMs).toBe(24 * 60 * 60_000);
  });

  it("attributes the report's blocks, keeps coverage when a test failed, and measures CRAP from it", () => {
    const text = "graphloom-coverage-v1 go\nexit 1\ntest --- FAIL: TestX (0.00s)\ntest FAIL example.com/m/pkg/a 0.2s\nB pkg/a/a.go:4.2,6.3 3 1\nB pkg/a/a.go:7.2,9.3 3 0\nseen pkg/a/a.go\n";
    const d = doneOf(coverageState(input({ evidence: [diff, ...ready("go"), goRun(text, { exit: 1 })] })));
    expect(d.outcomes.get(recordKey(goRecord))).toMatchObject({ source: "measured", covered: 3, total: 6 });
    expect(d.facts.runs).toEqual([expect.objectContaining({ language: "go", ran: true, exit: 1 })]);
  });

  it("says why a function was not run: no report at all, a report that did not fit, a package that did not build, a report for another function", () => {
    const reason = (e: EvidenceRecord): string => (doneOf(coverageState(input({ evidence: [diff, ...ready("go"), e] }))).outcomes.get(recordKey(goRecord)) as { reason: string }).reason;
    expect(reason(goRun("", { stderr: "docker: Error response from daemon: OCI runtime create failed", report: { text: "", truncated: false } }))).toMatch(/the coverage command wrote no report/);
    expect(reason(goRun("graphloom-coverage-v1 go\n", { report: { text: "graphloom-coverage-v1 go\n", truncated: true } }))).toMatch(/did not fit/);
    expect(reason(goRun("graphloom-coverage-v1 go\nexit 1\ntest FAIL example.com/m/pkg/a [build failed]\n"))).toBe("package pkg/a did not build offline");
    expect(coverageState(input({ evidence: [diff, ...ready("go"), command("cover-go", "", { argv: coverageCommand({ id: "cover-go", script: "go.sh", spec: goSpec.replace("3 16", "9 16") }, "/plugin", 1).argv, report: { text: "graphloom-coverage-v1 go\nseen pkg/a/a.go\n", truncated: false } })] }))).toMatchObject({ state: "failed", problems: [expect.stringContaining("other functions than the measurements name")] });
  });

  it("records what the sandbox could not offer, and runs nothing: Docker or the image missing, no cache, no image pinned", () => {
    const why = (e: EvidenceRecord[], p = profile): string => (doneOf(coverageState(input({ evidence: [diff, ...e], profile: p }))).outcomes.get(recordKey(goRecord)) as { reason: string }).reason;
    expect(why([command("sandbox-go", "unavailable: the docker CLI is not installed\n"), command("host-go-modcache", "/g\n")])).toBe("docker unavailable: the docker CLI is not installed");
    expect(why([command("sandbox-go", "unavailable: docker image golang@sha256:aa is not present locally; pull it before the run\n"), command("host-go-modcache", "/g\n")])).toMatch(/not present locally/);
    expect(why([command("sandbox-go", "", { exit: 125, stderr: "boom" }), command("host-go-modcache", "/g\n")])).toMatch(/the sandbox image check failed: boom/);
    expect(why([command("sandbox-go", "\n"), command("host-go-modcache", "/g\n")])).toBe("the sandbox image check printed no status");
    expect(why([command("sandbox-go", "ready\n"), command("host-go-modcache", "\n")])).toMatch(/Go module cache could not be located/);
    expect(why([], profileOf({ metrics: { sandbox: {} } }))).toMatch(/pins no go sandbox image/);
    expect(why([], profileOf({ metrics: { coverage: false } }))).toBe("coverage disabled by the profile");
  });

  it("turns the controller's refusal of the docker job into the functions' reason, never a second dispatch", () => {
    const refusal: EvidenceRecord = { ref: "refused", kind: "other", payload: { executorFailure: { summary: "docker confinement refused the job, which was not run: docker image golang@sha256:aa is not present locally; pull it before the run" } } };
    const d = doneOf(coverageState(input({ evidence: [diff, ...ready("go"), refusal] })));
    expect((d.outcomes.get(recordKey(goRecord)) as { reason: string }).reason).toMatch(/^docker confinement refused the job/);
  });

  it("notes the files a coverage run changed in its checkout, as the controller recorded them", () => {
    const run = goRun("graphloom-coverage-v1 go\nexit 0\nB pkg/a/a.go:4.2,6.3 3 1\nseen pkg/a/a.go\n", { payload: { checkout: { mutations: ["go.sum", "pkg/a/gen.go"] } } });
    expect(doneOf(coverageState(input({ evidence: [diff, ...ready("go"), run] }))).facts.runs[0]!.changed).toEqual(["go.sum", "pkg/a/gen.go"]);
  });

  it("takes the repository's root package as a package, and leaves hidden, testdata and vendor directories out", () => {
    const root: MetricsRecord = { ...goRecord, path: "main.go", function: "main.F", startLine: 3, endLine: 9 };
    const s = coverageState(input({ evidence: [diff, ...ready("go")], records: [root], index: new Map([["main.go", [["main.F", 3, 9]]]]), files: [{ path: "main.go", language: "go" }, { path: ".github/x.go", language: "go" }, { path: "pkg/testdata/t.go", language: "go" }, { path: "vendor/v/v.go", language: "go" }] }));
    expect((s as Extract<CoverageState, { state: "run" }>).plan.commands[0]!.spec).toBe(formatSpec({ packages: ["."], functions: [{ path: "main.go", start: 3, end: 9 }], setup: profile.metrics.sandbox!.go!.setup! }));
  });

  it("runs only the languages that have a function to measure, and not for a test file alone", () => {
    const d = doneOf(coverageState(input({ evidence: [diff], records: [{ ...goRecord, test: true }] })));
    expect(d.facts.runs).toEqual([]);
  });

  describe("TypeScript", () => {
    const rec = tsRecord("ui/src/a.ts");
    const tsInput = (evidence: EvidenceRecord[], over: Partial<CoverageInput> = {}): CoverageInput => ({
      evidence,
      records: [rec],
      index: new Map([["ui/src/a.ts", [[`${rec.function}`, 1, 6] as FunctionIndexEntry]]]),
      files: [{ path: "ui/src/a.ts", language: "typescript" }],
      profile: profileOf({ metrics: { coverage: true } }),
      afterRef: diff.ref,
      ...over,
    });
    const manifests = (ui: string | undefined, root: string | undefined): EvidenceRecord[] => [manifest("ui/src/package.json", undefined), manifest("ui/package.json", ui), manifest("package.json", root)];
    const reasonOf = (s: CoverageState): string => (doneOf(s).outcomes.get(recordKey(rec)) as { reason: string }).reason;
    const pkg = (deps: Record<string, string>): string => JSON.stringify({ devDependencies: deps });

    it("reads the package.json of the file's workspace chain before it decides anything", () => {
      const s = coverageState(tsInput([diff, ...ready("typescript")]));
      expect(s).toEqual({ state: "observe", paths: ["ui/src/package.json", "ui/package.json", "package.json"] });
    });

    it("does not start vitest when the repository declares no coverage provider", () => {
      const s = coverageState(tsInput([diff, ...ready("typescript"), ...manifests(pkg({ vitest: "^3.0.0" }), undefined)]));
      expect(reasonOf(s)).toBe("no vitest coverage provider in the repository");
      expect(doneOf(s).facts.runs).toEqual([{ language: "typescript", ran: false, reason: "no vitest coverage provider in the repository", tests: [], changed: [] }]);
    });

    it("does not start vitest when the provider's major does not match vitest's, and names both", () => {
      const s = coverageState(tsInput([diff, ...ready("typescript"), ...manifests(pkg({ vitest: "^3.2.4", "@vitest/coverage-v8": "^2.1.0" }), undefined)]));
      expect(reasonOf(s)).toBe("@vitest/coverage-v8 ^2.1.0 does not match vitest ^3.2.4");
    });

    it("reads vitest from the root and the provider from the workspace, up the chain", () => {
      const s = coverageState(tsInput([diff, ...ready("typescript"), ...manifests(pkg({ "@vitest/coverage-v8": "3.2.7" }), pkg({ vitest: "3.2.7" }))]));
      expect(s.state).toBe("run");
      const { plan } = s as Extract<CoverageState, { state: "run" }>;
      expect(plan.sandbox.image).toBe(DEFAULT_TS_IMAGE);
      expect(plan.commands).toEqual([{ id: "cover-ts-1", script: "ts.sh", spec: formatSpec({ workspace: "ui", files: ["ui/src/a.ts"], functions: [{ path: "ui/src/a.ts", start: 1, end: 6 }] }) }]);
      const confinement = coverageConfinement(plan, "/plugin");
      expect(confinementProblem(confinement)).toBeUndefined();
      expect(confinement).toMatchObject({ image: DEFAULT_TS_IMAGE, writable: ["."], readOnly: ["/plugin", "/npm-cache"], env: { npm_config_cache: "/npm-cache", HOME: "/tmp" } });
    });

    it("attributes statements by line range from the reduced coverage-final.json", () => {
      const evidence = [diff, ...ready("typescript"), ...manifests(pkg({ vitest: "3.2.7", "@vitest/coverage-v8": "3.2.7" }), undefined)];
      const planned = coverageState(tsInput(evidence)) as Extract<CoverageState, { state: "run" }>;
      const argv = coverageCommand(planned.plan.commands[0]!, "/plugin", 1).argv;
      const text = "graphloom-coverage-v1 typescript\nexit 0\nprovider @vitest/coverage-v8@3.2.7\nseen ui/src/a.ts\nS ui/src/a.ts 1 1\nS ui/src/a.ts 2 0\nS ui/src/a.ts 3 1\n";
      const d = doneOf(coverageState(tsInput([...evidence, command("cover-ts-1", "", { argv, report: { text, truncated: false } })])));
      expect(d.outcomes.get(recordKey(rec))).toEqual({ source: "measured", covered: 2, total: 3, unit: "line-statement", provider: "@vitest/coverage-v8@3.2.7" });
    });

    it("says the dependencies could not be installed offline when the report says so", () => {
      const evidence = [diff, ...ready("typescript"), ...manifests(pkg({ vitest: "3.2.7", "@vitest/coverage-v8": "3.2.7" }), undefined)];
      const planned = coverageState(tsInput(evidence)) as Extract<CoverageState, { state: "run" }>;
      const argv = coverageCommand(planned.plan.commands[0]!, "/plugin", 1).argv;
      const text = "graphloom-coverage-v1 typescript\nexit 1\nfail the repository's dependencies could not be installed offline from the operator's npm cache\n";
      expect(reasonOf(coverageState(tsInput([...evidence, command("cover-ts-1", "", { argv, report: { text, truncated: false } })])))).toMatch(/dependencies could not be installed offline/);
    });

    it("measures at most eight workspaces, and says so for the rest", () => {
      const dirs = Array.from({ length: 10 }, (_, i) => `w${i}`);
      const records = dirs.map((d) => tsRecord(`${d}/a.ts`));
      const evidence = [diff, ...ready("typescript"), ...dirs.map((d) => manifest(`${d}/package.json`, pkg({ vitest: "3.2.7", "@vitest/coverage-v8": "3.2.7" }))), manifest("package.json", undefined)];
      const s = coverageState({ evidence, records, index: new Map(), files: records.map((r) => ({ path: r.path, language: "typescript" as const })), profile, afterRef: diff.ref });
      expect(s.state).toBe("run");
      expect((s as Extract<CoverageState, { state: "run" }>).plan.commands).toHaveLength(8);
    });
  });
});

describe("the image check Fetch runs", () => {
  const script = sandboxProbeCommands(profile)[0]!.argv[2]!;
  const IMAGE = profile.metrics.sandbox!.go!.image!;

  /** The script with a PATH of stubs only: each named program is a shell script with the given body. */
  function run(stubs: Record<string, string>): { stdout: string; status: number | null; calls: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-probe-"));
    try {
      for (const tool of ["tail", "cut"]) spawnSync("ln", ["-s", spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), path.join(dir, tool)]);
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> ${dir}/calls\n${body}\n`, { mode: 0o755 });
      }
      const r = spawnSync("/bin/sh", ["-c", script, "sandbox-go", IMAGE], { encoding: "utf8", env: { PATH: dir } });
      const calls = spawnSync("cat", [path.join(dir, "calls")], { encoding: "utf8" }).stdout;
      return { stdout: r.stdout, status: r.status, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("is ready when graphloom sandbox pull does it, and asks docker nothing", () => {
    expect(run({ graphloom: "exit 0" })).toMatchObject({ stdout: "ready\n", status: 0, calls: `graphloom sandbox pull ${IMAGE}\n` });
  });

  it("asks docker itself when the graphloom on PATH is older than the sandbox command, or its pull failed", () => {
    const r = run({ graphloom: 'echo "usage: graphloom run ..." >&2; exit 2', docker: "exit 0" });
    expect(r).toMatchObject({ stdout: "ready\n", status: 0 });
    expect(r.calls).toBe(`graphloom sandbox pull ${IMAGE}\ndocker image inspect ${IMAGE}\n`);
  });

  it("pulls by digest when the image is missing, and says why when docker cannot", () => {
    expect(run({ docker: 'case "$1" in image) exit 1;; pull) exit 0;; esac' })).toMatchObject({ stdout: "ready\n" });
    expect(run({ docker: 'case "$1" in image) exit 1;; pull) echo "Error response from daemon: manifest unknown" >&2; exit 1;; esac' })).toMatchObject({ stdout: "unavailable: Error response from daemon: manifest unknown\n", status: 0 });
  });

  it("says the docker CLI is missing, and still exits 0", () => {
    expect(run({})).toMatchObject({ stdout: "unavailable: the docker CLI is not installed\n", status: 0 });
  });
});

describe("the sandbox environment checks", () => {
  it("report the image state without pulling, and never fail", () => {
    const checks = sandboxEnvironmentChecks(profile);
    expect(checks.map((c) => c.id)).toEqual(["docker-go", "docker-typescript"]);
    const sh = (image: string): string => spawnSync("/bin/sh", ["-c", checks[0]!.argv[2]!, "docker-go", image], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } }).stdout;
    expect(sh(profile.metrics.sandbox!.go!.image!)).toMatch(/^unavailable: the docker CLI is not installed/);
    expect(sandboxEnvironmentChecks(profileOf({ metrics: { coverage: false } }))).toEqual([]);
  });
});

// ---------------------------------------------------------------- through the graph

describe("coverage-measured (through the graph)", () => {
  const sim = simulate({ scenarioName: "coverage-measured" });
  const [job] = sim.jobs.filter((j) => j.instruction.startsWith("Measure the changed Go"));

  it("checks the images in Fetch, before any job of Report, then runs the coverage in a Docker sandbox over a prepared checkout", () => {
    const at = (text: string): number => sim.jobs.findIndex((j) => j.instruction.startsWith(text));
    expect(at("Check the Docker sandbox images")).toBeGreaterThan(at("Read the pull request's ledger ref"));
    expect(at("Check the Docker sandbox images")).toBeLessThan(at("Write the change report"));
    expect(sim.jobs[at("Check the Docker sandbox images")]).toMatchObject({ stageId: "fetch", readOnly: true });
    expect(at("Measure the changed Go")).toBeGreaterThan(at("List the changed lines"));
    expect(job).toMatchObject({ kind: "command", stageId: "report", readOnly: true, checkout: { from: "candidate" } });
    expect(job!.confinement).toMatchObject({ kind: "docker", image: BANYANDB_GO_IMAGE, readOnly: ["/plugin", "/gomodcache", "/rehearsal/tools", "/rehearsal/buf-cache"] });
    expect(confinementProblem(job!.confinement)).toBeUndefined();
  });

  it("is the only job that runs the pull request's code, and the static tools still run with no network", () => {
    expect(sim.jobs.filter((j) => j.confinement?.kind === "docker")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.instruction.startsWith("Measure the changed functions"))[0]!.confinement).toMatchObject({ kind: "bwrap", network: false });
  });

  it("writes the measured row, the measured CRAP and the Coverage sentence, and recomputes them in the validators", () => {
    expect(sim.written!.markdown).toContain("| `schema.ParseTTL` pkg/schema/ttl.go:6 | added | 12 (over the limit of 10) | 4 (over the limit of 3) | 40% (8/20 statements, measured) | 43.1 (at or over the threshold of 30) | not run: mutation not available in this version |");
    expect(sim.written!.markdown).toMatch(/Coverage \(go\): measured with go test -coverprofile -covermode=set over the touched packages, in the Docker sandbox \(image golang@sha256:670bb5aa5349…, no network, read-only dependency caches\) over a prepared checkout of the head, statement coverage by function line range; the tests passed\./);
    const json = JSON.parse(sim.written!.json) as { measurements: { tools: string; records: Array<{ coverage: unknown; crap: number }> } };
    expect(json.measurements.tools).toBe("static+coverage");
    expect(json.measurements.records[0]).toMatchObject({ coverage: { source: "measured", covered: 8, total: 20, unit: "statement" }, crap: 43.1 });
    expect(sim.receipts.filter((r) => r.requirementId === "measurements" || r.requirementId === "change-report").every((r) => r.valid)).toBe(true);
  });

  it("asks complexity-coverage for the measured CRAP, with the measured numbers, and stops at report ready", () => {
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    const qa = JSON.parse(sim.qa!.json) as { questions: Array<{ type: string; text: string; answer?: { answer: string } }> };
    const q = qa.questions.find((x) => x.type === "complexity-coverage")!;
    expect(q.text).toMatch(/Complexity 12, measured coverage 8\/20, CRAP 43\.1\./);
    expect(q.answer!.answer).toContain("the sandbox measured 8 of 20 statements covered");
  });

  const evaluate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
  // The evidence as the Report stage judges it: before the questions (the controller keeps only the latest review).
  const atReport = sim.evidence.slice(0, sim.evidence.findIndex((e) => e.resultSchema === "necessity-v1"));
  const tamper = (change: (c: { argv: string[]; stdoutTail: string }) => void): EvidenceRecord[] =>
    atReport.map((e) => {
      const c = (e.payload as { command?: { id: string; argv: string[]; stdoutTail: string } }).command;
      if (c?.id !== "cover-go") return e;
      const copy = { ...c, argv: [...c.argv] };
      change(copy);
      return { ...e, payload: { ...(e.payload as object), command: copy } } as EvidenceRecord;
    });

  it("rejects a written report that the coverage evidence does not recompute (a changed report, a changed spec)", () => {
    expect(evaluate("change-report", atReport)).toMatchObject({ status: "passed" });
    expect(evaluate("change-report", tamper((c) => (c.stdoutTail = c.stdoutTail.replace("B pkg/schema/ttl.go:14.3,16.4 3 0", "B pkg/schema/ttl.go:14.3,16.4 3 1"))))).toMatchObject({ status: "failed", reason: expect.stringMatching(/not the report the evidence recomputes/) });
    expect(evaluate("measurements", tamper((c) => (c.argv[3] = c.argv[3]!.replace("fn pkg/schema/ttl.go 6 35", "fn pkg/schema/ttl.go 6 20"))))).toMatchObject({ status: "failed", reason: expect.stringMatching(/other functions than the measurements name/) });
  });

  it("is not a measurement the validators accept before the coverage evidence exists", () => {
    const without = sim.evidence.filter((e) => (e.payload as { command?: { id: string } }).command?.id !== "cover-go");
    expect(evaluate("measurements", without)).toMatchObject({ status: "inconclusive" });
  });
});

describe("the sandbox-unavailable and coverage-off runs", () => {
  it("run no job in a container and say so, whatever the profile asks", () => {
    for (const config of [{}, { metrics: { generated: [], coverage: false, mutation: { enabled: false } } }]) {
      const sim = simulate({ scenarioName: "sandbox-unavailable", config });
      expect(sim.jobs.filter((j) => j.confinement?.kind === "docker" || j.checkout !== undefined)).toEqual([]);
      expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    }
  });

});

// ---------------------------------------------------------------- the awk reducer, for real

const goprofile = fileURLToPath(new URL("../tools/cover/goprofile.awk", import.meta.url));
const hasAwk = spawnSync("awk", ["BEGIN{}"]).status === 0;

describe.skipIf(!hasAwk)("goprofile.awk", () => {
  it("rewrites the module path to a repository path, keeps the blocks that start in a changed function, and lists every file it saw", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-awk-"));
    try {
      writeFileSync(path.join(dir, "spec.txt"), "pkg a\nfn sub/pkg/a/a.go 3 16\nfn sub/pkg/a/a.go 30 40\n");
      writeFileSync(path.join(dir, "c.out"), ["mode: set", "example.com/m/pkg/a/a.go:4.2,6.3 3 0", "example.com/m/pkg/a/a.go:4.2,6.3 3 1", "example.com/m/pkg/a/a.go:20.2,22.3 2 1", "example.com/m/pkg/a/a.go:31.2,32.3 2 0", "example.com/m/pkg/b/b.go:4.2,6.3 9 1"].join("\n"));
      const out = spawnSync("awk", ["-f", goprofile, "-v", "mp=example.com/m", "-v", "root=sub", path.join(dir, "spec.txt"), path.join(dir, "c.out")], { encoding: "utf8" });
      expect(out.status).toBe(0);
      const lines = out.stdout.trim().split("\n").sort();
      expect(lines).toEqual(["B sub/pkg/a/a.go:31.2,32.3 2 0", "B sub/pkg/a/a.go:4.2,6.3 3 1", "seen sub/pkg/a/a.go", "seen sub/pkg/b/b.go"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const BANYANDB_GO_IMAGE = profile.metrics.sandbox!.go!.image!;

// ---------------------------------------------------------------- sandboxed setup and read-only mounts

describe("sandbox mounts and setup (profile)", () => {
  const withGo = (extra: Record<string, unknown>) => profileOf({ metrics: { generated: [], sandbox: { go: { image: profile.metrics.sandbox!.go!.image, ...extra } } } });
  const mounts = [{ name: "tools", path: "~/t/bin" }];
  const setup = [{ id: "gen", argv: ["sh", "-c", "echo hi > gen.txt"] }];

  it("probes where the mounts are on the host only when the profile names some, from `/`", () => {
    const ids = (p: Parameters<typeof sandboxProbeCommands>[0]): string[] => sandboxProbeCommands(p).map((c) => c.id);
    expect(ids(withGo({}))).toEqual(["sandbox-go", "host-go-modcache", "sandbox-typescript", "host-npm-cache"]);
    expect(ids(withGo({ readOnly: mounts }))).toEqual(["sandbox-go", "host-mounts-go", "host-go-modcache", "sandbox-typescript", "host-npm-cache"]);
    const probe = sandboxProbeCommands(withGo({ readOnly: mounts })).find((c) => c.id === "host-mounts-go")!;
    expect(probe.argv.slice(3)).toEqual(["host-mounts-go", "~/t/bin"]);
    expect(probe.argv[2]).toMatch(/^cd \/ /);
  });

  describe("the host probe script", () => {
    const script = sandboxProbeCommands(withGo({ readOnly: mounts })).find((c) => c.id === "host-mounts-go")!.argv[2]!;
    const run = (home: string | undefined, ...paths: string[]) => {
      const r = spawnSync("/bin/sh", ["-c", script, "host-mounts-go", ...paths], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(home !== undefined ? { HOME: home } : {}) } });
      return { status: r.status, lines: r.stdout.trimEnd().split("\n") };
    };

    it("expands ~ to the operator's home, follows links to the real directory, and answers one line per path", () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "gl-mounts-"));
      try {
        spawnSync("sh", ["-c", `mkdir -p real/bin && ln -s "$PWD/real/bin" tools && mkdir plain`], { cwd: home });
        const real = spawnSync("sh", ["-c", "cd real/bin && pwd -P"], { cwd: home, encoding: "utf8" }).stdout.trim();
        const plain = spawnSync("sh", ["-c", "cd plain && pwd -P"], { cwd: home, encoding: "utf8" }).stdout.trim();
        expect(run(home, "~/tools", "~/plain", `${home}/plain`, "~/nope", "relative/dir", "/", "~/real/bin/../..")).toEqual({
          status: 0,
          lines: [
            `ok ${real}`,
            `ok ${plain}`,
            `ok ${plain}`,
            `missing ${home}/nope is not a directory on this host`,
            "missing not an absolute path",
            "missing / is the filesystem root",
            `ok ${home}`,
          ],
        });
        expect(run(undefined, "~/tools").lines).toEqual(["missing HOME is not set"]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it("states mounts and setup on the plan, in the spec the command carries, and in a confinement the SDK accepts", () => {
    const p = withGo({ readOnly: mounts, setup });
    const evidence = [diff, command("sandbox-go", "ready\n"), command("host-go-modcache", "/gomodcache\n"), command("host-mounts-go", "ok /home/u/real/bin\n")];
    const s = coverageState(input({ evidence, profile: p })) as Extract<CoverageState, { state: "run" }>;
    expect(s.state).toBe("run");
    expect(s.plan.mounts).toEqual([{ name: "tools", path: "/home/u/real/bin" }]);
    expect(parseSpec(s.plan.commands[0]!.spec).setup).toEqual(setup);
    const c = coverageConfinement(s.plan, "/plugin");
    expect(confinementProblem(c)).toBeUndefined();
    expect(c).toMatchObject({ readOnly: ["/plugin", "/gomodcache", "/home/u/real/bin"], env: { GRAPHLOOM_MOUNT_TOOLS: "/home/u/real/bin" } });
    // Mounts are read-only: never listed as writable.
    expect((c as { writable: string[] }).writable).toEqual([".", "@scratch/gocache"]);
  });

  it("waits for the mounts probe, and says which mount is unusable without running anything", () => {
    const p = withGo({ readOnly: mounts, setup });
    const base = [diff, command("sandbox-go", "ready\n"), command("host-go-modcache", "/gomodcache\n")];
    expect(coverageState(input({ evidence: base, profile: p }))).toMatchObject({ state: "probe" });
    const why = (line: string, over: Parameters<typeof command>[2] = {}): string => (doneOf(coverageState(input({ evidence: [...base, command("host-mounts-go", line, over)], profile: p }))).outcomes.get(recordKey(goRecord)) as { reason: string }).reason;
    expect(why("missing /home/u/t/bin is not a directory on this host\n")).toBe("sandbox mount tools (~/t/bin): /home/u/t/bin is not a directory on this host");
    expect(why("")).toBe("sandbox mount tools (~/t/bin): the host probe printed no answer for it");
    expect(why("", { exit: 2, stderr: "boom" })).toMatch(/the sandbox mounts could not be located on the host: boom/);
    expect(why("ok /a:b\n")).toMatch(/resolves to a path a container cannot mount/);
  });

  it("makes every function not run, with the failed setup command named, when the setup failed; and keeps what ran when it did not", () => {
    const p = withGo({ readOnly: mounts, setup });
    const spec = formatSpec({ packages: ["pkg/a"], functions: [{ path: "pkg/a/a.go", start: 3, end: 16 }], setup });
    const evidence = (text: string): EvidenceRecord[] => [
      diff,
      command("sandbox-go", "ready\n"),
      command("host-go-modcache", "/gomodcache\n"),
      command("host-mounts-go", "ok /m\n"),
      command("cover-go", "", { argv: coverageCommand({ id: "cover-go", script: "go.sh", spec }, "/plugin", 60_000).argv, report: { text, truncated: false } }),
    ];
    const failed = doneOf(coverageState(input({ evidence: evidence("graphloom-coverage-v1 go\nsetup-fail gen 3 generator exploded\n"), profile: p })));
    expect(failed.outcomes.get(recordKey(goRecord))).toEqual({ reason: "setup failed: gen exited 3 (generator exploded)" });
    expect(failed.facts.runs[0]).toMatchObject({ ran: false, reason: "setup failed: gen exited 3 (generator exploded)" });
    const fine = doneOf(coverageState(input({ evidence: evidence("graphloom-coverage-v1 go\nsetup gen ok\nexit 0\nB pkg/a/a.go:4.2,6.3 3 1\nseen pkg/a/a.go\n"), profile: p })));
    expect(fine.outcomes.get(recordKey(goRecord))).toMatchObject({ source: "measured", covered: 3 });
    expect(fine.facts.runs[0]).toMatchObject({ ran: true, setup: ["gen"] });
  });
});

describe("go.sh runs the setup before the tests", () => {
  const goSh = fileURLToPath(new URL("../tools/cover/go.sh", import.meta.url));
  const stubs = (dir: string): void => {
    // A `go` that records its calls into order.txt, writes a one-block profile for `go test`, and names the module for `go env GOMOD`.
    writeFileSync(
      path.join(dir, "go"),
      `#!/bin/sh
case "$1" in
  env) echo "$PWD/go.mod" ;;
  test)
    echo "test" >> "$ORDER"
    for a in "$@"; do case "$a" in -coverprofile=*) printf 'mode: set\nexample.com/m/pkg/a/a.go:4.2,6.3 3 1\n' > "\${a#-coverprofile=}" ;; esac; done
    echo "ok  	example.com/m/pkg/a	0.1s" ;;
esac
`,
      { mode: 0o755 },
    );
  };

  function run(setup: Array<{ id: string; argv: string[] }>): { report: string; order: string[]; status: number | null } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-gosh-"));
    try {
      const bin = path.join(dir, "bin");
      const work = path.join(dir, "work");
      spawnSync("mkdir", ["-p", bin, path.join(work, "pkg", "a")]);
      stubs(bin);
      writeFileSync(path.join(work, "go.mod"), "module example.com/m\n\ngo 1.25\n");
      const spec = formatSpec({ packages: ["pkg/a"], functions: [{ path: "pkg/a/a.go", start: 3, end: 16 }], setup });
      const parts = [spec];
      const rep = path.join(dir, "report.txt");
      const order = path.join(dir, "order.txt");
      writeFileSync(order, "");
      const r = spawnSync("sh", [goSh, String(parts.length), ...parts], { cwd: work, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, GRAPHLOOM_REPORT_FILE: rep, ORDER: order } });
      return { report: spawnSync("cat", [rep], { encoding: "utf8" }).stdout, order: spawnSync("cat", [order], { encoding: "utf8" }).stdout.split("\n").filter(Boolean), status: r.status };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const note = (id: string): { id: string; argv: string[] } => ({ id, argv: ["sh", "-c", `echo ${id} >> "$ORDER"`] });

  it("runs each setup command in order, from the checkout's root, before `go test`, and reports them", () => {
    const r = run([note("one"), note("two"), { id: "where", argv: ["sh", "-c", 'pwd >> "$ORDER"; printf "%s" "$0|$1" >> "$ORDER"; echo >> "$ORDER"', "a b", "c'd"] }]);
    expect(r.status).toBe(0);
    expect(r.order.slice(0, 2)).toEqual(["one", "two"]);
    expect(r.order[2]).toMatch(/\/work$/);
    expect(r.order[3]).toBe("a b|c'd");
    expect(r.order.at(-1)).toBe("test");
    expect(r.report.split("\n").slice(0, 5)).toEqual(["graphloom-coverage-v1 go", "setup one ok", "setup two ok", "setup where ok", "exit 0"]);
    expect(r.report).toContain("B pkg/a/a.go:4.2,6.3 3 1");
  });

  it("stops at the first failing command: the later ones and the tests do not run, and the report says which failed, its exit and its output", () => {
    const r = run([note("one"), { id: "broken", argv: ["sh", "-c", 'echo "line1"; echo "boom here" >&2; exit 7'] }, note("never")]);
    expect(r.status).toBe(0);
    expect(r.order).toEqual(["one"]);
    expect(r.report).toBe("graphloom-coverage-v1 go\nsetup one ok\nsetup-fail broken 7 line1 boom here\n");
  });

  it("reports a program that does not exist as exit 127, and has no tests run", () => {
    const r = run([{ id: "ghost", argv: ["definitely-not-a-program-xyz"] }]);
    expect(r.order).toEqual([]);
    expect(r.report).toMatch(/^graphloom-coverage-v1 go\nsetup-fail ghost 127 /);
  });

  it("runs no setup, and the report has no setup facts, when the spec names none", () => {
    const r = run([]);
    expect(r.order).toEqual(["test"]);
    expect(r.report).not.toMatch(/^setup/m);
  });
});
