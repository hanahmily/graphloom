// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GIT_ENV } from "../src/commands.js";
import { commandRuns } from "../src/evidence.js";
import { effectiveConclusion, necessityDecision, necessityProblems, parseNecessityRecord, supportedBreaks, type Necessity, type PrincipleVerdict } from "../src/necessity.js";
import { applies, MAX_GLOBS, MAX_PRINCIPLES, MAX_STATEMENT_CHARS, parsePrinciples, principlesContext, principlesReadCommand, principlesReading } from "../src/principles.js";
import { parseProfile } from "../src/profile.js";
import { renderNecessity } from "../src/qa.js";
import { defaultNecessity } from "../src/rehearsal-qa.js";
import { PRINCIPLES_FILE, PRINCIPLES_PATH } from "../src/rehearsal-fixtures.js";
import { REHEARSAL_HEAD, REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";
import { writtenNecessity } from "../src/write.js";
import { assignmentOf, BANYANDB, jobsOf, scenarioWith, simulate, type Simulation } from "./support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("parsing a principles file", () => {
  it("reads the documented format: frontmatter skipped, id, statement paragraphs, Why, Applies to, Source", () => {
    const { principles, notes } = parsePrinciples(PRINCIPLES_FILE);
    expect(principles.map((p) => p.id)).toEqual(["small-steps", "offline-idempotent", "proto-compatible"]);
    expect(principles[0]).toEqual({ id: "small-steps", statement: "A change does one thing, so it can be reviewed and reverted alone.", why: "mixed changes hide regressions.", appliesTo: [], source: "docs/design/README.md" });
    expect(principles[1]!.appliesTo).toEqual(["pkg/offline/**", "**/sync*.go"]);
    expect(principles[1]!.source).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"Not A Principle Id" is not a principle id/);
  });

  it("keeps a multi-paragraph statement up to the first bullet, and ignores the title and intro", () => {
    const { principles } = parsePrinciples("# Title\nIntro paragraph.\n\n## a1\nFirst paragraph.\n\nSecond paragraph.\n- Why: because\nstray text after a bullet\n## b\nOnly a statement.\n");
    expect(principles).toEqual([
      { id: "a1", statement: "First paragraph.\n\nSecond paragraph.", why: "because", appliesTo: [] },
      { id: "b", statement: "Only a statement.", appliesTo: [] },
    ]);
  });

  it("treats a missing Applies to as every change, and ignores bad ids with a note", () => {
    const { principles, notes } = parsePrinciples("## Bad_Id\nx\n## -lead\ny\n## ok-1\nz\n");
    expect(principles.map((p) => p.id)).toEqual(["ok-1"]);
    expect(principles[0]!.appliesTo).toEqual([]);
    expect(notes).toHaveLength(2);
  });

  it("skips an item without a statement and a repeated id, each with a note", () => {
    const { principles, notes } = parsePrinciples("## empty\n- Why: nothing\n## dup\nfirst\n## dup\nsecond\n");
    expect(principles.map((p) => [p.id, p.statement])).toEqual([["dup", "first"]]);
    expect(notes.join(" ")).toMatch(/empty has no statement.*dup appears more than once/);
  });

  it("cuts what is over the bounds, with a note: principles, statement length, globs", () => {
    const many = Array.from({ length: MAX_PRINCIPLES + 3 }, (_, i) => `## p${i}\nstatement ${i}\n`).join("\n");
    const r = parsePrinciples(many);
    expect(r.principles).toHaveLength(MAX_PRINCIPLES);
    expect(r.notes.join(" ")).toContain(`more than ${MAX_PRINCIPLES} principles`);
    const long = parsePrinciples(`## long\n${"x".repeat(MAX_STATEMENT_CHARS + 50)}\n`);
    expect(long.principles[0]!.statement).toHaveLength(MAX_STATEMENT_CHARS);
    expect(long.notes.join(" ")).toContain("cut to 1000");
    const globs = Array.from({ length: MAX_GLOBS + 5 }, (_, i) => `d${i}/**`).join(", ");
    const g = parsePrinciples(`## g\nstatement\n- Applies to: ${globs}\n`);
    expect(g.principles[0]!.appliesTo).toHaveLength(MAX_GLOBS);
    expect(g.notes.join(" ")).toContain(`first ${MAX_GLOBS} were kept`);
  });

  it("returns no principles for text without any", () => {
    expect(parsePrinciples("")).toEqual({ principles: [], notes: [] });
    expect(parsePrinciples("---\nname: x\n---\n# Only a title\n").principles).toEqual([]);
  });
});

