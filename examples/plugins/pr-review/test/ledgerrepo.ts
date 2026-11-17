// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EnvironmentCommand, EvidenceRecord, RehearsalScenario } from "@graphloom/sdk";
import { ledgerReadCommand } from "../src/kit/commands.js";
import { LEDGER_JSON_FILE, LEDGER_MD_FILE, LEDGER_REVIEW_JSON_FILE, LEDGER_REVIEW_MD_FILE } from "../src/kit/constants.js";
import { ledgerWriteCommands, parseSectionRecord, priorState, writtenLedger, type Migration } from "../src/kit/ledger.js";
import { partCommands, readParts, recordedNecessityJson } from "../src/kit/parts.js";
import { ledgerPublishedCommand } from "../src/publish.js";
import type { PullRequest } from "../src/kit/request.js";
import { REHEARSAL_HEAD } from "../src/rehearsal.js";
import { reviewMarkdown, topLedgerJson } from "../src/kit/ledgerv2.js";
import type { Simulation } from "./support.js";

const sh = promisify(execFile);
export const LEDGER_REF = "refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger";
export const LEDGER_PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7 };
export const GIT_TEST_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** What a later head's Fetch reads of a ledger: the ref with its listing, and every registry part, by command id (the stubs of a scenario). */
export interface LedgerState {
  sha: string;
  reads: Record<string, string>;
  qa: string;
  necessity: string;
  design: { heads: Array<Record<string, unknown>>; qa: Array<Record<string, unknown>>; items: Array<Record<string, unknown>> };
  review: { heads: Array<Record<string, unknown>>; findings: Array<Record<string, unknown>> } | undefined;
}

/**
 * A review clone holding a pull request's ledger, which the Answers and Publish stages of simulated runs advance with their own
 * commands (the section write and `ledger-published`), every simulated head renamed to a label of the test's.
 */
