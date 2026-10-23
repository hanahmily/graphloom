import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { checkReferences, validateResultShape } from "@graphloom/sdk";
import type { CodingHarness, CodingResultContract, CodingRunRequest, CodingRunResult, CodingSession, CodingSessionOptions, CodingTool, NativeToolUse } from "./harness.js";
import { bounded, inlineObjectSchema, scopeNotes } from "./assignment.js";
import { envList, minimalEnv } from "./child-env.js";
import { PI_AGENT_DIR_ENV, PI_API_KEY_CREDENTIAL, PI_MODEL_ENV, PI_PASS_ENV_ENV, PI_PROVIDER_ENV } from "./pi-config.js";

export interface PiHarnessOptions {
  /** Pi provider id. Default: `GRAPHLOOM_PI_PROVIDER`. */
  provider?: string;
  /** Model id; a job's `harnessOptions.modelId` overrides it. Default: `GRAPHLOOM_PI_MODEL`. */
  modelId?: string;
  /** Pi agent dir holding `auth.json` and `models.json`. Default: `GRAPHLOOM_PI_AGENT_DIR`, then `~/.pi/agent`. */
  agentDir?: string;
  systemPrompt?: string;
  /**
   * Extra environment variable names Pi's shell commands may see. They
   * otherwise get only `PATH`, `HOME`, locale, proxy, and similar basics, never
   * the executor's secrets. Default: `GRAPHLOOM_PI_PASS_ENV` (comma-separated).
   */
  passEnv?: string[];
  /** Builds the provider registry and auth store. Default: Pi's, from `agentDir`. */
  createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
}

const SESSION_REF = /^pi-[0-9a-f]{12}$/;
const SUBMIT_RESULT = "submit_result";
/** Pi's built-in coding tools, all active: the agent runs unrestricted in the worktree. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const RESERVED_TOOL_NAMES = new Set<string>([...PI_BUILTIN_TOOLS, SUBMIT_RESULT]);
const BUDGET_EXHAUSTED = "model request budget exhausted";
const MAX_TOOL_RESULT_CHARS = 32_000;
const OPEN_OBJECT = { type: "object", additionalProperties: true } as unknown as ToolDefinition["parameters"];
/** §4.2: in-turn correction attempts beyond the first before the job fails. */
const MAX_RESULT_RETRIES = 2;

const DEFAULT_SYSTEM_PROMPT = [
  "You are a GraphLoom coding agent working in a git worktree.",
  "Use the shell and file tools to investigate, write code, and run builds and tests in the worktree.",
  "GraphLoom tools go through the controller, which records each call; treat their results as the recorded observations.",
  "Finish with a short summary of what you did and what you observed. Do not include secrets or private reasoning.",
].join(" ");

/**
 * A `CodingHarness` that runs a Pi coding agent with Pi's full built-in toolset
 * (shell included) in the worktree. Graph tools become Pi tools whose calls go
 * to the controller as child operations. Each provider request reserves run
 * budget first, and sessions persist under the controller's session directory.
 */
