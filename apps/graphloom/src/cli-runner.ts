import path from "node:path";
import { BUILTIN_AGENT_EXECUTOR_ID, pinJobExecutor } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, type JobResult, type Runner } from "@graphloom/runner";
import {
  CLAUDE_BIN_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
  CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
  CODEX_BIN_ENV,
  CODEX_DEFAULT_RESPONSE_TIMEOUT_MS,
  CODEX_HOME_ENV,
  CODING_AGENT_RUN_ID,
  DEFAULT_CODING_TIMEOUT_MS,
  claudeCodeHarnessModule,
  codexHarnessModule,
  codingAgentBinding,
  codingAgentExecutorPackage,
  piHarnessModule,
} from "@graphloom/executor-coding-agent";
import { commandBinding, commandExecutorPackage, type CommandBindingOptions } from "@graphloom/executor-command";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { enabledHarnesses, type HarnessName, type RunnerConfig } from "./runner-config.js";

const WATCHDOGS = [
  ["startupTimeoutMs", CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS],
  ["responseTimeoutMs", CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS],
] as const;
const INSTALLED_HARNESSES: Record<HarnessName, string> = {
  "claude-code": claudeCodeHarnessModule,
  codex: codexHarnessModule,
  pi: piHarnessModule,
};

/**
 * Keep the controller's executor pin, tools, budget port and session unchanged.
 * Agent jobs run on the configured harness, or the one `input.harness` names;
 * command jobs and GitHub reads run in their own built-in executor processes.
 */
export function createCliRunner(
  config: RunnerConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  /** Harness adapter modules to load instead of the installed ones (tests). */
  harnessModules: Partial<Record<HarnessName, string>> = {},
  /** Command executor module to load instead of the installed one (quick mode's stand-in; tests). */
  commandModule?: string,
  /**
   * The graph's own `environment.checks`/`.prepare` declarations, by id.
   * Quick mode (§3.2) never stubs these: not just the once-per-run preflight,
   * but every checkout's own re-preparation of them (`runInCheckout`, which
   * dispatches the identical id set under the *checkout job's own*
   * instruction — "RED check", "Candidate checks" — not a recognizable
   * environment-check one), so matching by instruction text alone misses it.
   * Matched by complete declaration (id and argv), not id alone: a graph's own
   * command job could otherwise reuse the environment's ids with different
   * argv and reach the real executor instead of quick mode's stub.
   */
  environmentCommands?: ReadonlyMap<string, readonly string[]>,
  /** GitHub executor module to load instead of the installed one (`--offline`'s stand-in; tests). */
  githubModule?: string,
): Runner {
  const fallback: Runner = {
    async runJob(job, ctx) {
      return failure(
        ctx,
        config === undefined
          ? "CLI agent runner is not configured; set GRAPHLOOM_RUNNER_CONFIG or ~/.config/graphloom/runner.json with a harness and allowUnrestricted: true"
          : `CLI runner does not serve executor ${job.executor?.id ?? job.kind}`,
      );
    },
  };
  if (config === undefined) return fallback;
  if (config.allowUnrestricted !== true) throw new Error("CLI runner requires allowUnrestricted: true");
  const agents = new Map<HarnessName, Runner>(
    enabledHarnesses(config).map((harness) => [
      harness,
      createBuiltinExecutorRunner({
        packages: [{
          manifest: {
            ...codingAgentExecutorPackage,
            entryModule: path.join(path.dirname(codingAgentExecutorPackage.entryModule), "legacy-executors.js"),
            executorIds: [CODING_AGENT_RUN_ID, BUILTIN_AGENT_EXECUTOR_ID],
          },
          ...codingAgentBinding({
            harness: harnessModules[harness] ?? INSTALLED_HARNESSES[harness],
            ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            ...(harness === "claude-code" ? { claude: claudeOptions(config) } : {}),
            ...(harness === "codex" ? { codex: codexOptions(config) } : {}),
            ...(config.pi !== undefined ? { pi: config.pi } : {}),
          }),
        }],
        fallback,
      }),
    ]),
  );
  const tokenEnv = config.github?.tokenEnv;
  const token = tokenEnv !== undefined ? env[tokenEnv] : undefined;
  const githubPackages = config.github !== undefined
    ? [{
        // The real package is sandboxed (read-only closure, no writes); the
        // --offline stand-in is shipped code, not plugin-authored, that
        // writes nothing but its own cursor sidecars beside the scenario
        // file (packages/sdk/src/rehearsal-client.ts) — the same trust and
        // isolation already given to the command and coding-agent stand-ins,
        // and the only way it can read the scenario file at all (a sandbox
        // has no path to grant an arbitrary rehearsal scratch directory).
        manifest: githubModule !== undefined
          ? { ...githubExecutorPackage, entryModule: githubModule, isolation: "unrestricted" as const }
          : githubExecutorPackage,
        ...githubBinding({
          ...(token !== undefined && token !== "" ? { token } : {}),
          ...(config.github.baseUrl !== undefined ? { baseUrl: config.github.baseUrl } : {}),
        }),
        ...(githubModule !== undefined ? { allowUnrestricted: true as const } : {}),
      }]
    : [];
  const commandPackage = (module: string) => ({
    manifest: { ...commandExecutorPackage, entryModule: module },
    ...commandBinding(commandOptions(config)),
  });
  const others =
    commandModule === undefined
      ? createBuiltinExecutorRunner({ packages: [commandPackage(commandExecutorPackage.entryModule), ...githubPackages], fallback })
      : routeEnvironmentChecks(
          createBuiltinExecutorRunner({ packages: [commandPackage(commandExecutorPackage.entryModule), ...githubPackages], fallback }),
          createBuiltinExecutorRunner({ packages: [commandPackage(commandModule), ...githubPackages], fallback }),
          environmentCommands ?? new Map(),
        );
  const defaultAgent = agents.get(config.harness)!;
  return {
    async describeExecutors() {
      return [...(await defaultAgent.describeExecutors!()), ...(await others.describeExecutors!())];
    },
    async runJob(job, ctx) {
      const pinned = pinJobExecutor(job);
      const id = pinned.executor!.id;
      if (id !== BUILTIN_AGENT_EXECUTOR_ID && id !== CODING_AGENT_RUN_ID) return others.runJob(pinned, ctx);
      const legacy = id === BUILTIN_AGENT_EXECUTOR_ID;
      // The schema a plugin's resultSchema names (if any) reaches the
      // executor through ctx.resultContract, resolved by the controller from
      // the run's own declared contracts; this runner forwards only the
      // harness choice and the assignment text.
      const { harness: chosen, ...input } = legacy ? { assignment: pinned.instruction } : (object(pinned.input) ?? {});
      const agent = chosen === undefined ? defaultAgent : agents.get(chosen as HarnessName);
      if (agent === undefined) {
        return failure(ctx, `agent job asks for harness ${JSON.stringify(chosen)}, which the runner config does not enable (harnesses: ${[...agents.keys()].join(", ")})`);
      }
      // stageId/purpose travel only as far as the job's own identity for B3's
      // provenance check (docs/design-graph-rehearsal.md §4.1, §4.7); a
      // plugin never declares either itself, and the legacy executor has no
      // use for them.
      const finalInput = legacy ? input : { ...input, stageId: job.stageId, purpose: job.purpose };
      return agent.runJob({ ...pinned, input: finalInput }, ctx);
    },
  };
}