describe("which principles apply", () => {
  const { principles } = parsePrinciples(PRINCIPLES_FILE);
  const [every, offline, proto] = principles as [(typeof principles)[0], (typeof principles)[0], (typeof principles)[0]];
  it("applies one with no globs to every change, and one with globs when any changed file matches any glob", () => {
    const files = [{ path: "pkg/offline/sync.go" }];
    expect(applies(every, files)).toBe(true);
    expect(applies(offline, files)).toBe(true);
    expect(applies(proto, files)).toBe(false);
    expect(applies(proto, [{ path: "pkg/offline/sync.go" }, { path: "api/x/v1/group.proto" }])).toBe(true);
    expect(applies(offline, [{ path: "docs/readme.md" }, { path: "cmd/run_sync.go" }])).toBe(false);
    expect(applies(offline, [{ path: "cmd/sync_all.go" }])).toBe(true);
  });

  it("matches a renamed file under its old name too", () => {
    expect(applies(offline, [{ path: "pkg/new/x.go", previousPath: "pkg/offline/x.go" }])).toBe(true);
  });

  it("flags a pull request that changes the principles file itself", () => {
    const read = { path: PRINCIPLES_PATH, commit: REHEARSAL_MERGE_BASE, file: "present" as const, text: PRINCIPLES_FILE, truncated: false };
    expect(principlesContext(read, [{ path: "a.go" }]).changed).toBe(false);
    expect(principlesContext(read, [{ path: PRINCIPLES_PATH }]).changed).toBe(true);
    expect(principlesContext(read, [{ path: "skills/other.md", previousPath: PRINCIPLES_PATH }]).changed).toBe(true);
    expect(principlesContext({ ...read, file: "absent", text: "" }, [{ path: "a.go" }]).applicable).toEqual([]);
  });
});

describe("the profile's questions.principles", () => {
  it("is set for BanyanDB, with the ref left to default to the base commit", () => {
    expect(parseProfile(BANYANDB).questions.principles).toEqual({ path: "skills/design-principles/SKILL.md" });
  });

  it("accepts a repository-relative .md path and an optional git ref name", () => {
    const q = (principles: unknown) => parseProfile({ ...BANYANDB, questions: { principles } }).questions.principles;
    expect(q({ path: "skills/x/SKILL.md", ref: "feat/principles-1.0_a" })).toEqual({ path: "skills/x/SKILL.md", ref: "feat/principles-1.0_a" });
    expect(parseProfile({ ...BANYANDB, questions: {} }).questions.principles).toBeUndefined();
  });

  it("refuses a bad path, a bad ref and extra keys", () => {
    const q = (principles: unknown) => () => parseProfile({ ...BANYANDB, questions: { principles } });
    expect(q({ path: "/etc/x.md" })).toThrow(/repository-relative path to a \.md file/);
    expect(q({ path: "../x.md" })).toThrow(/repository-relative path/);
    expect(q({ path: "skills/x.txt" })).toThrow(/\.md file/);
    expect(q({})).toThrow(/\.md file/);
    expect(q({ path: "a.md", ref: "bad ref" })).toThrow(/git ref name/);
    expect(q({ path: "a.md", ref: "x".repeat(201) })).toThrow(/git ref name/);
    expect(q({ path: "a.md", ref: "-x" })).toThrow(/git ref name/);
    expect(q({ path: "a.md", other: 1 })).toThrow();
    expect(q("a.md")).toThrow(/must be an object/);
  });
});

