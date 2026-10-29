// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Opt-in live check of the Claude Code fork `graphloom session open` relies on
 * (docs/design-supervisor-harnesses.md §11, items 5, 7 and 8): GRAPHLOOM_LIVE_CLAUDE_FORK=1.
 * It runs the real `claude` (the cheapest few turns) in a temporary config dir that holds only a copy of
 * your login (`.credentials.json` from $GRAPHLOOM_LIVE_CLAUDE_LOGIN_DIR, else $CLAUDE_CONFIG_DIR, else
 * ~/.claude), never your own config dir, and checks that `--resume <id> --fork-session --session-id <new>`
 * writes `<new>.jsonl` beside the parent with the parent's turns and the new ones, leaves the parent
 * byte-identical, forks a fork, and refuses a reused `--session-id`; and records whether
 * `--append-system-prompt` reaches the model on a resume. The interactive form (a terminal) is the same
 * flags; the transcript layout is the same file.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureClaudeFork, restoreClaudeFork } from "@graphloom/agent-harness/claude";
import { claudeTurns, conversationTurns } from "@graphloom/agent-harness/session";

const live = process.env.GRAPHLOOM_LIVE_CLAUDE_FORK === "1";
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

describe.skipIf(!live)("live: Claude Code's fork of a recorded session", () => {
  it("writes the fork under the id GraphLoom chose, leaves the parent alone, chains, and refuses a reused id", () => {
    const login = process.env.GRAPHLOOM_LIVE_CLAUDE_LOGIN_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const config = mkdtempSync(path.join(os.tmpdir(), "gl-live-fork-config-"));
    const work = mkdtempSync(path.join(os.tmpdir(), "gl-live-fork-work-"));
    temps.push(config, work);
    copyFileSync(path.join(login, ".credentials.json"), path.join(config, ".credentials.json"));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_CODE") && k !== "CLAUDECODE" && k !== "AI_AGENT"));
    env.CLAUDE_CONFIG_DIR = config;
    const claude = (args: string[]) => spawnSync(process.env.GRAPHLOOM_CLAUDE_BIN || "claude", ["-p", ...args, "--output-format", "json"], { cwd: work, env, encoding: "utf8", timeout: 180_000 });
    const result = (r: ReturnType<typeof claude>): { result: string; session_id: string } => JSON.parse(r.stdout) as { result: string; session_id: string };

    // The parent: a job's session, as the harness keeps it.
    const parent = randomUUID();
    const first = claude(["Reply with exactly the single word ALPHA and nothing else.", "--session-id", parent]);
    expect(first.status, first.stderr).toBe(0);
    const projects = path.join(config, "projects");
    const project = readdirSync(projects).find((p) => readdirSync(path.join(projects, p)).includes(`${parent}.jsonl`))!;
    const parentFile = path.join(projects, project, `${parent}.jsonl`);
    const saved = path.join(work, "saved");
    mkdirSync(saved);
    writeFileSync(path.join(saved, `claude-${parent}.json`), JSON.stringify({ project, model: null, systemPromptSha256: "live" }));
    copyFileSync(parentFile, path.join(saved, `claude-${parent}.jsonl`));
    const savedHash = sha(path.join(saved, `claude-${parent}.jsonl`));
    const parentHash = sha(parentFile);

    // Fork it as `session open` does: restore into the store, choose the id, resume with the fork flags.
    const fork = restoreClaudeFork({ configDir: config, savedDir: saved, parentRef: `claude-${parent}` });
    return fork.then((f) => {
      const second = claude(["What exact word did you reply with before? Then say the marker word of your system note, or NONE if you have none.", "--resume", parent, "--fork-session", "--session-id", f.forkId, "--append-system-prompt", "Status note: the marker word is ZEBRA-NOTE."]);
      expect(second.status, second.stderr).toBe(0);
      const answer = result(second);
      // The fork has the id GraphLoom chose, in the same project directory, with the parent's turns and the new one.
      expect(answer.session_id).toBe(f.forkId);
      expect(readdirSync(path.join(projects, project))).toContain(`${f.forkId}.jsonl`);
      expect(sha(parentFile)).toBe(parentHash);
      expect(sha(path.join(saved, `claude-${parent}.jsonl`))).toBe(savedHash);
      const text = readFileSync(path.join(projects, project, `${f.forkId}.jsonl`), "utf8");
      expect(claudeTurns(text).length).toBe(2);
      expect(claudeTurns(text)[0]!.answer).toContain("ALPHA");
      // The recorded observation (design-supervisor-harnesses.md §11, item 5): whether the appended note reaches the model on a resume.
      const noteApplied = /ZEBRA/.test(answer.result) && !/NONE/.test(answer.result);
      console.log(`live fork: --append-system-prompt on a resume applied: ${noteApplied}; reply: ${JSON.stringify(answer.result)}`);
      return captureClaudeFork({ configDir: config, fork: f, targetDir: path.join(work, "out"), maxBytes: 1 << 20 }).then((captured) => {
        expect(captured).toMatchObject({ stored: true, ref: `claude-${f.forkId}` });
        expect(conversationTurns("claude-code", captured!.transcript, f.parentTranscript)).toHaveLength(1);
        // A fork of the fork, and a reused id is refused.
        return restoreClaudeFork({ configDir: config, savedDir: path.join(work, "out"), parentRef: `claude-${f.forkId}` }).then((g) => {
          const third = claude(["Say OK.", "--resume", f.forkId, "--fork-session", "--session-id", g.forkId]);
          expect(third.status, third.stderr).toBe(0);
          expect(readdirSync(path.join(projects, project))).toContain(`${g.forkId}.jsonl`);
          const reused = claude(["hi", "--resume", parent, "--fork-session", "--session-id", g.forkId]);
          expect(`${reused.stdout}${reused.stderr}`).toMatch(/already in use/);
        });
      });
    });
  }, 600_000);
});
