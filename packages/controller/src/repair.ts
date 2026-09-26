import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RepairTarget } from "@graphloom/sdk";

export interface RepairSnapshot {
  artifactId: string;
  candidateRoot: string;
  baseDigest: string;
  baseActiveVersion: string;
  target: RepairTarget;
  /** Executor repairs: the requested executor id and the candidate's entry module. */
  executorId?: string;
  candidateEntryModule?: string;
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

const UNDIGESTED = new Set(["node_modules", ".git"]);

/**
 * Entries under a candidate that the digest skips, so review and activation
 * would never see what Node loads from them. With `linkedDependencies`, the
 * top-level node_modules may hold only the controller's dependency symlinks.
 */
export async function unreviewedEntries(
  root: string,
  options: { linkedDependencies?: boolean } = {},
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(path.join(root, rel))) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const info = await lstat(path.join(root, child));
      if (UNDIGESTED.has(name)) {
        if (child === "node_modules" && options.linkedDependencies) {
          found.push(...(await unlinkedDependencies(root)));
        } else {
          found.push(child);
        }
      } else if (info.isDirectory()) {
        await walk(child);
      }
    }
  };
  await walk("");
  return found.sort();
}

async function unlinkedDependencies(root: string): Promise<string[]> {
  const found: string[] = [];
  const modules = path.join(root, "node_modules");
  for (const name of await readdir(modules)) {
    const info = await lstat(path.join(modules, name));
    if (info.isSymbolicLink()) continue;
    if (name.startsWith("@") && info.isDirectory()) {
      for (const scoped of await readdir(path.join(modules, name))) {
        if (!(await lstat(path.join(modules, name, scoped))).isSymbolicLink()) {
          found.push(`node_modules/${name}/${scoped}`);
        }
      }
      continue;
    }
    found.push(`node_modules/${name}`);
  }
  return found;
}

/** Throws when a candidate holds entries its digest cannot cover. */
export async function assertCandidateFullyReviewed(
  root: string,
  options: { linkedDependencies?: boolean } = {},
): Promise<void> {
  const found = await unreviewedEntries(root, options);
  if (found.length > 0) {
    const shown = found.slice(0, 5).join(", ");
    throw new Error(`candidate contains entries review cannot see: ${shown}${found.length > 5 ? ", …" : ""}`);
  }
}

/** Base files the candidate edited or deleted, sorted; files it only added are not listed. */
export async function changedBaseFiles(
  baseRoot: string,
  candidateRoot: string,
  ignore: ReadonlySet<string>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const rel of (await listFilesRecursive(baseRoot)).sort()) {
    if (ignore.has(rel)) continue;
    const [want, got] = await Promise.all([
      readFile(path.join(baseRoot, rel)),
      readFile(path.join(candidateRoot, rel)).catch(() => undefined),
    ]);
    if (got === undefined || !want.equals(got)) changed.push(rel);
  }
  return changed;
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
  target: RepairTarget;
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

/**
 * Let a candidate copied without node_modules resolve the same dependencies the
 * installed package does: each declared dependency is linked under
 * `<intoDir>/node_modules`, which must be the candidate root or an ancestor.
 */
export async function linkDependencies(baseReal: string, intoDir: string): Promise<void> {
  const declared = await declaredDependencies(baseReal);
  const names = new Set(Object.values(declared).flatMap((deps) => Object.keys(deps ?? {})));
  for (const name of names) {
    const found = findDependency(baseReal, name);
    if (found === undefined) continue;
    const link = path.join(intoDir, "node_modules", name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(await realpath(found), link, "dir");
  }
}

/**
 * Candidates run against the installed package's dependencies, linked before
 * the patch, so a patch may not change what package.json declares.
 */
export async function assertDependenciesUnchanged(baseReal: string, candidateRoot: string): Promise<void> {
  const [base, candidate] = await Promise.all([
    declaredDependencies(baseReal),
    declaredDependencies(candidateRoot),
  ]);
  for (const field of DEPENDENCY_FIELDS) {
    if (JSON.stringify(sortedEntries(candidate[field])) !== JSON.stringify(sortedEntries(base[field]))) {
      throw new Error(`candidate changes declared ${field} in package.json`);
    }
  }
}

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

type DeclaredDependencies = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

async function declaredDependencies(root: string): Promise<DeclaredDependencies> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return {};
  }
  const pkg = JSON.parse(raw) as DeclaredDependencies;
  return Object.fromEntries(DEPENDENCY_FIELDS.map((field) => [field, pkg[field]]));
}

function sortedEntries(deps: Record<string, string> | undefined): [string, string][] {
  return Object.entries(deps ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

function findDependency(fromRealRoot: string, name: string): string | undefined {
  for (let dir = fromRealRoot; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}
