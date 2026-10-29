// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export type {
  ChildOperationPort,
  ExecutorDescriptor,
  ExecutorSourceOverride,
  JobConfinement,
  JobContext,
  JobEvidenceItem,
  JobResult,
  Runner,
} from "./types.js";
export {
  createScriptedRunner,
  type ScriptedJobHandler,
  type ScriptedRunnerOptions,
} from "./scripted.js";
export {
  assertNoBuiltinShadowing,
  BUILTIN_EXECUTOR_NAMESPACE,
  createRegistryRunner,
  createTrustedInProcessRunner,
  createChildExecutorRunner,
  describeExecutorModule,
  type DescribedExecutor,
  type TrustedInProcessRunnerOptions,
  type ChildExecutorRunnerOptions,
  type RegistryRunnerOptions,
} from "./registry.js";
export { digestExecutorSource } from "./digest.js";
export {
  DOCKER_RUN_MODULE,
  RUN_LABEL,
  containerIdentity,
  daemonIsRootless,
  dockerImageProblem,
  ensureDockerImage,
  type ImageOutcome,
  dockerRunArgs,
  killContainers,
  removeRunContainers,
  withDockerConfinement,
  type DockerRunOptions,
  type DockerRunSpec,
} from "./sandbox-docker.js";
export { agentExecutables } from "./registry.js";
export { assertSandboxSupported, packageClosure, packageRootOf } from "./sandbox.js";
export { confineWorker, confinementUnsupported, expandHome, hasPrivateTmp, operatorGoSettings, type BwrapSandbox, type ConfinedWorker, type OperatorGo } from "./confine.js";
export {
  createBuiltinExecutorRunner,
  type BuiltinExecutorPackage,
  type BuiltinExecutorRunnerOptions,
} from "./builtin.js";
