import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { BUILTIN_EXECUTOR_NAMESPACE, createChildExecutorRunner } from "./registry.js";
import { assertSandboxSupported } from "./sandbox.js";
import type { Runner } from "./types.js";

export interface BuiltinExecutorPackage extends ExecutorBinding {
  manifest: ExecutorPackageManifest;
}

export interface BuiltinExecutorRunnerOptions {
  /** Built-in packages to serve, each with the operator's grants. */
  packages: readonly BuiltinExecutorPackage[];
  /** Runner for every job no listed package serves. */
  fallback: Runner;
  /** Per-job timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Override the runner's worker entry (tests). */
  workerModule?: string;
}

/**
 * Serve built-in executor packages, each in its own sandboxed executor process
 * that sees only the credentials, effect grant, and configuration the operator
 * bound, and can read only its own package and dependencies.
 */
export function createBuiltinExecutorRunner(options: BuiltinExecutorRunnerOptions): Runner {
  assertSandboxSupported();
  const claimed = new Map<string, string>();
  for (const { manifest, credentials, env } of options.packages) {
    for (const id of manifest.executorIds) {
      if (!id.startsWith(BUILTIN_EXECUTOR_NAMESPACE)) {
        throw new Error(`built-in package ${manifest.name} serves ${id} outside ${BUILTIN_EXECUTOR_NAMESPACE}*`);
      }
      const owner = claimed.get(id);
      if (owner !== undefined) {
        throw new Error(`executor ${id} is served by both ${owner} and ${manifest.name}`);
      }
      claimed.set(id, manifest.name);
    }
    for (const name of Object.keys(credentials ?? {})) {
      if (!(manifest.credentials ?? []).includes(name)) {
        throw new Error(`built-in package ${manifest.name} does not accept credential "${name}"`);
      }
    }
    for (const name of Object.keys(env ?? {})) {
      if (!(manifest.configEnv ?? []).includes(name)) {
        throw new Error(`built-in package ${manifest.name} does not accept configuration "${name}"`);
      }
    }
  }

  return options.packages.reduceRight<Runner>((fallback, pkg) => {
    const env: NodeJS.ProcessEnv = { ...pkg.env };
    if (process.env.NODE_EXTRA_CA_CERTS !== undefined) {
      env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    }
    return createChildExecutorRunner({
      entryModule: pkg.manifest.entryModule,
      executorIds: [...pkg.manifest.executorIds],
      builtin: true,
      sandbox: true,
      fallback,
      env,
      allowedEffects: pkg.allowedEffects ?? ["read"],
      ...(pkg.credentials !== undefined ? { credentials: pkg.credentials } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.workerModule !== undefined ? { workerModule: options.workerModule } : {}),
    });
  }, options.fallback);
}
