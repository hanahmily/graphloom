/** Child entry for the CLI: legacy agent jobs keep their admitted executor identity. */
import { BUILTIN_AGENT_EXECUTOR_ID } from "@graphloom/sdk";
import { executors as codingExecutors } from "./executors.js";

export const executors = [
  ...codingExecutors,
  // The alias takes its assignment from the job's instruction (the CLI router ignores its input),
  // so it advertises no input shape.
  ...codingExecutors.map(({ inputShape: _shape, ...executor }) => ({ ...executor, id: BUILTIN_AGENT_EXECUTOR_ID })),
];
