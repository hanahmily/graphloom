// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureClaudeFork, restoreClaudeFork } from "../claude/fork.js";
import { captureCodexFork, restoreCodexFork } from "../codex/fork.js";
import {
  EXTRACT_ANSWER_BYTES,
  EXTRACT_MAX_BYTES,
  OPENING_NOTE_PREFIX,
  claudeTurns,
  codexTurns,
  contextTokens,
  conversationTurns,
  cutText,
  turnExtract,
} from "./conversation.js";

const jsonl = (...lines: unknown[]): string => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

const CLAUDE = jsonl(
  { type: "mode" },
  { type: "user", message: { role: "user", content: "Answer the questions." } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading the base." }, { type: "tool_use", id: "t1", name: "Read", input: {} }], usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "SECRET-TOOL-OUTPUT" }] } },
  { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done: 3 answered." }], usage: { input_tokens: 7, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } },
  { type: "user", isMeta: true, message: { role: "user", content: "meta reminder" } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: `${OPENING_NOTE_PREFIX} a fork of the answers session.` }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Noted." }] } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "why was Q2 partial?" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Because the citation was weak." }] } },
);

const CODEX = jsonl(
  { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } },
  { type: "event_msg", payload: { type: "user_message", message: "Check the answers." } },
  { type: "response_item", payload: { type: "function_call_output", output: "SECRET-TOOL-OUTPUT" } },
  { type: "event_msg", payload: { type: "agent_message", message: "commentary" } },
  { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1234 } } } },
  { type: "event_msg", payload: { type: "task_complete", last_agent_message: "All supported." } },
  { type: "event_msg", payload: { type: "user_message", message: "which was weakest?" } },
  { type: "event_msg", payload: { type: "agent_message", message: "Q2." } },
);

describe("transcript turns and the turn extract", () => {
  it("reads Claude Code's human turns and each turn's last answer, leaving tool results, meta and subagent text out", () => {
    expect(claudeTurns(CLAUDE)).toEqual([
      { user: "Answer the questions.", answer: "Done: 3 answered." },
      { user: `${OPENING_NOTE_PREFIX} a fork of the answers session.`, answer: "Noted." },
      { user: "why was Q2 partial?", answer: "Because the citation was weak." },
    ]);
    const own = conversationTurns("claude-code", CLAUDE, CLAUDE.split("\n").slice(0, 6).join("\n") + "\n");
    // The parent's one human turn is skipped, and so is the opening note.
    expect(own).toEqual([{ user: "why was Q2 partial?", answer: "Because the citation was weak." }]);
    expect(JSON.stringify(turnExtract(own))).not.toContain("SECRET-TOOL-OUTPUT");
  });

  it("reads Codex's user messages and each turn's last agent message", () => {
    expect(codexTurns(CODEX)).toEqual([
      { user: "Check the answers.", answer: "All supported." },
      { user: "which was weakest?", answer: "Q2." },
    ]);
  });

  it("keeps operator messages verbatim and cuts the oldest answers first, then the oldest operator messages, marking each cut", () => {
    const turns = Array.from({ length: 80 }, (_, i) => ({ user: `question ${i} ${"q".repeat(1500)}`, answer: "a".repeat(10_000) }));
    const extract = turnExtract(turns);
    expect(Buffer.byteLength(JSON.stringify(extract))).toBeLessThanOrEqual(EXTRACT_MAX_BYTES);
    // Each answer is cut to its 4 KiB limit; past the overall limit the oldest answers go first.
    expect(extract.at(-1)!.answer!.length).toBeLessThanOrEqual(EXTRACT_ANSWER_BYTES);
    expect(extract.at(-1)!.answerCut).toBe(true);
    const dropped = extract.filter((t) => t.answer === "… [cut]").length;
    expect(dropped).toBeGreaterThan(0);
    expect(extract.slice(0, dropped).every((t) => t.answer === "… [cut]")).toBe(true);
    expect(extract.slice(dropped).every((t) => t.answer !== "… [cut]")).toBe(true);
    // The operator's messages are whole while they fit.
    expect(extract.every((t) => t.operator.startsWith("question ") && t.operatorCut === undefined)).toBe(true);
    expect(extract[0]!.operator).toBe(turns[0]!.user);
    // Operator messages past their own 128 KiB bound are cut oldest first.
    const long = turnExtract(Array.from({ length: 6 }, (_, i) => ({ user: `m${i} ${"x".repeat(40_000)}` })));
    const cut = long.map((t) => t.operatorCut === true);
    expect(cut.some(Boolean)).toBe(true);
    expect(cut.at(-1)).toBe(false);
    expect(long.at(-1)!.operator).toBe(`m5 ${"x".repeat(40_000)}`);
    expect(Buffer.byteLength(JSON.stringify(long))).toBeLessThanOrEqual(EXTRACT_MAX_BYTES);
  });

  it("holds the bound for very many short turns, dropping the oldest whole and saying how many", () => {
    const turns = Array.from({ length: 7000 }, (_, i) => ({ user: `hello ${i}`, answer: "world" }));
    const extract = turnExtract(turns);
    expect(Buffer.byteLength(JSON.stringify(extract))).toBeLessThanOrEqual(EXTRACT_MAX_BYTES);
    expect(extract.at(-1)!.operator).toBe("hello 6999");
    expect(extract[0]!.droppedBefore).toBe(turns.length - extract.length);
    expect(extract[0]!.droppedBefore).toBeGreaterThan(0);
    expect(extract.slice(1).every((t) => t.droppedBefore === undefined)).toBe(true);
  });

  it("cuts on a character boundary and marks the cut", () => {
    const text = "é".repeat(3000);
    const cut = cutText(text, 100);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(100);
    expect(cut.endsWith("… [cut]")).toBe(true);
    expect(cutText("short", 100)).toBe("short");
  });

  it("estimates the context from the last usage record, or the transcript's size over four", () => {
    expect(contextTokens("claude-code", CLAUDE)).toBe(7 + 300);
    expect(contextTokens("codex", CODEX)).toBe(1234);
    expect(contextTokens("claude-code", jsonl({ type: "user", message: { content: "hi" } }))).toBe(Math.ceil(Buffer.byteLength(jsonl({ type: "user", message: { content: "hi" } })) / 4));
  });
});

