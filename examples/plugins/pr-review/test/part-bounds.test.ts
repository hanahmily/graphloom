// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { commandJobProblem, commandProblem, JOB_INPUT_RESERVE_BYTES } from "../src/kit/bounds.js";
import { PART_BASE, REPORT_JSON, REVIEW_HTML } from "../src/kit/constants.js";
import { ledgerWriteCommands, reviewLedgerWriteCommands } from "../src/kit/ledger.js";
import { appendixWriteCommands, htmlWriteCommands, necessityWriteCommands, partCommands, qaWriteCommands, readParts, recordCommands, recordedReport, reportWriteCommands } from "../src/kit/parts.js";
import type { PullRequest } from "../src/kit/request.js";
import { root } from "./support.js";

/**
 * Part-set writes (design §6.6) as the command executor takes them. A live pr-design-review on apache/skywalking-banyandb#1487
 * (181 files, +30,736 lines; hub-bad193fb) planned report.json's first part at 250,050 bytes once serialized: the splitter
 * sized parts against a looser bound than the dispatch guard's, so the guard refused the write and the Report stage never
 * finished. Every write job the kit plans is checked here by the guard (`commandProblem`, `commandJobProblem`) and by the
 * executor's own validator (`commandInputProblem`, executors/command/src/run.ts), with content that grows under escaping.
 */
const executorSource = path.resolve(root, "../../../executors/command/src/run.ts");
const present = existsSync(executorSource);
const executor = async (): Promise<{ commandInputProblem(v: unknown): string | undefined }> => (await import(pathToFileURL(executorSource).href)) as { commandInputProblem(v: unknown): string | undefined };

/** Asserts each command, dispatched as the graph dispatches a write (one per job), passes the guard and the executor. */
async function expectEachAccepted(commands: readonly EnvironmentCommand[]): Promise<void> {
  expect(commands.length).toBeGreaterThan(0);
  const validate = present ? (await executor()).commandInputProblem : undefined;
  for (const c of commands) {
    expect(commandProblem(c), c.id).toBeUndefined();
    const input = { commands: [c] };
    expect(commandJobProblem({ stageId: "s", kind: "command", purpose: "diagnostic", readOnly: false, instruction: "i", input } as JobSpec), c.id).toBeUndefined();
    if (validate !== undefined) expect(validate(input), c.id).toBeUndefined();
  }
}

/** Text heavy in what grows under JSON escaping: quotes, backslashes, newlines, tabs, control characters, non-ASCII, a surrogate pair. */
const escapeHeavy = (n: number): string => {
  const unit = 'say "it" \\ back\\slash\n\ttab \u0001\u001f ünïcödé ✓ 😀 </script> $(x) `y` 100%\r\n';
  let text = "";
  while (text.length < n) text += unit;
  return text.slice(0, n);
};
/** A report as large as #1487's: a JSON document of escape-heavy strings, so its own text is full of escapes that escape again. */
const heavyReport = (items: number): string =>
  JSON.stringify({ schema: "graphloom-report-v1", items: Array.from({ length: items }, (_, i) => ({ id: `R${i}`, summary: escapeHeavy(900), cites: [`pkg/${i}.go:${i + 1}`] })) }, null, 2);

let seq = 0;
const ran = (c: EnvironmentCommand): EvidenceRecord => ({ ref: `w-${++seq}`, kind: "command", payload: { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: "written\n", stderrTail: "" } } }) as EvidenceRecord;
const PR = { mode: "review", owner: "apache", repo: "skywalking-banyandb", number: 1487, head: "a".repeat(40) } as PullRequest;

