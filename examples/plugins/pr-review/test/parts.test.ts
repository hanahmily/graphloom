// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { GIT_ENV } from "../src/commands.js";
import { LEDGER_MOVED, ledgerRef, PART_BASE, REPORT_JSON, REVIEW_MD } from "../src/constants.js";
import { ledgerWriteCommand, ledgerWriteCommands, writtenLedger } from "../src/ledger.js";
import { htmlWriteCommands, MAX_PART_CHUNKS, partCommands, readParts, recordedHtml, recordedReport, reportWriteCommands, sha256, splitParts } from "../src/parts.js";
import { htmlProblems } from "../src/html.js";
import { validatorById } from "../src/validators.js";
import { BANYANDB, candidateEvidence, simulate } from "./support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gl-pr-${prefix}-`));
  dirs.push(dir);
  return dir;
};

const bytes = (c: EnvironmentCommand): number => Buffer.byteLength(JSON.stringify({ commands: [c] }), "utf8");

/** A recorded command run, as the controller stores one. */
const record = (n: number, c: EnvironmentCommand, exitCode = 0): EvidenceRecord => ({
  ref: `e${n}`,
  kind: "command",
  candidateDigest: "d0",
  payload: { producer: { operationId: `op${n}`, stageId: "report", purpose: "diagnostic", readOnly: true, kind: "command" }, command: { id: c.id, argv: c.argv, exitCode, stdoutTail: "written\n", stderrTail: "" } },
});
const recorded = (commands: readonly EnvironmentCommand[]): EvidenceRecord[] => commands.map((c, i) => record(i + 1, c));

