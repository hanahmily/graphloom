// A stand-in for the Claude Code CLI in headless stream-json mode, for tests.
// FAKE_CLAUDE_SCRIPT names a JSON file `{ start: Step[], resume: Step[] }`; each
// step is one model response:
//   { text } | { tool, args } | { parallel: [{ tool, args } | { bash }] } | { bash }
//   | { structured } | { think: ms } | { hang: true } | { error } | { limit } | { crash }
//   | { agent: Step[], background?: true } | { spawnChild: { pidFile, ignoreTerm } }
// A `spawnChild` step starts a descendant in the CLI's process group with its
// stdio redirected, which writes its pid once ready and then runs forever.
// An `agent` step is an Agent tool call whose subagent makes the given responses,
// forwarded with parent_tool_use_id. A background subagent runs after the turn's
// result, then a follow-up turn reports it and ends with a second result. Each
// subagent's texts go to `<session>/subagents/agent-<id>.jsonl` beside the
// transcript, and the log records the files under `<session>/` at startup.
// Like Claude Code, running totals (`modelUsage`, `total_cost_usd`) cover the
// whole session: they are appended to the transcript as a `cost-state` record
// and restored from it on resume, unless the script sets `restoreCost: false`.
// `dropSide: true` makes a resumed session delete its side directory, and
// `linkTranscript: path` leaves the transcript a symlink to `path` at exit.
// `byPrompt: [{ match, steps }]` runs the first entry whose `match` the prompt
// contains, in place of `start` or `resume`.
// `background: "default"` backgrounds an Agent call that did not ask for it, as
// Claude Code now does, announcing it with `task_started` and an
// `async_launched` tool result. With `autoTurnOnResume: true`, a resumed
// session first runs a turn of its own (Claude Code does this for background
// agents the previous process left unfinished) and emits its empty result
// before it reads the prompt. `--replay-user-messages` echoes the prompt back,
// marked `isReplay`, when the session takes it up. Only the result of the turn
// that called StructuredOutput carries `structured_output`.
// FAKE_CLAUDE_LOG names a file that gets one JSON line per invocation.
// Both are read from the environment as it reaches the process.
import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (argv.includes("--help")) {
  // B2's capability probe (docs/design-graph-rehearsal.md §3.1) asks the
  // configured binary's own --help for every flag the adapter passes it;
  // this stand-in must answer that the same way the real CLI would, or every
  // gated `run` in these tests hangs for the probe's own timeout.
  process.stdout.write([
    "-p", "--output-format", "--input-format", "--verbose", "--replay-user-messages",
    "--forward-subagent-text", "--permission-mode", "--permission-prompt-tool", "--settings",
    "--tools", "--strict-mcp-config", "--append-system-prompt", "--mcp-config", "--model",
    "--json-schema", "--resume", "--session-id",
  ].join(" ") + "\n");
  process.exit(0);
}

