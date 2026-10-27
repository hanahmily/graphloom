// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Credentials for the Pi supervisor, for any provider Pi knows: a built-in
 * one (`deepseek`, `openai`, `minimax-cn`, ...) or a custom one defined in the
 * agent dir's `models.json` (for example an OpenAI-compatible endpoint with
 * `"api": "openai-completions"`, a `baseUrl`, and `"apiKey": "$SOME_ENV_VAR"`).
 * Pi's own registry and auth store resolve them; GraphLoom only injects an
 * explicit key, plus the fallback variables provider-profiles.ts lists
 * (MiniMax's historical ones). No other provider is special-cased.
 * Never log or return key values into prompts or transcripts.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { ENV_KEY_FALLBACKS } from "./provider-profiles.js";

/**
 * Where a provider's credential came from, never the value:
 * - `options`: an explicit key passed by the caller.
 * - `env:<NAME>`: an environment variable (Pi's own variable for the provider,
 *   a `$NAME` reference in models.json, or a GraphLoom fallback variable).
 * - `models.json`: a literal key or `!command` in the agent dir's models.json.
 * - `pi-stored`: Pi's auth store (`auth.json`, `/login`) or another Pi source.
 */
export type PiCredentialSource = "options" | `env:${string}` | "models.json" | "pi-stored";

export interface ResolvedProviderCredential {
  /** Present only when GraphLoom injects the key into Pi's ModelRuntime. */
  apiKey?: string;
  /** Set when `apiKey` is injected; otherwise Pi resolves the credential itself. */
  source?: PiCredentialSource;
}

/** Every name is "present": makes Pi's env lookup list all of a provider's variable names. */
const ANY_ENV: Record<string, string> = new Proxy({}, { get: () => "present" });

/**
 * The environment variable names Pi reads an API key from for a built-in
 * provider (`DEEPSEEK_API_KEY` for `deepseek`, `MINIMAX_CN_API_KEY` for
 * `minimax-cn`, ...), from Pi's own table; empty for a provider Pi has no
 * variable for (a models.json custom provider names its own in `apiKey`).
 */
export function piProviderEnvVars(provider: string): string[] {
  try {
    return [...(findEnvKeys(provider, ANY_ENV) ?? [])];
  } catch {
    return [];
  }
}

/**
 * Every environment variable that can hold `provider`'s key, in the order
 * they are consulted: GraphLoom's MiniMax fallbacks, then Pi's own. Empty
 * for a models.json custom provider, whose `apiKey` names its own.
 */
export function providerCredentialEnvVars(provider: string): string[] {
  return [...new Set([...(ENV_KEY_FALLBACKS[provider] ?? []), ...piProviderEnvVars(provider)])];
}

/**
 * The key GraphLoom injects for `provider`, if any:
 * 1. an explicit `apiKey`;
 * 2. the provider's fallback variables in provider-profiles.ts, in order
 *    (MiniMax's `MINIMAX_CN_API_KEY` then `MINIMAX_API_KEY`, as before);
 * 3. nothing: Pi resolves the credential with its own order (auth store,
 *    models.json `apiKey` including `$ENV` references, then the provider's
 *    environment variable).
 */
export function resolveProviderCredential(options: {
  provider: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedProviderCredential {
  const explicit = options.apiKey?.trim();
  if (explicit) return { apiKey: explicit, source: "options" };
  const env = options.env ?? process.env;
  for (const name of ENV_KEY_FALLBACKS[options.provider] ?? []) {
    const value = env[name]?.trim();
    if (value) return { apiKey: value, source: `env:${name}` };
  }
  return {};
}

/** A file of the installed Pi coding agent, found as Node would: the nearest `node_modules` up from this module. */
function piModuleFile(relative: string): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", relative);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let piDefaults:Promise<Readonly<Record<string, string>> | undefined> | undefined;

/**
 * Pi's own per-provider default model table (what Pi starts a provider on),
 * read from the pinned Pi version. Pi does not export it from its entry
 * point, so it is loaded from the installed module beside that entry; any
 * failure only means no default is known.
 */
function piDefaultModels(): Promise<Readonly<Record<string, string>> | undefined> {
  piDefaults ??= (async () => {
    try {
      const file = piModuleFile("dist/core/model-resolver.js");
      if (file === undefined) return undefined;
      const mod = (await import(pathToFileURL(file).href)) as { defaultModelPerProvider?: Record<string, string> };
      return typeof mod.defaultModelPerProvider === "object" ? mod.defaultModelPerProvider : undefined;
    } catch {
      return undefined;
    }
  })();
  return piDefaults;
}

/**
 * The model to recommend for `provider` among the ids Pi's registry lists for
 * it: Pi's own default for that provider when it is listed, else the first.
 * Used to recommend a model, never to override a configured one.
 */
export async function piDefaultModelId(provider: string, modelIds: readonly string[]): Promise<string | undefined> {
  const preferred = (await piDefaultModels())?.[provider];
  if (preferred !== undefined && modelIds.includes(preferred)) return preferred;
  return modelIds[0];
}

/**
 * Whether Pi's registry, reading `modelsPath` (a candidate models.json) with
 * the agent dir's `authPath`, loads without error and lists `provider/modelId`.
 * No provider call and no credential is resolved.
 */
export async function checkPiModelsFile(args: { authPath: string; modelsPath: string; provider: string; modelId: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ authPath: args.authPath, modelsPath: args.modelsPath });
  const error = runtime.getError();
  if (error !== undefined) return { ok: false, reason: `Pi refuses it: ${error}` };
  if (runtime.getModel(args.provider, args.modelId) === undefined) return { ok: false, reason: `Pi does not list ${args.provider}/${args.modelId} from it` };
  return { ok: true };
}
