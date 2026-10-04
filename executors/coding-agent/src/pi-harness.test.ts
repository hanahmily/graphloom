import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext, ToolCallRequest, ToolCallResult } from "@graphloom/sdk";
import { CONTINUATION_NOTICE, createCodingAgentExecutor } from "./index.js";
import { createPiHarness, PI_MODEL_ENV, PI_PROVIDER_ENV, type PiHarnessOptions } from "./pi.js";

interface FauxContext {
  messages: Array<{ role: string; content: unknown }>;
}
type FauxStep = unknown | ((context: FauxContext) => unknown);
interface FauxModule {
  fauxProvider(options?: { provider?: string }): {
    provider: unknown;
    getModel(): { id: string };
    state: { callCount: number };
    setResponses(responses: FauxStep[]): void;
  };
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}

/** First `<node_modules>/<pkg>` visible from `fromFile` (works for ESM-only packages). */
function findPackageDir(fromFile: string, pkg: string): string {
  for (const dir of createRequire(fromFile).resolve.paths(pkg) ?? []) {
    const candidate = path.join(dir, pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${pkg} not found from ${fromFile}`);
}

/** Pi's own pi-ai instance, wherever npm placed it. */
async function loadPiAi(): Promise<FauxModule> {
  const piDir = findPackageDir(import.meta.filename, "@earendil-works/pi-coding-agent");
  const aiDir = findPackageDir(path.join(piDir, "package.json"), "@earendil-works/pi-ai");
  return (await import(pathToFileURL(path.join(aiDir, "dist", "index.js")).href)) as FauxModule;
}

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

let providerSeq = 0;

async function setup(harnessOverrides: PiHarnessOptions = {}) {
  const ai = await loadPiAi();
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-harness-"));
  temps.push(dir);
  const worktree = path.join(dir, "worktree");
  const sessions = path.join(dir, "sessions");
  await mkdir(worktree);
  const provider = `faux-coding-${(providerSeq += 1)}`;
  const faux = ai.fauxProvider({ provider });
  const keysSet: Array<[string, string]> = [];
  const executor = createCodingAgentExecutor(
    createPiHarness({
      provider,
      modelId: faux.getModel().id,
      agentDir: dir,
      async createModelRuntime(agentDir) {
        const runtime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: path.join(agentDir, "models.json"),
        });
        runtime.registerNativeProvider(faux.provider as never);
        const setKey = runtime.setRuntimeApiKey.bind(runtime);
        runtime.setRuntimeApiKey = async (id, key, options) => {
          keysSet.push([id, key]);
          await setKey(id, key, options);
        };
        return runtime;
      },
      ...harnessOverrides,
    }),
  );
  const toolCalls: ToolCallRequest[] = [];
  const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: worktree,
    artifactDir: dir,
    writeScope: ["notes.md"],
    usage: { reserveModelCall: async () => true },
    tools: {
      bindings: [{ name: "read_comments", effect: "read", description: "Read an issue's comments" }],
      async call(req): Promise<ToolCallResult> {
        toolCalls.push(req);
        return { status: "ok", summary: "2 comments", childOperationId: `child-${toolCalls.length}` };
      },
    },
    ...over,
  });
  const say = (text: string) => ai.fauxAssistantMessage(text);
  const use = (name: string, args: Record<string, unknown>) =>
    ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });
  return { ai, dir, worktree, sessions, provider, faux, executor, ctx, toolCalls, keysSet, say, use };
}

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

function lastMessageText(context: FauxContext): string {
  return JSON.stringify(context.messages.at(-1)?.content ?? "");
}

describe("Pi coding harness", () => {
  it("sends graph tool calls through the controller and shows the model the recorded result", async () => {
    const h = await setup();
    let seen = "";
    h.faux.setResponses([
      h.use("read_comments", { issue: 7 }),
      (context: FauxContext) => {
        seen = lastMessageText(context);
        return h.say("Summarized 2 comments");
      },
    ]);
    const result = await h.executor.execute({ assignment: "Summarize issue 7" }, h.ctx());

    expect(result).toMatchObject({ status: "ok", summary: "Summarized 2 comments" });
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0]).toMatchObject({ tool: "read_comments", input: { issue: 7 } });
    expect(h.toolCalls[0]!.toolCallId).toMatch(/^pi-[0-9a-f]{8}-.+/);
    expect(h.toolCalls[0]!.toolCallId.length).toBeLessThanOrEqual(128);
    expect(seen).toContain("child-1");
    expect(seen).toContain("2 comments");
    expect(payload(result)).toMatchObject({ harness: "pi", modelCalls: 2, toolCalls: [{ childOperationId: "child-1" }] });
  });

  it("gives the agent Pi's shell and file tools in the worktree", async () => {
    const h = await setup();
    const results: string[] = [];
    const collect = (next: unknown) => (context: FauxContext) => {
      results.push(lastMessageText(context));
      return next;
    };
    h.faux.setResponses([
      h.use("bash", { command: "mkdir -p src && printf 'export const x = 1;\\n' > src/x.ts && echo built" }),
      collect(h.use("write", { path: "notes.md", content: "summary\n" })),
      collect(h.use("edit", { path: "notes.md", edits: [{ oldText: "summary", newText: "final summary" }] })),
      collect(h.use("ls", { path: "src" })),
      collect(h.use("read", { path: "notes.md" })),
      collect(h.say("wrote code and notes")),
    ]);
    const result = await h.executor.execute({ assignment: "write code" }, h.ctx());

    expect(result).toMatchObject({ status: "ok", summary: "wrote code and notes" });
    expect(results[0]).toContain("built");
    expect(results[3]).toContain("x.ts");
    expect(results[4]).toContain("final summary");
    expect(await readFile(path.join(h.worktree, "src/x.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(await readFile(path.join(h.worktree, "notes.md"), "utf8")).toBe("final summary\n");
  });

  it("runs Pi's shell commands with a minimal environment, never the executor's secrets", async () => {
    vi.stubEnv("GRAPHLOOM_GITHUB_LIVE_TOKEN", "ghp-executor-secret");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("CUSTOM_TOOL_HOME", "/opt/custom");
    vi.stubEnv("OTHER_TOOL_HOME", "/opt/other");
    const printEnv = "env | grep -E '^(GRAPHLOOM_|PI_|LC_ALL|HOME|PATH|CUSTOM_|OTHER_)' | sort";
    const outputs: string[] = [];
    const run = (h: Awaited<ReturnType<typeof setup>>) => {
      h.faux.setResponses([
        h.use("bash", { command: printEnv }),
        (context: FauxContext) => {
          outputs.push(lastMessageText(context));
          return h.say("listed");
        },
      ]);
      return h.executor.execute({ assignment: "list the environment" }, h.ctx());
    };
    await run(await setup({ passEnv: ["CUSTOM_TOOL_HOME"] }));
    vi.stubEnv("GRAPHLOOM_PI_PASS_ENV", "CUSTOM_TOOL_HOME, OTHER_TOOL_HOME");
    await run(await setup());

    const [chosen, configured] = outputs;
    for (const kept of ["HOME=", "PATH=", "LC_ALL=C.UTF-8", "CUSTOM_TOOL_HOME=/opt/custom"]) expect(chosen).toContain(kept);
    for (const dropped of ["ghp-executor-secret", "GRAPHLOOM_", "PI_", "OTHER_TOOL_HOME"]) expect(chosen).not.toContain(dropped);
    expect(configured).toContain("OTHER_TOOL_HOME=/opt/other");
    expect(configured).not.toContain("ghp-executor-secret");
  });

  it("tells the agent its write scope, or that the job is read-only", async () => {
    const h = await setup();
    const prompts: string[] = [];
    const record = (context: FauxContext) => {
      prompts.push(lastMessageText(context));
      return h.say("ok");
    };
    h.faux.setResponses([record, record]);
    await h.executor.execute({ assignment: "work" }, h.ctx());
    await h.executor.execute({ assignment: "look" }, h.ctx({ readOnly: true, writeScope: undefined as never }));

    expect(prompts[0]).toContain("Change only these paths: notes.md.");
    expect(prompts[1]).toContain("This job is read-only");
    expect(prompts[1]).not.toContain("Change only these paths");
  });

  it("reserves budget before every provider request and ends the session on refusal", async () => {
    const h = await setup();
    let grants = 1;
    h.faux.setResponses([h.use("read_comments", { issue: 1 }), h.say("never sent")]);
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({ usage: { reserveModelCall: async () => grants-- > 0 } }),
    );

    expect(result).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
    expect(h.faux.state.callCount).toBe(1);
    expect(h.toolCalls).toHaveLength(1);
    expect(payload(result)).toMatchObject({ modelCalls: 1 });
  });

  it("sends no provider request without host budget accounting", async () => {
    const h = await setup();
    h.faux.setResponses([h.say("never sent")]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({ usage: undefined as never }));
    expect(result).toMatchObject({ status: "failed", summary: "model request budget exhausted" });
    expect(h.faux.state.callCount).toBe(0);
  });

  it("stops the session when the job is cancelled", async () => {
    const h = await setup();
    const controller = new AbortController();
    h.faux.setResponses([h.use("read_comments", { issue: 1 }), h.say("never sent")]);
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({
        signal: controller.signal,
        tools: {
          bindings: [{ name: "read_comments", effect: "read" }],
          async call() {
            controller.abort();
            return { status: "ok", summary: "read" };
          },
        },
      }),
    );
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(h.faux.state.callCount).toBe(1);
  });

  it("does not start a cancelled job", async () => {
    const h = await setup();
    const controller = new AbortController();
    controller.abort();
    h.faux.setResponses([h.say("never sent")]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx({ signal: controller.signal }));
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
    expect(h.faux.state.callCount).toBe(0);
  });

  it("returns structured output submitted against an inline result schema", async () => {
    const h = await setup();
    const schema = JSON.stringify({
      type: "object",
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
    });
    let rejection = "";
    h.faux.setResponses([
      h.use("submit_result", { note: "no greeting" }),
      (context: FauxContext) => {
        rejection = lastMessageText(context);
        return h.use("submit_result", { greeting: "hello" });
      },
      h.say("never sent"),
    ]);
    const result = await h.executor.execute({ assignment: "greet", resultSchema: schema }, h.ctx());

    expect(rejection).toContain("greeting");
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { greeting: "hello" } });
    expect(h.faux.state.callCount).toBe(2);
  });

  it("fails a job whose agent never submits the requested result", async () => {
    const h = await setup();
    h.faux.setResponses([h.say("I wrote it")]);
    const result = await h.executor.execute({ assignment: "write", resultSchema: "writer-result-v1" }, h.ctx());
    expect(result).toMatchObject({
      status: "failed",
      summary: "agent finished without submitting a writer-result-v1 result: I wrote it",
    });
  });

  const findingContract = {
    name: "plan-review-v1",
    schema: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] },
    references: ["finding"],
    knownReferences: { finding: { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
  };

  it("reconciles a reference written as its shown description, in one turn", async () => {
    const h = await setup();
    h.faux.setResponses([h.use("submit_result", { finding: "metric counts running actions" }), h.say("never sent")]);
    const result = await h.executor.execute(
      { assignment: "review" },
      h.ctx({ resultContract: findingContract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { finding: "P1" } });
    expect(h.faux.state.callCount).toBe(1);
  });

  it("rejects a reference outside the shown set in-turn, and accepts the corrected retry", async () => {
    const h = await setup();
    let rejection = "";
    h.faux.setResponses([
      h.use("submit_result", { finding: "a made-up finding" }),
      (context: FauxContext) => {
        rejection = lastMessageText(context);
        return h.use("submit_result", { finding: "P1" });
      },
      h.say("never sent"),
    ]);
    const result = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract: findingContract }));
    expect(rejection).toContain("P1");
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { finding: "P1" } });
    expect(h.faux.state.callCount).toBe(2);
  });

  it("fails the job as a contract violation once in-turn retries are spent on an unreconcilable reference", async () => {
    const h = await setup();
    h.faux.setResponses([
      h.use("submit_result", { finding: "nope 1" }),
      h.use("submit_result", { finding: "nope 2" }),
      h.use("submit_result", { finding: "nope 3" }),
      h.say("never sent"),
    ]);
    const result = await h.executor.execute({ assignment: "review" }, h.ctx({ resultContract: findingContract }));
    expect(result).toMatchObject({
      status: "failed",
      failureKind: "contract_violation",
      summary: expect.stringContaining("plan-review-v1"),
    });
    expect(h.faux.state.callCount).toBe(3);
  });

  it("saves the session under sessionDir and resumes it with its history", async () => {
    const h = await setup();
    let history = "";
    h.faux.setResponses([
      h.say("first turn done"),
      (context: FauxContext) => {
        history = JSON.stringify(context.messages);
        return h.say("second turn done");
      },
    ]);
    const first = await h.executor.execute({ assignment: "Write the first draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef?: string }).sessionRef;
    expect(ref).toMatch(/^pi-[0-9a-f]{12}$/);
    expect((await readdir(h.sessions)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
    expect(JSON.parse(await readFile(path.join(h.sessions, `${ref}.json`), "utf8"))).toEqual({
      provider: h.provider,
      modelId: h.faux.getModel().id,
      systemPromptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const second = await h.executor.execute(
      { assignment: "Revise the draft" },
      h.ctx({ session: { dir: h.sessions, resume: ref! } }),
    );
    expect(second).toMatchObject({ status: "ok", summary: "second turn done", sessionRef: ref });
    expect(history).toContain("Write the first draft");
    expect(history).toContain("first turn done");
    expect(history).toContain(CONTINUATION_NOTICE.slice(0, 40));
    expect((await readdir(h.sessions)).sort()).toEqual([`${ref}.json`, `${ref}.jsonl`]);
  });

  it("refuses to resume a session under a different model or system prompt, before any request", async () => {
    const h = await setup();
    h.faux.setResponses([h.say("first turn done")]);
    const first = await h.executor.execute({ assignment: "draft" }, h.ctx({ session: { dir: h.sessions } }));
    const ref = (first as { sessionRef: string }).sessionRef;
    const model = `${h.provider}/${h.faux.getModel().id}`;
    const resume = (executor: typeof h.executor, harnessOptions?: Record<string, unknown>) =>
      executor.execute(
        { assignment: "revise", ...(harnessOptions !== undefined ? { harnessOptions } : {}) },
        h.ctx({ session: { dir: h.sessions, resume: ref } }),
      );
    const restoreFailure = (reason: string) => ({ status: "failed", summary: `agent session ${ref} could not be restored: ${reason}` });

    h.faux.setResponses([h.say("never sent")]);
    expect(await resume(h.executor, { modelId: "another-model" })).toEqual(
      restoreFailure(`saved session ${ref} ran on ${model}; this job asks for ${h.provider}/another-model`),
    );
    const switched = (await setup({ provider: "another-provider", modelId: h.faux.getModel().id })).executor;
    expect(await resume(switched)).toEqual(
      restoreFailure(`saved session ${ref} ran on ${model}; this job asks for another-provider/${h.faux.getModel().id}`),
    );
    const prompted = (await setup({ provider: h.provider, modelId: h.faux.getModel().id, systemPrompt: "Another prompt." })).executor;
    expect(await resume(prompted)).toEqual(restoreFailure(`saved session ${ref} ran with a different system prompt`));
    for (const record of ["null", "[]", "{not json"]) {
      await writeFile(path.join(h.sessions, `${ref}.json`), record, "utf8");
      expect(await resume(h.executor)).toEqual(restoreFailure(`saved session ${ref} has no readable settings record`));
    }
    await rm(path.join(h.sessions, `${ref}.json`));
    expect(await resume(h.executor)).toEqual(restoreFailure(`saved session ${ref} has no readable settings record`));
    expect(h.faux.state.callCount).toBe(1);
  });

  it.each([
    ["missing", "pi-000000000000", undefined, "no saved session for pi-000000000000"],
    ["corrupt", "pi-00000000000c", "not a session\n", "saved session pi-00000000000c is corrupt"],
    ["empty", "pi-00000000000e", "", "saved session pi-00000000000e is empty"],
    ["malformed", "../escape", undefined, "malformed session ref ../escape"],
  ])("fails to resume a %s session instead of starting fresh", async (_label, ref, contents, reason) => {
    const h = await setup();
    await mkdir(h.sessions, { recursive: true });
    if (contents !== undefined) await writeFile(path.join(h.sessions, `${ref}.jsonl`), contents, "utf8");
    h.faux.setResponses([h.say("never sent")]);
    const result = await h.executor.execute(
      { assignment: "continue" },
      h.ctx({ session: { dir: h.sessions, resume: ref } }),
    );

    expect(result).toEqual({ status: "failed", summary: `agent session ${ref} could not be restored: ${reason}` });
    expect(h.faux.state.callCount).toBe(0);
    expect(await readdir(h.sessions)).toEqual(contents !== undefined ? [`${ref}.jsonl`] : []);
    if (contents !== undefined) expect(await readFile(path.join(h.sessions, `${ref}.jsonl`), "utf8")).toBe(contents);
  });

  it("keeps the API key out of prompts, transcripts, and results", async () => {
    const h = await setup();
    const secret = "sk-test-secret-4471";
    let request = "";
    h.faux.setResponses([
      (context: FauxContext) => {
        request = JSON.stringify(context);
        return h.say("done");
      },
    ]);
    const result = await h.executor.execute(
      { assignment: "work" },
      h.ctx({
        session: { dir: h.sessions },
        credentials: { get: async (name) => (name === "pi-api-key" ? secret : undefined) },
      }),
    );

    expect(result).toMatchObject({ status: "ok" });
    expect(h.keysSet).toEqual([[h.provider, secret]]);
    const transcript = await readFile(path.join(h.sessions, `${(result as { sessionRef: string }).sessionRef}.jsonl`), "utf8");
    for (const text of [request, transcript, JSON.stringify(result)]) expect(text).not.toContain(secret);
  });

  it("requires a configured provider and model", async () => {
    vi.stubEnv(PI_PROVIDER_ENV, "");
    vi.stubEnv(PI_MODEL_ENV, "");
    const h = await setup({ provider: undefined as never, modelId: undefined as never });
    await expect(h.executor.execute({ assignment: "work" }, h.ctx())).rejects.toThrow(
      "no Pi model configured: set GRAPHLOOM_PI_PROVIDER and GRAPHLOOM_PI_MODEL",
    );
  });

  it("lets the job pick a model only from the operator's provider", async () => {
    const h = await setup();
    await expect(
      h.executor.execute({ assignment: "work", harnessOptions: { modelId: "not-a-model" } }, h.ctx()),
    ).rejects.toThrow(`Pi model not found: ${h.provider}/not-a-model`);
  });
});