const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id");
const cwd = process.cwd();
const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const sideDir = path.join(projectDir, sessionId);
const streaming = flag("--input-format") === "stream-json";
const controlLog = `${process.env.FAKE_CLAUDE_LOG}.controls`;
const controls = (value) => appendFileSync(controlLog, `${JSON.stringify(value)}\n`);
const waiting = new Map();
let nextPermission = 0;
let interrupted = false;
let input;
let inputClosed = false;
let scriptFinished = false;
let assignmentStarted = false;
const prompt = streaming ? await new Promise((resolve) => {
  input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "user") {
      assignmentStarted = true;
      const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
      const takeUp = () => {
        if (argv.includes("--replay-user-messages")) {
          emit({ type: "user", isReplay: true, message: { role: "user", content: message.message.content }, session_id: flag("--resume") ?? flag("--session-id") });
        }
        resolve(message.message.content);
      };
      if (flag("--resume") !== undefined && script.autoTurnOnResume) {
        emit({ type: "result", subtype: "success", is_error: false, result: "", session_id: flag("--resume") });
        // Like Claude Code, a prompt still queued when input closes is dropped.
        setTimeout(() => (inputClosed ? process.exit(0) : takeUp()), 200);
      } else {
        takeUp();
      }
    } else if (message.type === "control_response") {
      const response = message.response;
      waiting.get(response.request_id)?.(response);
      waiting.delete(response.request_id);
    } else if (message.type === "control_request") {
      controls(message);
      const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
      if (message.request.subtype === "initialize" && script.earlyResult) {
        emit({ type: "result", subtype: "success", is_error: false, result: "never ran the assignment" });
        return;
      }
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (message.request.subtype === "interrupt") {
        const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
        if (script.ignoreInterrupt) return;
        interrupted = true;
        mkdirSync(projectDir, { recursive: true });
        appendFileSync(transcript, `${JSON.stringify({ text: "interrupted turn saved" })}\n`);
        emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted" });
      }
    }
  });
  input.on("close", () => {
    inputClosed = true;
    // A turn result can precede background work; let it finish before exiting.
    if (scriptFinished || interrupted || !assignmentStarted) process.exit(0);
  });
}) : readFileSync(0, "utf8");
process.on("SIGTERM", () => {
  controls({ signal: "SIGTERM" });
  const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
  if (!script.ignoreTerm) process.exit(143);
});

async function permission(toolName, toolInput, subtype = "can_use_tool") {
  if (!streaming) return { behavior: "allow", updatedInput: toolInput };
  const request_id = `permission-${++nextPermission}`;
  const response = new Promise((resolve) => waiting.set(request_id, resolve));
  emit({ type: "control_request", request_id, request: { subtype, tool_name: toolName, input: toolInput, tool_use_id: `tool-${nextPermission}` } });
  const reply = await response;
  controls({ tool: toolName, input: toolInput, reply });
  return reply.subtype === "success" ? reply.response : { behavior: "deny", message: reply.error };
}

const side = {};
if (existsSync(sideDir)) {
  for (const entry of readdirSync(sideDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      side[path.relative(sideDir, file)] = readFileSync(file, "utf8");
    }
  }
}

const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
let history = [];
let restored = { totalCostUSD: 0, modelUsage: {} };
if (resume !== undefined) {
  if (!existsSync(transcript)) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
  }
  const entries = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  history = entries.filter((e) => e.text !== undefined).map((e) => e.text);
  const costState = entries.filter((e) => e.type === "cost-state").at(-1);
  if (costState !== undefined && script.restoreCost !== false) restored = costState;
  if (script.dropSide === true) rmSync(sideDir, { recursive: true, force: true });
}

const mcpFile = flag("--mcp-config");
const server = mcpFile ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.graphloom : undefined;
appendFileSync(
  process.env.FAKE_CLAUDE_LOG,
  `${JSON.stringify({
    argv,
    prompt,
    cwd,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    env: process.env,
    history,
    side,
    mcp: server ? { type: server.type, url: server.url } : null,
  })}\n`,
);

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...server.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  return (await response.json()).result;
}

mkdirSync(projectDir, { recursive: true });
const record = (text) => appendFileSync(transcript, `${JSON.stringify({ text })}\n`);
record(prompt);

let connected = false;
if (server) connected = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })) !== undefined;
emit({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: script.malformedInit ? [null] : server ? [{ name: "graphloom", status: connected ? "connected" : "failed" }] : [] });

