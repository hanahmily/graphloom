// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentCommand } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  architectureMermaid,
  architecturePlan,
  architectureProblems,
  architectureTargets,
  assembleArchitecture,
  readArchitectureCheck,
  renderArchitectureMarkdown,
  type ArchEdge,
  type ArchNode,
  type Architecture,
} from "../src/architecture.js";
import { readClaimCheck } from "../src/claims.js";
import { GIT_ENV } from "../src/commands.js";
import { areaProblems } from "../src/large.js";
import { assembleReport, reportProblems, type ReportContext, type ReporterOutput } from "../src/report.js";
import { pullFile, type PullFile } from "../src/snapshot.js";
import { reporterSections } from "../src/template.js";
import { assignmentOf, profileOf, scenarioWith, simulate } from "./support.js";
import { REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gl-pr-${prefix}-`));
  dirs.push(dir);
  return dir;
};

const added = (p: string, lines: string[]): PullFile =>
  pullFile({ path: p, status: "added", previousPath: null, additions: lines.length, deletions: 0, sha: null, patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`, patchOmitted: false })!;
const FILES = [added("pkg/alpha/alpha.go", ["package alpha", "", "func A() {}"]), added("pkg/beta/beta.go", ["package beta", "", 'import "example.com/lib/pkg/alpha"', "", "func B() { alpha.A() }"])];

const node = (id: string, over: Partial<ArchNode> = {}): ArchNode => ({ id, label: id, kind: "package", change: "added", paths: [`pkg/${id}`], cite: { path: `pkg/${id}/${id}.go`, side: "head", start: 1, end: 1 }, ...over });
const edge = (from: string, to: string, over: Partial<ArchEdge> = {}): ArchEdge => ({ from, to, label: `${from} uses ${to}`, kind: "import", change: "added", cite: { path: "pkg/beta/beta.go", side: "head", start: 3, end: 3 }, ...over });
const GOOD: Architecture = { nodes: [node("alpha"), node("beta"), node("store", { change: "unchanged", cite: { path: "pkg/store/store.go", side: "base", start: 1, end: 1 } })], edges: [edge("beta", "alpha"), edge("store", "alpha", { kind: "call", change: "unchanged" })] };