export function createPiHarness(harnessOptions: PiHarnessOptions = {}): CodingHarness {
  return {
    name: "pi",
    resumable: true,
    async createSession(options) {
      const provider = harnessOptions.provider ?? process.env[PI_PROVIDER_ENV];
      const jobModel = options.options?.modelId;
      if (jobModel !== undefined && typeof jobModel !== "string") throw new Error("harnessOptions.modelId must be a string");
      const modelId = jobModel ?? harnessOptions.modelId ?? process.env[PI_MODEL_ENV];
      if (!provider || !modelId) {
        throw new Error(`no Pi model configured: set ${PI_PROVIDER_ENV} and ${PI_MODEL_ENV}`);
      }
      const agentDir = harnessOptions.agentDir ?? process.env[PI_AGENT_DIR_ENV] ?? path.join(os.homedir(), ".pi", "agent");
      const systemPrompt = harnessOptions.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const passEnv = harnessOptions.passEnv ?? envList(process.env[PI_PASS_ENV_ENV]);
      const settings: SessionSettings = { provider, modelId, systemPromptSha256: sha256(systemPrompt) };
      const saved = openSessionManager(options, settings);
      const modelRuntime = await (harnessOptions.createModelRuntime ?? defaultModelRuntime)(agentDir);
      // The key is bound to the operator's provider; it never enters a prompt or the transcript.
      const apiKey = await options.credentials?.get(PI_API_KEY_CREDENTIAL);
      if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Pi model not found: ${provider}/${modelId}`);
      const root = await realpath(options.cwd);
      for (const tool of options.tools) {
        if (RESERVED_TOOL_NAMES.has(tool.name)) throw new Error(`tool ${tool.name} collides with a Pi harness tool`);
      }
      // Pi's own bash would hand every command the executor's whole environment.
      const bash = createBashToolDefinition(root, {
        spawnHook: (spawn) => ({ ...spawn, env: minimalEnv(spawn.env, passEnv) }),
      }) as unknown as ToolDefinition;

      let disposed: (() => void) | undefined;
      // Native tools the latest run's own turns called; undefined when they could not be read.
      // Read lazily by finish(), so no return path can report tools before they are collected.
      let readTools: () => NativeToolUse[] | undefined = () => [];
      const session: CodingSession = {
        async run(request) {
          readTools = () => [];
          if (options.signal?.aborted) return finish({ status: "failed", summary: "agent session aborted" });
          let submitted: { value: unknown } | undefined;
          let contractFailure: string[] | undefined;
          const callId = turnCallId();
          const resultTool =
            request.resultContract !== undefined
              ? submitContractResultTool(
                  request.resultContract,
                  (value) => (submitted = { value }),
                  (problems) => (contractFailure = problems),
                )
              : request.resultSchema !== undefined
                ? submitResultTool(request.resultSchema, (value) => (submitted = { value }))
                : undefined;
          const tools = [...options.tools.map((tool) => mediatedTool(tool, callId)), ...(resultTool !== undefined ? [resultTool] : [])];
          const { session: agent } = await createAgentSession({
            cwd: root,
            agentDir,
            model,
            thinkingLevel: "off",
            modelRuntime,
            resourceLoader: isolatedResourceLoader(systemPrompt),
            noTools: "all",
            tools: [...PI_BUILTIN_TOOLS, ...tools.map((t) => t.name)],
            customTools: [bash, ...tools],
            sessionManager: saved.manager,
            settingsManager: SettingsManager.inMemory({
              compaction: { enabled: false },
              retry: { enabled: false },
              cacheWarming: "off",
            }),
          });
          disposed = () => agent.dispose();
          let budgetRefused = false;
          const stream = agent.agent.streamFunction;
          agent.agent.streamFunction = async (...args: Parameters<typeof stream>) => {
            if (!(await options.reserveModelCall())) {
              budgetRefused = true;
              throw new Error(BUDGET_EXHAUSTED);
            }
            return stream(...args);
          };
          const onAbort = () => void agent.abort().catch(() => undefined);
          options.signal?.addEventListener("abort", onAbort, { once: true });
          const firstNew = agent.messages.length;
          readTools = () => piNativeTools(agent.messages, firstNew, new Set(tools.map((t) => t.name)));
          try {
            await agent.prompt(promptText(request, options), { expandPromptTemplates: false });
            await agent.waitForIdle();
          } catch (err) {
            return finish({ status: "failed", summary: bounded(err instanceof Error ? err.message : String(err)) });
          } finally {
            options.signal?.removeEventListener("abort", onAbort);
          }

          const last = lastAssistant(agent.messages);
          if (budgetRefused) return finish({ status: "failed", summary: BUDGET_EXHAUSTED, ...output(submitted) });
          if (options.signal?.aborted || last?.stopReason === "aborted") {
            return finish({ status: "failed", summary: "agent session aborted", ...output(submitted) });
          }
          if (last?.stopReason === "error") {
            return finish({ status: "failed", summary: bounded(`agent request failed: ${last.errorMessage ?? "unknown error"}`) });
          }
          const text = last !== undefined ? assistantText(last) : "";
          if (contractFailure !== undefined) {
            const problems = contractFailure.join("; ");
            return finish({
              status: "failed",
              summary: bounded(`result did not satisfy its declared contract (${request.resultContract!.name}) after ${MAX_RESULT_RETRIES} retries: ${problems}`),
              failureKind: "contract_violation",
              ...output(submitted),
            });
          }
          const resultName = request.resultContract?.name ?? request.resultSchema;
          if (resultName !== undefined && submitted === undefined) {
            const missing = `agent finished without submitting a ${resultName} result`;
            return finish({ status: "failed", summary: bounded(text ? `${missing}: ${text}` : missing) });
          }
          return finish({
            status: "completed",
            summary: bounded(text || submittedSummary(submitted) || "agent completed"),
            ...output(submitted),
          });
        },
        async dispose() {
          disposed?.();
        },
      };

      async function finish(result: CodingRunResult): Promise<CodingRunResult> {
        const attemptTools = readTools();
        const tooled: CodingRunResult = attemptTools !== undefined ? { ...result, nativeTools: attemptTools } : result;
        if (saved.ref === undefined || !existsSync(saved.file)) return tooled;
        await writeAtomic(settingsFile(saved.file), JSON.stringify(settings));
        return { ...tooled, sessionRef: saved.ref };
      }
      return session;
    },
  };
}

async function defaultModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
}

/** What a saved session ran under; a resume under other settings would pass their turns off as continuity. */
interface SessionSettings {
  provider: string;
  modelId: string;
  systemPromptSha256: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function settingsFile(sessionFile: string): string {
  return sessionFile.replace(/\.jsonl$/, ".json");
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, target);
}

type SavedSession =
  | { manager: SessionManager; ref: string; file: string }
  | { manager: SessionManager; ref?: undefined; file?: undefined };

/** Restore the session `resume` names or fail; never start a fresh one in its place. */
function openSessionManager(options: CodingSessionOptions, settings: SessionSettings): SavedSession {
  if (options.resume === undefined) {
    if (options.sessionDir === undefined) return { manager: SessionManager.inMemory(options.cwd) };
    const ref = `pi-${randomBytes(6).toString("hex")}`;
    const file = path.join(options.sessionDir, `${ref}.jsonl`);
    return { manager: SessionManager.open(file, options.sessionDir, options.cwd), ref, file };
  }
  const ref = options.resume;
  if (!SESSION_REF.test(ref)) throw new Error(`malformed session ref ${ref}`);
  if (options.sessionDir === undefined) throw new Error("no session directory to restore from");
  const file = path.join(options.sessionDir, `${ref}.jsonl`);
  // Pi opens a missing file as a new session and rewrites an empty one, so check first.
  if (!existsSync(file)) throw new Error(`no saved session for ${ref}`);
  if (statSync(file).size === 0) throw new Error(`saved session ${ref} is empty`);
  let manager: SessionManager;
  try {
    manager = SessionManager.open(file, options.sessionDir, options.cwd);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  if (manager.buildSessionContext().messages.length === 0) throw new Error(`saved session ${ref} has no turns`);
  let recorded: Partial<Record<keyof SessionSettings, unknown>> | null;
  try {
    recorded = JSON.parse(readFileSync(settingsFile(file), "utf8")) as typeof recorded;
  } catch {
    recorded = null;
  }
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) {
    throw new Error(`saved session ${ref} has no readable settings record`);
  }
  if (recorded.provider !== settings.provider || recorded.modelId !== settings.modelId) {
    throw new Error(
      `saved session ${ref} ran on ${String(recorded.provider)}/${String(recorded.modelId)}; this job asks for ${settings.provider}/${settings.modelId}`,
    );
  }
  if (recorded.systemPromptSha256 !== settings.systemPromptSha256) {
    throw new Error(`saved session ${ref} ran with a different system prompt`);
  }
  return { manager, ref, file };
}

/** A fresh prefix per turn, so a provider's call id never matches a call from an earlier turn. */
function turnCallId(): (id: string) => string {
  const turn = randomBytes(4).toString("hex");
  return (id) => `pi-${turn}-${id.length <= 96 ? id : createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function mediatedTool(tool: CodingTool, callId: (id: string) => string): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? `GraphLoom ${tool.effect} tool ${tool.name}. The controller records each call.`,
    parameters: OPEN_OBJECT,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const result = await tool.call(callId(toolCallId), params);
      const text = JSON.stringify(result);
      return {
        content: [{ type: "text", text: text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…` }],
        details: undefined,
      };
    },
  };
}

function submitResultTool(resultSchema: string, onSubmit: (value: unknown) => void): ToolDefinition {
  const schema = inlineObjectSchema(resultSchema) as ToolDefinition["parameters"] | undefined;
  return {
    name: SUBMIT_RESULT,
    label: "submit result",
    description:
      schema !== undefined
        ? "Submit your structured result once the work is done."
        : `Submit your structured result (${resultSchema}) once the work is done.`,
    parameters: schema ?? OPEN_OBJECT,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      onSubmit(params);
      return { content: [{ type: "text", text: "result recorded" }], details: undefined, terminate: true };
    },
  };
}

/**
 * §4.2/§4.3: validates a submission against its declared contract (schema
 * and, when the contract lists reference paths and the job supplied the
 * matching id sets, membership) and returns the problems to the model as a
 * non-terminating rejection it can act on in the same turn, bounded by
 * MAX_RESULT_RETRIES. `onFailure` fires once that bound is spent with an
 * invalid submission still on the table; the turn then ends (one more
 * rejection message, `terminate: true`) and the job fails as
 * `contract_violation`, not a silent "other".
 */
function submitContractResultTool(
  contract: CodingResultContract,
  onSubmit: (value: unknown) => void,
  onFailure: (problems: string[]) => void,
): ToolDefinition {
  let attempts = 0;
  return {
    name: SUBMIT_RESULT,
    label: "submit result",
    description: `Submit your structured result (${contract.name}) once the work is done.`,
    parameters: contract.schema as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      let problems = validateResultShape(params, contract.schema);
      let value: unknown = params;
      if (problems.length === 0 && contract.references !== undefined && contract.knownReferences !== undefined) {
        const checked = checkReferences(params, contract.references, contract.knownReferences);
        problems = checked.problems;
        value = checked.value;
      }
      if (problems.length === 0) {
        onSubmit(value);
        return { content: [{ type: "text", text: "result recorded" }], details: undefined, terminate: true };
      }
      attempts += 1;
      if (attempts > MAX_RESULT_RETRIES) {
        onFailure(problems);
        return {
          content: [{ type: "text", text: `Rejected: ${problems.join("; ")}. No retries remain; this job fails.` }],
          details: undefined,
          terminate: true,
        };
      }
      return {
        content: [{ type: "text", text: `Rejected: ${problems.join("; ")}. Call ${SUBMIT_RESULT} again with a corrected result.` }],
        details: undefined,
      };
    },
  };
}

function promptText(request: CodingRunRequest, options: CodingSessionOptions): string {
  const parts = [request.assignment, ...scopeNotes(options)];
  if (request.resultContract !== undefined || request.resultSchema !== undefined) {
    parts.push(`When you are done, call ${SUBMIT_RESULT} with your result.`);
  }
  return parts.join("\n\n");
}

function isolatedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

interface AssistantView {
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

function lastAssistant(messages: readonly unknown[]): AssistantView | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown };
    if (m.role === "assistant") return m as AssistantView;
  }
  return undefined;
}

/** Visible reply text only; thinking blocks and tool calls stay out of the summary. */
function assistantText(message: AssistantView): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

function submittedSummary(submitted: { value: unknown } | undefined): string | undefined {
  const value = submitted?.value as { summary?: unknown } | undefined;
  return typeof value?.summary === "string" ? value.summary : undefined;
}

function output(submitted: { value: unknown } | undefined): { output?: unknown } {
  return submitted !== undefined ? { output: submitted.value } : {};
}

const PI_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Built-in tool calls in the messages one run added; undefined when the messages are not in a readable shape. */
export function piNativeTools(messages: readonly unknown[] | undefined, from: number, mediated: Set<string>): NativeToolUse[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const used: NativeToolUse[] = [];
  for (const m of messages.slice(from) as { role?: unknown; content?: unknown }[]) {
    if (m === null || typeof m !== "object") return undefined;
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) return undefined;
    for (const block of m.content as { type?: unknown; name?: unknown }[]) {
      if (block?.type !== "toolCall") continue;
      if (typeof block.name !== "string") return undefined;
      if (!mediated.has(block.name)) used.push({ name: block.name, readOnly: PI_READ_ONLY_TOOLS.has(block.name) });
    }
  }
  return used;
}