describe("part-set writes within the command executor's bounds (design §6.6)", () => {
  it("sizes every part of a large, escape-heavy report.json and review.md so its job passes the guard and the executor; the parts reassemble byte for byte", async () => {
    const json = heavyReport(700);
    const markdown = escapeHeavy(400_000);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(600_000);
    const commands = reportWriteCommands(json, markdown);
    expect(commands.filter((c) => c.id.startsWith(`${PART_BASE.reportJson}-p`)).length).toBeGreaterThanOrEqual(3);
    await expectEachAccepted(commands);
    const read = recordedReport(commands.map(ran));
    expect(read.state).toBe("read");
    if (read.state === "read") {
      expect(read.value.json).toBe(json);
      expect(read.value.markdown).toBe(markdown);
    }
  });

  it("packs a part up to the guard's own bound, never past it (report-json-p1 at 250,050 bytes was refused)", async () => {
    // JSON-like text, a third of it quotes: each 4,000-character chunk is about 5,300 bytes escaped, so bytes, not the
    // chunk count, end a part, as they did for the live report.json.
    const text = `{"a":"b"},`.repeat(100_000);
    const commands = partCommands(PART_BASE.reportJson, REPORT_JSON, text);
    const limit = MAX_EXECUTOR_INPUT_BYTES - JOB_INPUT_RESERVE_BYTES;
    const first = Buffer.byteLength(JSON.stringify({ commands: [commands[0]] }), "utf8");
    expect(first).toBeLessThanOrEqual(limit);
    // Filled to within one chunk of the bound: the splitter measures against the guard's line, not a looser one.
    expect(first).toBeGreaterThan(limit - 5_500);
    await expectEachAccepted(commands);
    expect(readParts(commands.map(ran), PART_BASE.reportJson, REPORT_JSON)).toMatchObject({ state: "read", value: text });
  });

  it("writes the bytes it was given when the part commands run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-part-bounds-"));
    try {
      const text = heavyReport(400);
      const commands = partCommands(PART_BASE.reportJson, REPORT_JSON, text);
      expect(commands.length).toBeGreaterThan(1);
      for (const c of commands) {
        const r = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: dir, encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
      }
      expect(readFileSync(path.join(dir, REPORT_JSON), "utf8")).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sizes the HTML pages, the appendix, qa.json, necessity.json, records and the ledger's files the same way", async () => {
    const html = `<!doctype html><html><body>${escapeHeavy(500_000)}</body></html>`;
    const json = heavyReport(500);
    const markdown = escapeHeavy(300_000);
    const ledger = ledgerWriteCommands(PR, "absent", "absent", json, markdown);
    const review = reviewLedgerWriteCommands(PR, "absent", "absent", json, markdown, { from: "none" }, "pr-review");
    const sets: Array<[string, EnvironmentCommand[]]> = [
      ["review.html", htmlWriteCommands(html, false)],
      ["the appendix", appendixWriteCommands(html, true)],
      ["qa.json", qaWriteCommands(json, markdown)],
      ["necessity.json", necessityWriteCommands(json)],
      ["a record", recordCommands("answers-record-1", "answers", json)],
      ["the design ledger", ledger.parts],
      ["the review ledger", review.parts],
    ];
    for (const [what, commands] of sets) {
      expect(commands.length, what).toBeGreaterThan(1);
      await expectEachAccepted(commands);
    }
    await expectEachAccepted([ledger.write, review.write]);
    expect(readParts(sets[0]![1].map(ran), PART_BASE.reviewHtml, REVIEW_HTML)).toMatchObject({ state: "read", value: html });
  });

  it("writes an artifact that fits one command by that command, within the guard's bound too", async () => {
    // Escape-heavy text around the single command's limit: taken whole or split, never planned over a bound.
    for (const n of [30_000, 60_000, 90_000, 120_000, 200_000]) {
      const json = escapeHeavy(n);
      await expectEachAccepted(reportWriteCommands(json, escapeHeavy(n / 2)));
      await expectEachAccepted(qaWriteCommands(json, escapeHeavy(n / 2)));
      await expectEachAccepted(necessityWriteCommands(json));
      await expectEachAccepted(recordCommands("answers-record-2", "answers", json));
      const ledger = ledgerWriteCommands(PR, "absent", "absent", json, escapeHeavy(n / 2));
      await expectEachAccepted([...ledger.parts, ledger.write]);
    }
  });
});
