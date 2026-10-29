// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// A stand-in for an interactive Claude Code or Codex CLI, for `graphloom session open` tests. It records its
// argv, environment and what the confinement lets it do to $FAKE_AGENT_LOG, then behaves as the real CLI does
// for a fork: finds the restored session in its own store, writes a transcript under the new id holding the
// parent's turns and one operator turn with an answer. $FAKE_AGENT_SCRIPT (JSON) scripts it.
//   node fake-session-agent.mjs <claude|codex> [args...]
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [kind, ...args] = process.argv.slice(2);
const script = JSON.parse(process.env.FAKE_AGENT_SCRIPT || "{}");
// The log lives in the agent's own store: the one place the confinement lets it write.
const log = path.join((kind === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? "/nonexistent", "agent-log.jsonl");

if (args.includes("--help")) {
  if (script.helpFails) {
    process.stderr.write(`Unsupported shared launch flag: --help\n`);
    process.exit(1);
  }
  process.stdout.write(
    kind === "claude"
      ? "Usage: claude [options] [prompt]\n  --resume <id>\n  --fork-session\n  --session-id <uuid>\n  --append-system-prompt <text>\n"
      : "Usage: codex resume [options] [SESSION_ID] [PROMPT]\n  --sandbox <mode>\n",
  );
  process.exit(0);
}

function attempt(fn) {
  try {
    return fn() ?? "ok";
  } catch (err) {
    return err.code ?? String(err);
  }
}

const cwd = process.cwd();
const probes = {
  writeCheckout: attempt(() => writeFileSync(path.join(cwd, ".fake-agent-write"), "x")),
  maskedRead: attempt(() => (process.env.FAKE_AGENT_MASKED ? readFileSync(process.env.FAKE_AGENT_MASKED, "utf8") : "")),
  homeFile: process.env.FAKE_AGENT_HOME_FILE ? existsSync(process.env.FAKE_AGENT_HOME_FILE) : null,
  homeWrite: attempt(() => writeFileSync(path.join(process.env.HOME ?? "/nonexistent", ".fake-agent-home-write"), "x")),
  launcherStateWrite: process.env.FAKE_AGENT_STATE_DIR ? attempt(() => writeFileSync(path.join(process.env.FAKE_AGENT_STATE_DIR, "marker"), "x")) : null,
  storeWrite: kind === "claude" ? attempt(() => writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".probe"), "x")) : attempt(() => writeFileSync(path.join(process.env.CODEX_HOME, ".probe"), "x")),
};
if (process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME) {
  appendFileSync(
    log,
    `${JSON.stringify({ kind, argv: args, cwd, tty: process.stdin.isTTY === true, env: { GH_TOKEN: process.env.GH_TOKEN ?? null, GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null }, probes })}\n`,
  );
}

const ask = script.ask ?? "why did you settle the first question that way?";
const answer = script.answer ?? "Because the base commit already had the helper.";
const now = new Date().toISOString();

function claude() {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const parentId = value("--resume");
  const forkId = args.includes("--session-id") ? value("--session-id") : randomUUID();
  const store = path.join(process.env.CLAUDE_CONFIG_DIR, "projects");
  let parent;
  for (const project of readdirSync(store)) {
    const file = path.join(store, project, `${parentId}.jsonl`);
    if (existsSync(file)) parent = { project, text: readFileSync(file, "utf8") };
  }
  if (parent === undefined) {
    process.stderr.write(`no conversation found with session ID: ${parentId}\n`);
    process.exit(1);
  }
  const target = script.dropSessionId ? randomUUID() : forkId;
  const lines = parent.text.split("\n").filter(Boolean);
  if (!script.noTurn) {
    lines.push(
      JSON.stringify({ type: "user", sessionId: target, timestamp: now, message: { role: "user", content: ask } }),
      JSON.stringify({ type: "assistant", sessionId: target, timestamp: now, message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 9 } } }),
    );
  }
  if (script.pad) lines.push(JSON.stringify({ type: "attachment", pad: "x".repeat(script.pad) }));
  mkdirSync(path.join(store, parent.project), { recursive: true });
  writeFileSync(path.join(store, parent.project, `${target}.jsonl`), `${lines.join("\n")}\n`);
  // A fork keeps its own side directory.
  if (existsSync(path.join(store, parent.project, parentId))) {
    mkdirSync(path.join(store, parent.project, target), { recursive: true });
    writeFileSync(path.join(store, parent.project, target, "fork-side.txt"), "side\n");
  }
}

function codex() {
  const rest = args.slice(1).filter((a) => a !== "--sandbox" && a !== "danger-full-access");
  const thread = rest[0];
  const sessions = path.join(process.env.CODEX_HOME, "sessions");
  let found;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(`-${thread}.jsonl`)) found = p;
    }
  };
  if (existsSync(sessions)) walk(sessions);
  if (found === undefined) {
    process.stderr.write(`No saved session found with ID ${thread}\n`);
    process.exit(1);
  }
  const lines = [];
  if (!script.noTurn) {
    lines.push(
      JSON.stringify({ timestamp: now, type: "event_msg", payload: { type: "user_message", message: ask } }),
      JSON.stringify({ timestamp: now, type: "event_msg", payload: { type: "agent_message", message: answer } }),
      JSON.stringify({ timestamp: now, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 777 } } } }),
    );
  }
  if (script.pad) lines.push(JSON.stringify({ type: "response_item", payload: { pad: "x".repeat(script.pad) } }));
  appendFileSync(found, `${lines.join("\n")}\n`);
}

if (kind === "claude") claude();
else codex();
process.exit(script.exit ?? 0);
