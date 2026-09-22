import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  GraphDefinition,
  Receipt,
  StageAttempt,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { IntakePin } from "./intake.js";

export type RunStatus = "running" | "succeeded" | "stopped" | "failed";

export interface DurableRunState {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  generation: number;
  stateRevision: number;
  activeVersion: string;
  mode: "normal" | "recovery";
  current: StageAttempt;
  receipts: Receipt[];
  evidence: EvidenceRecord[];
  privateState?: string;
  definition: GraphDefinition;
  validatorBindings: ValidatorBinding[];
  budgets: IntakePin["budgets"];
  intake: IntakePin;
  worktreePath: string;
  worktreeBranch: string;
  artifactDir: string;
  stateDir: string;
  sourceDirtyBefore: string[];
  evidenceSeq: number;
  receiptSeq: number;
}

export async function saveRunState(state: DurableRunState): Promise<void> {
  await mkdir(state.stateDir, { recursive: true });
  const target = path.join(state.stateDir, "state.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, target);
}

export async function loadRunState(stateDir: string): Promise<DurableRunState> {
  const raw = await readFile(path.join(stateDir, "state.json"), "utf8");
  return JSON.parse(raw) as DurableRunState;
}
