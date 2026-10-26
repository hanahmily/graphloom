// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IntakePin } from "./intake.js";
import { resolveBundleEntry } from "./bundle.js";

/** Digest the pinned createGraph entry bytes (not just the manifest). */
export async function digestBundleEntry(intake: IntakePin): Promise<string> {
  const entry = resolveBundleEntry(intake);
  const bytes = await readFile(entry);
  return createHash("sha256").update(bytes).digest("hex");
}

/** The installed bundle's pin, read the way intake reads it. */
export async function readInstalledBundlePin(previous: IntakePin["bundle"]): Promise<IntakePin["bundle"]> {
  const manifestRaw = await readFile(path.join(previous.bundlePath, "graphloom.manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as { graphId?: unknown; version?: unknown; digests?: Record<string, unknown> };
  if (manifest.graphId !== previous.graphId) {
    throw new Error(`the installed bundle is graph ${String(manifest.graphId)}, not this run's ${previous.graphId}; a plugin update keeps the graph`);
  }
  const bundle = {
    ...previous,
    // An update may carry a new version of the same graph; the definition
    // checks on resume still require the same stages, requirements,
    // validator bindings and private-state schema.
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    digests: manifest.digests ?? {},
    manifestRaw,
    manifestDigest: createHash("sha256").update(manifestRaw, "utf8").digest("hex"),
  };
  return { ...bundle, entryDigest: await digestBundleEntry({ bundle } as IntakePin) };
}

/** Re-read the on-disk manifest and entry; ensure they still match the run pin. */
export async function assertPinnedBundleUnchanged(intake: IntakePin): Promise<void> {
  const manifestPath = path.join(intake.bundle.bundlePath, "graphloom.manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  if (digest !== intake.bundle.manifestDigest) {
    throw new Error(
      `pinned manifest digest mismatch: expected ${intake.bundle.manifestDigest}, got ${digest}`,
    );
  }
  const manifest = JSON.parse(raw) as {
    graphId?: string;
    version?: string;
    digests?: { sourceTree?: string };
  };
  if (manifest.graphId !== intake.bundle.graphId || manifest.version !== intake.bundle.version) {
    throw new Error("pinned graphId/version no longer matches on-disk manifest");
  }
  const pinnedTree = (intake.bundle.digests as { sourceTree?: string } | undefined)?.sourceTree;
  const liveTree = manifest.digests?.sourceTree;
  if (pinnedTree && liveTree && pinnedTree !== liveTree) {
    throw new Error("pinned sourceTree digest no longer matches on-disk manifest");
  }

  const liveEntry = await digestBundleEntry(intake);
  if (liveEntry !== intake.bundle.entryDigest) {
    throw new Error(
      `pinned entry digest mismatch: expected ${intake.bundle.entryDigest}, got ${liveEntry}`,
    );
  }
}
