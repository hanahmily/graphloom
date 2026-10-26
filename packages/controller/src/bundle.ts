// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
  return resolveSafeEntry(bundlePath, relative);
}

/**
 * Resolve the bundle's optional rehearsal entry (docs/design-graph-rehearsal.md
 * §4.4), a module exporting `GraphRehearsal`. `undefined` when the manifest
 * declares none — every graph is still rehearsable on schema synthesis alone.
 */
export function resolveBundleRehearsalEntry(intake: IntakePin): string | undefined {
  const manifest = JSON.parse(intake.bundle.manifestRaw) as {
    entryPoints?: { rehearsal?: string };
  };
  const relative = manifest.entryPoints?.rehearsal;
  return relative === undefined ? undefined : resolveSafeEntry(intake.bundle.bundlePath, relative);
}

function resolveSafeEntry(bundlePath: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[/\\]/).includes("..")) {
    throw new Error(`unsafe bundle entry: ${relative}`);
  }
  return path.resolve(bundlePath, relative);
}
