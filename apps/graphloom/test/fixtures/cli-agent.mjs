#!/usr/bin/env node
// A deterministic Claude Code protocol peer: writes or independently reviews the greeting.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
let prompt;
if (argv.includes("--input-format") && flag("--input-format") === "stream-json") {
  const lines = createInterface({ input: process.stdin });
  prompt = await new Promise((resolve) => {
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "user") resolve(event.message.content);
      if (event.type === "control_request") {
        process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: {} } })}\n`);
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
const sessionId = flag(argv.includes("--resume") ? "--resume" : "--session-id");
const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "cli-test");
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ role: "assistant", content: output })}\n`);
process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "reply-1", content: [{ type: "text", text: output.summary }] } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: output, session_id: sessionId })}\n`, () => process.exit(0));
