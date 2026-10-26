import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { BUILTIN_EXECUTOR_NAMESPACE, createChildExecutorRunner } from "./registry.js";
import { assertSandboxSupported, packageRootOf } from "./sandbox.js";
import type { Runner } from "./types.js";

export interface BuiltinExecutorPackage extends ExecutorBinding {
  manifest: ExecutorPackageManifest;
}

export interface BuiltinExecutorRunnerOptions {
  /** Built-in packages to serve, each with the operator's grants. */
  packages: readonly BuiltinExecutorPackage[];
  /** Runner for every job no listed package serves. */
  fallback: Runner;
  /** Per-job timeout (ms) for packages whose binding sets none. Default 30_000. */
  timeoutMs?: number;
  /** After a timeout or stop, how long an executor gets to stop before its process is killed. Default: the child runner's (10 s). */
  stopGraceMs?: number;
  /** Override the runner's worker entry (tests). */
  workerModule?: string;
}

/**
 * Serve built-in executor packages, each in its own executor process that sees
 * only the credentials, effect grant, and configuration the operator bound.
 * Sandboxed packages can read only their own package and dependencies; a
 * package declaring `isolation: "unrestricted"` runs with full user
 * permissions and requires `allowUnrestricted`.
 */
export function createBuiltinExecutorRunner(options: BuiltinExecutorRunnerOptions): Runner {
  if (options.packages.some((p) => p.manifest.isolation !== "unrestricted")) assertSandboxSupported();
  const claimed = new Map<string, string>();
  for (const { manifest, credentials, env, allowUnrestricted } of options.packages) {
    if (manifest.isolation === "unrestricted" && allowUnrestricted !== true) {
      throw new Error(
        `built-in package ${manifest.name} runs unrestricted; the operator must set allowUnrestricted`,
      );
    }
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
    const unrestricted = pkg.manifest.isolation === "unrestricted";
    // An unrestricted package runs commands, so it needs the user's PATH and HOME.
    const env: NodeJS.ProcessEnv = unrestricted ? { ...process.env, ...pkg.env } : { ...pkg.env };
    if (process.env.NODE_EXTRA_CA_CERTS !== undefined) {
      env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    }
    const timeoutMs = pkg.timeoutMs ?? options.timeoutMs;
    return createChildExecutorRunner({
      entryModule: pkg.manifest.entryModule,
      executorIds: [...pkg.manifest.executorIds],
      builtin: true,
      sandbox: !unrestricted,
      sourceRoot: packageRootOf(pkg.manifest.entryModule),
      ...(pkg.manifest.ownState !== undefined ? { ownState: pkg.manifest.ownState } : {}),
      fallback,
      env,
      allowedEffects: pkg.allowedEffects ?? ["read"],
      ...(pkg.credentials !== undefined ? { credentials: pkg.credentials } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(pkg.maxTimeoutMs !== undefined ? { maxTimeoutMs: pkg.maxTimeoutMs } : {}),
      ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
      ...(options.workerModule !== undefined ? { workerModule: options.workerModule } : {}),
    });
  }, options.fallback);
}
