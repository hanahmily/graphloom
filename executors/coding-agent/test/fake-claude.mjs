// A stand-in for the Claude Code CLI in headless stream-json mode, for tests.
// FAKE_CLAUDE_SCRIPT names a JSON file `{ start: Step[], resume: Step[] }`; each
// step is one model response:
//   { text } | { tool, args } | { parallel: [{ tool, args } | { bash }] } | { bash }
//   | { structured } | { think: ms } | { hang: true } | { error } | { crash }
// FAKE_CLAUDE_LOG names a file that gets one JSON line per invocation.
// Both are read from the environment as it reaches the process.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
const prompt = readFileSync(0, "utf8");

let history = [];
if (resume !== undefined) {
  if (!existsSync(transcript)) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
  }
  history = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).text);
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

const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
let responses = 0;
let lastText = "";
let structured;
let toolUses = 0;

async function runTool(msgId, step) {
  const id = `toolu_${(toolUses += 1)}`;
  if (step.bash !== undefined) {
    emit({ type: "assistant", message: { id: msgId, content: [{ type: "tool_use", id, name: "Bash", input: { command: step.bash } }] } });
    const out = execSync(step.bash, { cwd, encoding: "utf8" });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] } });
    return;
  }
  emit({ type: "assistant", message: { id: msgId, content: [{ type: "tool_use", id, name: `mcp__graphloom__${step.tool}`, input: step.args ?? {} }] } });
  const result = await rpc("tools/call", { name: step.tool, arguments: step.args ?? {} });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result.content }] } });
}

for (const step of resume !== undefined ? script.resume : script.start) {
  const msgId = `msg_${(responses += 1)}`;
  if (step.text !== undefined) {
    lastText = step.text;
    record(step.text);
    emit({ type: "assistant", message: { id: msgId, content: [{ type: "text", text: step.text }] } });
  } else if (step.tool !== undefined || step.bash !== undefined) {
    await runTool(msgId, step);
  } else if (step.parallel !== undefined) {
    for (const call of step.parallel) await runTool(msgId, call);
  } else if (step.structured !== undefined) {
    structured = step.structured;
    emit({ type: "assistant", message: { id: msgId, content: [{ type: "tool_use", id: "structured", name: "StructuredOutput", input: step.structured }] } });
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

emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: structured !== undefined ? JSON.stringify(structured) : lastText,
  session_id: sessionId,
  num_turns: responses,
  usage: { input_tokens: 10 * responses, output_tokens: 5 * responses, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  total_cost_usd: 0.0125,
  ...(structured !== undefined && flag("--json-schema") !== undefined ? { structured_output: structured } : {}),
});
