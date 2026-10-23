/**
 * `graphloom check` (L0), `graphloom rehearse` (L1), `graphloom replay` (L2)
 * and `graphloom probe` (L3), per docs/design-graph-rehearsal.md. All four
 * read a real task.yaml and a real plugin bundle; `rehearse` and `probe` run
 * the real controller (or the real CLI runner directly) end to end.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyGraphDefaultBudgets,
  checkB3,
  defaultRecoveryReserve,
  classifyAgentResult,
  createController,
  evaluateRehearsal,
  intakeTask,
  loadRunState,
  producerOf,
  replayRun,
  resolveBundleEntry,
  resolveBundleEntryFromManifest,
  resolveBundleRehearsalEntry,
  resolveStateDir,
  taskConfigValue,
  type BoundaryResult,
  type ContractOutcome,
  type DurableRunState,
  type RehearsalReport,
  type ReplayReport,
} from "@graphloom/controller";
import { createChildPluginHost } from "@graphloom/plugin-host";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import {
  checkContract,
  readCallLog,
  readUnverifiedReads,
  REHEARSAL_ADVERSARIAL_ENV,
  REHEARSAL_GITHUB_TOKEN_ENV,
  REHEARSAL_SYNTHESIZED_ENV,
  unsupportedSchemaKeywords,
  validateResultShape,
  type ContractCheck,
  type EvidenceRecord,
  type GraphDefinition,
  type GraphRehearsal,
  type JobSpec,
  type ReferenceSet,
  type RecordedCall,
  type RehearsalCommandResult,
  type RehearsalExpectation,
  type RehearsalReply,
  type RehearsalScenario,
} from "@graphloom/sdk";
import {
  claudeRehearsalStandIn,
  CODING_AGENT_RUN_ID,
  codexRehearsalStandIn,
  piRehearsalModule,
  readRecordedAssignment,
  REHEARSAL_HOME_ENV,
  REHEARSAL_SCENARIO_ENV,
} from "@graphloom/executor-coding-agent";
import { commandRehearsalModule } from "@graphloom/executor-command";
import { GITHUB_API_URL_ENV, githubRehearsalModule } from "@graphloom/executor-github";
import type { Runner } from "@graphloom/runner";
import { probeHarnessCapabilities, type CapabilityProbeResult } from "./capability-probe.js";
import { createCliRunner } from "./cli-runner.js";
import { loadRunnerConfig, requireRunnerConfig } from "./runner-config.js";
import type { RunnerConfig } from "./runner-config.js";

const execFileAsync = promisify(execFile);

/** Default rehearsal budgets (§3.2): small enough that a non-converging graph surfaces in seconds, not minutes. */
const DEFAULT_REHEARSAL_BUDGETS = { agentInvocations: 24, jobs: 64, decisions: 256, corrections: 4 };

/**
 * The budgets a rehearsal's generated task names: the defaults above, the
 * scenario's own over them, and a `recoveryReserve` that fits the
 * rehearsal's own agent allowance when the scenario sets none. Without it
 * the run would inherit the reserve a graph declares for live runs (such as
 * 90 of 1,800) and the final check would refuse 24 calls with a reserve of
 * 90 before anything ran. The reserve follows the controller's own rule,
 * kept below the allowance; an explicit scenario reserve is used as is.
 */
export function rehearsalBudgets(scenarioBudgets?: RehearsalScenario["budgets"]): Record<string, number> {
  const budgets: Record<string, number> = { ...DEFAULT_REHEARSAL_BUDGETS, ...scenarioBudgets };
  if (budgets.recoveryReserve === undefined) {
    const allowance = budgets.agentInvocations!;
    const reserve = Math.min(defaultRecoveryReserve(allowance), allowance - 1);
    if (reserve >= 1) budgets.recoveryReserve = reserve;
  }
  return budgets;
}
/**
 * §3.4: a probe spends at most this many real provider calls. Not "one
 * assignment in, one result out, plus a little correction room" for every
 * contract: a tool-heavy assignment (a code review running open-code-review's
 * own multi-step delegation workflow, each round trip its own reservation)
 * needs several just to finish reading the change, before it can answer at
 * all. Found live: a real Codex probe of banyandb-fix's code-review-v2 was
 * terminated mid-workflow at the old bound of 3, never producing a result.
 */
const MAX_PROBE_MODEL_CALLS = 10;
/**
 * A rehearsal enables the GitHub executor unconditionally, same as the three
 * coding harnesses: a graph that never dispatches to it pays nothing, and one
 * that does (its token here, never a real one) needs no separate opt-in. A
 * real GitHub base URL still answers unless the caller also points
 * GRAPHLOOM_GITHUB_API_URL at a fake one.
 */
export { REHEARSAL_GITHUB_TOKEN_ENV };

