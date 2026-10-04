import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "@graphloom/sdk";
import { createCodexHarness, type CodexHarnessOptions } from "./codex.js";
import { codexHarnessModule, codingAgentBinding, createCodingAgentExecutor } from "./index.js";

const fakeCodex = fileURLToPath(new URL("../test/fake-codex.mjs", import.meta.url));

type Step = Record<string, unknown>;
interface Invocation {
  argv: string[];
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  schema: unknown;
}

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const RESULT = { comments: [], summary: { total_files: 1, reviewed_files: 1, skipped_files: 0, coverage_rate: 1 } };
const SCHEMA = JSON.stringify({ type: "object", properties: { comments: { type: "array" } }, required: ["comments"], additionalProperties: false });
const command = (id: string, phase: "started" | "completed") => ({
  event: { type: `item.${phase}`, item: { id, type: "command_execution", command: "ocr delegate preview", status: phase === "started" ? "in_progress" : "completed" } },
});
const turn = (usage = { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 50 }) => [
  { event: { type: "thread.started", thread_id: "t1" } },
  { event: { type: "turn.started" } },
  command("item_1", "started"),
  command("item_1", "completed"),
  { event: { type: "item.completed", item: { id: "item_2", type: "agent_message", text: JSON.stringify(RESULT) } } },
  { last: JSON.stringify(RESULT) },
  { event: { type: "turn.completed", usage } },
];