let responses = 0;
let turnResponses = 0;
let lastText = "";
let structured;
let toolUses = 0;
let cost = 0;
/** This process's usage per model; the main thread and subagents run on different models. */
const usage = {};
const MAIN_MODEL = "claude-fake-main";
const SUB_MODEL = "claude-fake-sub";
const count = (model, tokens) => {
  const u = (usage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  for (const [k, v] of Object.entries(tokens)) u[k] += v;
};
const totals = () => {
  const models = structuredClone(restored.modelUsage);
  for (const [model, u] of Object.entries(usage)) {
    const t = (models[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    for (const [k, v] of Object.entries(u)) t[k] += v;
  }
  return { totalCostUSD: restored.totalCostUSD + cost, modelUsage: models };
};
const assistant = (msgId, parent, content) => emit({ type: "assistant", message: { id: msgId, content }, parent_tool_use_id: parent });
const toolResult = (parent, id, content, extra = {}) =>
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: parent, ...extra });

async function runTool(msgId, step, parent) {
  const id = `toolu_${(toolUses += 1)}`;
  if (step.bash !== undefined) {
    assistant(msgId, parent, [{ type: "tool_use", id, name: "Bash", input: { command: step.bash } }]);
    const decision = await permission("Bash", { command: step.bash });
    const out = decision.behavior === "allow" ? execSync(step.bash, { cwd, encoding: "utf8" }) : decision.message;
    toolResult(parent, id, out);
    return;
  }
  assistant(msgId, parent, [{ type: "tool_use", id, name: `mcp__graphloom__${step.tool}`, input: step.args ?? {} }]);
  const decision = await permission(`mcp__graphloom__${step.tool}`, step.args ?? {});
  const result = decision.behavior === "allow"
    ? await rpc("tools/call", { name: step.tool, arguments: step.args ?? {} })
    : { content: decision.message };
  toolResult(parent, id, result.content);
}

function result() {
  if (interrupted) return;
  count(MAIN_MODEL, { cacheReadInputTokens: 100, cacheCreationInputTokens: 20 });
  cost += 0.0125;
  const { totalCostUSD, modelUsage } = totals();
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: structured !== undefined ? JSON.stringify(structured) : lastText,
    session_id: sessionId,
    num_turns: turnResponses,
    usage: { input_tokens: 10 * turnResponses, output_tokens: 5 * turnResponses, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    modelUsage,
    total_cost_usd: totalCostUSD,
    ...(structured !== undefined && flag("--json-schema") !== undefined ? { structured_output: fillSchema(structured) } : {}),
  });
  turnResponses = 0;
  structured = undefined;
}

/** A `structured` step is the result; like a model, fill the schema's shape with it. */
function fillSchema(value) {
  const schema = JSON.parse(flag("--json-schema"));
  const keys = Object.keys(schema.properties ?? {});
  return keys.length === 1 && schema.required?.[0] === keys[0] && keys[0] === "result" ? { result: value } : value;
}

const background = [];

