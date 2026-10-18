import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertBoundedJson, MAX_EXECUTOR_INPUT_BYTES, type EvidenceRecord } from "@graphloom/sdk";
import {
  applyFixerRead,
  createIssue,
  deliverCommands,
  emptyIssueTable,
  findingIdOf,
  findingLedger,
  issueFileJson,
  issueIdOf,
  issueMarkdown,
  issueTableRows,
  MAX_READ_BYTES,
  moveIssue,
  readIssuesCommand,
  severityOf,
  writeIssuesCommand,
  writtenIssues,
  writtenJson,
  type IssueTable,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const HANG = { path: "pkg/timestamp/scheduler.go", start_line: 88, end_line: 95, category: "bug", severity: "high", content: "Close now waits forever for an action that ignores cancellation." };
const LEAK = { ...HANG, start_line: 120, end_line: 121, severity: "critical", content: "trigger leaks the timer. It never stops." };
const ctx = (ref: string, round = 1) => ({ round, digest: "d1", ref });

/** I1 open, I2 reopened, I3 done, as the graph last wrote them. */
function table(): IssueTable {
  const t = emptyIssueTable();
  createIssue(t, { id: "F1", comment: HANG }, { status: "open", actor: "verifier", note: "confirmed", raisedIn: 1, ctx: ctx("ev-1") });
  const i2 = createIssue(t, { id: "F2", comment: LEAK }, { status: "open", actor: "verifier", note: "confirmed", raisedIn: 1, ctx: ctx("ev-1") });
  moveIssue(i2, "fixer", "fixed", "stopped the timer", ctx("ev-2", 2));
  moveIssue(i2, "reviewer", "reopened", "still leaks on error", ctx("ev-3", 2));
  const i3 = createIssue(t, { id: "F3", comment: { ...HANG, start_line: 7, end_line: 7, content: "Off by one." } }, { status: "open", actor: "verifier", note: "confirmed", raisedIn: 1, ctx: ctx("ev-1") });
  moveIssue(i3, "fixer", "fixed", "fixed the bound", ctx("ev-2", 2));
  moveIssue(i3, "reviewer", "done", "bound is right", ctx("ev-3", 2));
  t.written = writtenIssues(issueFileJson(t))!;
  return t;
}

type Edit = (f: { issues: Array<Record<string, unknown> & { id: string; history: unknown[] }> }) => void;
function fixerRead(t: IssueTable, edit: Edit): IssueTable {
  const file = JSON.parse(issueFileJson(t)) as Parameters<Edit>[0];
  edit(file);
  applyFixerRead(t, { present: true, text: JSON.stringify(file) }, ctx("ev-read", 3));
  return t;
}
const status = (t: IssueTable) => t.issues.map((i) => `${i.id}:${i.status}`).join(" ");
const markFixed = (id: string, note = "changed x.go:1"): Edit => (f) => {
  const i = f.issues.find((x) => x.id === id)!;
  i.history.push({ actor: "fixer", from: i.status, to: "fixed", note });
  i.status = "fixed";
};

describe("issues table", () => {
  it("names issues after their findings and maps severities to P0-P3", () => {
    expect([issueIdOf("F12"), findingIdOf("I12"), findingIdOf("F3"), findingIdOf(" i4 ")]).toEqual(["I12", "F12", "F3", "F4"]);
    expect(["critical", "high", "medium", "low", undefined].map((severity) => severityOf(severity === undefined ? {} : { severity }))).toEqual(["P0", "P1", "P2", "P3", "P1"]);
    const t = table();
    expect(t.issues[1]).toMatchObject({ id: "I2", severity: "P0", title: "trigger leaks the timer.", location: { path: "pkg/timestamp/scheduler.go", startLine: 120, endLine: 121 }, round: 1 });
    expect(issueTableRows(t.issues)[2]).toBe("| I1 | P1 (high) | open | `pkg/timestamp/scheduler.go:88-95` | Close now waits forever for an action that ignores cancellation. | verifier: confirmed |");
    expect(issueMarkdown(t)).toContain("- round 2, reviewer: fixed → reopened (ev-3, candidate d1): still leaks on error");
  });

  it("cuts a table too large to read back to short notes, so a read of the file is never truncated", () => {
    const t = emptyIssueTable();
    for (let n = 1; n <= 40; n += 1) {
      const i = createIssue(t, { id: `F${n}`, comment: { ...HANG, content: "x".repeat(3_000), evidence: "y".repeat(3_000) } }, { status: "open", actor: "verifier", note: "z".repeat(3_000), raisedIn: 1, ctx: ctx("ev-1") });
      for (let k = 0; k < 4; k += 1) moveIssue(i, k % 2 === 0 ? "fixer" : "reviewer", k % 2 === 0 ? "fixed" : "reopened", "w".repeat(3_000), ctx("ev-2"));
    }
    const json = issueFileJson(t);
    expect(Buffer.byteLength(json)).toBeLessThan(MAX_READ_BYTES);
    expect((JSON.parse(json) as { issues: unknown[] }).issues).toHaveLength(40);
    expect(t.issues[0]!.history[1]!.note.length).toBeGreaterThan(200);
  });

  it("accepts the fixer moving an open or a reopened issue to fixed with a note", () => {
    const t = fixerRead(table(), (f) => {
      markFixed("I1", "bounded Close (scheduler.go:5)")(f);
      markFixed("I2", "stop the timer on error too")(f);
    });
    expect(status(t)).toBe("I1:fixed I2:fixed I3:done");
    expect(t.rejections).toEqual([]);
    expect(t.issues[0]!.history.at(-1)).toEqual({ actor: "fixer", from: "open", to: "fixed", note: "bounded Close (scheduler.go:5)", round: 3, candidate: "d1", evidence: "ev-read" });
    expect(t.issues[1]!.history.at(-1)).toMatchObject({ from: "reopened", to: "fixed" });
  });

  const illegal: Array<[string, Edit, RegExp]> = [
    ["marking an issue done", (f) => void (f.issues[0]!.status = "done"), /the fixer moved I1 from open to done: only the code reviewer marks an issue done/],
    ["dismissing an issue", (f) => void (f.issues[0]!.status = "dismissed"), /from open to dismissed: only the verifier dismisses an issue/],
    ["reopening a done issue", (f) => void (f.issues[2]!.status = "open"), /from done to open: the fixer may only move an open or reopened issue to fixed/],
    ["skipping to done from reopened", (f) => void (f.issues[1]!.status = "done"), /from reopened to done/],
    ["marking fixed without a note", (f) => void (f.issues[0]!.status = "fixed"), /marked I1 fixed without a history entry/],
    ["deleting an issue", (f) => void f.issues.splice(0, 1), /the fixer deleted I1/],
    ["rewording an issue", (f) => Object.assign(f.issues[0]!, { title: "Not a bug", severity: "P3" }), /changed I1's severity, title; only the graph sets them/],
    ["moving an issue's location", (f) => void ((f.issues[0]!.location as { startLine: number }).startLine = 1), /changed I1's location/],
    ["adding an issue", (f) => void f.issues.push({ id: "I9", history: [], status: "open" }), /the fixer added I9; only the code reviewer raises issues/],
  ];
  for (const [what, edit, why] of illegal) {
    it(`rejects the fixer ${what} and keeps the accepted table`, () => {
      const before = issueFileJson(table());
      const t = fixerRead(table(), edit);
      expect(t.rejections.map((r) => r.note).join("; ")).toMatch(why);
      // The table, and so the file the graph writes back, is unchanged apart from the rejection on record.
      const strip = (json: string) => JSON.stringify((JSON.parse(json) as { issues: Array<{ id: string; status: string }> }).issues.map((i) => [i.id, i.status]));
      expect(strip(issueFileJson(t))).toBe(strip(before));
    });
  }

  it("keeps a legal move while rejecting a reword of the same issue", () => {
    const t = fixerRead(table(), (f) => {
      markFixed("I1")(f);
      f.issues[0]!.description = "rewritten";
    });
    expect(status(t)).toBe("I1:fixed I2:reopened I3:done");
    expect(t.rejections.map((r) => r.note)).toEqual(["the fixer changed I1's description; only the graph sets them"]);
  });

  it("restores a file that was deleted, cut short or is not JSON, and ignores a read before the graph ever wrote one", () => {
    for (const [read, why] of [
      [{ present: false }, /was deleted/],
      [{ present: true, text: "{", truncated: false }, /could not be read: it is not valid JSON/],
      [{ present: true, text: "{}", truncated: true }, /larger than the graph reads back/],
      [{ present: true, text: '{"issues": {}}' }, /it has no issues array/],
    ] as const) {
      const t = table();
      applyFixerRead(t, read, ctx("ev-read"));
      expect(t.rejections.map((r) => r.note).join(), JSON.stringify(read)).toMatch(why);
      expect(status(t)).toBe("I1:open I2:reopened I3:done");
    }
    const never = table();
    delete never.written;
    applyFixerRead(never, { present: true, text: "garbage" }, ctx("ev-read"));
    expect(never.rejections).toEqual([]);
  });
});

describe("the issues file in a Git worktree", () => {
  const git = (cwd: string, ...args: string[]) => execFileAsync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
  const run = async (cwd: string, argv: string[]) => {
    const report = path.join(cwd, "..", `report-${Math.random().toString(36).slice(2)}`);
    const out = await execFileAsync(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, GRAPHLOOM_REPORT_FILE: report, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
    return { stdout: out.stdout, report: existsSync(report) ? await readFile(report, "utf8") : undefined };
  };
  /** A repository that does not ignore .graphloom/, with one change in the worktree. */
  async function repo(): Promise<{ root: string; dir: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "issue-fix-issues-"));
    const dir = path.join(root, "repo");
    await execFileAsync("git", ["init", "-q", dir]);
    await writeFile(path.join(dir, "a.go"), "package a\n");
    await git(dir, "add", "a.go");
    await git(dir, "commit", "-qm", "base");
    await writeFile(path.join(dir, "a.go"), "package a\n\nfunc A() {}\n");
    return { root, dir };
  }
  // What the controller's candidate digest and scope checks see: git diff against the base, and untracked files Git does not ignore.
  const visible = async (dir: string) => [
    ...(await git(dir, "status", "--porcelain", "-uall")).stdout.split("\n").filter(Boolean),
    ...(await git(dir, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean),
  ];

  it("writes and reads back the file without Git seeing it, in a repository that does not ignore .graphloom", async () => {
    const { root, dir } = await repo();
    try {
      const t = table();
      const json = issueFileJson(t, { round: 2, phase: "discovery" });
      const before = await visible(dir);
      const write = writeIssuesCommand(json, issueMarkdown(t))!;
      expect(writtenJson(write.argv)).toBe(json);
      expect((await run(dir, write.argv)).stdout).toBe("written\n");
      expect(await readFile(path.join(dir, ".graphloom/issues.json"), "utf8")).toBe(json);
      expect(await readFile(path.join(dir, ".graphloom/issues.md"), "utf8")).toContain("# Review issues");
      expect(await visible(dir)).toEqual(before);
      const read = await run(dir, readIssuesCommand().argv);
      expect(read).toEqual({ stdout: "present\n", report: json });
      await rm(path.join(dir, ".graphloom"), { recursive: true });
      expect(await run(dir, readIssuesCommand().argv)).toEqual({ stdout: "missing\n", report: undefined });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds the write command by the executor's input bytes, cutting the markdown, never the JSON, with multi-byte notes", async () => {
    // 40 issues, four updates each, with Chinese notes and an emoji: a small JSON, but markdown with every note in full.
    const t = emptyIssueTable();
    const note = `关闭时等待没有超时，调度器会一直阻塞 🚧 ${"在动作忽略取消时永远等待。".repeat(40)}`;
    for (let n = 1; n <= 40; n += 1) {
      const i = createIssue(t, { id: `F${n}`, comment: { ...HANG, content: `第${n}个问题：${note}` } }, { status: "open", actor: "verifier", note, raisedIn: 1, ctx: ctx("ev-1") });
      for (let k = 0; k < 4; k += 1) moveIssue(i, k % 2 === 0 ? "fixer" : "reviewer", k % 2 === 0 ? "fixed" : "reopened", note, ctx("ev-2"));
    }
    const json = issueFileJson(t);
    const markdown = issueMarkdown(t);
    expect(Buffer.byteLength(markdown)).toBeGreaterThan(MAX_EXECUTOR_INPUT_BYTES);
    const write = writeIssuesCommand(json, markdown)!;
    // What the controller checks before it dispatches the job.
    expect(() => assertBoundedJson({ commands: [write] })).not.toThrow();
    expect(write.argv.length).toBeLessThanOrEqual(64);
    expect(write.argv.every((a) => a.length <= 4_096 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(a))).toBe(true);
    expect(writtenJson(write.argv)).toBe(json);
    const { root, dir } = await repo();
    try {
      await run(dir, write.argv);
      expect(await readFile(path.join(dir, ".graphloom/issues.json"), "utf8")).toBe(json);
      const md = await readFile(path.join(dir, ".graphloom/issues.md"), "utf8");
      expect(markdown.startsWith(md.slice(0, md.indexOf("\n… (cut short")))).toBe(true);
      expect(md).toContain("… (cut short; see .graphloom/issues.json)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // A JSON that cannot fit at all is refused, not dispatched.
    expect(writeIssuesCommand("x".repeat(MAX_EXECUTOR_INPUT_BYTES), "")).toBeUndefined();
  });

  it("delivers in a repository whose own .gitignore already ignores .graphloom/ (GraphLoom's does)", async () => {
    const { root, dir } = await repo();
    try {
      await writeFile(path.join(dir, ".gitignore"), ".graphloom/\n", "utf8");
      await git(dir, "add", ".gitignore");
      await git(dir, "commit", "-q", "-m", "ignore .graphloom");
      const t = table();
      await run(dir, writeIssuesCommand(issueFileJson(t), issueMarkdown(t))!.argv);
      const [deliver] = deliverCommands("fix/1", "Fix it", "Body");
      await run(dir, deliver!.argv);
      const files = (await git(dir, "show", "--name-only", "--format=", "fix/1")).stdout.split("\n").filter(Boolean);
      expect(files).toEqual(["a.go"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the file out of the delivered commit even when the fixer deleted its .gitignore, and the next read hides it again", async () => {
    const { root, dir } = await repo();
    try {
      const t = table();
      await run(dir, writeIssuesCommand(issueFileJson(t), issueMarkdown(t))!.argv);
      await unlink(path.join(dir, ".graphloom/.gitignore"));
      expect(await visible(dir)).toContain(".graphloom/issues.json");
      const [deliver] = deliverCommands("fix/1", "Fix it", "Body");
      await run(dir, deliver!.argv);
      const files = (await git(dir, "show", "--name-only", "--format=", "fix/1")).stdout.split("\n").filter(Boolean);
      expect(files).toEqual(["a.go"]);
      await run(dir, readIssuesCommand().argv);
      expect((await visible(dir)).filter((p) => p.includes(".graphloom"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The #119 dogfood run (issue-fix 0.2.0, before the issues file): its evidence, replayed, still gives a coherent table.
const REPLAY = process.env.ISSUE_FIX_REPLAY_STATE ?? path.join(repoRoot, "examples/graphloom-state/4c70ff66-dd9/state.json");
describe.skipIf(!existsSync(REPLAY))("replay of run 4c70ff66-dd9", () => {
  it("rebuilds every confirmed finding as an issue with a history that never skips a state", async () => {
    const state = JSON.parse(await readFile(REPLAY, "utf8")) as { evidence: EvidenceRecord[] };
    const ledger = findingLedger(state.evidence);
    const { issues } = ledger.issues;
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.history[0]!.from, i.id).toBeNull();
      i.history.forEach((h, n) => n > 0 && expect(h.from, `${i.id} event ${n}`).toBe(i.history[n - 1]!.to));
      expect(i.status).toBe(i.history.at(-1)!.to);
      expect(["done", "dismissed"]).toContain(i.status);
      expect(ledger.findings.find((f) => issueIdOf(f.id) === i.id)!.state).toBe(i.status === "done" ? "fixed" : "dismissed");
    }
    // The run completed: every confirmed finding was fixed, and the table says so.
    expect(issues.filter((i) => i.status === "done").length).toBe(ledger.findings.filter((f) => f.state === "fixed").length);
  });
});