export interface CheckReport {
  ok: boolean;
  problems: string[];
  definition?: GraphDefinition;
  rehearsal?: GraphRehearsal;
  /** B2 (§3.1): each enabled spawned-CLI harness's own --help names every flag its adapter passes it. */
  capabilities?: CapabilityProbeResult;
  /** The gate in `run` (§3.5): each environment check's own stdout, fingerprint input — a changed tool version re-rehearses. */
  environmentOutputs: Record<string, string>;
}

/** The task's pinned config for a plugin host, so check, rehearse and replay describe the same graph a run would. */
function configOption(intake: Pick<DurableRunState["intake"], "config">): { config?: unknown } {
  const config = taskConfigValue(intake);
  return config !== undefined ? { config } : {};
}

async function describeBundle(intake: Awaited<ReturnType<typeof intakeTask>>): Promise<GraphDefinition> {
  const host = await createChildPluginHost({
    entryModule: resolveBundleEntry(intake),
    activeVersion: `${intake.bundle.graphId}@${intake.bundle.version}`,
    generation: 1,
    cwd: intake.bundle.bundlePath,
    ...configOption(intake),
  });
  try {
    const result = await host.describe({ runId: "check", operationId: `op-${randomUUID().slice(0, 8)}`, expectedStateRevision: 0 });
    if (!result.ok) {
      throw new Error(`plugin describe() failed: ${JSON.stringify(result.observation)}`);
    }
    return result.value;
  } finally {
    await host.close();
  }
}

/**
 * A bundle's rehearsal entry is the same untrusted bundle code as its graph
 * entry, so it loads inside the same isolated child host `describeBundle`
 * uses for `createGraph`/`describe()` — never a bare `import()` into this
 * CLI process, which would run arbitrary bundle code with the CLI's own
 * full environment and filesystem access.
 */
async function loadRehearsal(intake: Awaited<ReturnType<typeof intakeTask>>): Promise<GraphRehearsal | undefined> {
  const entry = resolveBundleRehearsalEntry(intake);
  if (entry === undefined) return undefined;
  const host = await createChildPluginHost({
    entryModule: resolveBundleEntry(intake),
    activeVersion: `${intake.bundle.graphId}@${intake.bundle.version}`,
    generation: 1,
    cwd: intake.bundle.bundlePath,
    ...configOption(intake),
  });
  try {
    const result = await host.rehearsal!({ runId: "check", operationId: `op-${randomUUID().slice(0, 8)}`, expectedStateRevision: 0 }, entry);
    if (!result.ok) {
      throw new Error(`rehearsal entry failed: ${JSON.stringify(result.observation)}`);
    }
    if (result.value === undefined) {
      throw new Error(`${entry} does not export \`rehearsal\``);
    }
    return result.value;
  } finally {
    await host.close();
  }
}

/**
 * A scenario reply, staged as the one piece of evidence a real dispatch for
 * `contractName` would have left behind (classifyAgentResult, the same
 * function a real run's recordJobEvidence calls) — a synthetic ref and a
 * best-effort producer, since L0 has no real dispatch to read one from:
 * `advance()`'s own choice of purpose/readOnly for this contract is plugin
 * code (§3.1), not something a static check can see, so a review-kind
 * contract is assumed read-only review and anything else a work dispatch.
 */
function syntheticEvidenceRecord(
  definition: GraphDefinition,
  stageId: string,
  contractName: string,
  evidenceKind: "file" | "command" | "workspace" | "review" | "other",
  output: unknown,
): EvidenceRecord {
  const purpose = evidenceKind === "review" ? "review" : "work";
  const job: JobSpec = {
    stageId,
    kind: "agent",
    purpose,
    instruction: "L0 static check",
    resultSchema: contractName,
    ...(purpose === "review" ? { readOnly: true } : {}),
  };
  const item = { kind: "other" as const, payload: { codingAgent: { status: "completed", output } } };
  const outcome: ContractOutcome | undefined = classifyAgentResult(definition, job, item);
  const producer = { operationId: "op-l0-synthetic", stageId, purpose, readOnly: purpose === "review", kind: "agent" };
  const attach = (payload: unknown) =>
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, producer } : { value: payload, producer };
  const base = { ref: "l0-synthetic", generation: 1, resultSchema: contractName };
  if (outcome === undefined) {
    return { ...base, kind: "other", payload: attach(item.payload) };
  }
  return { ...base, kind: outcome.kind, contract: outcome.contract, payload: attach(outcome.payload) };
}