describe("reading the file: from the ref or the base, never from the head", () => {
  const sh = (cwd: string, args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=A", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  function repo() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-principles-"));
    dirs.push(dir);
    sh(dir, ["init", "-q", "-b", "main"]);
    const put = (text: string | undefined) => {
      mkdirSync(path.join(dir, "skills/design-principles"), { recursive: true });
      if (text === undefined) rmSync(path.join(dir, PRINCIPLES_PATH), { force: true });
      else writeFileSync(path.join(dir, PRINCIPLES_PATH), text);
      sh(dir, ["add", "-A", "-f"]);
      sh(dir, ["commit", "-q", "--allow-empty", "-m", "c"]);
      return sh(dir, ["rev-parse", "HEAD"]);
    };
    const none = put(undefined);
    const base = put("## from-base\nthe base version\n");
    sh(dir, ["checkout", "-q", "-b", "unmerged"]);
    const unmerged = put("## from-ref\nthe unmerged version\n");
    sh(dir, ["checkout", "-q", "-b", "pr", base]);
    const head = put("## from-head\nthe pull request rewrote the rules\n");
    return { dir, none, base, unmerged, head };
  }
  const run = (dir: string, command: ReturnType<typeof principlesReadCommand>) => {
    const report = path.join(dir, ".git", "report.txt");
    const r = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV, GRAPHLOOM_REPORT_FILE: report } });
    return { status: r.status, stderr: r.stderr, report: r.status === 0 ? readFileSync(report, "utf8") : "" };
  };

  it("reads the base commit's version by default, though the head (checked out) has another", () => {
    const r = repo();
    const out = run(r.dir, principlesReadCommand({ path: PRINCIPLES_PATH }, r.base));
    expect(out.report).toBe(`commit ${r.base}\npresent\n## from-base\nthe base version\n`);
    expect(out.report).not.toContain("from-head");
    expect(readFileSync(path.join(r.dir, PRINCIPLES_PATH), "utf8")).toContain("from-head");
  });

  it("reads a named ref (a local branch not merged upstream) and records the commit it resolved to", () => {
    const r = repo();
    const out = run(r.dir, principlesReadCommand({ path: PRINCIPLES_PATH, ref: "unmerged" }, r.base));
    expect(out.report).toBe(`commit ${r.unmerged}\npresent\n## from-ref\nthe unmerged version\n`);
  });

  it("records a missing file as absent, not as an error, and refuses a ref that names no commit", () => {
    const r = repo();
    expect(run(r.dir, principlesReadCommand({ path: PRINCIPLES_PATH, ref: r.none }, r.base)).report).toBe(`commit ${r.none}\nabsent\n`);
    expect(run(r.dir, principlesReadCommand({ path: "skills/nope/SKILL.md" }, r.base)).report).toBe(`commit ${r.base}\nabsent\n`);
    const bad = run(r.dir, principlesReadCommand({ path: PRINCIPLES_PATH, ref: "no-such-branch" }, r.base));
    expect(bad.status).toBe(4);
    expect(bad.stderr).toContain("names no commit");
  });

  it("is a graph command of Fetch whose ref is the pinned base, never the head, unless the profile names one", () => {
    const sim = simulate({ scenarioName: "necessity-principles" });
    const job = jobsOf(sim, "Read the design principles file")[0]!;
    expect(job.stageId).toBe("fetch");
    expect(job.readOnly).toBe(true);
    const argv = (job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(argv.slice(4)).toEqual([REHEARSAL_MERGE_BASE, PRINCIPLES_PATH]);
    expect(argv.join(" ")).not.toContain(REHEARSAL_HEAD);
    const named = simulate({ scenarioName: "necessity-principles", config: { questions: { ...(BANYANDB.questions as object), principles: { path: PRINCIPLES_PATH, ref: "unmerged" } } } });
    expect((jobsOf(named, "Read the design principles file")[0]!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv.slice(4)).toEqual(["unmerged", PRINCIPLES_PATH]);
  });

  it("reads the recorded bytes back, and a profile without principles reads nothing", () => {
    const sim = simulate({ scenarioName: "necessity-principles" });
    const reading = principlesReading(sim.evidence, { path: PRINCIPLES_PATH }, REHEARSAL_MERGE_BASE);
    expect(reading).toMatchObject({ state: "read", read: { commit: REHEARSAL_MERGE_BASE, file: "present", text: PRINCIPLES_FILE } });
    expect(principlesReading(sim.evidence, { path: "other.md" }, REHEARSAL_MERGE_BASE)).toEqual({ state: "missing" });
    const plain = simulate({ scenarioName: "necessity-necessary", config: { questions: { excludeRoots: [] } } });
    expect(jobsOf(plain, "Read the design principles file")).toEqual([]);
    expect(plain.qa!.markdown).not.toContain("Principles:");
  });

  it("hands a failed read to the supervisor", () => {
    const s = scenarioWith("necessity-principles", (sc) => {
      sc.commands!["principles-read"] = { exitCode: 4, stderr: "the ref unmerged names no commit in this clone" };
    });
    const sim = simulate({ scenario: s });
    expect(sim.final.action.type).toBe("supervise");
    expect(JSON.stringify(sim.final.action)).toContain("reading the design principles file failed");
  });
});

