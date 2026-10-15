import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ACTION_SPEC_KEYS, assertGraphDecision, stableHash, type AgentSessionView, type GraphAction } from "@graphloom/sdk";
import type { AdmissionFacts, ModelRef, SupervisorAdmission, SupervisorProposal, SupervisorRejection } from "./types.js";

/**
 * GraphLoom-owned admission tools. Each proposes one controller action; the
 * controller admits and settles it, and reports the outcome on the next turn.
 * Pi's own bash/edit/write stay disabled while deciding.
 */
export const GRAPHLOOM_SUPERVISOR_ACTIONS = [
  "dispatch",
  "observe",
  "validate",
  "reenter",
  "qualify_repair",
  "activate_repair",
  "return",
  "stop",
] as const;

export type GraphLoomSupervisorAction = (typeof GRAPHLOOM_SUPERVISOR_ACTIONS)[number];

export const SWITCH_MODEL_TOOL = "switch_model";

interface ActionTool {
  specKey: string;
  description: string;
  spec: Record<string, unknown>;
}

const STRING = { type: "string" };
const STRINGS = { type: "array", items: STRING };
const EVIDENCE_REFS = { ...STRINGS, description: "Evidence refs that support this action." };

/** JSON Schema for one action spec; extra fields pass through to controller admission. */
function spec(
  required: Record<string, unknown>,
  optional: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    required: Object.keys(required),
    properties: { ...required, ...optional },
    additionalProperties: true,
  };
}

const ACTION_TOOLS: Record<GraphLoomSupervisorAction, ActionTool> = {
  dispatch: {
    specKey: "job",
    description: "Run one job for the current stage. You write its instruction for this trial. Work jobs need a writeScope.",
    spec: spec(
      {
        stageId: STRING,
        kind: { type: "string", enum: ["agent", "command"] },
        purpose: { type: "string", enum: ["work", "check", "review", "repair", "diagnostic"] },
        instruction: STRING,
      },
      {
        writeScope: STRINGS,
        readOnly: { type: "boolean" },
        executor: spec({ id: STRING }, { version: STRING }),
        input: { description: "Bounded JSON input for the pinned executor." },
        continueFrom: {
          type: "string",
          description:
            "An operationId from agentSessions for this stage and dispatch key: the agent resumes that session with its earlier context. Omit to start fresh.",
        },
      },
    ),
  },
  observe: {
    specKey: "observe",
    description: "Record worktree evidence. paths are relative to the run worktree.",
    spec: spec({}, { paths: STRINGS, includeWorkspaceManifest: { type: "boolean" } }),
  },
  validate: {
    specKey: "validate",
    description: "Evaluate a stage's requirements against current evidence.",
    spec: spec({ stageId: STRING }, { requirementIds: STRINGS }),
  },
  reenter: {
    specKey: "reenter",
    description: "Start a new attempt of a stage.",
    spec: spec({ stageId: STRING, reason: STRING }, { evidenceRefs: EVIDENCE_REFS }),
  },
  qualify_repair: {
    specKey: "qualify",
    description: "Copy and patch a plugin, validator, or executor package, then qualify it through preflight and independent review.",
    spec: spec(
      { target: { type: "string", enum: ["plugin", "validator", "executor"] }, reason: STRING },
      {
        executorId: { ...STRING, description: "Required when target is executor." },
        requirementId: {
          ...STRING,
          description: "The disputed requirement. Required to substitute a validator on an opaque bundle.",
        },
        evidenceRefs: EVIDENCE_REFS,
      },
    ),
  },
  activate_repair: {
    specKey: "activate",
    description: "Activate a qualified repair candidate for this run.",
    spec: spec({ qualifiedArtifactId: STRING, reason: STRING }),
  },
  return: {
    specKey: "return",
    description: "Hand control back to the graph. Stages are not accepted by returning.",
    spec: spec({ summary: STRING }, { evidenceRefs: EVIDENCE_REFS }),
  },
  stop: {
    specKey: "stop",
    description: "Stop the run. Prefer other authorized remedies while budget and authority remain.",
    spec: spec({ reason: STRING, blocker: STRING }, { evidenceRefs: EVIDENCE_REFS }),
  },
};

const SUBMITTED =
  "Submitted to the GraphLoom controller. Its outcome is reported at the start of your next turn.";

export interface AdmissionToolbox {
  tools: ToolDefinition[];
  /** The action tools offered this turn, in prompt order. */
  offered: GraphLoomSupervisorAction[];
  /** The proposal a tool accepted this turn, if any. */
  proposal(): SupervisorProposal | undefined;
  /** The controller's last rejection, once it ended the turn (`remaining: 0`). */
  exhausted(): SupervisorRejection | undefined;
}

/**
 * The action tools whose preconditions can hold in this state. Narrowing only
 * saves wasted turns; the controller's admission stays the authority.
 */
