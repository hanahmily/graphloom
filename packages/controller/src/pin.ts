import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IntakePin } from "./intake.js";

/** Re-read the on-disk manifest and ensure it still matches the run pin. */
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
}