describe("architecture validation (design 6.10)", () => {
  const problems = (a: Architecture): string => architectureProblems(a, FILES).join(" | ");

  it("accepts a diagram of changed components, with context that an edge joins to a changed one", () => {
    expect(architectureProblems(GOOD, FILES)).toEqual([]);
    expect(architectureProblems({ nodes: [], edges: [] }, FILES)).toEqual([]);
  });

  it("refuses duplicate ids, an id the edge claims take, and an edge that names a node that is not there", () => {
    expect(problems({ nodes: [node("alpha"), node("alpha")], edges: [] })).toContain("the id appears twice");
    expect(problems({ nodes: [node("e1", { paths: ["pkg/alpha"] })], edges: [] })).toContain("form e<number>");
    expect(problems({ nodes: [node("alpha")], edges: [edge("alpha", "nowhere")] })).toContain('to "nowhere" is not a node id');
    expect(problems({ nodes: [node("alpha")], edges: [edge("ghost", "alpha")] })).toContain('from "ghost" is not a node id');
  });

  it("refuses an added or modified node whose paths match no changed file, and accepts a directory that holds one", () => {
    expect(problems({ nodes: [node("gamma", { paths: ["pkg/gamma"] })], edges: [] })).toContain("none of its paths (pkg/gamma) matches a file the pull request changes");
    expect(architectureProblems({ nodes: [node("alpha", { paths: ["pkg/alpha"] })], edges: [] }, FILES)).toEqual([]);
    expect(architectureProblems({ nodes: [node("alpha", { paths: ["pkg/alpha/alpha.go"] })], edges: [] }, FILES)).toEqual([]);
    expect(problems({ nodes: [node("al", { paths: ["pkg/al"] })], edges: [] })).toContain("matches a file");
  });

  it("refuses an unchanged node that no edge joins to an added or modified node", () => {
    const ctx = node("store", { change: "unchanged" });
    expect(problems({ nodes: [ctx], edges: [] })).toContain("no edge connects it to an added or modified node");
    expect(problems({ nodes: [ctx, node("other", { change: "unchanged", paths: ["pkg/other"] })], edges: [edge("store", "other", { kind: "call" })] })).toContain("no edge connects it");
    expect(architectureProblems({ nodes: [ctx, node("alpha")], edges: [edge("alpha", "store", { kind: "call" })] }, FILES)).toEqual([]);
  });

  it("holds the bounds: 30 nodes, 60 edges, label lengths, a path inside the repository, and cites that are ranges", () => {
    const many = Array.from({ length: 31 }, (_, i) => node(`n${i}`, { paths: ["pkg/alpha"] }));
    expect(problems({ nodes: many, edges: [] })).toContain("31 nodes, more than 30");
    const edges = Array.from({ length: 61 }, () => edge("alpha", "beta"));
    expect(problems({ nodes: [node("alpha"), node("beta")], edges })).toContain("61 edges, more than 60");
    expect(problems({ nodes: [node("alpha", { label: "x".repeat(81) })], edges: [] })).toContain("81 characters");
    expect(problems({ nodes: [node("alpha", { paths: ["../etc"] })], edges: [] })).toContain("not a repository-relative path");
    expect(problems({ nodes: [node("alpha", { paths: ["/etc"] })], edges: [] })).toContain("not a repository-relative path");
    expect(problems({ nodes: [node("alpha", { cite: { path: "pkg/alpha/alpha.go", side: "head", start: 0, end: 0 } })], edges: [] })).toContain("not a range");
    expect(problems({ nodes: [node("alpha", { cite: { path: "pkg/alpha/alpha.go", side: "head", start: 5, end: 2 } })], edges: [] })).toContain("not a range");
    expect(problems({ nodes: [node("alpha", { paths: [] })], edges: [] })).toContain("no paths");
  });

  it("is part of the report's deterministic rules, and an area report leaves it empty", () => {
    const sections = reporterSections(profileOf());
    const ctx: ReportContext = { sections, files: FILES, facts: [] };
    const base: ReporterOutput = {
      purpose: { text: "", source: "inferred", quote: "" },
      overview: "",
      sections: sections.map((s) => ({ id: s.id, none: s.id !== "other", items: s.id === "other" ? [{ text: "changes", cites: FILES.map((f) => ({ path: f.path, side: "head" as const, start: 1, end: 1, symbol: "" })), facts: [], state: [], behavior: [] }] : [] })),
      notes: [],
      architecture: { nodes: [node("gamma", { paths: ["pkg/gamma"] })], edges: [] },
    };
    expect(reportProblems(base, ctx, { summary: false }).join("|")).toContain("none of its paths");
    expect(areaProblems({ ...base, architecture: GOOD }, ctx).join("|")).toContain("an area report leaves the architecture empty");
    expect(areaProblems({ ...base, architecture: { nodes: [], edges: [] } }, ctx).join("|")).not.toContain("architecture");
  });
});