/** L0 (§3.1): the declared data agrees with itself and the environment's tools are present, for zero provider calls. */
export async function check(taskPath: string): Promise<CheckReport> {
  const intake = await intakeTask(taskPath);
  const problems: string[] = [];
  const definition = await describeBundle(intake);
  // The run's final budgets: the graph's defaultBudgets under the task's, checked across budgets.
  try {
    applyGraphDefaultBudgets(intake, definition);
  } catch (err) {
    problems.push(`budgets: ${err instanceof Error ? err.message : String(err)}`);
  }

  const contracts = definition.resultContracts ?? [];
  const byName = new Map(contracts.map((c) => [c.name, c]));
  const bindingByRequirement = new Map(definition.defaultValidators.map((b) => [b.requirementId, b]));
  for (const requirement of definition.requirements) {
    const contract = byName.get(requirement.evidenceSchema);
    if (contract === undefined) continue; // not every evidenceSchema names a result contract (file/workspace/command evidence).
    if (!["file", "command", "workspace", "review", "other"].includes(contract.evidenceKind)) {
      problems.push(`contract ${contract.name}: evidenceKind ${JSON.stringify(contract.evidenceKind)} is not a recognized kind`);
    }
    if (!bindingByRequirement.has(requirement.id)) {
      problems.push(`requirement ${requirement.id}: names contract ${contract.name} but has no validator binding`);
    }
  }
  for (const contract of contracts) {
    for (const keyword of unsupportedSchemaKeywords(contract.schema)) {
      problems.push(`contract ${contract.name}: schema uses ${keyword}, which validateResultShape does not enforce`);
    }
  }

  let rehearsal: GraphRehearsal | undefined;
  try {
    rehearsal = await loadRehearsal(intake);
  } catch (err) {
    problems.push(`rehearsal entry: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rehearsal !== undefined) {
    // The contract-versus-parser check (B5, §3.1): a reply that validates
    // against its own declared schema is then classified exactly as a real
    // dispatch's evidence would be (classifyAgentResult, the same function
    // recordJobEvidence calls) and walked through the requirement's own
    // validator, read-only, in the plugin host — a scenario can be green
    // under a plugin's unit simulation and still assert a journey the real
    // validators would refuse.
    const requirementByContract = new Map(
      definition.requirements.filter((r) => bindingByRequirement.has(r.id)).map((r) => [r.evidenceSchema, r]),
    );
    const host = await createChildPluginHost({
      entryModule: resolveBundleEntry(intake),
      activeVersion: `${intake.bundle.graphId}@${intake.bundle.version}`,
      generation: 1,
      cwd: intake.bundle.bundlePath,
      ...configOption(intake),
    });
    try {
      for (const [scenarioName, scenario] of Object.entries(rehearsal.scenarios)) {
        for (const [contractName, replies] of Object.entries(scenario.results)) {
          const contract = byName.get(contractName);
          if (contract === undefined) {
            problems.push(`scenario ${scenarioName}: names contract ${contractName}, which the plugin did not declare`);
            continue;
          }
          const requirement = requirementByContract.get(contractName);
          const binding = requirement !== undefined ? bindingByRequirement.get(requirement.id) : undefined;
          const stage = requirement !== undefined ? definition.stages.find((s) => s.requirementIds.includes(requirement.id)) : undefined;
          for (const [i, reply] of replies.entries()) {
            if (reply.output === undefined) continue;
            const violations = validateResultShape(reply.output, contract.schema);
            if (violations.length > 0) {
              problems.push(`scenario ${scenarioName}: ${contractName}[${i}] does not validate against its own contract: ${violations.join("; ")}`);
              continue;
            }
            if (requirement === undefined || binding === undefined || stage === undefined) continue; // no bound requirement to walk its validator; already flagged above if that is itself the problem.
            // Only the last reply (§4.4: "the last reply repeats") is the
            // steady state a requirement's validator should see — an earlier
            // one can legitimately be a mid-sequence draft a different part of
            // the same contract's own dispatch history produced (banyandb-fix's
            // own planner draft under decision-record-v1, before the
            // implementer's confirmation settles it), not evidence that
            // requirement ever saw on its own.
            if (i !== replies.length - 1) continue;
            const label = `scenario ${scenarioName}: ${contractName}[${i}] against ${requirement.id}'s validator`;
            try {
              const record = syntheticEvidenceRecord(definition, stage.id, contractName, contract.evidenceKind, reply.output);
              const result = await host.evaluate!(
                { runId: "check", operationId: `op-${randomUUID().slice(0, 8)}`, expectedStateRevision: 0 },
                binding.validatorId,
                { requirementId: requirement.id, statement: requirement.statement, evidence: [record] },
              );
              if (!result.ok) {
                problems.push(`${label}: ${JSON.stringify(result.observation)}`);
              } else if (result.value.status === "failed") {
                problems.push(`${label}: ${result.value.reason}`);
              }
              // "inconclusive" (missing command/file evidence quick mode never
              // stages) and "passed" are both fine: only a real refusal, not an
              // under-informed validator, is this check's business.
            } catch (err) {
              problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } finally {
      await host.close();
    }
  }

  const env = definition.environment;
  const environmentOutputs: Record<string, string> = {};
  for (const c of env?.checks ?? []) {
    const [cmd, ...args] = c.argv;
    if (cmd === undefined) {
      problems.push(`environment check ${c.id}: empty argv`);
      continue;
    }
    try {
      const { stdout } = await execFileAsync(cmd, args, { cwd: intake.repoPath, timeout: c.timeoutMs ?? 10_000 });
      environmentOutputs[c.id] = stdout;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      problems.push(`environment check ${c.id} failed: ${detail}`);
    }
  }

  // B2: optional, since check (like rehearse) needs no $GRAPHLOOM_RUNNER_CONFIG —
  // without one (or a malformed one), capabilities stays unverified rather
  // than blocking check's own verdict on a problem that is runner config's
  // to report, not check's.
  const runnerConfig = await loadRunnerConfig().catch(() => undefined);
  const capabilities = await probeHarnessCapabilities(runnerConfig);
  if (capabilities.status === "failed") problems.push(...capabilities.notes.map((n) => `harness capability: ${n}`));

  return { ok: problems.length === 0, problems, definition, capabilities, environmentOutputs, ...(rehearsal !== undefined ? { rehearsal } : {}) };
}

interface RehearsalRun {
  report: RehearsalReport;
  rehearsalRoot: string;
  scenarioPath: string;
  stateDir?: string;
}

/**
 * B3's own call-log cross-check (§4.1, §4.7): every stand-in logs the
 * contract it was given alongside the dispatching job's own `operationId`;
 * this reads that log back and compares it against the evidence producer the
 * controller itself recorded for the same `operationId`. A mismatch means a
 * reply landed under a different job than the one that asked — a continued
 * session mixing turns, a stale result applied fresh — and names both
 * contract identities. A rehearsal with nothing logged for an operation (a
 * replay; a dispatch the stand-in never instrumented) has nothing to
 * cross-check and is not itself a finding.
 */
export function checkProvenance(state: DurableRunState, calls: RecordedCall[]): BoundaryResult {
  const byOperation = new Map(calls.filter((c) => c.operationId !== undefined).map((c) => [c.operationId!, c]));
  const notes: string[] = [];
  for (const record of state.evidence) {
    if (record.resultSchema === undefined) continue;
    const operationId = producerOf(record)?.operationId;
    if (operationId === undefined) continue;
    const call = byOperation.get(operationId);
    if (call?.contractName === undefined || call.contractName === record.resultSchema) continue;
    notes.push(
      `${record.ref}: operation ${operationId} asked for ${record.resultSchema}, but the stand-in logged answering ${call.contractName}`,
    );
  }
  return notes.length > 0 ? { status: "failed", notes } : { status: "passed", notes: [] };
}

/**
 * Does the actual rehearsal (§3.2): real controller, real plugin host, the
 * stand-in models. Leaves the rehearsal's scratch directory and its worktree
 * in place; the caller decides what to do with them (`rehearse` cleans up on
 * `ready`, `probe` always cleans up since the rehearsal itself is only a
 * means to a real assignment).
 */
async function performRehearsal(
  taskPath: string,
  options: { scenario?: string; commands?: "stub" | "run"; offline?: boolean; synthesized?: boolean; adversarial?: boolean } = {},
): Promise<RehearsalRun> {
  const absoluteTaskPath = path.resolve(taskPath);
  const taskDir = path.dirname(absoluteTaskPath);
  const intake = await intakeTask(absoluteTaskPath);
  const rehearsalData = await loadRehearsal(intake);
  const definition = await describeBundle(intake);
  const environmentCommands = new Map(
    [...(definition.environment?.checks ?? []), ...(definition.environment?.prepare ?? [])].map((c) => [c.id, c.argv] as const),
  );
  const scenarioName = options.scenario ?? "happy";
  const scenario: RehearsalScenario = rehearsalData?.scenarios[scenarioName] ?? {
    results: {},
    expect: { status: "succeeded" },
  };
  if (rehearsalData !== undefined && rehearsalData.scenarios[scenarioName] === undefined) {
    throw new Error(`no scenario named ${JSON.stringify(scenarioName)}; this bundle declares: ${Object.keys(rehearsalData.scenarios).join(", ") || "(none)"}`);
  }

  const rehearsalRoot = await mkdtemp(path.join(os.tmpdir(), "graphloom-rehearsal-"));
  const scenarioPath = path.join(rehearsalRoot, "scenario.json");
  const standInHome = path.join(rehearsalRoot, "stand-in-home");
  const stateRoot = path.join(rehearsalRoot, "state");
  await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");

  const tempTaskPath = path.join(taskDir, `.graphloom-rehearsal-${randomUUID().slice(0, 8)}.yaml`);
  const budgets = rehearsalBudgets(scenario.budgets);
  const budgetLines = Object.entries(budgets).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  // The graph's own request text, verbatim (as a block scalar: a plugin may
  // read it for compatibility checks or prompt content) — never synthesized,
  // so the real graph logic sees the same task it would on a live run.
  const requestBody = intake.task.request.split("\n").map((line) => `  ${line}`).join("\n");
  await writeFile(
    tempTaskPath,
    // The task's own config path: the temporary task sits beside it, so the
    // rehearsal intakes the same config (and digest) a live run would.
    `graph: ${intake.task.graph}\nrepo: ${intake.task.repo}\n${intake.task.config !== undefined ? `config: ${JSON.stringify(intake.task.config)}\n` : ""}request: |\n${requestBody}\nbudgets:\n${budgetLines}\n`,
    "utf8",
  );

  const previousScenarioEnv = process.env[REHEARSAL_SCENARIO_ENV];
  const previousHomeEnv = process.env[REHEARSAL_HOME_ENV];
  const previousSynthesizedEnv = process.env[REHEARSAL_SYNTHESIZED_ENV];
  const previousAdversarialEnv = process.env[REHEARSAL_ADVERSARIAL_ENV];
  process.env[REHEARSAL_SCENARIO_ENV] = scenarioPath;
  process.env[REHEARSAL_HOME_ENV] = standInHome;
  if (options.synthesized === true) process.env[REHEARSAL_SYNTHESIZED_ENV] = "1";
  else delete process.env[REHEARSAL_SYNTHESIZED_ENV];
  if (options.adversarial === true) process.env[REHEARSAL_ADVERSARIAL_ENV] = "1";
  else delete process.env[REHEARSAL_ADVERSARIAL_ENV];
  try {
    // Every harness a plugin might dispatch to gets its stand-in enabled
    // unconditionally; createCliRunner's own per-job `input.harness` routing
    // (apps/graphloom/src/cli-runner.ts) sends each dispatch to the right one.
    const standInPassEnv = [REHEARSAL_SCENARIO_ENV, REHEARSAL_HOME_ENV, REHEARSAL_SYNTHESIZED_ENV, REHEARSAL_ADVERSARIAL_ENV];
    const runnerConfig: RunnerConfig = {
      harness: "pi",
      harnesses: ["pi", "claude-code", "codex"],
      allowUnrestricted: true,
      claude: { command: claudeRehearsalStandIn, passEnv: standInPassEnv },
      codex: { command: codexRehearsalStandIn, passEnv: standInPassEnv },
      github: {
        tokenEnv: REHEARSAL_GITHUB_TOKEN_ENV,
        // The real GitHub executor is sandboxed (not allowUnrestricted) and
        // runs in its own child process, which inherits none of this
        // process's environment — only what its binding explicitly carries.
        // A live base-url override must travel that way too, not as an env
        // mutation this function's caller expects to just be inherited.
        ...(process.env[GITHUB_API_URL_ENV] !== undefined ? { baseUrl: process.env[GITHUB_API_URL_ENV] } : {}),
      },
    };
    const stubCommands = options.commands !== "run";
    const offline = options.offline === true;
    const runner = createCliRunner(
      runnerConfig,
      process.env,
      { pi: piRehearsalModule },
      stubCommands ? commandRehearsalModule : undefined,
      environmentCommands,
      offline ? githubRehearsalModule : undefined,
    );
    const substituted = [
      `pi: rehearsal stand-in (${piRehearsalModule})`,
      `claude-code: rehearsal stand-in (${claudeRehearsalStandIn})`,
      `codex: rehearsal stand-in (${codexRehearsalStandIn})`,
      ...(stubCommands ? [`command: rehearsal stand-in (${commandRehearsalModule}), quick mode's default`] : []),
      ...(offline ? [`github: rehearsal stand-in (${githubRehearsalModule}), replaying recorded reads (--offline)`] : []),
      ...(options.synthesized === true ? ["every agent reply: schema-synthesized, ignoring the scenario's own scripted replies (--synthesized)"] : []),
      ...(options.adversarial === true ? ["every agent reply: adversarially corrupted before submission, to prove the robustness machinery is wired (--adversarial)"] : []),
    ];
    const report = await createController().run({
      taskPath: tempTaskPath,
      runner,
      stateRoot,
      runId: `rehearsal-${randomUUID().slice(0, 8)}`,
      supervisorFactory: async () => createScriptedSupervisor({ decisions: scenario.supervisor ?? [] }),
    });
    const state = await loadRunState(report.stateDir);
    // B2 probes the operator's real, configured binaries (not this rehearsal's
    // own stand-in runnerConfig above): the question is whether a live run
    // would find what its adapters need, same as the gate in `run` (§3.5).
    // Offline reads with nothing recorded fold into the same boundary: a seam
    // this rehearsal could not fully verify, same spirit as an unreadable
    // --help (§4.6: never a fabricated payload, the gap is reported instead).
    const realConfig = await loadRunnerConfig().catch(() => undefined);
    const capabilities = await probeHarnessCapabilities(realConfig);
    const unverifiedReads = offline ? readUnverifiedReads(scenarioPath) : [];
    const B2 = unverifiedReads.length === 0
      ? capabilities
      : {
          status: capabilities.status === "failed" ? "failed" as const : "unverified" as const,
          notes: [...capabilities.notes, ...unverifiedReads.map((id) => `offline: no recorded read for ${id}`)],
        };
    // B3's own default (malformed agent evidence) stays canonical in the
    // controller; the call-log cross-check needs the scenario's own sidecar
    // file, a CLI concern, so it is computed here and merged in.
    const baseline = checkB3(state);
    const provenance = checkProvenance(state, readCallLog(scenarioPath));
    const B3: BoundaryResult = {
      status: baseline.status === "failed" || provenance.status === "failed" ? "failed" : baseline.status,
      notes: [...baseline.notes, ...provenance.notes],
    };
    const evaluated = evaluateRehearsal(state, scenario, { B2, B3 }, {
      substituted,
      notCovered: stubCommands
        ? ["the toolchain, build and tests: command jobs answered from the scenario's stubs (quick mode); rerun with --commands run for the full verdict"]
        : [],
    });
    return { report: evaluated, rehearsalRoot, scenarioPath, stateDir: report.stateDir };
  } finally {
    if (previousScenarioEnv === undefined) delete process.env[REHEARSAL_SCENARIO_ENV];
    else process.env[REHEARSAL_SCENARIO_ENV] = previousScenarioEnv;
    if (previousHomeEnv === undefined) delete process.env[REHEARSAL_HOME_ENV];
    else process.env[REHEARSAL_HOME_ENV] = previousHomeEnv;
    if (previousSynthesizedEnv === undefined) delete process.env[REHEARSAL_SYNTHESIZED_ENV];
    else process.env[REHEARSAL_SYNTHESIZED_ENV] = previousSynthesizedEnv;
    if (previousAdversarialEnv === undefined) delete process.env[REHEARSAL_ADVERSARIAL_ENV];
    else process.env[REHEARSAL_ADVERSARIAL_ENV] = previousAdversarialEnv;
    await rm(tempTaskPath, { force: true });
  }
}

/** A rehearsal's worktree/branch live in the real repo, not its scratch root; both are removed together. */
async function cleanUpRehearsal(run: RehearsalRun): Promise<void> {
  if (run.stateDir !== undefined) {
    await createController().delete(run.stateDir, { force: true }).catch(() => undefined);
  }
  await rm(run.rehearsalRoot, { recursive: true, force: true });
}

export interface RehearseOptions {
  scenario?: string;
  keep?: boolean;
  /** Quick mode (default, "stub") answers command jobs from the scenario; "run" executes them for real, same as `check`'s environment checks always do. */
  commands?: "stub" | "run";
  /** GitHub reads are real by default (§4.6); `true` replays the scenario's own `reads` instead, reporting an unrecorded one as unverified rather than asking GitHub. */
  offline?: boolean;
  /** Ignores every scripted reply and always synthesizes from the contract's own schema (§4.4), the contract-versus-parser check of §4.1 with no scenario data at all. */
  synthesized?: boolean;
  /** Corrupts every agent reply before submission (§4.4), to prove the robustness machinery itself — not any one plugin's own logic — is wired on this machine. */
  adversarial?: boolean;
}

/** L1 (§3.2): the real controller, plugin host and harness adapters, with a stand-in model and no provider calls. */
export async function rehearse(taskPath: string, options: RehearseOptions = {}): Promise<RehearsalReport> {
  const run = await performRehearsal(taskPath, options);
  // `not-ready`, `inconclusive`, or an uncaught error leave the worktree and
  // scratch root for inspection, same as `--keep`; only `ready` cleans up.
  if (!options.keep && run.report.verdict === "ready") await cleanUpRehearsal(run);
  return run.report;
}

/**
 * L2 (§3.3): would a recorded run's real outputs be accepted under the
 * bundle's current code? Reads only; no provider calls.
 *
 * `bundlePath` overrides the recorded run's own `intake.bundle.bundlePath`,
 * an absolute path frozen at record time on whatever machine recorded it —
 * replaying "the bundle's current code" means wherever it is installed now,
 * which is only ever the same path by coincidence (found running this
 * design's own committed fixture in CI, on a different machine than the one
 * that recorded it).
 */
export async function replay(runRef: string, options: { stateRoot?: string; bundlePath?: string } = {}): Promise<ReplayReport> {
  const stateDir = await resolveStateDir(runRef, options.stateRoot);
  const recorded = await loadRunState(stateDir);
  const bundlePath = options.bundlePath ?? recorded.intake.bundle.bundlePath;
  const host = await createChildPluginHost({
    entryModule: resolveBundleEntryFromManifest(bundlePath, recorded.intake.bundle.manifestRaw),
    activeVersion: recorded.activeVersion,
    generation: recorded.generation,
    cwd: bundlePath,
    ...configOption(recorded.intake),
  });
  try {
    return await replayRun(recorded, host);
  } finally {
    await host.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export interface RecordedScenario {
  /** `"happy"` for a succeeded run; the run's own id otherwise, so a regression keeps a traceable name. */
  name: string;
  scenario: RehearsalScenario;
}

/**
 * §4.5: extracts a `RehearsalScenario` from a recorded run's durable state —
 * every agent result (`codingAgent.output`, grouped by its stamped
 * `resultSchema`, in order), every command result (environment checks
 * excluded — they are never stubbed, §3.2), and every GitHub read payload
 * (by executor id) — so a real model's own replies become a rehearsal's
 * stand-in data at no further cost than the run already spent. A failed
 * agent result pairs with its `executorFailure` evidence (same
 * `operationId`) for the fail reply's summary.
 */
export async function recordScenario(runRef: string, options: { stateRoot?: string } = {}): Promise<RecordedScenario> {
  const stateDir = await resolveStateDir(runRef, options.stateRoot);
  const state = await loadRunState(stateDir);

  const failureSummaries = new Map<string, string>();
  for (const record of state.evidence) {
    const failure = asRecord(asRecord(record.payload)?.executorFailure);
    if (typeof failure?.operationId === "string" && typeof failure.summary === "string") {
      failureSummaries.set(failure.operationId, failure.summary);
    }
  }

  const results: Record<string, RehearsalReply[]> = {};
  const commands: Record<string, RehearsalCommandResult> = {};
  const reads: Record<string, unknown[]> = {};
  // The file-kind evidence a work dispatch's own effects left behind carries
  // no producer at all (the workspace diff that creates it is not itself a
  // job), but it is always recorded immediately after that dispatch's own
  // agent evidence, before the next dispatch's (dispatches are sequential,
  // §4.6) — so it attaches to whichever reply this loop pushed most recently,
  // reset the moment anything else is seen. A supervisor's own diagnostic
  // `observe` during recovery records file evidence the same shape, but never
  // in the same generation as the stale reply it would otherwise attach to
  // (found live: a reenter's own recovery observe of the already-written fix
  // files landed on the prior generation's unrelated review reply) — gate on
  // generation too, not just "most recent," since a dispatch's own effects
  // never cross a generation boundary but a later observe can share one.
  let activeReply: RehearsalReply | undefined;
  let activeReplyGeneration: number | undefined;
  for (const record of state.evidence) {
    const payload = asRecord(record.payload);
    if (payload === undefined) {
      activeReply = undefined;
      continue;
    }
    if (activeReply !== undefined && record.generation !== activeReplyGeneration) {
      activeReply = undefined;
    }
    const producer = asRecord(payload.producer);
    const operationId = typeof producer?.operationId === "string" ? producer.operationId : undefined;

    const codingAgent = asRecord(payload.codingAgent);
    if (record.resultSchema !== undefined && codingAgent !== undefined) {
      const reply: RehearsalReply = codingAgent.status === "completed"
        ? { output: codingAgent.output }
        : { fail: { kind: "exit", summary: (operationId !== undefined ? failureSummaries.get(operationId) : undefined) ?? "recorded failure" } };
      (results[record.resultSchema] ??= []).push(reply);
      activeReply = reply;
      activeReplyGeneration = record.generation;
      continue;
    }
    // A valid/repaired "review"-kind result flattens to its own validated
    // output, producer-stripped — the same shape classifyAgentResult leaves
    // behind (packages/controller/src/loop.ts) and agentRuns()-style lookups
    // already read; a failed review never reaches this flattened shape (it
    // keeps its codingAgent wrapper, handled above), so there is no fail
    // case to recover here.
    if (record.resultSchema !== undefined && record.kind === "review") {
      const { producer: _producer, ...output } = payload;
      const reply: RehearsalReply = { output };
      (results[record.resultSchema] ??= []).push(reply);
      activeReply = reply;
      activeReplyGeneration = record.generation;
      continue;
    }

    if (record.kind === "file" && typeof payload.path === "string" && typeof payload.bytes === "string") {
      if (activeReply !== undefined) (activeReply.effects ??= []).push({ path: payload.path, bytes: payload.bytes });
      continue; // not a reset: more than one file may follow the same dispatch
    }
    if (record.kind === "workspace") continue; // a changed-paths summary of the same effects; nothing new to record

    // The once-per-run preflight and every checkout's own re-preparation both
    // stamp `environment` onto their command evidence (environment.ts); those
    // commands are never stubbed (§3.2), so recording them as replies would
    // only be noise a rehearsal never reads.
    const command = asRecord(payload.command);
    if (command !== undefined && payload.environment === undefined && typeof command.id === "string" && typeof command.exitCode === "number") {
      commands[command.id] = {
        exitCode: command.exitCode,
        stdout: typeof command.stdoutTail === "string" ? command.stdoutTail : "",
        stderr: typeof command.stderrTail === "string" ? command.stderrTail : "",
      };
      activeReply = undefined;
      continue;
    }

    if (payload.github !== undefined && typeof producer?.executorId === "string") {
      (reads[producer.executorId] ??= []).push(payload.github);
    }
    activeReply = undefined;
  }

  const expect: RehearsalExpectation = {
    status: state.status === "succeeded" ? "succeeded" : "stopped",
    receipts: [...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))],
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...(state.recoveryTrigger !== undefined ? { recovery: [state.recoveryTrigger.code] } : {}),
  };

  const scenario: RehearsalScenario = {
    results,
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
    ...(Object.keys(reads).length > 0 ? { reads } : {}),
    expect,
  };
  return { name: state.status === "succeeded" ? "happy" : state.runId, scenario };
}

export interface ProbeReport {
  contract: string;
  assignment: string;
  status: "ok" | "failed";
  summary: string;
  providerCalls: number;
  check?: ContractCheck;
}

/**
 * A throwaway `git worktree` off the task's own pinned commit, outside the
 * operator's real checkout entirely and always force-removed: `probe`
 * dispatches directly to the real runner, with none of a controller run's
 * own post-job scope diff to catch a stray write, and the Pi harness exposes
 * its write/bash tools regardless of `job.readOnly` (prompt guidance there,
 * not an enforced restriction) — so a real model's probe turn must never run
 * against a path the operator actually cares about.
 */
async function withDisposableWorktree<T>(repoPath: string, pinnedHead: string, fn: (worktreePath: string) => Promise<T>): Promise<T> {
  const branch = `graphloom/probe-${randomUUID().slice(0, 8)}`;
  const worktreePath = path.join(os.tmpdir(), `graphloom-probe-worktree-${randomUUID().slice(0, 8)}`);
  await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, pinnedHead], { cwd: repoPath });
  try {
    return await fn(worktreePath);
  } finally {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath }).catch(() => undefined);
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoPath }).catch(() => undefined);
    await execFileAsync("git", ["branch", "-D", branch], { cwd: repoPath }).catch(() => undefined);
  }
}

