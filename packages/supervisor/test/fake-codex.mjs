// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// A stand-in for the Codex CLI as the supervisor drives it: `codex exec
// --json` with the prompt on stdin, `exec ... resume <thread> -`, the last
// message written to --output-last-message, and rollouts under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. Like Codex
// 0.162, a resume needs the thread's rollout and names the same thread, and
// file reads are shell commands (Codex has no read tool).
//
// FAKE_CODEX_QUEUE names a JSON file holding an array of steps shared by every
// process: each process takes the first one (one prompt is one process). A
// step is the agent's answer to that prompt:
//   { observe?: Obs[], text } | { observe?, empty: true } | { observe?, error: text }
//   | { hang: true } | { crash: text }
// where an Obs is one item Codex runs on its own:
//   { type: "command_execution", command, output?, exitCode? }  streamed as given
//   { type: "command_execution", command, run }                 runs `sh -c run` for real in the cwd
//   { type: "file_change", path, content }                      writes the file for real (its patch tool)
//   { type: <other>, ...fields }                                streamed as given
// `error` reports the text as Codex does (an `error` event, then
// `turn.failed`) and exits 1: a usage limit, an overloaded API, a missing
// login. FAKE_CODEX_LOG names a file that gets one JSON line per process:
// argv, cwd, the prompt, the thread, whether it resumed, and whether an API
// key reached it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (argv.includes("--help")) {
  process.stdout.write(
    `${[
      "Commands:", "  resume  Resume a previous session", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox",
      "[possible values: read-only, workspace-write, danger-full-access]", "--cd", "--output-last-message", "--model", "--config",
      "--ignore-user-config", "--output-schema",
    ].join("\n")}\n`,
  );
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  const home = process.env.CODEX_HOME;
  if (home !== undefined && existsSync(path.join(home, "auth.json"))) {
    process.stderr.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\n");
  process.exit(1);
}

const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "/", ".codex");
const resumeAt = argv.indexOf("resume");
const resumed = resumeAt >= 0 ? argv.at(-2) : undefined;
const cwd = process.cwd();

function findRollout(id) {
  const sessions = path.join(home, "sessions");
  if (!existsSync(sessions)) return undefined;
  for (const entry of readdirSync(sessions, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) return path.join(entry.parentPath, entry.name);
  }
  return undefined;
}

/** Take the next step off the shared queue. */
function nextStep() {
  const file = process.env.FAKE_CODEX_QUEUE;
  const queue = JSON.parse(readFileSync(file, "utf8"));
  const step = queue.shift();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(queue));
  renameSync(tmp, file);
  if (step === undefined) throw new Error("fake codex: script exhausted");
  return step;
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
let rollout = resumed !== undefined ? findRollout(resumed) : undefined;
const threadId = resumed ?? randomUUID();
appendFileSync(
  process.env.FAKE_CODEX_LOG,
  `${JSON.stringify({
    argv,
    cwd,
    prompt,
    threadId,
    resumed: resumed !== undefined,
    apiKey: process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
  })}\n`,
);
if (resumed !== undefined && rollout === undefined) {
  process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${resumed}\n`);
  process.exit(1);
}
if (rollout === undefined) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dir = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  mkdirSync(dir, { recursive: true });
  rollout = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`);
  writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", id: threadId, cwd })}\n`);
}
const record = (value) => appendFileSync(rollout, `${JSON.stringify(value)}\n`);
record({ type: "prompt", text: prompt });
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

const step = nextStep();
let items = 0;
for (const obs of step.observe ?? []) {
  const id = `item_${items++}`;
  if (obs.type === "command_execution") {
    emit({ type: "item.started", item: { id, type: "command_execution", command: obs.command, aggregated_output: "", exit_code: null, status: "in_progress" } });
    let output = obs.output ?? "";
    let exitCode = obs.exitCode ?? 0;
    if (obs.run !== undefined) {
      try {
        output = execFileSync("sh", ["-c", obs.run], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        exitCode = 0;
      } catch (err) {
        output = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
        exitCode = err.status ?? 1;
      }
    }
    const item = { id, type: "command_execution", command: obs.command, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed" };
    emit({ type: "item.completed", item });
    record({ type: "event", item });
  } else if (obs.type === "file_change") {
    const changes = [{ path: obs.path, kind: obs.kind ?? "add" }];
    emit({ type: "item.started", item: { id, type: "file_change", changes, status: "in_progress" } });
    let status = "completed";
    try {
      writeFileSync(path.resolve(cwd, obs.path), obs.content ?? "");
    } catch {
      status = "failed";
    }
    emit({ type: "item.completed", item: { id, type: "file_change", changes, status } });
  } else {
    const { type, ...fields } = obs;
    emit({ type: "item.started", item: { id, type, ...fields, status: "in_progress" } });
    emit({ type: "item.completed", item: { id, type, ...fields, status: "completed" } });
  }
}

if (step.hang) {
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}
if (step.crash !== undefined) {
  process.stderr.write(`${step.crash}\n`);
  process.exit(3);
}
if (step.error !== undefined) {
  emit({ type: "error", message: step.error });
  emit({ type: "turn.failed", error: { message: step.error } });
  process.exit(1);
}
const text = step.empty === true ? "" : String(step.text ?? "");
if (text !== "") emit({ type: "item.completed", item: { id: `item_${items++}`, type: "agent_message", text } });
writeFileSync(flag("--output-last-message"), text);
record({ type: "assistant", text });
emit({ type: "turn.completed", usage: { input_tokens: 10 * (items + 1), cached_input_tokens: 4, output_tokens: 5 * (items + 1) } });