export class LedgerRepo {
  dir = "";
  async init(dirs: string[], prefix = "pr-review-ledger-"): Promise<this> {
    this.dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(this.dir);
    await sh("git", ["init", "-q", "-b", "main", this.dir], { env: GIT_TEST_ENV });
    return this;
  }
  git = async (...args: string[]): Promise<string> => (await sh("git", args, { cwd: this.dir, env: GIT_TEST_ENV, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  exec = async (argv: readonly string[], extra: Record<string, string> = {}) => sh(argv[0]!, argv.slice(1), { cwd: this.dir, env: { ...GIT_TEST_ENV, ...extra }, maxBuffer: 64 * 1024 * 1024 });
  private async put(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(path.join(this.dir, file)), { recursive: true });
    await writeFile(path.join(this.dir, file), text);
  }

  /** Runs a command as the command executor does, with a report file, and returns what it wrote there (or printed). */
  async report(c: EnvironmentCommand): Promise<string> {
    const out = path.join(this.dir, ".git", "graphloom-report");
    await writeFile(out, "");
    const r = await this.exec(c.argv, { GRAPHLOOM_REPORT_FILE: out });
    const text = await readFile(out, "utf8");
    return text !== "" ? text : r.stdout;
  }

  /** What Fetch reads of the ledger as it is now: the ref, then its registry in parts, as `priorState` asks for them. */
  async reads(): Promise<{ sha: string; reads: Record<string, string>; evidence: EvidenceRecord[] }> {
    const read = ledgerReadCommand(LEDGER_PULL.owner, LEDGER_PULL.repo, LEDGER_PULL.number);
    const reads: Record<string, string> = { [read.id]: (await this.exec(read.argv)).stdout };
    const sha = await this.git("rev-parse", "--verify", "--quiet", LEDGER_REF).catch(() => "absent");
    let evidence: EvidenceRecord[] = [{ ref: "read", kind: "command", candidateDigest: "d", generation: 1, payload: { command: { id: read.id, argv: read.argv, exitCode: 0, stdoutTail: reads[read.id]!, stderrTail: "" } } } as EvidenceRecord];
    for (let state = priorState(evidence, sha), guard = 0; state.state === "missing" && guard < 40; state = priorState(evidence, sha), guard += 1) {
      for (const c of state.next) {
        const text = await this.report(c);
        reads[c.id] = text;
        evidence = [...evidence, { ref: `e${evidence.length}`, kind: "command", candidateDigest: "d", generation: 1, payload: { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: text, stderrTail: "" } } } as EvidenceRecord];
      }
    }
    return { sha, reads, evidence };
  }

  /** The ledger after a run, with its head renamed to `label`: its Answers write (from the value the run read), then Publish's. */
  async advance(sim: Simulation, label: string): Promise<LedgerState> {
    const rename = (s: string): string => s.split(REHEARSAL_HEAD).join(label);
    const job = sim.jobs.find((j) => j.instruction.startsWith("Advance the pull"))!;
    const written = writtenLedger((job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)!;
    const parts = (base: string, file: string): string => {
      const p = readParts(sim.evidence, base, file);
      if (p.state !== "read") throw new Error(`${file} was not written: ${p.state}`);
      return p.value;
    };
    const json = written.files !== undefined ? parts("ledger-json", LEDGER_JSON_FILE) : written.json;
    const markdown = written.files !== undefined ? parts("ledger-md", LEDGER_MD_FILE) : written.markdown;
    const migration: Migration =
      written.migration.mode === "-" ? { from: "none" } : { from: "v1", review: written.migration.mode === "v1+review" ? { json: parts("ledger-review-json", LEDGER_REVIEW_JSON_FILE), markdown: parts("ledger-review-md", LEDGER_REVIEW_MD_FILE) } : undefined };
    const necessity = recordedNecessityJson(sim.evidence);
    if (necessity.state !== "read") throw new Error("necessity.json was not recorded");
    // The worktree's files the write commits beside the section's ledger.json.
    await this.put(".graphloom/review/qa.json", rename(sim.qa!.json));
    await this.put(".graphloom/review/necessity.json", necessity.value);
    await this.put(".graphloom/review/report.json", "{}\n");
    const pr = { ...LEDGER_PULL, head: label, mode: "review" } as PullRequest;
    const w = ledgerWriteCommands(pr, written.old, written.baseline, rename(json), rename(markdown), migration);
    for (const c of w.parts) await this.exec(c.argv);
    const record = parseSectionRecord((await this.exec(w.write.argv)).stdout)!;
    const patch = readParts(sim.evidence, "publish-patch", ".graphloom/review/ledger/publish-patch.json");
    if (patch.state === "read") {
      const text = rename(patch.value);
      for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", text)) await this.exec(part.argv);
      await this.exec(ledgerPublishedCommand(pr, JSON.parse(text), { design: record.sections.design!, review: record.sections.review ?? "absent" }, process.execPath).argv);
    }
    const { sha, reads } = await this.reads();
    const show = async (p: string): Promise<string> => this.git("show", `${sha}:${p}`);
    const hasReview = (await this.git("ls-tree", "--name-only", sha)).split("\n").includes("review");
    return { sha, reads, qa: await show("design/qa.json"), necessity: await show("design/necessity.json"), design: JSON.parse(await show("design/ledger.json")), review: hasReview ? JSON.parse(await show("review/ledger.json")) : undefined };
  }
}

/**
 * Points the ledger ref of the repository at `dir` at a commit of a v2 ledger holding `sections` (each a section's ledger.json; the
 * design section gets the files beside it), as the Answers stage's write leaves it.
 */
export async function v2Ledger(dir: string, sections: { design?: unknown; review?: unknown }): Promise<string> {
  const files: Record<string, string> = { "ledger.json": topLedgerJson(LEDGER_PULL) };
  if (sections.design !== undefined) Object.assign(files, { "design/ledger.json": JSON.stringify(sections.design), "design/ledger.md": "# design\n", "design/qa.json": "{}\n", "design/report.json": "{}\n" });
  if (sections.review !== undefined) Object.assign(files, { "review/ledger.json": JSON.stringify(sections.review), "review/ledger.md": reviewMarkdown(LEDGER_PULL) });
  return commitLedger(dir, files, "a v2 ledger");
}

/**
 * Advances the ledger ref of the repository at `dir` (from where it is, or creates it) to a commit whose tree is `files` (paths one
 * directory deep at most), as another run's write would.
 */
export async function commitLedger(dir: string, files: Record<string, string>, message = "another run"): Promise<string> {
  const git = async (...args: string[]): Promise<string> => (await sh("git", args, { cwd: dir, env: GIT_TEST_ENV })).stdout.trim();
  const lines: string[] = [];
  const trees = new Map<string, string[]>();
  for (const [name, text] of Object.entries(files)) {
    const out = path.join(dir, ".git", "graphloom-blob");
    await writeFile(out, text);
    const id = await git("hash-object", "-w", out);
    const [top, rest] = name.includes("/") ? [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)] : [undefined, name];
    if (top === undefined) lines.push(`100644 blob ${id}\t${rest}`);
    else trees.set(top, [...(trees.get(top) ?? []), `100644 blob ${id}\t${rest}`]);
  }
  const mktree = async (entries: string[]): Promise<string> => {
    const out = path.join(dir, ".git", "graphloom-tree");
    await writeFile(out, `${entries.join("\n")}\n`);
    return (await sh("sh", ["-c", 'git mktree < "$1"', "mktree", out], { cwd: dir, env: GIT_TEST_ENV })).stdout.trim();
  };
  for (const [name, entries] of trees) lines.push(`040000 tree ${await mktree(entries)}\t${name}`);
  const tree = await mktree(lines);
  const parent = await git("rev-parse", "--verify", "--quiet", LEDGER_REF).catch(() => "");
  const commit = await git("commit-tree", tree, ...(parent !== "" ? ["-p", parent] : []), "-m", message);
  await git("update-ref", LEDGER_REF, commit);
  return commit;
}

/** The files of the ledger ref's tree now, by path, so a test can change a few and commit the rest as they are. */
export async function ledgerFiles(dir: string): Promise<Record<string, string>> {
  const git = async (...args: string[]): Promise<string> => (await sh("git", args, { cwd: dir, env: GIT_TEST_ENV, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const out: Record<string, string> = {};
  for (const p of (await git("ls-tree", "-r", "--name-only", LEDGER_REF)).split("\n").filter(Boolean)) out[p] = await git("cat-file", "blob", `${LEDGER_REF}:${p}`);
  return out;
}

/** The sections' subtrees the ledger ref holds now: what a run that read it now swaps from. */
export async function baselinesNow(dir: string): Promise<{ design: string; review: string }> {
  const at = async (s: string): Promise<string> => (await sh("git", ["rev-parse", "--verify", "--quiet", `${LEDGER_REF}:${s}`], { cwd: dir, env: GIT_TEST_ENV }).catch(() => ({ stdout: "absent" }))).stdout.trim();
  return { design: await at("design"), review: await at("review") };
}

/** A scenario reading the ledger `at` holds, as Fetch reads it: the ref and its registry parts. */
export function withLedger(s: RehearsalScenario, at: Pick<LedgerState, "reads">): RehearsalScenario {
  for (const [id, stdout] of Object.entries(at.reads)) s.commands![id] = { exitCode: 0, stdout };
  return s;
}