const necessityOf = (sim: Simulation) => {
  const run = commandRuns(sim.evidence, "necessity-write").at(-1)!;
  return JSON.parse(writtenNecessity(run.command.argv)!) as { conclusion: string; conclusionNote?: string; decision: { action: string; reason: string }; principles?: { path: string; commit: string; file: string; changedByPullRequest: boolean; principles: Array<{ id: string; applicable: boolean }>; verdicts: Array<{ id: string; verdict: string }>; checks: Array<{ id: string; verdict: string }>; broken: string[] }; answer: { status: string } };
};
const qaOf = (sim: Simulation) => JSON.parse(sim.qa!.json) as { questions: Array<{ id: string; type: string }>; necessity: { conclusion: string; principlesBroken?: string[] } };
const stopped = (sim: Simulation) => sim.final.action.type === "stop";

describe("N1 judges each applicable principle (a run whose principles all hold)", () => {
  const sim = simulate({ scenarioName: "necessity-principles" });

  it("lists the applicable principles to the answerer and constrains the ids to them, in the answerer's contract and the checker's", () => {
    const answerer = jobsOf(sim, "Answer the necessity question")[0]!;
    const text = assignmentOf(answerer);
    expect(text).toContain("- small-steps: A change does one thing");
    expect(text).toContain("Why: mixed changes hide regressions. Source: docs/design/README.md");
    expect(text).toContain("- offline-idempotent: Offline sync must be safe to repeat");
    expect(text).not.toContain("proto-compatible");
    expect(text).toContain("preserves (the change keeps it), breaks (the change violates it) or not-applicable");
    expect(answerer.knownReferences!["principles[].id"]!.ids).toEqual(["small-steps", "offline-idempotent"]);
    const checker = jobsOf(sim, "Check the necessity answer against")[0]!;
    expect(assignmentOf(checker)).toContain("P principle offline-idempotent — preserves");
    expect(checker.knownReferences!["verdicts[].principles[].id"]!.ids).toEqual(["small-steps", "offline-idempotent"]);
  });

  it("records the verdicts, the file's path and commit, what applied and the checker's judgments in necessity.json", () => {
    const n = necessityOf(sim);
    expect(n.conclusion).toBe("necessary");
    expect(n.principles).toMatchObject({ path: PRINCIPLES_PATH, commit: REHEARSAL_MERGE_BASE, file: "present", changedByPullRequest: false, broken: [] });
    expect(n.principles!.principles.map((p) => [p.id, p.applicable])).toEqual([["small-steps", true], ["offline-idempotent", true], ["proto-compatible", false]]);
    expect(n.principles!.verdicts.map((v) => [v.id, v.verdict])).toEqual([["small-steps", "preserves"], ["offline-idempotent", "preserves"]]);
    expect(n.principles!.checks.map((c) => c.verdict)).toEqual(["supported", "supported"]);
    expect(stopped(sim)).toBe(true);
  });

  it("renders the Principles block in part 2 of the Necessity section of review.md", () => {
    const md = sim.qa!.markdown;
    const part2 = md.slice(md.indexOf("## 2. Does the fix fit"), md.indexOf("## 3. Is there a simpler"));
    expect(part2).toContain(`Principles: \`${PRINCIPLES_PATH}\` at \`${REHEARSAL_MERGE_BASE.slice(0, 12)}\``);
    expect(part2).toMatch(/- small-steps — preserves — The change keeps the principle small-steps\. — `pkg\/timestamp\/duration\.go:30-42` "func ParseDuration"; checker: supported/);
    expect(part2).toContain("- offline-idempotent — preserves —");
    expect(part2).toContain("Principles that did not apply: proto-compatible.");
    expect(part2).toContain("is not a principle id");
    expect(part2).not.toContain("This pull request changes");
  });
});

