import path from "node:path";
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
