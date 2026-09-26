import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertGraphDecision } from "@graphloom/sdk";
import type { ModelRef, SupervisorProposal } from "./types.js";

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
      },
    ),
  },
  observe: {
    specKey: "observe",
    description: "Record worktree evidence.",
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
      { executorId: { ...STRING, description: "Required when target is executor." }, evidenceRefs: EVIDENCE_REFS },
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
  /** The proposal a tool accepted this turn, if any. */
  proposal(): SupervisorProposal | undefined;
}

/**
 * Build the admission tools for one supervisor turn. The first valid call
 * ends the turn; invalid arguments return an error the model can correct.
 */
export function createAdmissionTools(configured: readonly ModelRef[]): AdmissionToolbox {
  let proposal: SupervisorProposal | undefined;

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

  const actionTools = GRAPHLOOM_SUPERVISOR_ACTIONS.map((action): ToolDefinition => {
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
        if (proposal !== undefined) return duplicate();
        try {
          return accept(assertGraphDecision({ reason: params.reason, action: { type: action, [specKey]: params[specKey] } }));
        } catch (err) {
          return reject(err instanceof Error ? err.message : String(err));
        }
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
      if (proposal !== undefined) return duplicate();
      const { provider, modelId, reason } = params as { provider: string; modelId: string; reason: string };
      if (!configured.some((m) => m.provider === provider && m.modelId === modelId)) {
        return reject(`${provider}/${modelId} is not an operator-configured model`);
      }
      return accept({ type: "switch_model", provider, modelId, reason });
    },
  } as ToolDefinition;

  return { tools: [...actionTools, switchTool], proposal: () => proposal };
}

function schema(properties: Record<string, unknown>): ToolDefinition["parameters"] {
  return { type: "object", required: Object.keys(properties), properties } as unknown as ToolDefinition["parameters"];
}