describe("the claim check of the diagram (design 6.10)", () => {
  const sections = reporterSections(profileOf());
  const ctx: ReportContext = { sections, files: FILES, facts: [] };
  const report = (arch: Architecture) => ({ sections: sections.map((s) => ({ id: s.id, none: true, items: [] })), notes: [], architecture: arch });

  it("claims every node as A.<id> and every edge as A.e<n>, with the plugin's import note on the edge it concerns", () => {
    const targets = architectureTargets(GOOD, new Map([["A.e2", "import missing: the head's import blocks list no import of alpha"]]));
    expect(targets.map((t) => t.id)).toEqual(["A.alpha", "A.beta", "A.store", "A.e1", "A.e2"]);
    expect(targets[4]!.text).toContain("Plugin note: import missing");
    expect(targets[3]!.text).not.toContain("Plugin note");
    expect(targets[3]!.cites).toEqual([{ path: "pkg/beta/beta.go", side: "head", start: 3, end: 3, symbol: "" }]);
  });

  it("drops an unsupported node with its edges, and an unsupported edge alone, and records both", () => {
    const arch: Architecture = { nodes: [node("alpha"), node("beta"), node("gamma", { paths: ["pkg/alpha"] })], edges: [edge("beta", "alpha"), edge("gamma", "alpha"), edge("beta", "gamma", { kind: "call" })] };
    const { architecture, parts } = assembleArchitecture(arch, new Map([["A.gamma", "unsupported: the code shows no such component"], ["A.e1", "partial: wrong direction"]]));
    expect(architecture.nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
    expect(architecture.edges).toEqual([]);
    expect(parts).toEqual([
      { id: "A.gamma", kind: "node", item: "", label: "gamma", reason: "unsupported: the code shows no such component (its 2 edges dropped with it)" },
      { id: "A.e1", kind: "edge", item: "", label: "beta → alpha: beta uses alpha", reason: "partial: wrong direction" },
    ]);
    const edgeOnly = assembleArchitecture(arch, new Map([["A.e2", "unsupported"]]));
    expect(edgeOnly.architecture.nodes).toHaveLength(3);
    expect(edgeOnly.architecture.edges).toHaveLength(2);
    expect(edgeOnly.parts.map((p) => `${p.kind}:${p.id}`)).toEqual(["edge:A.e2"]);
  });

  it("drops the context an unsupported node leaves with no changed neighbour", () => {
    const { architecture, parts } = assembleArchitecture(GOOD, new Map([["A.alpha", "unsupported"], ["A.beta", "unsupported"]]));
    expect(architecture.nodes).toEqual([]);
    expect(parts.map((p) => p.id)).toEqual(["A.alpha", "A.beta", "A.store"]);
    expect(parts.at(-1)!.reason).toContain("no remaining edge connects it");
  });

  it("reads the checker's verdicts for the diagram's claims, and a report assembled from them carries what stands", () => {
    const targets = architectureTargets(GOOD);
    const verdicts = targets.map((t) => ({ item: t.id, verdict: t.id === "A.e1" ? "unsupported" : "supported", note: t.id === "A.e1" ? "the code does not import it" : "", quotes: t.id === "A.beta" ? [{ path: "pkg/beta/beta.go", line: 1, text: "package beta" }] : t.id === "A.e2" ? [{ path: "pkg/beta/beta.go", line: 3, text: 'import "example.com/lib/pkg/alpha"' }] : t.id === "A.alpha" ? [{ path: "pkg/alpha/alpha.go", line: 1, text: "package alpha" }] : [] }));
    const reading = readClaimCheck({ verdicts }, targets, FILES);
    expect("problems" in reading).toBe(false);
    if ("problems" in reading) return;
    expect(reading.unchecked).toEqual([]);
    expect([...reading.weak.keys()]).toEqual(["A.e1"]);
    const final = assembleReport(report(GOOD), reading.weak, ctx);
    expect(final.architecture.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["store>alpha"]);
    expect(final.removedParts.filter((p) => p.kind === "edge").map((p) => p.id)).toEqual(["A.e1"]);
    expect(reportProblems({ sections: final.sections.map((s) => ({ id: s.id, none: s.none, items: s.items })), notes: [], architecture: final.architecture }, ctx, { final: true }).filter((p) => p.includes("architecture"))).toEqual([]);
  });

  it("makes a supported node need quotes that match the diff when its cite is in the diff", () => {
    const targets = architectureTargets({ nodes: [node("alpha")], edges: [] });
    const reading = readClaimCheck({ verdicts: [{ item: "A.alpha", verdict: "supported", note: "", quotes: [{ path: "pkg/alpha/alpha.go", line: 1, text: "package other" }] }] }, targets, FILES);
    if ("problems" in reading) throw new Error("unreadable");
    expect(reading.weak.get("A.alpha")).toContain("do not match");
  });
});

describe("the Mermaid block and the markdown of the diagram", () => {
  it("is a mermaid code block of components and connections, text only", () => {
    const lines = architectureMermaid(GOOD);
    expect(lines[0]).toBe("```mermaid");
    expect(lines[1]).toBe("flowchart LR");
    expect(lines.at(-1)).toBe("```");
    expect(lines.filter((l) => l.includes(":::added"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes(":::unchanged"))).toHaveLength(1);
    expect(lines.some((l) => l.includes('n2 -->|"beta uses alpha (import, added)"| n1'))).toBe(true);
    expect(lines.some((l) => l.includes('n3 -->|"store uses alpha (call)"| n1'))).toBe(true);
    expect(architectureMermaid({ nodes: [], edges: [] })).toEqual([]);
  });

  it("draws a removed connection dashed, and keeps hostile label text from ending a label or the block", () => {
    const lines = architectureMermaid({ nodes: [node("a", { label: 'x"] --> y["z' }), node("b")], edges: [edge("a", "b", { change: "removed", label: 'q"| n9' })] });
    expect(lines.some((l) => l.includes("-.->"))).toBe(true);
    expect(lines.join("\n")).not.toContain('x"]');
    expect(lines.join("\n").match(/```/g)).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("  n1[")).join()).toContain("#quot;");
  });

  it("reads as a list where Mermaid does not render, and says None when there is nothing to draw", () => {
    const md = renderArchitectureMarkdown(GOOD).join("\n");
    expect(md).toContain("## Architecture\n```mermaid");
    expect(md).toContain("Components:\n- alpha (package, added): pkg/alpha — pkg/alpha/alpha.go:1");
    expect(md).toContain("Connections:\n- beta → alpha (import, added): beta uses alpha — pkg/beta/beta.go:3");
    expect(renderArchitectureMarkdown({ nodes: [], edges: [] }).join("\n")).toContain("None");
  });
});

describe("the tree check, run for real (design 6.10)", () => {
  const git = (cwd: string, args: string[]): string => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (dir: string, files: Record<string, string>): void => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), t);
    }
  };
  /** A base commit with pkg/store and a head that adds pkg/alpha and pkg/beta (which imports alpha). */
  const repo = (): { dir: string; base: string } => {
    const dir = tmp("arch");
    git(dir, ["init", "-q", "-b", "main"]);
    put(dir, { "pkg/store/store.go": "package store\n\nfunc S() {}\n", "README.md": "x\n" });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]);
    put(dir, {
      "pkg/alpha/alpha.go": "package alpha\n\nfunc A() {}\n",
      "pkg/beta/beta.go": 'package beta\n\n// import "ignored/in/a/comment"\nimport (\n\t"fmt"\n\tal "example.com/lib/pkg/alpha"\n\t_ "example.com/lib/pkg/extra"\n)\n\nfunc B() { al.A(); fmt.Println() }\n',
      "pkg/store/store.go": "package store\n\nimport \"os\"\n\nfunc S() { _ = os.Args }\n",
    });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "head"]);
    return { dir, base };
  };
  const exec = (cwd: string, c: EnvironmentCommand): string => {
    const report = path.join(tmp("report"), "report.txt");
    const r = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, GRAPHLOOM_REPORT_FILE: report } });
    expect(r.status, r.stderr).toBe(0);
    return existsSync(report) ? readFileSync(report, "utf8") : "";
  };
  const check = (arch: Architecture, cwd: string, base: string) => {
    const plan = architecturePlan(arch, base);
    return { plan, result: readArchitectureCheck(plan, plan.commands.map((c) => exec(cwd, c))) };
  };

  it("resolves a cite in the tree it names, and finds none missing in a sound diagram", () => {
    const { dir, base } = repo();
    const arch: Architecture = { nodes: [node("alpha"), node("beta"), node("store", { change: "unchanged", cite: { path: "pkg/store/store.go", side: "base", start: 1, end: 3 } })], edges: [edge("beta", "alpha", { cite: { path: "pkg/beta/beta.go", side: "head", start: 6, end: 6 } })] };
    const { plan, result } = check(arch, dir, base);
    expect(plan.commands.length).toBe(1);
    expect(plan.commands[0]!.id).toBe("arch-check-1");
    expect(result.problems).toEqual([]);
    expect(result.notes.size).toBe(0);
  });

  it("names a cite that has no such file in its tree, one past the end of the file, and an unchanged path that is not at the base", () => {
    const { dir, base } = repo();
    const arch: Architecture = {
      nodes: [
        node("alpha", { cite: { path: "pkg/alpha/alpha.go", side: "base", start: 1, end: 1 } }),
        node("beta", { cite: { path: "pkg/beta/beta.go", side: "head", start: 1, end: 99 } }),
        node("ghost", { change: "unchanged", paths: ["pkg/ghost"], cite: { path: "pkg/store/store.go", side: "head", start: 1, end: 1 } }),
      ],
      edges: [edge("beta", "ghost", { cite: { path: "pkg/beta/missing.go", side: "head", start: 1, end: 1 } })],
    };
    const { result } = check(arch, dir, base);
    const text = result.problems.join(" | ");
    expect(text).toContain("node alpha: the cite pkg/alpha/alpha.go:1 names no such file in the base tree");
    expect(text).toMatch(/node beta: the cite pkg\/beta\/beta\.go lies past the end of the file in the head tree \(\d+ lines\)/);
    expect(text).toContain("node ghost: the path pkg/ghost does not exist at the base");
    expect(text).toContain("edge A.e1: the cite pkg/beta/missing.go:1 names no such file in the head tree");
  });

  it("reads the from package's head import blocks and notes a Go edge whose import is not there, never a failure", () => {
    const { dir, base } = repo();
    const arch: Architecture = {
      nodes: [node("alpha"), node("beta"), node("store", { change: "unchanged", cite: { path: "pkg/store/store.go", side: "base", start: 1, end: 1 } })],
      edges: [
        edge("beta", "alpha", { cite: { path: "pkg/beta/beta.go", side: "head", start: 6, end: 6 } }),
        edge("store", "alpha", { kind: "call", cite: { path: "pkg/store/store.go", side: "head", start: 5, end: 5 } }),
        edge("beta", "alpha", { kind: "data", cite: { path: "pkg/beta/beta.go", side: "head", start: 6, end: 6 } }),
        edge("store", "beta", { kind: "import", change: "removed", cite: { path: "pkg/store/store.go", side: "base", start: 1, end: 1 } }),
      ],
    };
    const { result } = check(arch, dir, base);
    expect(result.problems).toEqual([]);
    expect([...result.notes.keys()]).toEqual(["A.e2"]);
    expect(result.notes.get("A.e2")).toContain("import missing");
    expect(result.notes.get("A.e2")).toContain("package store");
    expect(result.notes.get("A.e2")).toContain("pkg/alpha");
  });

  it("lists aliased and blank imports and skips a commented one", () => {
    const { dir, base } = repo();
    const arch: Architecture = { nodes: [node("beta"), node("extra", { paths: ["pkg/beta"], cite: { path: "pkg/beta/beta.go", side: "head", start: 1, end: 1 } })], edges: [edge("extra", "beta")] };
    const plan = architecturePlan({ nodes: [node("beta"), node("alpha")], edges: [edge("beta", "alpha")] }, base);
    const out = exec(dir, plan.commands[0]!);
    const imports = out.split("\n").filter((l) => / import /.test(l)).map((l) => l.replace(/^\d+ import /, ""));
    expect(imports).toEqual(["fmt", "example.com/lib/pkg/alpha", "example.com/lib/pkg/extra"]);
    expect(out).not.toContain("ignored/in/a/comment");
    void arch;
  });

  it("binds each run to its diagram: the argv names the base and every entry, and a path outside the repository never reaches a command", () => {
    const a = architecturePlan(GOOD, "b".repeat(40));
    const b = architecturePlan({ ...GOOD, edges: GOOD.edges.slice(0, 1) }, "b".repeat(40));
    expect(a.commands[0]!.argv).not.toEqual(b.commands[0]!.argv);
    expect(a.commands[0]!.argv[4]).toBe("b".repeat(40));
    expect(architecturePlan(GOOD, undefined).unavailable).toContain("no pinned base");
    expect(architecturePlan({ nodes: [], edges: [] }, "b".repeat(40)).commands).toEqual([]);
    const many: Architecture = { nodes: Array.from({ length: 30 }, (_, i) => node(`n${i}`)), edges: Array.from({ length: 60 }, (_, i) => edge(`n${i % 30}`, `n${(i + 1) % 30}`, { cite: { path: `pkg/f${i}.go`, side: "head", start: 1, end: 1 } })) };
    const plan = architecturePlan(many, "b".repeat(40));
    expect(plan.commands.length).toBeGreaterThan(1);
    expect(plan.commands.every((c) => c.argv.length <= 64)).toBe(true);
  });
});

