// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EXECUTOR_INPUT_BYTES } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { reportWriteCommand, writeChunks, writtenReport } from "../src/write.js";
import { secretFindings } from "../src/secrets.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("writeChunks", () => {
  it("cuts text into argv-sized pieces that join back, and never splits a surrogate pair", () => {
    const text = `${"a".repeat(3_999)}😀${"b".repeat(5_000)}`;
    const chunks = writeChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 4_000)).toBe(true);
    expect(chunks.every((c) => !/[\ud800-\udbff]$/.test(c))).toBe(true);
    expect(writeChunks("")).toEqual([]);
  });
});

describe("the report-write command", () => {
  it("round-trips the JSON and the markdown through its argv, so the bytes written are evidence", () => {
    const json = JSON.stringify({ a: "x".repeat(9_000), b: "ünïcode ✓" });
    const markdown = `# Report\n${"line\n".repeat(2_000)}`;
    const command = reportWriteCommand(json, markdown)!;
    expect(command.id).toBe("report-write");
    expect(command.argv.every((a) => a.length <= 4_096)).toBe(true);
    expect(command.argv.length).toBeLessThanOrEqual(64);
    expect(writtenReport(command.argv)).toEqual({ json, markdown });
    expect(writtenReport(["sh", "-c", "x", "other-id", "0"])).toBeUndefined();
  });

  it("writes report.json, review.md and a .gitignore of `*` when run, and leaves nothing half written", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-write-"));
    dirs.push(dir);
    const json = JSON.stringify({ schema: "pr-change-report-v1", text: "a 'quoted' \"line\"\nand $(not run) `either`" });
    const markdown = "# Report\n- item with $HOME and `ticks` and 'quotes' — and unicode ✓\n";
    const command = reportWriteCommand(json, markdown)!;
    const out = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: dir, encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe("written");
    expect(readFileSync(path.join(dir, ".graphloom/review/report.json"), "utf8")).toBe(json);
    expect(readFileSync(path.join(dir, ".graphloom/review/review.md"), "utf8")).toBe(markdown);
    expect(readFileSync(path.join(dir, ".graphloom/review/.gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(path.join(dir, ".graphloom/review/report.json.tmp"))).toBe(false);
    expect(existsSync(path.join(dir, ".graphloom/review/review.md.tmp"))).toBe(false);
  });

  it("is one command only when the JSON and the markdown fit it together; otherwise there is none, and the artifacts are written in parts (parts.test.ts)", () => {
    const json = JSON.stringify({ pad: "j".repeat(150_000) });
    const markdown = `# Report\n${"m".repeat(200_000)}`;
    expect(reportWriteCommand(json, markdown)).toBeUndefined();
    expect(reportWriteCommand(JSON.stringify({ pad: "j".repeat(300_000) }), "# md")).toBeUndefined();
    const fits = reportWriteCommand(JSON.stringify({ pad: "j".repeat(100_000) }), "# md")!;
    expect(Buffer.byteLength(JSON.stringify({ commands: [fits] }), "utf8")).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
  });
});

describe("secretFindings (design 12.3)", () => {
  it("finds private-key headers, GitHub tokens, AWS keys and Slack tokens, by line", () => {
    const text = ["fine", "-----BEGIN RSA PRIVATE KEY-----", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-abcdef"].join("\n");
    expect(secretFindings(text)).toEqual(["line 2: a private key header", "line 3: a GitHub token", "line 4: a GitHub token", "line 5: an AWS access key", "line 6: a Slack token"]);
  });

  it("leaves ordinary text, hashes and short strings alone", () => {
    expect(secretFindings("commit 0123456789abcdef0123456789abcdef01234567 and ghp_ short and AKIA123")).toEqual([]);
  });
});

describe("the chunks a file is written in never cut a character", () => {
  const text = `${"a".repeat(3_999)}😀${"漢".repeat(2_500)}${"😀🎉".repeat(2_100)}${"é".repeat(4_001)}tail`;

  it("splits on character boundaries: no lone surrogate, every chunk valid UTF-8 text, and the chunks join back to the text", () => {
    const chunks = writeChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4_000);
      expect(Buffer.from(c, "utf8").toString("utf8")).toBe(c);
      expect(c).not.toMatch(/[\ud800-\udbff]$/);
      expect(c).not.toMatch(/^[\udc00-\udfff]/);
    }
    // The emoji that straddles the 4,000th unit is carried whole into the next chunk.
    expect(chunks[0]!.length).toBe(3_999);
    expect(chunks[1]!.startsWith("😀")).toBe(true);
  });
});
