// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyReferenceEnums, checkReferences, validateResultShape } from "@graphloom/sdk";
import {
  BUDGET_EXHAUSTED,
  SESSION_ABORTED,
  captureCodexTurn,
  openCodexThread,
  runCodexProcess,
  type CodexSessionSettings,
  type CodexSessionStore,
  type CodexThread,
} from "#agent-harness/codex";
import { envList, minimalEnv } from "#agent-harness/process";
import { bounded, inlineObjectSchema, scopeNotes } from "./assignment.js";
import {
  CODEX_BIN_ENV,
  CODEX_DEFAULT_RESPONSE_TIMEOUT_MS,
  CODEX_HOME_ENV,
  CODEX_MODEL_ENV,
  CODEX_PASS_ENV_ENV,
  CODEX_REASONING_EFFORT_ENV,
  CODEX_RESPONSE_TIMEOUT_ENV,
} from "./codex-config.js";
import {
  JOB_CONTRACT_ENV,
  JOB_IDENTITY_ENV,
  JOB_REFERENCES_ENV,
  fitWatchdog,
  type CodingHarness,
  type CodingRunRequest,
  type CodingRunResult,
  type CodingSessionOptions,
} from "./harness.js";

export interface CodexHarnessOptions {
  /** Codex executable. Default: `GRAPHLOOM_CODEX_BIN`, then `codex` on PATH. */
  command?: string;
  /** Model name; a job's `harnessOptions.model` overrides it. Default: `GRAPHLOOM_CODEX_MODEL`, then Codex's own. */
  model?: string;
  /** Reasoning effort (`minimal` to `xhigh`); a job's `harnessOptions.effort` overrides it. Default: `GRAPHLOOM_CODEX_REASONING_EFFORT`, then Codex's own. */
  reasoningEffort?: string;
  /** Codex home: its login and config, so it selects the account. Default: `GRAPHLOOM_CODEX_HOME`, then `CODEX_HOME`, then Codex's own `~/.codex`. */
  codexHome?: string;
  /** Extra environment variable names Codex may see, beyond its minimal set. Default: `GRAPHLOOM_CODEX_PASS_ENV` (comma-separated). */
  passEnv?: string[];
  /** Stop Codex when it shows no activity this long while no command is running; 0 disables. Default: `GRAPHLOOM_CODEX_RESPONSE_TIMEOUT_MS`, then 600000. */
  responseTimeoutMs?: number;
  /** How long a stopped process gets before SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
}

const RESULT_NOTE = "Your final message is your result: only the JSON object, with no prose and no code fence.";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/**
 * Every flag a job's `codex exec` run is passed (the shared driver's
 * `CODEX_EXEC_FLAGS` plus `--output-schema`, which `runCodex` below adds),
 * for the B2 capability probe (docs/design-graph-rehearsal.md §3.1): a binary
 * whose `codex exec --help` is missing one of these silently lacks a feature
 * this adapter depends on. Keep this in sync with both.
 */
export const CODEX_ADAPTER_FLAGS: readonly string[] = [
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "--cd",
  "--output-last-message",
  "--model",
  "--config",
  "--output-schema",
];

/**
 * A `CodingHarness` that runs the user's Codex CLI (`codex exec`) headless in
 * the worktree, in Codex's read-only sandbox. It serves read-only jobs without
 * graph tools: Codex cannot confine writes to a job's write scope, and its
 * graph tools would bypass the controller. With a session directory, Codex
 * persists the thread (no `--ephemeral`); the harness copies its rollout file
 * there while the turn runs and restores it before `codex exec resume`.
 */
export function createCodexHarness(harnessOptions: CodexHarnessOptions = {}): CodingHarness {
  return {
    name: "codex",
    resumable: true,
    async createSession(options) {
      if (!options.readOnly) throw new Error("the Codex harness runs read-only jobs only");
      if (options.tools.length > 0) throw new Error("the Codex harness cannot serve graph tools");
      const command = harnessOptions.command ?? (process.env[CODEX_BIN_ENV] || "codex");
      const jobModel = options.options?.model;
      if (jobModel !== undefined && typeof jobModel !== "string") throw new Error("harnessOptions.model must be a string");
      const model = jobModel ?? harnessOptions.model ?? (process.env[CODEX_MODEL_ENV] || undefined);
      const jobEffort = options.options?.effort;
      if (jobEffort !== undefined && typeof jobEffort !== "string") throw new Error("harnessOptions.effort must be a string");
      const reasoningEffort = jobEffort ?? harnessOptions.reasoningEffort ?? (process.env[CODEX_REASONING_EFFORT_ENV] || undefined);
      if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) {
        throw new Error(`Codex reasoning effort must be one of ${[...REASONING_EFFORTS].join(", ")}`);
      }
      const codexHome = harnessOptions.codexHome ?? (process.env[CODEX_HOME_ENV] || process.env.CODEX_HOME || undefined);
      const env = minimalEnv(process.env, harnessOptions.passEnv ?? envList(process.env[CODEX_PASS_ENV_ENV]));
      if (codexHome !== undefined) env.CODEX_HOME = codexHome;
      const responseTimeoutMs = fitWatchdog(harnessOptions.responseTimeoutMs ?? envMs(CODEX_RESPONSE_TIMEOUT_ENV, CODEX_DEFAULT_RESPONSE_TIMEOUT_MS), options.timeoutMs);
      // Codex's own default home, where it keeps rollouts when none is set.
      const home = codexHome ?? path.join(os.homedir(), ".codex");
      const settings: CodexSessionSettings = { model: model ?? null };
      const store: CodexSessionStore = { home, settings, ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}) };
      const thread = await openCodexThread(store, options.resume);
      return {
        async run(request) {
          const { value: result, sessionRef } = await captureCodexTurn(
            store,
            thread,
            {
              resumed: options.resume !== undefined,
              ...(options.onSessionSaved !== undefined ? { onSessionSaved: (ref: string) => options.onSessionSaved?.(ref) } : {}),
            },
            (onActivity) =>
              runCodex({
                command,
                model,
                reasoningEffort,
                env,
                responseTimeoutMs,
                killGraceMs: harnessOptions.killGraceMs ?? 5_000,
                request,
                options,
                thread,
                ...(onActivity !== undefined ? { onActivity } : {}),
              }),
          );
          return sessionRef !== undefined ? { ...result, sessionRef } : result;
        },
      };
    },
  };
}