export function offeredActions(facts?: AdmissionFacts): GraphLoomSupervisorAction[] {
  if (facts === undefined) return [...GRAPHLOOM_SUPERVISOR_ACTIONS];
  return GRAPHLOOM_SUPERVISOR_ACTIONS.filter((action) => {
    if (action === "activate_repair") return facts.qualifiedArtifactIds.length > 0;
    if (action === "qualify_repair") return facts.canQualify;
    if (action === "return") return facts.inRecovery;
    return true;
  });
}

export interface ContinuationJob {
  stageId?: unknown;
  kind?: unknown;
  purpose?: unknown;
  jobId?: unknown;
  executor?: { id?: unknown };
  continueFrom?: unknown;
}

/** Mirrors packages/controller/src/agent-sessions.ts's dispatchKey, pure and duplicable: supervisor depends only on @graphloom/sdk, not controller. */
function dispatchKey(job: ContinuationJob, fallbackExecutorId?: string): string {
  if (typeof job.jobId === "string") return job.jobId;
  const pinnedId = typeof job.executor?.id === "string" ? job.executor.id : fallbackExecutorId ?? String(job.kind);
  return `${String(job.purpose)}:${pinnedId}`;
}

/** The stage an action concerns, for keys and repeat-detection; `undefined` for a stage-less action type. */
function stageForAction(action: GraphAction): string | undefined {
  switch (action.type) {
    case "dispatch":
      return action.job.stageId;
    case "validate":
      return action.validate.stageId;
    case "reenter":
      return action.reenter.stageId;
    default:
      return undefined;
  }
}

/** The action's own spec, with its free text (`reason`, and a dispatch's `instruction`) stripped before hashing. */
function specForHash(action: GraphAction): unknown {
  const key = ACTION_SPEC_KEYS[action.type]!;
  const spec = (action as unknown as Record<string, unknown>)[key];
  if (spec === null || typeof spec !== "object") return spec;
  const { reason: _reason, instruction: _instruction, ...rest } = spec as Record<string, unknown>;
  return rest;
}

/**
 * Mirrors packages/controller/src/escalation.ts's supervisorProposalKey,
 * byte-for-byte: both call the same promoted @graphloom/sdk stableHash, so
 * there is nothing left to diverge the way a hand-duplicated canonicalizer
 * could. Exported so tests can precompute the key for a known action.
 */
export function supervisorProposalKey(triggerCode: string, action: GraphAction): string {
  return stableHash([triggerCode, stageForAction(action) ?? null, action.type, specForHash(action)]);
}

/**
 * Same checks as the controller's continuationRefusal, run before admission so
 * a bad continueFrom is rejected in-turn like any other malformed job, rather
 * than reaching the controller and hard-stopping the run with no recovery.
 */
/** Mutable work must declare where it may write; the controller hard-stops the run on this, with no recovery. */
export function writeScopeRefusal(job: { purpose?: unknown; readOnly?: unknown; writeScope?: unknown }): string | undefined {
  if (job.purpose !== "work" || job.readOnly === true) return undefined;
  if (Array.isArray(job.writeScope) && job.writeScope.length > 0) return undefined;
  return "a work job needs a non-empty writeScope; to rerun the graph's own step, reenter the stage instead";
}

/** An observe path outside the run worktree; the controller hard-stops the run on this too. */
export function escapingObservePath(paths: unknown): string | undefined {
  if (!Array.isArray(paths)) return undefined;
  return paths.find((p) => typeof p === "string" && (path.isAbsolute(p) || p.split(/[/\\]/).includes("..")));
}

export function continuationRefusal(
  job: ContinuationJob,
  agentSessions: readonly AgentSessionView[],
  generation: number,
): string | undefined {
  const from = job.continueFrom;
  if (typeof from !== "string") return undefined;
  if (job.kind !== "agent") {
    return `only agent jobs carry sessions; set kind to "agent" to continue ${from}, or omit continueFrom for a ${String(job.kind)} job`;
  }
  const record = agentSessions.find((r) => r.operationId === from);
  if (record === undefined) {
    return `no agent session was recorded for operation ${from}`;
  }
  if (record.stageId !== job.stageId) {
    return `operation ${from} ran stage ${record.stageId}, not ${String(job.stageId)}`;
  }
  // A job that does not name its own executor inherits the session's: continuing
  // a session means using the executor that session already ran on, and the
  // supervisor cannot otherwise predict a run's own executor-catalog overrides
  // (RunView exposes no such catalog) the way the controller's own pinning does.
  const key = dispatchKey(job, record.executorId);
  if (record.dispatchKey !== key) {
    return `operation ${from} has dispatch key ${record.dispatchKey}, not ${key}`;
  }
  if (record.generation > generation) {
    return `operation ${from} was recorded by a later generation (${record.generation} > ${generation})`;
  }
  const successor = agentSessions.find((r) => r.continuedFrom === from);
  if (successor !== undefined) {
    return `operation ${from} was already continued by ${successor.operationId}; continue from that one`;
  }
  return undefined;
}

/**
 * Build the admission tools for one supervisor turn. The first admissible
 * call ends the turn; invalid arguments, and a proposal the controller's
 * pre-admission check refuses, return an error the model can correct.
 */
