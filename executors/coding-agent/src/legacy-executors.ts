/** Child entry for the CLI: legacy agent jobs keep their admitted executor identity. */
import { BUILTIN_AGENT_EXECUTOR_ID } from "@graphloom/sdk";
import { executors as codingExecutors } from "./executors.js";

export const executors = [
  ...codingExecutors,
  ...codingExecutors.map((executor) => ({ ...executor, id: BUILTIN_AGENT_EXECUTOR_ID })),
];
