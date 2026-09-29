// Stands in for `codex exec --json`: logs its invocation, prints the scripted
// JSONL events, and writes the scripted last message to --output-last-message.
// Steps: {event}, {sleepMs}, {hang: true}, {last: "..."}, {stderr: "..."}, {exit: code},
// {spawnChild: {pidFile, ignoreTerm}}: a descendant in Codex's process group with
// its stdio redirected, which writes its pid once ready and then runs forever.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const schemaFile = flag("--output-schema");
appendFileSync(
  process.env.FAKE_CODEX_LOG,
  `${JSON.stringify({
    argv,
    prompt: Buffer.concat(chunks).toString("utf8"),
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FAKE_CODEX_"))),
    schema: schemaFile !== undefined ? JSON.parse(readFileSync(schemaFile, "utf8")) : null,
  })}\n`,
);
const steps = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, "utf8"));
for (const step of steps) {
  if (step.event !== undefined) process.stdout.write(`${JSON.stringify(step.event)}\n`);
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