/**
 * L3 (§3.4): does the real model on the real configured harness produce
 * what this contract demands? The only rung that spends provider calls,
 * bounded to `MAX_PROBE_MODEL_CALLS`. The assignment is the real text a
 * rehearsal's own dispatch rendered for this contract, not a guess — a
 * quick rehearsal runs first (stand-in, zero cost) purely to capture it.
 */
export async function probe(
  taskPath: string,
  options: { contract: string; scenario?: string; commands?: "stub" | "run"; offline?: boolean },
  /** Test seam: a runner in place of the real configured one (never used by the CLI). */
  overrideRunner?: Runner,
): Promise<ProbeReport> {
  const intake = await intakeTask(path.resolve(taskPath));
  const definition = await describeBundle(intake);
  const contract = definition.resultContracts?.find((c) => c.name === options.contract);
  if (contract === undefined) {
    const names = (definition.resultContracts ?? []).map((c) => c.name).join(", ") || "(none)";
    throw new Error(`no contract named ${JSON.stringify(options.contract)}; this bundle declares: ${names}`);
  }

  const run = await performRehearsal(taskPath, {
    ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
    ...(options.commands !== undefined ? { commands: options.commands } : {}),
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
  });
  let recorded: { assignment: string; harness: string; knownReferences?: Record<string, ReferenceSet> } | undefined;
  try {
    recorded = readRecordedAssignment(run.scenarioPath, options.contract);
  } finally {
    await cleanUpRehearsal(run);
  }
  if (recorded === undefined) {
    throw new Error(
      `the rehearsal never dispatched a job naming contract ${JSON.stringify(options.contract)}; is it reached on the ${JSON.stringify(options.scenario ?? "happy")} scenario path?`,
    );
  }
  const { assignment, harness, knownReferences } = recorded;

  const runner = overrideRunner ?? createCliRunner(await requireRunnerConfig());
  let providerCalls = 0;
  const probeDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-probe-"));
  try {
    return await withDisposableWorktree(intake.repoPath, intake.pinnedHead, async (worktreePath) => {
      const result = await runner.runJob(
        {
          stageId: "probe",
          kind: "agent",
          purpose: "diagnostic",
          readOnly: true,
          instruction: assignment,
          resultSchema: contract.name,
          executor: { id: CODING_AGENT_RUN_ID },
          input: { assignment, harness },
          ...(knownReferences !== undefined ? { knownReferences } : {}),
        },
        {
          runId: "probe",
          operationId: `op-${randomUUID().slice(0, 8)}`,
          generation: 1,
          worktreePath,
          artifactDir: probeDir,
          resultContract: {
            name: contract.name,
            schema: contract.schema,
            ...(contract.references !== undefined ? { references: contract.references } : {}),
            ...(knownReferences !== undefined ? { knownReferences } : {}),
          },
          children: {
            callTool: async () => ({ status: "failed", summary: "probe admits no tools" }),
            reserveModelCall: async () => {
              providerCalls += 1;
              return providerCalls <= MAX_PROBE_MODEL_CALLS;
            },
          },
        },
      );
      const output = result.evidence
        ?.map((e) => (e.payload as { codingAgent?: { output?: unknown } } | undefined)?.codingAgent?.output)
        .find((v) => v !== undefined);
      return {
        contract: contract.name,
        assignment,
        status: result.status === "ok" ? "ok" : "failed",
        summary: result.summary,
        providerCalls,
        ...(output !== undefined ? { check: checkContract(output, contract, knownReferences) } : {}),
      };
    });
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}