function envMs(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} must be a non-negative number of milliseconds`);
  return ms;
}

interface RunArgs {
  command: string;
  model: string | undefined;
  reasoningEffort: string | undefined;
  env: NodeJS.ProcessEnv;
  responseTimeoutMs: number;
  killGraceMs: number;
  request: CodingRunRequest;
  options: CodingSessionOptions;
  thread: CodexThread;
  /** Called on each event Codex streams, while its rollout may be growing. */
  onActivity?: () => void;
}

async function runCodex(args: RunArgs): Promise<CodingRunResult> {
  const { options, request } = args;
  if (options.signal?.aborted) return { status: "failed", summary: SESSION_ABORTED };
  // Codex has no hook before each provider request: the first is reserved up
  // front, and one more after each command whose output goes back to the model.
  if (!(await options.reserveModelCall())) return { status: "failed", summary: BUDGET_EXHAUSTED };

  const scratch = await mkdtemp(path.join(os.tmpdir(), "gl-codex-"));
  try {
    // Codex has no in-turn retry in this harness either, so the reference id
    // set is baked into the schema as `enum` up front (§4.3).
    const schema =
      request.resultContract !== undefined
        ? applyReferenceEnums(request.resultContract.schema, request.resultContract.references, request.resultContract.knownReferences)
        : request.resultSchema !== undefined
          ? inlineObjectSchema(request.resultSchema)
          : undefined;
    const extra: string[] = [];
    if (schema !== undefined) {
      const file = path.join(scratch, "schema.json");
      await writeFile(file, JSON.stringify(schema), { mode: 0o600 });
      extra.push("--output-schema", file);
    }
    const wantsResult = request.resultContract !== undefined || request.resultSchema !== undefined;
    const prompt = [request.assignment, ...scopeNotes(options), ...(wantsResult ? [RESULT_NOTE] : [])].join("\n\n");

    const childEnv = { ...args.env };
    const contractName = request.resultContract?.name ?? request.resultSchema;
    if (contractName !== undefined) childEnv[JOB_CONTRACT_ENV] = contractName;
    if (request.identity !== undefined) childEnv[JOB_IDENTITY_ENV] = JSON.stringify(request.identity);
    if (request.resultContract?.knownReferences !== undefined) childEnv[JOB_REFERENCES_ENV] = JSON.stringify(request.resultContract.knownReferences);

    const run = await runCodexProcess({
      command: args.command,
      thread: args.thread,
      cwd: options.cwd,
      env: childEnv,
      prompt,
      sandbox: "read-only",
      // Without a session directory nothing is continued, so Codex persists nothing.
      ephemeral: options.sessionDir === undefined,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
      args: extra,
      lastMessageFile: path.join(scratch, "last-message.txt"),
      responseTimeoutMs: args.responseTimeoutMs,
      killGraceMs: args.killGraceMs,
      reserveModelCall: () => options.reserveModelCall(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(args.onActivity !== undefined ? { onActivity: args.onActivity } : {}),
    });
    const outcome: CodingRunResult =
      run.outcome.kind === "failed"
        ? { status: "failed", summary: run.outcome.summary }
        : interpretMessage(run.outcome.message, request, wantsResult, schema !== undefined);
    const tooled: CodingRunResult = run.nativeTools === undefined ? outcome : { ...outcome, nativeTools: run.nativeTools };
    return run.usage !== undefined ? { ...tooled, usage: run.usage } : tooled;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A completed turn's final message as the job's result: JSON checked against the job's result contract, or plain text. */
function interpretMessage(message: string, request: CodingRunRequest, wantsResult: boolean, constrained: boolean): CodingRunResult {
  if (!wantsResult) return { status: "completed", summary: bounded(message || "Codex completed") };
  const kind = request.resultContract?.name ?? (constrained ? "structured" : request.resultSchema);
  const output = parseJson(message);
  if (output === undefined) return { status: "failed", summary: `agent finished without submitting a ${kind} result` };
  if (request.resultContract !== undefined) {
    const problems = validateResultShape(output, request.resultContract.schema);
    let value: unknown = output;
    if (problems.length === 0 && request.resultContract.references !== undefined && request.resultContract.knownReferences !== undefined) {
      const checked = checkReferences(output, request.resultContract.references, request.resultContract.knownReferences);
      problems.push(...checked.problems);
      value = checked.value;
    }
    if (problems.length > 0) {
      // --output-schema makes a type-level miss rare; a reference
      // outside the shown set is the likely case here. Codex has no
      // further turn in this run to correct it in, so the job fails as
      // a named contract violation instead of recording the result.
      return {
        status: "failed",
        summary: bounded(`result did not satisfy its declared contract (${kind}): ${problems.join("; ")}`),
        failureKind: "contract_violation",
        output,
      };
    }
    const submitted = (value as { summary?: unknown } | null)?.summary;
    return {
      status: "completed",
      summary: bounded(typeof submitted === "string" ? submitted : `Codex submitted a ${kind} result`),
      output: value,
    };
  }
  const submitted = (output as { summary?: unknown } | null)?.summary;
  return {
    status: "completed",
    summary: bounded(typeof submitted === "string" ? submitted : `Codex submitted a ${kind} result`),
    output,
  };
}

/** The final message as a JSON object; a code fence around it is tolerated. */
function parseJson(message: string): Record<string, unknown> | undefined {
  const body = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(message)?.[1] ?? message;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
