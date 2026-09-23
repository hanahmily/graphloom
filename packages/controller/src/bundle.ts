import path from "node:path";
import type { IntakePin } from "./intake.js";

/** Resolve the pinned createGraph entry module from the bundle manifest. */
export function resolveBundleEntry(intake: IntakePin): string {
  return resolveBundleEntryFromManifest(intake.bundle.bundlePath, intake.bundle.manifestRaw);
}

export function resolveBundleEntryFromManifest(
  bundlePath: string,
  manifestRaw: string,
): string {
  const manifest = JSON.parse(manifestRaw) as {
    entryPoints?: { createGraph?: string };
  };
  const relative = manifest.entryPoints?.createGraph ?? "./dist/index.js";
  if (path.isAbsolute(relative) || relative.split(/[/\\]/).includes("..")) {
    throw new Error(`unsafe bundle entry: ${relative}`);
  }
  return path.resolve(bundlePath, relative);
}