describe("forking a saved session into the agent's store", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });
  const temp = async (): Promise<string> => {
    const d = await mkdtemp(path.join(os.tmpdir(), "gl-fork-"));
    dirs.push(d);
    return d;
  };

  it("restores a Claude session without touching the saved copy, and captures the fork by the id chosen", async () => {
    const root = await temp();
    const saved = path.join(root, "saved");
    const store = path.join(root, "claude");
    const parent = "11111111-1111-4111-8111-111111111111";
    await mkdir(path.join(saved, `claude-${parent}`), { recursive: true });
    await writeFile(path.join(saved, `claude-${parent}.json`), JSON.stringify({ project: "-p", model: "m", systemPromptSha256: "s" }));
    await writeFile(path.join(saved, `claude-${parent}.jsonl`), CLAUDE);
    await writeFile(path.join(saved, `claude-${parent}`, "side.txt"), "side");
    const fork = await restoreClaudeFork({ configDir: store, savedDir: saved, parentRef: `claude-${parent}` });
    expect(fork.forkId).not.toBe(parent);
    expect(await readFile(path.join(store, "projects", "-p", `${parent}.jsonl`), "utf8")).toBe(CLAUDE);
    expect(await readFile(path.join(store, "projects", "-p", parent, "side.txt"), "utf8")).toBe("side");
    // Nothing under the fork's id yet: nothing to capture.
    expect(await captureClaudeFork({ configDir: store, fork, targetDir: path.join(root, "out"), maxBytes: 1 << 20 })).toBeUndefined();
    // The agent writes the fork; capture keeps a self-contained copy with the parent's settings.
    await writeFile(path.join(store, "projects", "-p", `${fork.forkId}.jsonl`), `${CLAUDE}${jsonl({ type: "user", message: { role: "user", content: "next" } })}`);
    const got = await captureClaudeFork({ configDir: store, fork, targetDir: path.join(root, "out"), maxBytes: 1 << 20 });
    expect(got).toMatchObject({ ref: `claude-${fork.forkId}`, stored: true });
    expect(JSON.parse(await readFile(path.join(root, "out", `claude-${fork.forkId}.json`), "utf8"))).toEqual({ project: "-p", model: "m", systemPromptSha256: "s" });
    const big = await captureClaudeFork({ configDir: store, fork, targetDir: path.join(root, "out2"), maxBytes: 10 });
    expect(big).toMatchObject({ stored: false });
    expect(big!.transcript).toContain("next");
    expect(await readdir(path.join(root, "out2")).catch(() => [])).toEqual([]);
    // A corrupt or missing saved copy is refused.
    await writeFile(path.join(saved, `claude-${parent}.jsonl`), "not json\n");
    await expect(restoreClaudeFork({ configDir: store, savedDir: saved, parentRef: `claude-${parent}` })).rejects.toThrow(/corrupt/);
    await expect(restoreClaudeFork({ configDir: store, savedDir: saved, parentRef: "claude-22222222-2222-4222-8222-222222222222" })).rejects.toThrow(/no saved session/);
  });

  it("copies a Codex rollout under a new thread id with its session_meta rewritten, and never writes the recorded thread's own", async () => {
    const root = await temp();
    const saved = path.join(root, "saved");
    const home = path.join(root, "codex");
    const parent = "00000000-0000-4000-8000-000000000001";
    await mkdir(saved, { recursive: true });
    const rel = `sessions/2026/10/29/rollout-2026-10-29T10-00-00-${parent}.jsonl`;
    await writeFile(path.join(saved, `codex-${parent}.json`), JSON.stringify({ rollout: rel, model: null }));
    await writeFile(path.join(saved, `codex-${parent}.jsonl`), CODEX);
    const fork = await restoreCodexFork({ home, savedDir: saved, parentRef: `codex-${parent}`, now: new Date(2026, 9, 29, 11, 30, 5) });
    expect(fork.forkThread).not.toBe(parent);
    expect(fork.rollout).toBe(`sessions/2026/10/29/rollout-2026-10-29T11-30-05-${fork.forkThread}.jsonl`);
    const copied = (await readFile(path.join(home, fork.rollout), "utf8")).split("\n");
    expect(JSON.parse(copied[0]!)).toEqual({ type: "session_meta", payload: { id: fork.forkThread } });
    expect(copied.slice(1).join("\n")).toBe(CODEX.split("\n").slice(1).join("\n"));
    await expect(readFile(path.join(home, rel))).rejects.toThrow();
    const got = await captureCodexFork({ home, fork, targetDir: path.join(root, "out"), maxBytes: 1 << 20 });
    expect(got).toMatchObject({ ref: `codex-${fork.forkThread}`, stored: true });
    // The saved fork restores in turn (the saved meta names a rollout path that ends with the thread id).
    const again = await restoreCodexFork({ home, savedDir: path.join(root, "out"), parentRef: `codex-${fork.forkThread}` });
    expect(again.parentThread).toBe(fork.forkThread);
  });
});