describe("the diagram in the graph (design 6.10)", () => {
  it("checks the trees before the claim check, tells the checker about each claim, and records what it drops", () => {
    const sim = simulate({ scenarioName: "architecture-diagram" });
    const order = sim.jobs.map((j) => (j.kind === "agent" ? `${j.resultSchema}` : j.instruction.split(" ").slice(0, 3).join(" "))).filter((x) => ["change-report-v1", "Check the architecture", "claim-check-v1", "change-report-revision-v1"].some((p) => x.startsWith(p)));
    expect(order).toEqual(["change-report-v1", "Check the architecture", "claim-check-v1", "change-report-revision-v1", "claim-check-v1"]);
    const checker = sim.jobs.find((j) => j.resultSchema === "claim-check-v1")!;
    expect(assignmentOf(checker)).toContain("A.server");
    expect(assignmentOf(checker)).toContain("A.e1");
    expect(assignmentOf(checker)).toContain("A.e3");
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
    expect(sim.written).toBeDefined();
    const report = JSON.parse(sim.written!.json) as { architecture: Architecture; removedParts: Array<{ id: string; kind: string }> };
    expect(report.architecture.edges.map((e) => e.label)).toEqual(["schedules the nightly sweep", "serves Group"]);
    expect(report.removedParts.filter((p) => p.kind === "edge").map((p) => p.id)).toEqual(["A.e2"]);
  });

  it("sends the reporter back with the problems when a cite does not resolve in its tree, and hands the run to the supervisor after two corrections", () => {
    const scenario = scenarioWith("architecture-diagram", (s) => {
      s.commands!["arch-check-1"] = { exitCode: 0, stdout: "1 ok\n2 missing\n3 ok\n4 ok\n5 ok\n6 ok\nchecked 6\n" };
    });
    const sim = simulate({ scenario });
    expect(sim.final.action).toMatchObject({ type: "supervise" });
    const reporters = sim.jobs.filter((j) => j.resultSchema === "change-report-v1");
    expect(reporters).toHaveLength(3);
    expect(assignmentOf(reporters[1]!)).toContain("failed deterministic validation");
    expect(assignmentOf(reporters[1]!)).toContain("names no such file in the");
    expect(sim.final.action.type === "supervise" ? sim.final.action.supervise.reason : "").toMatch(/architecture diagram still fails the tree check after 2 corrections/);
  });

  it("refuses a diagram with no pinned base to read the trees at, rather than skipping the check", () => {
    expect(REHEARSAL_MERGE_BASE).toHaveLength(40);
    expect(architecturePlan(GOOD, undefined).unavailable).toBeDefined();
  });
});