describe("the conclusion rule", () => {
  const breaks: PrincipleVerdict = { id: "p", verdict: "breaks", explanation: "x", citations: [] };
  const judged = (conclusion: Necessity["conclusion"], verdict: string, check: "supported" | "partial" | "unsupported" | undefined) => ({
    necessity: { conclusion, principles: [breaks] },
    check: { verdict, ...(check !== undefined ? { principles: [{ id: "p", verdict: check, note: "" }] } : {}) },
  });

  it("turns necessary into questionable when the checker supports a break, and leaves every other conclusion as it is", () => {
    expect(effectiveConclusion(judged("necessary", "supported", "supported"))).toBe("questionable");
    expect(effectiveConclusion(judged("questionable", "supported", "supported"))).toBe("questionable");
    expect(effectiveConclusion(judged("unnecessary", "supported", "supported"))).toBe("unnecessary");
    expect(effectiveConclusion(judged("needs author", "supported", "supported"))).toBe("needs author");
  });

  it("changes nothing for a break the checker does not support, or that was not a break", () => {
    expect(effectiveConclusion(judged("necessary", "supported", "unsupported"))).toBe("necessary");
    expect(effectiveConclusion(judged("necessary", "supported", "partial"))).toBe("necessary");
    expect(effectiveConclusion(judged("necessary", "supported", undefined))).toBe("necessary");
    const kept = { necessity: { conclusion: "necessary" as const, principles: [{ ...breaks, verdict: "preserves" as const }] }, check: { verdict: "supported", principles: [{ id: "p", verdict: "supported" as const, note: "" }] } };
    expect(effectiveConclusion(kept)).toBe("necessary");
    expect(supportedBreaks(kept)).toEqual([]);
  });

  it("never skips the other questions on a break, and names the principle in the decision", () => {
    const d = necessityDecision(judged("necessary", "supported", "supported"), false);
    expect(d.action).toBe("ask-all");
    expect(d.reason).toContain("N1 concluded questionable (design principle broken: p)");
    expect(necessityDecision(judged("unnecessary", "supported", "supported"), false).action).toBe("skip");
  });
});

describe("a supported break (the checker confirms offline-idempotent is broken)", () => {
  const sim = simulate({ scenarioName: "necessity-principle-broken" });

  it("makes N1 questionable, names the principle, and still asks every other question", () => {
    const n = necessityOf(sim);
    expect(n.conclusion).toBe("questionable");
    expect(n.conclusionNote).toBe("Design principle broken (the checker supports it): offline-idempotent.");
    expect(n.principles!.broken).toEqual(["offline-idempotent"]);
    expect(n.decision.action).toBe("ask-all");
    expect(n.decision.reason).toContain("offline-idempotent");
    expect(n.answer.status).toBe("partially answered");
    const qa = qaOf(sim);
    expect(qa.necessity).toMatchObject({ conclusion: "questionable", principlesBroken: ["offline-idempotent"] });
    expect(qa.questions.filter((q) => q.id !== "N1").length).toBeGreaterThan(0);
    expect(jobsOf(sim, "Answer the questions").length).toBeGreaterThan(0);
    expect(stopped(sim)).toBe(true);
  });

  it("says so in review.md's conclusion and the principle's line", () => {
    const md = sim.qa!.markdown;
    expect(md).toMatch(/Conclusion: \*\*questionable\*\*\..*Design principle broken \(the checker supports it\): offline-idempotent\./);
    expect(md).toContain("- offline-idempotent — breaks —");
    expect(md).toContain("the checker supports a broken design principle");
  });
});