/** Runs a command in `cwd`, as the command executor would. */
const run = (cwd: string, c: EnvironmentCommand): { code: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** Text with what a shell would mangle: quotes, `$(...)`, backticks, percent signs, newlines, a surrogate pair at a chunk boundary, and non-ASCII. */
const awkward = (n: number): string => {
  const unit = "line 'one' \"two\" $(not run) `either` 100% ünïcode ✓ 😀\n";
  let text = "";
  while (text.length < n) text += unit;
  return text.slice(0, n);
};

describe("multi-part writes (design 6.6)", () => {
  it("splits an artifact of more than 600 KB into at least three parts, each within the command bounds", () => {
    const text = `${"x".repeat(599_999)}\nend`;
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(600_000);
    const commands = partCommands("report-json", REPORT_JSON, text);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const c of commands) {
      expect(c.argv.length).toBeLessThanOrEqual(64);
      expect(c.argv.every((a) => a.length <= 4_096)).toBe(true);
      expect(bytes(c)).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    }
    expect(commands.map((c) => c.id)).toEqual(commands.map((_, i) => `report-json-p${i + 1}`));
    // The parts joined are the artifact, and the chunk count matches what each part declares.
    expect(commands.map((c) => c.argv.slice(9).join("")).join("")).toBe(text);
    expect(commands.every((c) => Number(c.argv[8]) === c.argv.length - 9 && c.argv[7] === sha256(text) && c.argv[6] === String(commands.length))).toBe(true);
  });

  it("a small artifact is one part; an empty one too", () => {
    expect(partCommands("b", REPORT_JSON, "hello")).toHaveLength(1);
    expect(partCommands("b", REPORT_JSON, "")).toHaveLength(1);
    expect(splitParts("")).toEqual([[]]);
  });

  it("splits by what the executor accepts once escaped: text made of escapes yields more parts, each within the input bound", () => {
    const text = "\u0001".repeat(120_000);
    const commands = partCommands("b", REPORT_JSON, text);
    expect(commands.length).toBeGreaterThan(Math.ceil(120_000 / (MAX_PART_CHUNKS * 4_000)));
    expect(commands.every((c) => bytes(c) <= MAX_EXECUTOR_INPUT_BYTES)).toBe(true);
    expect(commands.map((c) => c.argv.slice(9).join("")).join("")).toBe(text);
  });

  it("writes the bytes it was given when its commands run, in order: nothing is in place until the last part, and no temporary file is left", () => {
    const dir = tmp("parts");
    const text = awkward(650_000);
    const commands = partCommands("report-json", REPORT_JSON, text);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    commands.forEach((c, i) => {
      const r = run(dir, c);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("written");
      expect(existsSync(path.join(dir, REPORT_JSON))).toBe(i === commands.length - 1);
    });
    expect(readFileSync(path.join(dir, REPORT_JSON), "utf8")).toBe(text);
    expect(existsSync(path.join(dir, `${REPORT_JSON}.parts`))).toBe(false);
    expect(readFileSync(path.join(dir, ".graphloom/review/.gitignore"), "utf8")).toBe("*\n");
  });

  it("an earlier artifact stays in place while a new one is being written, and is replaced only by the last part", () => {
    const dir = tmp("replace");
    const first = partCommands("a", REPORT_JSON, awkward(500_000));
    for (const c of first) expect(run(dir, c).code).toBe(0);
    const old = readFileSync(path.join(dir, REPORT_JSON), "utf8");
    const second = partCommands("a", REPORT_JSON, `${awkward(500_000)}changed`);
    for (const c of second.slice(0, -1)) expect(run(dir, c).code).toBe(0);
    expect(readFileSync(path.join(dir, REPORT_JSON), "utf8")).toBe(old);
    expect(run(dir, second.at(-1)!).code).toBe(0);
    expect(readFileSync(path.join(dir, REPORT_JSON), "utf8")).toBe(`${awkward(500_000)}changed`);
  });

  it("refuses a part that arrives before the first, and a last part whose assembled file does not hash to the digest", () => {
    const dir = tmp("order");
    const commands = partCommands("a", REPORT_JSON, awkward(500_000));
    const early = run(dir, commands[1]!);
    expect(early.code).toBe(3);
    expect(existsSync(path.join(dir, REPORT_JSON))).toBe(false);
    const dir2 = tmp("digest");
    const altered = commands.map((c, i) => (i === 1 ? { ...c, argv: c.argv.map((a, k) => (k === 10 ? `${a}X` : a)) } : c));
    altered.slice(0, -1).forEach((c) => run(dir2, c));
    const last = run(dir2, altered.at(-1)!);
    if (spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0) {
      expect(last.code).toBe(5);
      expect(last.stderr).toContain("digest mismatch");
      expect(existsSync(path.join(dir2, REPORT_JSON))).toBe(false);
    }
  });

  it("round-trips the recorded parts: the validator's reader concatenates them in order and checks the digest", () => {
    const text = awkward(700_000);
    const commands = partCommands("report-json", REPORT_JSON, text);
    const got = readParts(recorded(commands), "report-json", REPORT_JSON);
    expect(got).toMatchObject({ state: "read", value: text });
    expect(readParts([], "report-json", REPORT_JSON)).toEqual({ state: "none" });
  });

  it("detects a missing part, a reordered part, an altered part, a part of another file, parts of two artifacts, and a failed part", () => {
    const text = awkward(700_000);
    const commands = partCommands("report-json", REPORT_JSON, text);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    const all = recorded(commands);
    // Missing: part 2 was never written.
    const missing = readParts(all.filter((_, i) => i !== 1), "report-json", REPORT_JSON);
    expect(missing).toMatchObject({ state: "failed" });
    expect((missing as { reason: string }).reason).toMatch(new RegExp(`part 2 of ${commands.length}.*never written`));
    // Reordered: part 3 was written before part 2.
    const swapped = [all[0]!, all[2]!, all[1]!].map((e, i) => ({ ...e, ref: `s${i}` }));
    const reordered = readParts(swapped, "report-json", REPORT_JSON);
    expect(reordered).toMatchObject({ state: "failed" });
    expect((reordered as { reason: string }).reason).toMatch(/out of order/);
    // Altered: a chunk of part 2 differs from what was hashed.
    const tamper = (n: number, change: (argv: string[]) => string[]): EvidenceRecord[] => commands.map((c, i) => record(i + 1, i === n ? { ...c, argv: change([...c.argv]) } : c));
    const altered = readParts(tamper(1, (a) => a.map((x, k) => (k === 10 ? `${x}!` : x))), "report-json", REPORT_JSON);
    expect(altered).toMatchObject({ state: "failed" });
    expect((altered as { reason: string }).reason).toMatch(/do not hash to their digest/);
    // A part that names another file, another position, or declares a chunk count it does not carry.
    expect((readParts(tamper(1, (a) => a.map((x, k) => (k === 4 ? "other.json" : x))), "report-json", REPORT_JSON) as { reason: string }).reason).toMatch(new RegExp(`is not part 2 of ${commands.length}`));
    expect((readParts(tamper(1, (a) => a.map((x, k) => (k === 5 ? "3" : x))), "report-json", REPORT_JSON) as { reason: string }).reason).toMatch(new RegExp(`is not part 2 of ${commands.length}`));
    expect((readParts(tamper(1, (a) => a.slice(0, -1)), "report-json", REPORT_JSON) as { reason: string }).reason).toMatch(/declares/);
    // Parts of two artifacts: a part that carries another digest.
    const other = partCommands("report-json", REPORT_JSON, `${text}more`);
    const mixed = [record(1, commands[0]!), record(2, other[1]!), record(3, commands[2]!)];
    expect((readParts(mixed, "report-json", REPORT_JSON) as { reason: string }).reason).toMatch(/another digest/);
    // A part whose command failed.
    const failed = commands.map((c, i) => record(i + 1, c, i === 2 ? 1 : 0));
    expect((readParts(failed, "report-json", REPORT_JSON) as { reason: string }).reason).toMatch(/did not succeed/);
  });

  it("reads the later of a single command and a part set, so an artifact that grew is read from its parts", () => {
    const small = reportWriteCommands(JSON.stringify({ a: 1 }), "# small");
    expect(small).toHaveLength(1);
    expect(small[0]!.id).toBe("report-write");
    const big = reportWriteCommands(JSON.stringify({ pad: "j".repeat(300_000) }), `# big\n${"m".repeat(300_000)}`);
    expect(big.map((c) => c.id)).toEqual(expect.arrayContaining([`${PART_BASE.reportJson}-p1`, `${PART_BASE.reviewMd}-p1`]));
    expect(big.length).toBeGreaterThanOrEqual(4);
    const evidence = [...recorded(small), ...big.map((c, i) => record(100 + i, c))];
    expect(recordedReport(recorded(small))).toMatchObject({ state: "read", value: { json: JSON.stringify({ a: 1 }), markdown: "# small" } });
    const got = recordedReport(evidence);
    expect(got).toMatchObject({ state: "read" });
    expect((got as { value: { json: string } }).value.json).toBe(JSON.stringify({ pad: "j".repeat(300_000) }));
    // A markdown part missing leaves the report unread, not half read.
    expect(recordedReport(evidence.filter((e) => (e.payload as { command: { id: string } }).command.id !== `${PART_BASE.reviewMd}-p2`))).toMatchObject({ state: "failed" });
    const html = htmlWriteCommands("<p>hi</p>", false);
    expect(recordedHtml(html.map((c, i) => record(i + 1, c)), false)).toMatchObject({ state: "read", value: "<p>hi</p>" });
    expect(recordedHtml(html.map((c, i) => record(i + 1, c)), true)).toEqual({ state: "none" });
  });
});

