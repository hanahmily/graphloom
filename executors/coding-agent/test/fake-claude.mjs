// A stand-in for the Claude Code CLI in headless stream-json mode, for tests.
// FAKE_CLAUDE_SCRIPT names a JSON file `{ start: Step[], resume: Step[] }`; each
// step is one model response:
//   { text } | { tool, args } | { parallel: [{ tool, args } | { bash }] } | { bash }
//   | { structured } | { think: ms } | { hang: true } | { error } | { crash }
//   | { agent: Step[], background?: true }
// An `agent` step is an Agent tool call whose subagent makes the given responses,
// forwarded with parent_tool_use_id. A background subagent runs after the turn's
// result, then a follow-up turn reports it and ends with a second result. Each
// subagent's texts go to `<session>/subagents/agent-<id>.jsonl` beside the
// transcript, and the log records the files under `<session>/` at startup.
// Like Claude Code, running totals (`modelUsage`, `total_cost_usd`) cover the
// whole session: they are appended to the transcript as a `cost-state` record
// and restored from it on resume, unless the script sets `restoreCost: false`.
// FAKE_CLAUDE_LOG names a file that gets one JSON line per invocation.
// Both are read from the environment as it reaches the process.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id");
const cwd = process.cwd();
const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const sideDir = path.join(projectDir, sessionId);
const prompt = readFileSync(0, "utf8");
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
emit({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: server ? [{ name: "graphloom", status: connected ? "connected" : "failed" }] : [] });

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
const toolResult = (parent, id, content) =>
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: parent });

async function runTool(msgId, step, parent) {
  const id = `toolu_${(toolUses += 1)}`;
  if (step.bash !== undefined) {
    assistant(msgId, parent, [{ type: "tool_use", id, name: "Bash", input: { command: step.bash } }]);
    const out = execSync(step.bash, { cwd, encoding: "utf8" });
    toolResult(parent, id, out);
    return;
  }
  assistant(msgId, parent, [{ type: "tool_use", id, name: `mcp__graphloom__${step.tool}`, input: step.args ?? {} }]);
  const result = await rpc("tools/call", { name: step.tool, arguments: step.args ?? {} });
  toolResult(parent, id, result.content);
}

function result() {
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
    ...(structured !== undefined && flag("--json-schema") !== undefined ? { structured_output: structured } : {}),
  });
  turnResponses = 0;
}

const background = [];

async function respond(step, parent) {
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
  } else if (step.parallel !== undefined) {
    for (const call of step.parallel) await runTool(msgId, call, parent);
  } else if (step.agent !== undefined) {
    const id = `toolu_${(toolUses += 1)}`;
    assistant(msgId, parent, [{ type: "tool_use", id, name: "Agent", input: { prompt: "subtask", run_in_background: step.background === true } }]);
    if (step.background) {
      toolResult(parent, id, "Async agent launched");
      background.push({ id, steps: step.agent });
    } else {
      for (const inner of step.agent) await respond(inner, id);
      toolResult(parent, id, "subagent done");
    }
  } else if (step.structured !== undefined) {
    structured = step.structured;
    assistant(msgId, parent, [{ type: "tool_use", id: "structured", name: "StructuredOutput", input: step.structured }]);
  } else if (step.think !== undefined) {
    for (let waited = 0; waited < step.think; waited += 100) {
      emit({ type: "system", subtype: "thinking_tokens", session_id: sessionId });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
  } else if (step.crash !== undefined) {
    process.stderr.write(`${step.crash}\n`);
    process.exit(3);
  }
}

for (const step of resume !== undefined ? script.resume : script.start) await respond(step, null);
result();
if (background.length > 0) {
  for (const { id, steps } of background) {
    for (const step of steps) await respond(step, id);
    emit({ type: "system", subtype: "task_notification", tool_use_id: id, status: "completed", session_id: sessionId });
  }
  await respond({ text: "The background subagent finished." }, null);
  result();
}
appendFileSync(transcript, `${JSON.stringify({ type: "cost-state", ...totals() })}\n`);