describe("a break the checker does not support", () => {
  const sim = simulate({ scenarioName: "necessity-principle-unsupported" });

  it("is recorded with both statements and leaves the conclusion where it was", () => {
    const n = necessityOf(sim);
    expect(n.conclusion).toBe("necessary");
    expect(n.conclusionNote).toBeUndefined();
    expect(n.principles!.verdicts.find((v) => v.id === "offline-idempotent")!.verdict).toBe("breaks");
    expect(n.principles!.checks.find((c) => c.id === "offline-idempotent")!.verdict).toBe("unsupported");
    expect(n.principles!.broken).toEqual([]);
    expect(n.answer.status).toBe("answered");
    const md = sim.qa!.markdown;
    expect(md).toMatch(/- offline-idempotent — breaks — .*; checker: unsupported \(the checker's note on offline-idempotent\)/);
    expect(md).not.toContain("Design principle broken");
  });
});

describe("when the repository has no principles file, or the pull request changes it", () => {
  it("records the absence in review.md and necessity.json, and N1 proceeds as before", () => {
    const sim = simulate({ scenarioName: "necessity-necessary" });
    const n = necessityOf(sim);
    expect(n.principles).toMatchObject({ file: "absent", commit: REHEARSAL_MERGE_BASE, principles: [] });
    expect(n.conclusion).toBe("necessary");
    expect(sim.qa!.markdown).toContain(`Principles: no principles file at ${REHEARSAL_MERGE_BASE.slice(0, 12)}:${PRINCIPLES_PATH}.`);
    expect(jobsOf(sim, "Answer the necessity question").map(assignmentOf)[0]).toContain("No design principle applies to this change: leave principles empty.");
  });

  it("flags in review.md that the pull request changes the file and was judged by the version at the ref", () => {
    const sim = simulate({ scenarioName: "necessity-principles" });
    const rec = parseNecessityRecord(writtenNecessity(commandRuns(sim.evidence, "necessity-write").at(-1)!.command.argv)!)!;
    const flagged = renderNecessity({ ...rec, principles: { ...rec.principles!, ref: "unmerged", changedByPullRequest: true } });
    expect(flagged).toContain(`This pull request changes ${PRINCIPLES_PATH}; it was judged by the version at unmerged.`);
    const absent = renderNecessity({ ...rec, principles: { ...rec.principles!, file: "absent", principles: [], changedByPullRequest: true } });
    expect(absent).toContain(`Principles: no principles file at ${REHEARSAL_MERGE_BASE.slice(0, 12)}:${PRINCIPLES_PATH}.`);
    expect(absent).toContain(`This pull request changes ${PRINCIPLES_PATH}; it was judged by the version at ${REHEARSAL_MERGE_BASE.slice(0, 12)}.`);
  });
});

describe("the principle verdicts' deterministic rules", () => {
  const cite = { path: "pkg/a.go", tree: "head" as const, start: 1, end: 2, quote: "x" };
  const verdict = (over: Partial<PrincipleVerdict> = {}): PrincipleVerdict => ({ id: "a", verdict: "preserves", explanation: "keeps it", citations: [cite], ...over });
  const problems = (principles: PrincipleVerdict[], applicable: string[] = ["a", "b"]) => necessityProblems({ ...defaultNecessity("Parse retention durations"), principles }, [{ source: "title", text: "Parse retention durations" }], applicable.map((id) => ({ id })));

  it("passes when each applicable id is answered once", () => {
    expect(problems([verdict(), verdict({ id: "b", verdict: "not-applicable", citations: [] })])).toEqual([]);
    expect(problems([], [])).toEqual([]);
  });

  it("asks for a verdict for an applicable id left out, and refuses a repeated or unknown id", () => {
    expect(problems([verdict()]).join(" ")).toMatch(/principle b: no verdict/);
    expect(problems([verdict(), verdict(), verdict({ id: "b" })]).join(" ")).toMatch(/principle a: answered 2 times/);
    expect(problems([verdict(), verdict({ id: "b" }), verdict({ id: "zzz" })]).join(" ")).toMatch(/"zzz": not a principle that applies.*answer exactly: a, b/);
    expect(problems([verdict()], []).join(" ")).toMatch(/none applies: leave principles empty/);
  });

  it("needs a citation behind preserves and breaks, in a tree, within bounds", () => {
    expect(problems([verdict({ citations: [] }), verdict({ id: "b" })]).join(" ")).toMatch(/principle a: "preserves" cites the code/);
    expect(problems([verdict({ id: "a", verdict: "breaks", citations: [] }), verdict({ id: "b" })]).join(" ")).toMatch(/principle a: "breaks" cites the code/);
    expect(problems([verdict({ id: "a", verdict: "not-applicable", citations: [] }), verdict({ id: "b" })])).toEqual([]);
    expect(problems([verdict({ citations: [{ ...cite, path: "/abs" }] }), verdict({ id: "b" })]).join(" ")).toMatch(/a repository-relative path/);
    expect(problems([verdict({ explanation: " " }), verdict({ id: "b" })]).join(" ")).toMatch(/the explanation is empty/);
  });

  it("sends an answer that misses an applicable id back through the correction flow", () => {
    const good = scenarioWith("necessity-principles", () => undefined).results["necessity-v1"]![0]!.output as Necessity;
    const s = scenarioWith("necessity-principles", (sc) => {
      sc.results["necessity-v1"] = [{ output: { ...good, principles: [good.principles[0]] } }, { output: good }];
    });
    const sim = simulate({ scenario: s });
    const answerers = jobsOf(sim, "Answer the necessity question");
    expect(answerers.length).toBe(2);
    expect(assignmentOf(answerers[1]!)).toMatch(/N1 principle offline-idempotent: no verdict/);
    expect(necessityOf(sim).principles!.verdicts).toHaveLength(2);
  });
});
