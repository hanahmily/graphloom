#!/usr/bin/env node
// A deterministic Claude Code protocol peer: writes or independently reviews the greeting.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];

if (argv.includes("--help")) {
  // B2's capability probe (docs/design-graph-rehearsal.md §3.1) asks the
  // configured binary's own --help for every flag the adapter passes it;
  // this fixture must answer that the same way the real CLI would, or every
  // gated `run` in these tests hangs reading stdin for the probe's own
  // timeout.
  process.stdout.write([
    "-p", "--output-format", "--input-format", "--verbose", "--replay-user-messages",
    "--forward-subagent-text", "--permission-mode", "--permission-prompt-tool", "--settings",
    "--tools", "--strict-mcp-config", "--append-system-prompt", "--mcp-config", "--model",
    "--json-schema", "--resume", "--session-id",
  ].join(" ") + "\n");
  process.exit(0);
}

let prompt;
let interruptLive;
if (argv.includes("--input-format") && flag("--input-format") === "stream-json") {
  const lines = createInterface({ input: process.stdin });
  prompt = await new Promise((resolve) => {
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "user") {
        if (argv.includes("--replay-user-messages")) process.stdout.write(`${JSON.stringify({ ...event, isReplay: true })}\n`);
        resolve(event.message.content);
      }
      if (event.type === "control_request") {
        process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: {} } })}\n`);
        if (event.request.subtype === "interrupt") void interruptLive?.();
      }
    });
  });
} else {
  prompt = await new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => resolve(text));
  });
}
const review = String(prompt).includes("independent read-only reviewer");
const sessionId = flag(argv.includes("--resume") ? "--resume" : "--session-id");
const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "cli-test");
await mkdir(projectDir, { recursive: true });
const liveDir = process.env.GRAPHLOOM_TEST_LIVE_DIR;
if (liveDir && !review) {
  await mkdir(liveDir, { recursive: true });
  const heartbeat = () => {
    writeFileSync("GREETING.txt", "Hello, GraphLoom!\n");
    appendFileSync(path.join(liveDir, "heartbeat"), `${Date.now()}\n`);
  };
  heartbeat();
  const timer = setInterval(heartbeat, 25);
  let interrupted = false;
  interruptLive = async () => {
    if (interrupted) return;
    interrupted = true;
    clearInterval(timer);
    await writeFile(path.join(liveDir, "interrupted"), "interrupt received\n");
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ role: "assistant", content: "Interrupted live turn" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted", session_id: sessionId })}\n`, () => process.exit(0));
  };
  process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "live-reply", content: [{ type: "text", text: "Editing greeting" }] } })}\n`);
  await writeFile(path.join(liveDir, "running.json"), JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
  await new Promise(() => undefined);
}
let output;
if (review) {
  const bytes = await readFile("GREETING.txt", "utf8");
  output = process.env.GRAPHLOOM_TEST_BAD_REVIEW === "1"
    ? { summary: "No structured verdict supplied" }
    : { verdict: bytes === "Hello, GraphLoom!\n" ? "approved" : "request_changes", summary: "Checked exact greeting bytes" };
} else {
  await writeFile("GREETING.txt", "Hello, GraphLoom!\n");
  output = { summary: "Wrote greeting" };
}
await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ role: "assistant", content: output })}\n`);
process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "reply-1", content: [{ type: "text", text: output.summary }] } })}\n`);
// Fill the schema's shape, as a model does: a lone `result` property holds the whole result.
const schema = argv.includes("--json-schema") ? JSON.parse(flag("--json-schema")) : undefined;
const structured = Object.keys(schema?.properties ?? {}).join() === "result" ? { result: output } : output;
process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: structured, session_id: sessionId })}\n`, () => process.exit(0));
