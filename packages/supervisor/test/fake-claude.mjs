// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// A stand-in for the Claude Code CLI as the supervisor drives it: headless
// stream-json in and out, the control protocol (initialize, can_use_tool,
// interrupt), --session-id and --resume, and transcripts under
// $CLAUDE_CONFIG_DIR/projects/<cwd as a dir name>/<session>.jsonl. Like
// Claude Code 2.1.300, --resume finds a session in any project directory, and
// a --session-id already in use is refused.
//
// FAKE_CLAUDE_QUEUE names a JSON file holding an array of steps shared by
// every process: each process takes the first one (one prompt is one
// process). A step is the agent's answer to that prompt:
//   { observe?: Obs[], text } | { observe?, empty: true } | { observe?, error: text }
//   | { hang: true } | { crash: text }
// where an Obs is one native tool call:
//   { tool, input, output?, exitCode? }       streamed as given, no permission asked
//   { tool, input, ask: true, run?: command } asks can_use_tool first; with `run`,
//                                             an allowed call runs `sh -c run` for real
//   { tool: "Write", input: { file_path, content }, ask: true } writes the file for real
// `error` ends the turn with an error result carrying the text (a usage limit,
// an overloaded API, a missing login). FAKE_CLAUDE_LOG names a file that gets
// one JSON line per process: argv, cwd, the prompt, the session, and whether
// ANTHROPIC_API_KEY reached it.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (argv.includes("--help")) {
  process.stdout.write(`${[
    "-p", "--output-format", "--input-format", "--verbose", "--replay-user-messages", "--forward-subagent-text",
    "--permission-mode", "--permission-prompt-tool", "--tools", "--strict-mcp-config", "--append-system-prompt",
    "--model", "--effort", "--resume", "--session-id",
  ].join(" ")}\n`);
  process.exit(0);
}

const configDir = process.env.CLAUDE_CONFIG_DIR;
const projects = path.join(configDir, "projects");
const cwd = process.cwd();
const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id");
const findTranscript = () => {
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
};
const found = findTranscript();
const transcript = found ?? path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);

/** Take the next step off the shared queue. */
function nextStep() {
  const file = process.env.FAKE_CLAUDE_QUEUE;
  const queue = JSON.parse(readFileSync(file, "utf8"));
  const step = queue.shift();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(queue));
  renameSync(tmp, file);
  if (step === undefined) throw new Error("fake claude: script exhausted");
  return step;
}

const waiting = new Map();
let nextPermission = 0;
let stopped = false;
const input = createInterface({ input: process.stdin });
const prompt = await new Promise((resolve) => {
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (message.request.subtype === "interrupt") {
        stopped = true;
        emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted", session_id: sessionId });
      }
    } else if (message.type === "control_response") {
      waiting.get(message.response.request_id)?.(message.response);
      waiting.delete(message.response.request_id);
    } else if (message.type === "user") {
      emit({ type: "user", isReplay: true, message: { role: "user", content: message.message.content }, session_id: sessionId });
      resolve(message.message.content);
    }
  });
  input.on("close", () => process.exit(0));
});

appendFileSync(
  process.env.FAKE_CLAUDE_LOG,
  `${JSON.stringify({ argv, cwd, prompt, sessionId, resumed: resume !== undefined, apiKey: process.env.ANTHROPIC_API_KEY ?? null, configDir })}\n`,
);

if (resume !== undefined && found === undefined) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: sessionId });
  process.exit(1);
}
if (resume === undefined && found !== undefined) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}

mkdirSync(path.dirname(transcript), { recursive: true });
const record = (entry) => appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
record({ type: "user", text: prompt });
emit({ type: "system", subtype: "init", session_id: sessionId, cwd, mcp_servers: [] });

async function permission(tool, toolInput) {
  const request_id = `permission-${(nextPermission += 1)}`;
  const response = new Promise((resolve) => waiting.set(request_id, resolve));
  emit({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: tool, input: toolInput } });
  const reply = await response;
  return reply.subtype === "success" ? reply.response : { behavior: "deny", message: reply.error };
}

let responses = 0;
let tools = 0;
const step = nextStep();
for (const obs of step.observe ?? []) {
  if (stopped) break;
  const id = `toolu_${(tools += 1)}`;
  emit({ type: "assistant", message: { id: `msg_${(responses += 1)}`, content: [{ type: "tool_use", id, name: obs.tool, input: obs.input }] }, parent_tool_use_id: null });
  let output = obs.output ?? "ok";
  let isError = obs.exitCode !== undefined && obs.exitCode !== 0;
  if (obs.ask === true) {
    const decision = await permission(obs.tool, obs.input);
    if (decision.behavior !== "allow") {
      output = decision.message;
      isError = true;
    } else if (obs.run !== undefined) {
      try {
        output = execFileSync("sh", ["-c", obs.run], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        isError = false;
      } catch (err) {
        output = `Exit code ${err.status ?? 1}\n${String(err.stderr ?? "").trim()}`;
        isError = true;
      }
    } else if (obs.tool === "Write") {
      try {
        writeFileSync(path.resolve(cwd, obs.input.file_path), obs.input.content ?? "");
        output = `File created successfully at: ${obs.input.file_path}`;
      } catch (err) {
        output = String(err.message);
        isError = true;
      }
    }
  } else if (isError) {
    output = `Exit code ${obs.exitCode}\n${output}`;
  }
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null });
}

if (stopped) {
  await new Promise(() => undefined);
}
const usage = { inputTokens: 10 * (responses + 1), outputTokens: 5 * (responses + 1), cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
if (step.hang) {
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}
if (step.crash !== undefined) {
  process.stderr.write(`${step.crash}\n`);
  process.exit(3);
}
if (step.error !== undefined) {
  emit({ type: "result", subtype: "success", is_error: true, result: step.error, session_id: sessionId, modelUsage: { fake: usage } });
  record({ type: "cost-state", modelUsage: { fake: usage }, totalCostUSD: 0 });
  process.exit(1);
}
const text = step.empty === true ? "" : String(step.text ?? "");
if (text !== "") emit({ type: "assistant", message: { id: `msg_${(responses += 1)}`, content: [{ type: "text", text }] }, parent_tool_use_id: null });
record({ type: "assistant", text });
record({ type: "cost-state", modelUsage: { fake: usage }, totalCostUSD: 0.01 });
emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, modelUsage: { fake: usage }, total_cost_usd: 0.01 });