describe("a ledger too large for one command", () => {
  const pr = { mode: "report" as const, owner: "apache", repo: "skywalking-banyandb", number: 7, head: "a".repeat(40) };
  const ref = ledgerRef(pr.owner, pr.repo, pr.number);
  const git = (cwd: string, args: string[]): string => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const setup = (): string => {
    const dir = tmp("ledger");
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(dir, "x.txt"), "x\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    mkdirSync(path.join(dir, ".graphloom/review"), { recursive: true });
    writeFileSync(path.join(dir, ".graphloom/review/qa.json"), '{"qa":1}');
    writeFileSync(path.join(dir, ".graphloom/review/report.json"), '{"report":1}');
    return dir;
  };

  it("is written as part sets that the one ledger command reads; a small ledger stays one command with no parts", () => {
    const small = ledgerWriteCommands(pr, "absent", JSON.stringify({ tag: "s" }), "# s\n");
    expect(small.parts).toEqual([]);
    expect(small.write).toEqual(ledgerWriteCommand(pr, "absent", JSON.stringify({ tag: "s" }), "# s\n"));
    const json = JSON.stringify({ schema: "graphloom-pr-ledger-v1", pad: awkward(450_000) });
    const markdown = `# ledger\n${awkward(300_000)}`;
    expect(ledgerWriteCommand(pr, "absent", json, markdown)).toBeUndefined();
    const big = ledgerWriteCommands(pr, "absent", json, markdown);
    expect(big.parts.length).toBeGreaterThanOrEqual(4);
    const dir = setup();
    for (const c of big.parts) expect(run(dir, c).code).toBe(0);
    const r = run(dir, big.write);
    expect(r.code, r.stderr).toBe(0);
    const sha = git(dir, ["rev-parse", ref]);
    expect(git(dir, ["ls-tree", "--name-only", sha]).split("\n")).toEqual(["ledger.json", "ledger.md", "qa.json", "report.json"]);
    expect(spawnSync("git", ["show", `${sha}:ledger.json`], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout).toBe(json);
    expect(spawnSync("git", ["show", `${sha}:ledger.md`], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout).toBe(markdown);
    expect(writtenLedger(big.write.argv)).toMatchObject({ ref, old: "absent", files: { json: sha256(json), markdown: sha256(markdown) } });
    // The compare-and-swap still loses a race: the ref has moved.
    const again = run(dir, ledgerWriteCommands(pr, "absent", json, markdown).write);
    expect(again.code).toBe(LEDGER_MOVED);
  });
});

describe("a large pull request whose artifacts pass one write command", () => {
  const sim = simulate({ scenarioName: "large-artifacts", maxSteps: 400, budgets: { agentInvocations: 400, jobs: 400, decisions: 400 } });
  const ids = (prefix: string): string[] => sim.jobs.flatMap((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.map((c) => c.id) ?? []).filter((id) => id.startsWith(prefix));

  it("completes: report.json and review.html are written in parts, no write fails for size, and every requirement is met", () => {
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
    expect(ids("report-json-p").length).toBeGreaterThanOrEqual(2);
    expect(ids("review-html-p").length).toBeGreaterThanOrEqual(2);
    expect(ids("report-write")).toEqual([]);
    expect(sim.jobs.some((j) => j.instruction.startsWith("Write part 2 of"))).toBe(true);
  });

  const verdictOf = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
  const commandOf = (e: EvidenceRecord): { id: string; argv: string[] } | undefined => (e.payload as { command?: { id: string; argv: string[] } }).command;
  const withCommand = (id: string, change: (argv: string[]) => string[]): EvidenceRecord[] =>
    sim.evidence.map((e) => (commandOf(e)?.id === id ? { ...e, payload: { ...(e.payload as object), command: { ...commandOf(e)!, argv: change([...commandOf(e)!.argv]) } } } : e));

  it("the validators read the report from its parts: passed as written, failed for a part altered, missing or out of order", () => {
    expect(verdictOf("change-report", sim.evidence)).toMatchObject({ status: "passed" });
    const altered = verdictOf("change-report", withCommand("report-json-p2", (a) => a.map((x, k) => (k === 10 ? `${x}!` : x))));
    expect(altered).toMatchObject({ status: "failed" });
    expect((altered as { reason: string }).reason).toMatch(/do not hash to their digest/);
    const without = sim.evidence.filter((e) => commandOf(e)?.id !== "report-json-p2");
    expect(verdictOf("change-report", without)).toMatchObject({ status: "failed", reason: expect.stringMatching(/part 2 of \d+ of .*never written/) });
    const first = sim.evidence.findIndex((e) => commandOf(e)?.id === "report-json-p1");
    const second = sim.evidence.findIndex((e) => commandOf(e)?.id === "report-json-p2");
    const swapped = [...sim.evidence];
    [swapped[first], swapped[second]] = [swapped[second]!, swapped[first]!];
    expect(verdictOf("change-report", swapped)).toMatchObject({ status: "failed", reason: expect.stringMatching(/out of order/) });
    // review.html is part of the requirement: an altered part of it fails too, and so does markup that is not inert.
    expect(verdictOf("change-report", withCommand("review-html-p1", (a) => a.map((x, k) => (k === 10 ? `${x}!` : x))))).toMatchObject({ status: "failed", reason: expect.stringMatching(/review\.html was not written whole/) });
  });

  it("rejects a review.html whose written bytes carry a script, even when they are what a part set declares", () => {
    const evil = "<!doctype html><html><body><script>alert(1)</script></body></html>";
    const forged = htmlWriteCommands(evil, false);
    const injected = [...sim.evidence, ...forged.map((c, i) => ({ ...record(9_000 + i, c), candidateDigest: "d1" }))];
    expect(verdictOf("change-report", injected)).toMatchObject({ status: "failed", reason: expect.stringMatching(/review\.html is not the report the evidence recomputes/) });
    // Even the bytes the renderer would write, if they carried a script, fail the check on the written bytes.
    expect(htmlProblems(evil, { owner: "apache", repo: "skywalking-banyandb", head: "a".repeat(40) }).join()).toContain("<script");
  });

  it("the parts the evidence holds reconstruct to the report the graph recomputed", () => {
    const report = recordedReport(sim.evidence);
    expect(report.state).toBe("read");
    const json = (report as { value: { json: string } }).value.json;
    expect(json.length).toBeGreaterThan(236_000);
    expect(JSON.parse(json)).toMatchObject({ schema: "pr-change-report-v1", mode: "large" });
    const html = recordedHtml(sim.evidence, false);
    expect(html.state).toBe("read");
    expect((html as { value: string }).value.length).toBeGreaterThan(236_000);
    const md = (report as { value: { markdown: string } }).value.markdown;
    expect(md).toContain("# Report");
    void REVIEW_MD;
  });
});
