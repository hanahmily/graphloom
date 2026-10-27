// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A custom provider in Pi's own `models.json` (docs/design-pi-supervisor.md,
 * "Choosing a supervisor model"), for an endpoint Pi does not ship: an
 * OpenAI-, Anthropic-, Google-, or Mistral-compatible API at a `baseUrl`.
 * The key is never written: the entry's `apiKey` is a `$NAME` reference,
 * which Pi resolves from the environment variable `NAME` at request time.
 */
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { checkPiModelsFile } from "@graphloom/supervisor";

/** Pi API types a models.json custom provider may speak (pi-ai's KnownApi, less those needing cloud SDK auth). */
export const CUSTOM_PI_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"] as const;
export type CustomPiApi = (typeof CUSTOM_PI_APIS)[number];

export interface CustomPiProvider {
  /** The Pi provider id (`<id>/<modelId>` in supervisor.json). */
  id: string;
  api: CustomPiApi;
  baseUrl: string;
  modelId: string;
  /** The NAME of the environment variable that holds the key; never the key. */
  envVar: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
/** Upper case only, so a pasted key (mixed case, dashes) is never taken for a name and written. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Why `value` is not a usable custom provider, or undefined. */
export function customProviderProblem(value: CustomPiProvider, known: readonly string[] = []): string | undefined {
  if (!PROVIDER_ID.test(value.id)) return `provider id ${JSON.stringify(value.id)} must be letters, digits, ".", "_", or "-"`;
  if (known.includes(value.id)) return `Pi already knows a provider ${value.id}; choose another id`;
  if (!(CUSTOM_PI_APIS as readonly string[]).includes(value.api)) return `api must be one of ${CUSTOM_PI_APIS.join(", ")}`;
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    return "baseUrl is not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "baseUrl must be an http or https URL";
  if (url.username !== "" || url.password !== "") return "baseUrl must not carry credentials";
  if (value.modelId.trim() === "") return "model id must not be empty";
  // Never echoed: an operator may paste the key itself here by mistake.
  if (!ENV_NAME.test(value.envVar)) return "that is not an environment variable name: give the variable's NAME in upper case (for example MY_ENDPOINT_API_KEY), not the key";
  return undefined;
}

/** The models.json entry for `value`: Pi's own format, its key a `$NAME` reference. */
export function customProviderEntry(value: CustomPiProvider): Record<string, unknown> {
  return { baseUrl: value.baseUrl, api: value.api, apiKey: `$${value.envVar}`, models: [{ id: value.modelId }] };
}

/**
 * Add `value` to `<agentDir>/models.json`, keeping every other entry: checked
 * by loading the new file with Pi's own registry first, written mode 0600 to
 * a temporary file and renamed into place, the old file kept as
 * `models.json.bak-<stamp>`. Refuses an id the file already defines. Returns
 * the backup path, if a file existed.
 */
export async function addCustomPiProvider(agentDir: string, value: CustomPiProvider, stamp: string): Promise<string | undefined> {
  const problem = customProviderProblem(value);
  if (problem !== undefined) throw new Error(problem);
  const file = path.join(agentDir, "models.json");
  let current: Record<string, unknown> = {};
  let exists = false;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file}: expected an object`);
    current = parsed as Record<string, unknown>;
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot add a provider to ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const providers = (current.providers ?? {}) as Record<string, unknown>;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) throw new Error(`${file}: providers must be an object`);
  if (value.id in providers) throw new Error(`${file} already defines provider ${value.id}; edit it there`);
  const next = { ...current, providers: { ...providers, [value.id]: customProviderEntry(value) } };

  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Pi must load it and list the model, or nothing changes.
  const checked = await checkPiModelsFile({ authPath: path.join(agentDir, "auth.json"), modelsPath: tmp, provider: value.id, modelId: value.modelId }).catch(
    (err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
  );
  if (!checked.ok) {
    await rm(tmp, { force: true });
    throw new Error(`the new ${file}: ${checked.reason}`);
  }
  let kept: string | undefined;
  if (exists) {
    kept = `${file}.bak-${stamp}`;
    await copyFile(file, kept, constants.COPYFILE_EXCL);
    await chmod(kept, 0o600);
  }
  await rename(tmp, file);
  return kept;
}

