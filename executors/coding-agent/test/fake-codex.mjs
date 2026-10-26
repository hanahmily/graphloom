// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Stands in for `codex exec --json`: logs its invocation, prints the scripted
// JSONL events, and writes the scripted last message to --output-last-message.
// Steps: {event}, {sleepMs}, {hang: true}, {last: "..."}, {stderr: "..."}, {exit: code},
// {spawnChild: {pidFile, ignoreTerm}}: a descendant in Codex's process group with
// its stdio redirected, which writes its pid once ready and then runs forever.
// Like Codex, without --ephemeral a `thread.started` event starts the thread's
// rollout under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
// (default `$HOME/.codex`), and each later event is appended to it as it is
// printed. `codex exec ... resume <id> -` continues that rollout, logging the
// earlier prompts as `history`, and fails as Codex does when it has none.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

if (argv.includes("--help")) {
  // B2's capability probe (docs/design-graph-rehearsal.md §3.1) asks the
  // configured binary's own `exec --help` for every flag the adapter passes
  // it; this stand-in must answer that the same way the real CLI would, or
  // every gated `run` in these tests hangs reading stdin for the probe's own
  // timeout.
  process.stdout.write(
    ["--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "--cd", "--output-last-message", "--model", "--config", "--output-schema"].join(" ") + "\n",
  );
  process.exit(0);
}

const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "/", ".codex");
const resumeAt = argv.indexOf("resume");
const resumed = resumeAt >= 0 ? argv.at(-2) : undefined;

/** The rollout file Codex keeps for a thread, wherever its day directory is. */
function findRollout(id) {
  const sessions = path.join(home, "sessions");
  if (!existsSync(sessions)) return undefined;
  for (const entry of readdirSync(sessions, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) return path.join(entry.parentPath, entry.name);
  }
  return undefined;
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
let rollout = resumed !== undefined ? findRollout(resumed) : undefined;
const history =
  rollout !== undefined
    ? readFileSync(rollout, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === "prompt").map((r) => r.text)
    : [];
const schemaFile = flag("--output-schema");
appendFileSync(
  process.env.FAKE_CODEX_LOG,
  `${JSON.stringify({
    argv,
    prompt,
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FAKE_CODEX_"))),
    schema: schemaFile !== undefined ? JSON.parse(readFileSync(schemaFile, "utf8")) : null,
    history,
  })}\n`,
);
if (resumed !== undefined && rollout === undefined) {
  process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${resumed}\n`);
  process.exit(1);
}
const record = (value) => {
  if (rollout !== undefined) appendFileSync(rollout, `${JSON.stringify(value)}\n`);
};
if (resumed !== undefined) {
  record({ type: "prompt", text: prompt });
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: resumed })}\n`);
}

// A script of {sequence: [steps, ...]} plays one step list per invocation (the last repeats).
const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, "utf8"));
const steps = Array.isArray(script)
  ? script
  : script.sequence[Math.min(readFileSync(process.env.FAKE_CODEX_LOG, "utf8").split("\n").filter(Boolean).length - 1, script.sequence.length - 1)];
for (const step of steps) {
  if (step.raw !== undefined) process.stdout.write(`${step.raw}\n`);
  if (step.event !== undefined) {
    // A resumed run has already announced its thread.
    if (step.event.type === "thread.started" && resumed !== undefined) continue;
    if (step.event.type === "thread.started" && !argv.includes("--ephemeral") && rollout === undefined) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dir = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
      mkdirSync(dir, { recursive: true });
      rollout = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${step.event.thread_id}.jsonl`);
      writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", id: step.event.thread_id })}\n`);
      record({ type: "prompt", text: prompt });
    }
    process.stdout.write(`${JSON.stringify(step.event)}\n`);
    record({ type: "event", event: step.event });
  }
  if (step.sleepMs !== undefined) await new Promise((r) => setTimeout(r, step.sleepMs));
  if (step.hang === true) await new Promise(() => setInterval(() => undefined, 1_000));
  if (step.last !== undefined) writeFileSync(flag("--output-last-message"), step.last);
  if (step.stderr !== undefined) process.stderr.write(step.stderr);
  if (step.spawnChild !== undefined) {
    const { pidFile, ignoreTerm } = step.spawnChild;
    const body = `${ignoreTerm ? "process.on('SIGTERM', () => undefined);" : ""}require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => undefined, 1000);`;
    spawn(process.execPath, ["-e", body], { stdio: "ignore" }).unref();
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 10));
  }
  if (step.exit !== undefined) process.exit(step.exit);
}
