import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface RepairSnapshot {
  artifactId: string;
  candidateRoot: string;
  baseDigest: string;
  baseActiveVersion: string;
  target: "plugin" | "validator";
  reason: string;
  createdAt: string;
}

export interface QualifiedRepairArtifact extends RepairSnapshot {
  status: "qualifying" | "qualified" | "rejected" | "activated" | "superseded";
  candidateDigest?: string;
  patchAuthorSessionId?: string;
  /** Patch author's concise user-facing summary of the change. */
  patchSummary?: string;
  reviewerSessionId?: string;
  reviewReason?: string;
  rejectionReason?: string;
  qualifiedAt?: string;
  /** Controller-mediated preflight summary recorded at qualification. */
  preflightSummary?: string;
}

/** SHA-256 of a directory tree (paths + file bytes), excluding node_modules. */
export async function digestDirectoryTree(root: string): Promise<string> {
  const h = createHash("sha256");
  const entries = await listFilesRecursive(root);
  entries.sort();
  for (const rel of entries) {
    h.update(rel);
    h.update("\0");
    const bytes = await readFile(path.join(root, rel));
    h.update(bytes);
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * List files under root. Rejects symlinks so review/digest/activation cannot
 * follow links outside the candidate scope.
 */
async function listFilesRecursive(root: string, prefix = ""): Promise<string[]> {
  const abs = prefix ? path.join(root, prefix) : root;
  const names = await readdir(abs);
  const out: string[] = [];
  const rootReal = await realpath(root);
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const rel = prefix ? path.join(prefix, name) : name;
    const full = path.join(root, rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      throw new Error(
        `candidate contains symlink (rejected): ${rel.split(path.sep).join("/")}`,
      );
    }
    // Defense in depth: resolved path must stay under the candidate root.
    const resolved = path.resolve(full);
    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
      throw new Error(`candidate path escapes root: ${rel}`);
    }
    if (info.isDirectory()) {
      out.push(...(await listFilesRecursive(root, rel)));
    } else if (info.isFile()) {
      out.push(rel.split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Copy the pinned bundle into an isolated candidate tree under repairsDir.
 * Does not mutate the source install.
 */
export async function snapshotRepairCandidate(args: {
  bundlePath: string;
  repairsDir: string;
  baseActiveVersion: string;
  target: "plugin" | "validator";
  reason: string;
  artifactId?: string;
}): Promise<RepairSnapshot> {
  const artifactId = args.artifactId ?? `repair-${randomUUID().slice(0, 8)}`;
  const candidateRoot = path.join(args.repairsDir, artifactId, "candidate");
  await mkdir(path.dirname(candidateRoot), { recursive: true });
  // Always copy the real bundle tree — never leave a symlink to the live install.
  const bundleReal = await realpath(args.bundlePath);
  const baseDigest = await digestDirectoryTree(bundleReal);
  await cp(bundleReal, candidateRoot, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== "node_modules" && base !== ".git";
    },
  });
  const meta: RepairSnapshot = {
    artifactId,
    candidateRoot,
    baseDigest,
    baseActiveVersion: args.baseActiveVersion,
    target: args.target,
    reason: args.reason,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(args.repairsDir, artifactId, "snapshot.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

/** Reject patches that alter the pinned step list; stages pin is required. */
export async function assertCandidateStepsUnchanged(args: {
  baseDefinitionStages: Array<{ id: string; name: string; requirementIds: string[] }>;
  candidateRoot: string;
  /** Relative path to a JSON GraphDefinition-like file inside the candidate. */
  definitionRelativePath?: string;
}): Promise<void> {
  const rel = args.definitionRelativePath ?? "graphloom.stages.json";
  const defPath = path.join(args.candidateRoot, rel);
  let raw: string;
  try {
    raw = await readFile(defPath, "utf8");
  } catch {
    throw new Error(
      `candidate missing required stages pin (${rel}); add/delete/rename/reorder check cannot be deferred`,
    );
  }
  const parsed = JSON.parse(raw) as {
    stages?: Array<{ id: string; name: string; requirementIds: string[] }>;
  };
  const stages = parsed.stages;
  if (!Array.isArray(stages)) {
    throw new Error("candidate stages pin is malformed");
  }
  if (stages.length !== args.baseDefinitionStages.length) {
    throw new Error("candidate alters pinned stage count");
  }
  for (let i = 0; i < stages.length; i++) {
    const want = args.baseDefinitionStages[i]!;
    const got = stages[i]!;
    if (
      got.id !== want.id ||
      got.name !== want.name ||
      JSON.stringify(got.requirementIds) !== JSON.stringify(want.requirementIds)
    ) {
      throw new Error(
        `candidate alters pinned steps (stage ${want.id}): add/delete/rename/reorder rejected`,
      );
    }
  }
}