export function createAdmissionTools(
  configured: readonly ModelRef[],
  agentSessions: readonly AgentSessionView[] = [],
  generation = 0,
  triggerCode?: string,
  repeatedProposals: Record<string, { count: number }> = {},
  admission?: SupervisorAdmission,
): AdmissionToolbox {
  let proposal: SupervisorProposal | undefined;
  let exhausted: SupervisorRejection | undefined;
  const offered = offeredActions(admission?.facts);

  const accept = (next: SupervisorProposal) => {
    proposal = next;
    return { content: [{ type: "text" as const, text: SUBMITTED }], details: undefined, terminate: true };
  };
  const reject = (message: string) => ({
    content: [{ type: "text" as const, text: `Rejected: ${message}. Call one tool with corrected arguments.` }],
    details: undefined,
  });
  // A second call in the same batch must not keep the turn going after a proposal.
  const duplicate = () => ({ ...reject("a proposal was already submitted this turn"), terminate: true });
  const refused = (rejection: SupervisorRejection) => {
    if (rejection.remaining > 0) return reject(rejectionText(rejection));
    exhausted = rejection;
    return {
      content: [{ type: "text" as const, text: `Rejected: ${rejectionText(rejection)}.` }],
      details: undefined,
      terminate: true,
    };
  };

  const actionTools = offered.map((action): ToolDefinition => {
    const { specKey, description, spec: specSchema } = ACTION_TOOLS[action];
    return {
      name: action,
      label: action,
      description,
      parameters: schema({
        reason: { type: "string", description: "Concise decision summary shown to the operator." },
        [specKey]: specSchema,
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (proposal !== undefined || exhausted !== undefined) return duplicate();
        const job = params[specKey] as
          | ({ purpose?: unknown; readOnly?: unknown; writeScope?: unknown } & ContinuationJob)
          | undefined;
        if (action === "dispatch" && job !== undefined) {
          const scopeRefusal = writeScopeRefusal(job);
          if (scopeRefusal !== undefined) return reject(scopeRefusal);
          const refusal = continuationRefusal(job, agentSessions, generation);
          if (refusal !== undefined) return reject(refusal);
        }
        const paths = (params[specKey] as { paths?: unknown } | undefined)?.paths;
        const escaping = action === "observe" ? escapingObservePath(paths) : undefined;
        if (escaping !== undefined) return reject(`observe paths are relative to the run worktree; ${escaping} is not`);
        let candidate: SupervisorProposal;
        try {
          candidate = assertGraphDecision({ reason: params.reason, action: { type: action, [specKey]: params[specKey] } });
        } catch (err) {
          return reject(err instanceof Error ? err.message : String(err));
        }
        if (triggerCode !== undefined) {
          const key = supervisorProposalKey(triggerCode, candidate.action);
          const already = repeatedProposals[key]?.count ?? 0;
          if (already + 1 >= 3) {
            return reject(
              `this exact ${action} proposal would be the ${already + 1 === 3 ? "3rd" : `${already + 1}th`} time with no progress since the controller last checked; propose something that would change the outcome, or stop`,
            );
          }
        }
        const rejection = "action" in candidate ? admission?.check(candidate) : undefined;
        if (rejection !== undefined) return refused(rejection);
        return accept(candidate);
      },
    } as ToolDefinition;
  });

  const switchTool = {
    name: SWITCH_MODEL_TOOL,
    label: SWITCH_MODEL_TOOL,
    description: `Switch this supervisor session to another operator-configured model before your next turn. Configured: ${configured.map((m) => `${m.provider}/${m.modelId}`).join(", ")}.`,
    parameters: schema({
      provider: { type: "string" },
      modelId: { type: "string" },
      reason: { type: "string" },
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (proposal !== undefined || exhausted !== undefined) return duplicate();
      const { provider, modelId, reason } = params as { provider: string; modelId: string; reason: string };
      if (!configured.some((m) => m.provider === provider && m.modelId === modelId)) {
        return reject(`${provider}/${modelId} is not an operator-configured model`);
      }
      return accept({ type: "switch_model", provider, modelId, reason });
    },
  } as ToolDefinition;

  return { tools: [...actionTools, switchTool], offered, proposal: () => proposal, exhausted: () => exhausted };
}

/** How a controller rejection reads to the model: the failed precondition and current value, and what is left this turn. */
export function rejectionText(rejection: SupervisorRejection): string {
  const head = `the controller would not admit this ${rejection.action}: ${rejection.reason}`;
  if (rejection.remaining <= 0) {
    return `${head}. That was the last inadmissible proposal allowed this turn; the controller now applies its safe default`;
  }
  return `${head}. ${rejection.remaining} more inadmissible proposal${rejection.remaining === 1 ? "" : "s"} allowed this turn before the controller applies its safe default`;
}

function schema(properties: Record<string, unknown>): ToolDefinition["parameters"] {
  return { type: "object", required: Object.keys(properties), properties } as unknown as ToolDefinition["parameters"];
}
