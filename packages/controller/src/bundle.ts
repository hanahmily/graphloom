import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Validator } from "@graphloom/sdk";
import type { IntakePin } from "./intake.js";

/** Resolve the pinned createGraph entry module from the bundle manifest. */
export function resolveBundleEntry(intake: IntakePin): string {
  const manifest = JSON.parse(intake.bundle.manifestRaw) as {
    entryPoints?: { createGraph?: string };
  };
  const relative = manifest.entryPoints?.createGraph ?? "./dist/index.js";
  if (path.isAbsolute(relative) || relative.split(/[/\\]/).includes("..")) {
    throw new Error(`unsafe bundle entry: ${relative}`);
  }
  return path.resolve(intake.bundle.bundlePath, relative);
}

/**
 * Load validators from the same bundle entry used by the child host.
 * Controllers keep validators in-process; graphs run out-of-process.
 */
export async function loadValidatorsFromBundle(
  intake: IntakePin,
  definitionValidatorIds: string[],
): Promise<Record<string, Validator>> {
  const entry = resolveBundleEntry(intake);
  const mod = (await import(pathToFileURL(entry).href)) as {
    validatorById?: (id: string) => Validator | undefined;
    exactGreetingValidator?: Validator;
    independentReviewValidator?: Validator;
  };
  const out: Record<string, Validator> = {};
  for (const id of definitionValidatorIds) {
    const v =
      mod.validatorById?.(id) ??
      (id === "exact-greeting" ? mod.exactGreetingValidator : undefined) ??
      (id === "independent-reviewer" ? mod.independentReviewValidator : undefined);
    if (!v) {
      throw new Error(`bundle does not export validator ${id}`);
    }
    out[id] = v;
  }
  return out;
}