async function setup(overrides: CodexHarnessOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-codex-harness-"));
  temps.push(dir);
  const worktree = path.join(dir, "worktree");
  const scriptFile = path.join(dir, "script.json");
  const logFile = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "codex");
  await mkdir(worktree);
  // Codex gets a minimal environment, so the fake's settings travel in its wrapper.
  await writeFile(bin, `#!/bin/sh\nexport FAKE_CODEX_SCRIPT="${scriptFile}" FAKE_CODEX_LOG="${logFile}"\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, "utf8");
  await chmod(bin, 0o755);
  const executor = createCodingAgentExecutor(createCodexHarness({ command: bin, killGraceMs: 500, ...overrides }));
  let reservations = 0;
  const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: worktree,
    artifactDir: dir,
    readOnly: true,
    usage: {
      reserveModelCall: async () => {
        reservations += 1;
        return true;
      },
    },
    ...over,
  });
  const script = (steps: Step[]) => writeFile(scriptFile, JSON.stringify(steps), "utf8");
  const invocations = async (): Promise<Invocation[]> =>
    existsSync(logFile) ? (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Invocation) : [];
  return { worktree, executor, ctx, script, invocations, reservations: () => reservations };
}

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

const flagValue = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Codex harness", () => {
  it("runs codex exec read-only in the worktree and returns its JSON result and usage", async () => {
    vi.stubEnv("GRAPHLOOM_TEST_SECRET", "s3cret");
    vi.stubEnv("CODEX_EXTRA", "passed");
    const h = await setup({ model: "gpt-test", reasoningEffort: "high", codexHome: "/tmp/codex-home", passEnv: ["CODEX_EXTRA"] });
    await h.script(turn());
    const result = await h.executor.execute({ assignment: "Review the change", resultSchema: SCHEMA }, h.ctx());
    expect(result).toMatchObject({ status: "ok", summary: "Codex submitted a structured result" });
    expect(payload(result)).toMatchObject({
      harness: "codex",
      output: RESULT,
      usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 50, cacheWriteTokens: 0 },
      modelCalls: 2,
    });
    const [run] = await h.invocations();
    expect(run!.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(flagValue(run!.argv, "--sandbox")).toBe("read-only");
    expect(flagValue(run!.argv, "--cd")).toBe(h.worktree);
    expect(flagValue(run!.argv, "--model")).toBe("gpt-test");
    expect(flagValue(run!.argv, "--config")).toBe('model_reasoning_effort="high"');
    expect(run!.argv.at(-1)).toBe("-");
    expect(run!.schema).toEqual(JSON.parse(SCHEMA));
    expect(run!.prompt).toContain("Review the change");
    expect(run!.prompt).toContain("read-only");
    expect(run!.prompt).toContain("only the JSON object");
    expect(run!.env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(run!.env.CODEX_EXTRA).toBe("passed");
    expect(run!.env.GRAPHLOOM_TEST_SECRET).toBeUndefined();
  });

  it("bakes a result contract's reference ids into the schema, and fails as a contract violation on an unreconcilable miss", async () => {
    const h = await setup();
    const resultContract = {
      name: "plan-review-v1",
      schema: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] },
      references: ["finding"],
      knownReferences: { finding: { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
    };
    await h.script([...turn().slice(0, -2), { last: JSON.stringify({ finding: "P1" }) }, turn().at(-1)!]);
    const ok = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract }));
    expect(ok).toMatchObject({ status: "ok" });
    const [first] = await h.invocations();
    expect((first!.schema as { properties: { finding: { enum: string[] } } }).properties.finding).toMatchObject({ enum: ["", "P1"] });

    await h.script([...turn().slice(0, -2), { last: JSON.stringify({ finding: "a made-up finding" }) }, turn().at(-1)!]);
    const violated = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract }));
    expect(violated).toMatchObject({ status: "failed", failureKind: "contract_violation" });
  });

  it("serves only read-only jobs without graph tools", async () => {
    const h = await setup();
    await h.script(turn());
    await expect(h.executor.execute({ assignment: "edit" }, h.ctx({ readOnly: false }))).rejects.toThrow("read-only jobs only");
    const tools = { bindings: [{ name: "read_comments", effect: "read" as const }], call: async () => ({ status: "ok" as const, summary: "" }) };
    await expect(h.executor.execute({ assignment: "read" }, h.ctx({ tools }))).rejects.toThrow("cannot serve graph tools");
    expect(await h.invocations()).toEqual([]);
  });

  it("fails a run whose final message is not a JSON object", async () => {
    const h = await setup();
    await h.script([{ last: "Looks fine to me." }, { event: { type: "turn.completed", usage: {} } }]);
    const result = await h.executor.execute({ assignment: "Review", resultSchema: SCHEMA }, h.ctx());
    expect(result).toMatchObject({ status: "failed", summary: "agent finished without submitting a structured result" });
    await h.script([{ last: "not json" }, { event: { type: "turn.completed", usage: {} } }]);
    expect(await h.executor.execute({ assignment: "Review", resultSchema: "code-review-v1" }, h.ctx())).toMatchObject({
      status: "failed",
      summary: "agent finished without submitting a code-review-v1 result",
    });
  });

  it("reports a failed turn and a failed exit", async () => {
    const failedTurn = await setup();
    await failedTurn.script([{ event: { type: "turn.failed", error: { message: "usage limit reached" } } }, { exit: 1 }]);
    expect(await failedTurn.executor.execute({ assignment: "Review" }, failedTurn.ctx())).toMatchObject({
      status: "failed",
      summary: "Codex run failed: usage limit reached",
    });
    const crashed = await setup();
    await crashed.script([{ stderr: "not logged in" }, { exit: 1 }]);
    expect(await crashed.executor.execute({ assignment: "Review" }, crashed.ctx())).toMatchObject({ status: "failed", summary: "Codex run failed: not logged in" });
  });

  it("stops a silent Codex, but not while a command runs", async () => {
    const quiet = await setup({ responseTimeoutMs: 300 });
    await quiet.script([{ event: { type: "turn.started" } }, { hang: true }]);
    expect(await quiet.executor.execute({ assignment: "Review" }, quiet.ctx())).toMatchObject({ status: "failed", summary: "Codex stalled: no activity for 0.3s" });

    const busy = await setup({ responseTimeoutMs: 300 });
    await busy.script([command("item_1", "started"), { sleepMs: 800 }, command("item_1", "completed"), { last: "done" }, { event: { type: "turn.completed", usage: {} } }]);
    expect(await busy.executor.execute({ assignment: "Review" }, busy.ctx())).toMatchObject({ status: "ok", summary: "done" });
  });

  it("reserves budget before launching and stops Codex when a later request is refused", async () => {
    const none = await setup();
    await none.script(turn());
    expect(await none.executor.execute({ assignment: "Review" }, none.ctx({ usage: { reserveModelCall: async () => false } }))).toMatchObject({
      status: "failed",
      summary: "model request budget exhausted",
    });
    expect(await none.invocations()).toEqual([]);

    const h = await setup();
    let grants = 1;
    await h.script([command("item_1", "started"), command("item_1", "completed"), { hang: true }]);
    expect(await h.executor.execute({ assignment: "Review" }, h.ctx({ usage: { reserveModelCall: async () => grants-- > 0 } }))).toMatchObject({
      status: "failed",
      summary: "model request budget exhausted",
    });
  });

  it("stops the Codex process when the job is cancelled", async () => {
    const h = await setup({ responseTimeoutMs: 0 });
    const abort = new AbortController();
    await h.script([{ event: { type: "turn.started" } }, { hang: true }]);
    const started = Date.now();
    setTimeout(() => abort.abort(), 300);
    expect(await h.executor.execute({ assignment: "Review" }, h.ctx({ signal: abort.signal }))).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a descendant left in Codex's process group when Codex completes", async () => {
    const h = await setup();
    const pidFile = path.join(h.worktree, "..", "child.pid");
    await h.script([{ spawnChild: { pidFile, ignoreTerm: false } }, ...turn()]);
    expect(await h.executor.execute({ assignment: "Review" }, h.ctx())).toMatchObject({ status: "ok" });
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  });

  it("kills a descendant that ignores SIGTERM after Codex exits on cancellation", async () => {
    const h = await setup({ responseTimeoutMs: 0 });
    const pidFile = path.join(h.worktree, "..", "child.pid");
    const abort = new AbortController();
    await h.script([{ spawnChild: { pidFile, ignoreTerm: true } }, { event: { type: "turn.started" } }, { hang: true }]);
    setTimeout(() => abort.abort(), 300);
    expect(await h.executor.execute({ assignment: "Review" }, h.ctx({ signal: abort.signal }))).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  });

  it("is bound with its settings as executor environment", () => {
    const binding = codingAgentBinding({ harness: codexHarnessModule, codex: { command: "/opt/codex", model: "m", reasoningEffort: "high", codexHome: "/h", passEnv: ["A", "B"] } });
    expect(binding.env).toMatchObject({
      GRAPHLOOM_CODEX_BIN: "/opt/codex",
      GRAPHLOOM_CODEX_MODEL: "m",
      GRAPHLOOM_CODEX_REASONING_EFFORT: "high",
      GRAPHLOOM_CODEX_HOME: "/h",
      GRAPHLOOM_CODEX_PASS_ENV: "A,B",
    });
    expect(() => codingAgentBinding({ harness: codexHarnessModule, codex: { codexHome: "rel" } })).toThrow("absolute");
    expect(() => codingAgentBinding({ harness: codexHarnessModule, timeoutMs: 1_000 })).toThrow("codex.responseTimeoutMs");
  });
});
