import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "@graphloom/sdk";
import { createCodexHarness, type CodexHarnessOptions } from "./codex.js";
import { CONTINUATION_NOTICE, codexHarnessModule, codingAgentBinding, createCodingAgentExecutor } from "./index.js";

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
    // The default watchdog is fitted inside each job's wall clock; an explicit one must fit the default job.
    expect(() => codingAgentBinding({ harness: codexHarnessModule, timeoutMs: 1_000 })).not.toThrow();
    expect(() => codingAgentBinding({ harness: codexHarnessModule, timeoutMs: 1_000, codex: { responseTimeoutMs: 1_000 } })).toThrow("codex.responseTimeoutMs");
  });
});

describe("Codex sessions", () => {
  const THREAD = "01a1765e-0df0-7d32-a8d5-be19c4addf58";
  const started = { event: { type: "thread.started", thread_id: THREAD } };
  const answer = (text: string) => [
    { event: { type: "turn.started" } },
    { event: { type: "item.completed", item: { id: "item_9", type: "agent_message", text } } },
    { last: text },
    { event: { type: "turn.completed", usage: {} } },
  ];
  async function sessionSetup(overrides: CodexHarnessOptions = {}) {
    const home = await mkdtemp(path.join(os.tmpdir(), "gl-codex-home-"));
    temps.push(home);
    const h = await setup({ codexHome: home, ...overrides });
    return { ...h, home, sessions: path.join(home, "..", `${path.basename(home)}-sessions`) };
  }
  const rollouts = async (home: string) => {
    const dir = path.join(home, "sessions");
    if (!existsSync(dir)) return [];
    return (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".jsonl"));
  };

  it("keeps the thread Codex names, saves its rollout, and resumes it with `codex exec resume`", async () => {
    const h = await sessionSetup({ model: "gpt-test" });
    temps.push(h.sessions);
    await h.script([started, ...answer("first turn done")]);
    const first = await h.executor.execute({ assignment: "Review the first draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = `codex-${THREAD}`;
    expect(first).toMatchObject({ status: "ok", summary: "first turn done", sessionRef: ref });
    const [run] = await h.invocations();
    // Codex persists the thread only when the controller can continue it.
    expect(run!.argv).not.toContain("--ephemeral");
    expect((await readdir(h.sessions)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
    const meta = JSON.parse(await readFile(path.join(h.sessions, `${ref}.json`), "utf8")) as { rollout: string; model: string };
    expect(meta).toEqual({ rollout: expect.stringMatching(new RegExp(`^sessions/\\d{4}/\\d{2}/\\d{2}/rollout-.*-${THREAD}\\.jsonl$`)), model: "gpt-test" });

    // The saved copy is authoritative: the thread resumes even after Codex's own store lost it.
    await rm(path.join(h.home, "sessions"), { recursive: true, force: true });
    await h.script([started, ...answer("second turn done")]);
    const second = await h.executor.execute({ assignment: "Review it again" }, h.ctx({ session: { dir: h.sessions, resume: ref } }));
    expect(second).toMatchObject({ status: "ok", summary: "second turn done", sessionRef: ref });
    expect(payload(second)).toMatchObject({ continued: true, sessionRef: ref });
    const resumed = (await h.invocations()).at(-1)! as Invocation & { history: string[] };
    expect(resumed.argv).toEqual([
      "exec", "--sandbox", "read-only", "--cd", h.worktree,
      "resume", "--json", "--skip-git-repo-check", "--output-last-message", expect.any(String), "--model", "gpt-test",
      THREAD, "-",
    ]);
    expect(resumed.history).toEqual([expect.stringContaining("Review the first draft")]);
    expect(resumed.prompt.startsWith(CONTINUATION_NOTICE)).toBe(true);
    expect(await rollouts(h.home)).toEqual([meta.rollout.slice("sessions/".length)]);
  });

  it("saves and reports the thread while the turn still runs, so a job killed before it returns leaves a resumable one", async () => {
    const h = await sessionSetup({ responseTimeoutMs: 0 });
    temps.push(h.sessions);
    const controller = new AbortController();
    await h.script([started, { event: { type: "turn.started" } }, command("item_1", "started"), { hang: true }]);
    const kept: string[] = [];
    const running = h.executor.execute(
      { assignment: "Review the first draft" },
      h.ctx({ signal: controller.signal, session: { dir: h.sessions }, keepSession: (ref) => kept.push(ref) }),
    );
    await expect.poll(() => kept.length, { timeout: 5_000 }).toBe(1);
    const ref = `codex-${THREAD}`;
    expect(kept).toEqual([ref]);
    // What a host that kills the job now would be left with.
    const killed = `${h.sessions}-killed`;
    temps.push(killed);
    await mkdir(killed);
    for (const name of await readdir(h.sessions)) await writeFile(path.join(killed, name), await readFile(path.join(h.sessions, name)));
    expect((await readdir(killed)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
    expect(await readFile(path.join(killed, `${ref}.jsonl`), "utf8")).toContain("command_execution");
    controller.abort();
    expect(await running).toMatchObject({ status: "failed", summary: "agent session aborted" });

    await rm(path.join(h.home, "sessions"), { recursive: true, force: true });
    await h.script([started, ...answer("resumed after the kill")]);
    const resumed = await h.executor.execute({ assignment: "Finish the review" }, h.ctx({ session: { dir: killed, resume: ref } }));
    expect(resumed).toMatchObject({ status: "ok", summary: "resumed after the kill", sessionRef: ref });
    expect(((await h.invocations()).at(-1)! as Invocation & { history: string[] }).history).toEqual([expect.stringContaining("Review the first draft")]);
  });

  it("refuses to resume a missing, corrupt, or differently configured thread instead of starting fresh", async () => {
    const h = await sessionSetup({ model: "gpt-test" });
    temps.push(h.sessions);
    await h.script([started, ...answer("first turn done")]);
    const first = await h.executor.execute({ assignment: "Review" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;
    const restore = (resume: string, executor = h.executor) => executor.execute({ assignment: "again" }, h.ctx({ session: { dir: h.sessions, resume } }));
    const failure = (resume: string, reason: string) => ({ status: "failed", summary: `agent session ${resume} could not be restored: ${reason}` });
    const runs = (await h.invocations()).length;

    const other = createCodingAgentExecutor(createCodexHarness({ command: path.join(h.worktree, "..", "codex"), codexHome: h.home, model: "gpt-other" }));
    expect(await restore(ref, other)).toEqual(failure(ref, `saved session ${ref} ran on model gpt-test; this job asks for model gpt-other`));
    expect(await restore("codex-not-a-thread")).toEqual(failure("codex-not-a-thread", "malformed session ref codex-not-a-thread"));
    expect(await restore(`codex-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`)).toEqual(
      failure(`codex-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, `no saved session for codex-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`),
    );
    await writeFile(path.join(h.sessions, `${ref}.json`), JSON.stringify({ rollout: "../../escape.jsonl", model: "gpt-test" }), "utf8");
    expect(await restore(ref)).toEqual(failure(ref, `saved session ${ref} is corrupt`));
    expect((await h.invocations()).length).toBe(runs);
  });

  it("keeps no session without a session directory, and none when Codex never names its thread", async () => {
    const bare = await sessionSetup();
    await bare.script([started, ...answer("done")]);
    const result = await bare.executor.execute({ assignment: "Review" }, bare.ctx());
    expect(result).not.toHaveProperty("sessionRef");
    expect((await bare.invocations())[0]!.argv).toContain("--ephemeral");
    expect(await rollouts(bare.home)).toEqual([]);

    const unnamed = await sessionSetup();
    temps.push(unnamed.sessions);
    await unnamed.script(answer("done"));
    const kept: string[] = [];
    const quiet = await unnamed.executor.execute({ assignment: "Review" }, unnamed.ctx({ session: { dir: unnamed.sessions }, keepSession: (ref) => kept.push(ref) }));
    expect(quiet).toMatchObject({ status: "ok" });
    expect(quiet).not.toHaveProperty("sessionRef");
    expect(kept).toEqual([]);
  });
});

describe("transient retry and native tools (Codex)", () => {
  async function attempt(steps: Step[]) {
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_ATTEMPTS", "2");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_BASE_DELAY_MS", "1");
    vi.stubEnv("GRAPHLOOM_CODING_RETRY_MAX_DELAY_MS", "2");
    const h = await setup();
    execFileSync("git", ["-C", h.worktree, "init", "-q"]);
    await h.script([...steps, { event: { type: "turn.failed", error: { message: "Selected model is at capacity." } } }, { exit: 1 }]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx());
    return { result: result as { summary: string }, runs: (await h.invocations()).length };
  }
  const exec = (command: string) => ({ event: { type: "item.started", item: { id: "c1", type: "command_execution", command } } });

  it("retries a capacity failure when the failed try ran no tools", async () => {
    expect((await attempt([])).runs).toBe(2);
  });

  it("does not retry after any shell command, even a plain read", async () => {
    const { result, runs } = await attempt([exec('/bin/bash -lc "touch done.txt"')]);
    expect(runs).toBe(1);
    expect(result.summary).toContain("not retried: the failed try ran a native tool (command_execution)");
    expect((await attempt([exec("cat a.txt")])).runs).toBe(1);
    expect((await attempt([exec("ls\nrm /tmp/example")])).runs).toBe(1);
  });

  it("does not retry after an apply_patch or web search item either", async () => {
    expect((await attempt([{ event: { type: "item.started", item: { id: "p1", type: "file_change" } } }])).runs).toBe(1);
    expect((await attempt([{ event: { type: "item.started", item: { id: "w1", type: "web_search" } } }])).runs).toBe(1);
  });

  it("does not retry when the event stream is unparseable", async () => {
    const { result, runs } = await attempt([{ raw: "garbage {" }]);
    expect(runs).toBe(1);
    expect(result.summary).toContain("did not report which native tools");
  });
});