async function respond(step, parent) {
  if (interrupted) return;
  const msgId = `msg_${(responses += 1)}`;
  if (parent === null) turnResponses += 1;
  count(parent === null ? MAIN_MODEL : SUB_MODEL, { inputTokens: 10, outputTokens: 5 });
  if (step.text !== undefined) {
    if (parent === null) lastText = step.text;
    if (parent === null) record(step.text);
    else {
      mkdirSync(path.join(sideDir, "subagents"), { recursive: true });
      appendFileSync(path.join(sideDir, "subagents", `agent-${parent}.jsonl`), `${JSON.stringify({ text: step.text })}\n`);
    }
    assistant(msgId, parent, [{ type: "text", text: step.text }]);
  } else if (step.tool !== undefined || step.bash !== undefined) {
    await runTool(msgId, step, parent);
  } else if (step.native !== undefined) {
    // A built-in tool call (Read, Grep, ...) the fake answers without a permission round trip.
    const id = `toolu_${(toolUses += 1)}`;
    assistant(msgId, parent, [{ type: "tool_use", id, name: step.native, input: step.args ?? {} }]);
    toolResult(parent, id, "ok");
  } else if (step.raw !== undefined) {
    process.stdout.write(`${step.raw}\n`);
  } else if (step.parallel !== undefined) {
    for (const call of step.parallel) await runTool(msgId, call, parent);
  } else if (step.agent !== undefined) {
    const id = `toolu_${(toolUses += 1)}`;
    const tool = step.agentTool ?? "Agent";
    const agentInput = step.background === "default" ? { prompt: "subtask" } : { prompt: "subtask", run_in_background: step.background === true };
    assistant(msgId, parent, [{ type: "tool_use", id, name: tool, input: agentInput }]);
    const decision = await permission(tool, agentInput);
    if (decision.behavior !== "allow") {
      toolResult(parent, id, decision.message);
      if (step.background) emit({ type: "system", subtype: "task_notification", tool_use_id: id, status: "failed", session_id: sessionId });
      return;
    }
    if (step.background) {
      emit({ type: "system", subtype: "task_started", task_id: `task-${id}`, tool_use_id: id, is_backgrounded: true, session_id: sessionId });
      toolResult(parent, id, "Async agent launched", { tool_use_result: { isAsync: true, status: "async_launched", agentId: `task-${id}` } });
      background.push({ id, steps: step.agent });
    } else {
      for (const inner of step.agent) await respond(inner, id);
      toolResult(parent, id, "subagent done");
    }
  } else if (step.structured !== undefined) {
    structured = step.structured;
    assistant(msgId, parent, [{ type: "tool_use", id: "structured", name: "StructuredOutput", input: step.structured }]);
  } else if (step.permission !== undefined) {
    const { tool, input: toolInput, subtype } = step.permission;
    const decision = await permission(tool, toolInput, subtype);
    if (decision.behavior === "allow" && step.write !== undefined) {
      writeFileSync(path.resolve(cwd, toolInput.file_path ?? toolInput.notebook_path), step.write);
    }
  } else if (step.think !== undefined) {
    for (let waited = 0; waited < step.think; waited += 100) {
      emit({ type: "system", subtype: "thinking_tokens", session_id: sessionId });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else if (step.spawnChild !== undefined) {
    const { pidFile, ignoreTerm } = step.spawnChild;
    const body = `${ignoreTerm ? "process.on('SIGTERM', () => undefined);" : ""}require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => undefined, 1000);`;
    spawn(process.execPath, ["-e", body], { stdio: "ignore" }).unref();
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
  } else if (step.orphan) {
    // Retain the parent's output pipes briefly; the harness must reap the group.
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { stdio: ["ignore", "inherit", "inherit"] });
    process.exit(0);
  } else if (step.closeOutput) {
    process.stdout.end();
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  } else if (step.hang) {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  } else if (step.error !== undefined) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: step.error,
      session_id: sessionId,
      usage: { input_tokens: 7, output_tokens: 0 },
    });
    process.exit(1);
  } else if (step.limit !== undefined) {
    // Claude Code reports a session/usage limit as an error result with subtype "success".
    emit({ type: "result", subtype: "success", is_error: true, result: step.limit, session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0 } });
    process.exit(1);
  } else if (step.crash !== undefined) {
    process.stderr.write(`${step.crash}\n`);
    process.exit(3);
  }
}

const matched = (script.byPrompt ?? []).find((entry) => prompt.includes(entry.match));
for (const step of matched?.steps ?? (resume !== undefined ? script.resume : script.start)) await respond(step, null);
result();
if (!interrupted && background.length > 0) {
  for (const { id, steps } of background) {
    for (const step of steps) await respond(step, id);
    emit({ type: "system", subtype: "task_notification", tool_use_id: id, status: "completed", session_id: sessionId });
  }
  await respond({ text: "The background subagent finished." }, null);
  result();
}
appendFileSync(transcript, `${JSON.stringify({ type: "cost-state", ...totals() })}\n`);
if (script.linkTranscript !== undefined) {
  rmSync(transcript);
  symlinkSync(script.linkTranscript, transcript);
}

scriptFinished = true;
if (inputClosed) process.exit(0);