function failure(ctx: { runId: string; operationId: string; generation: number }, summary: string): JobResult {
  return { status: "failed", summary, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
}

/**
 * A command job dispatches only the environment's own declared checks and
 * preparation in two places (packages/controller/src/{environment,checkout}.ts):
 * the once-per-run preflight (`checkEnvironment`), and every checkout's own
 * re-preparation of them in its own directory (`runInCheckout`, which
 * dispatches the identical id set under the *checkout job's own* instruction
 * — "RED check", "Candidate checks" — not a recognizable one). Neither case
 * is visible to an executor itself (the protocol hands it only `input`+
 * context, never `instruction`/`purpose`/`stageId`), so the router — which
 * does see the full job — tells them apart by matching the exact declarations
 * instead: only the environment's own checks and prepare commands are ever
 * dispatched together, on their own, with no graph command mixed in. Id
 * alone is not enough: a graph's own command job could reuse the
 * environment's ids with different argv and reach the real executor instead
 * of quick mode's stub, so argv must match too.
 */
export function isEnvironmentDispatch(job: { input?: unknown }, environmentCommands: ReadonlyMap<string, readonly string[]>): boolean {
  const commands = (job.input as { commands?: Array<{ id?: unknown; argv?: unknown }> } | undefined)?.commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length !== environmentCommands.size) return false;
  return commands.every((c) => {
    const argv = c.argv;
    if (typeof c.id !== "string" || !Array.isArray(argv)) return false;
    const declared = environmentCommands.get(c.id);
    return declared !== undefined && declared.length === argv.length && declared.every((arg, i) => arg === argv[i]);
  });
}

/** Routes a job dispatching exactly the environment's own declared commands to `real`; everything else to `standIn`. */
function routeEnvironmentChecks(real: Runner, standIn: Runner, environmentCommands: ReadonlyMap<string, readonly string[]>): Runner {
  return {
    async describeExecutors() {
      return standIn.describeExecutors!();
    },
    async runJob(job, ctx) {
      return (isEnvironmentDispatch(job, environmentCommands) ? real : standIn).runJob(job, ctx);
    },
  };
}

/**
 * Command job settings. Commands see the command and login directory each
 * enabled harness is configured with, so an environment check finds the agent
 * its jobs will run on.
 */
export function commandOptions(config: RunnerConfig): CommandBindingOptions {
  const harnesses = enabledHarnesses(config);
  const env: Record<string, string> = {};
  if (harnesses.includes("claude-code")) {
    if (config.claude?.command !== undefined) env[CLAUDE_BIN_ENV] = config.claude.command;
    if (config.claude?.configDir !== undefined) env[CLAUDE_CONFIG_DIR_ENV] = config.claude.configDir;
  }
  if (harnesses.includes("codex")) {
    if (config.codex?.command !== undefined) env[CODEX_BIN_ENV] = config.codex.command;
    if (config.codex?.codexHome !== undefined) env[CODEX_HOME_ENV] = config.codex.codexHome;
  }
  return {
    ...(config.command?.timeoutMs !== undefined ? { timeoutMs: config.command.timeoutMs } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** Claude Code settings, with any default watchdog that would outlast the job timeout cut to half of it. */
export function claudeOptions(config: RunnerConfig): NonNullable<RunnerConfig["claude"]> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const claude = { ...config.claude };
  for (const [name, fallback] of WATCHDOGS) {
    if (claude[name] === undefined && fallback >= timeoutMs) claude[name] = Math.floor(timeoutMs / 2);
  }
  return claude;
}

/** Codex settings, with a default watchdog that would outlast the job timeout cut to half of it. */
export function codexOptions(config: RunnerConfig): NonNullable<RunnerConfig["codex"]> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS;
  const codex = { ...config.codex };
  if (codex.responseTimeoutMs === undefined && CODEX_DEFAULT_RESPONSE_TIMEOUT_MS >= timeoutMs) codex.responseTimeoutMs = Math.floor(timeoutMs / 2);
  return codex;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
