import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * File tools granted to the supervisor on a repair candidate. Shell, grep, and
 * find are withheld: they cannot be confined to the candidate root, and
 * build/test runs through controller preflight instead.
 */
export const CANDIDATE_CODING_TOOL_NAMES = ["read", "edit", "write", "ls"] as const;

/**
 * Validate a candidate root issued by the controller: it must be the real
 * (non-symlinked) directory `<repairsDir>/<artifactId>/candidate` with the
 * controller's `snapshot.json` beside it.
 */
export async function assertAdmittedCandidateRoot(
  repairsDir: string | undefined,
  candidateRoot: string,
): Promise<string> {
  if (!repairsDir) {
    throw new Error("candidate coding requires a controller repairs directory");
  }
  const resolved = path.resolve(candidateRoot);
  const real = await realpath(resolved).catch(() => {
    throw new Error(`candidate root does not exist: ${resolved}`);
  });
  if (real !== resolved) {
    throw new Error(`candidate root must not be a symlink: ${resolved}`);
  }
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`candidate root is not a directory: ${real}`);
  }
  const repairsReal = await realpath(path.resolve(repairsDir));
  const parts = path.relative(repairsReal, real).split(path.sep);
  if (parts.length !== 2 || parts[0] === ".." || parts[0] === "" || parts[1] !== "candidate") {
    throw new Error(`candidate root is not a controller-issued snapshot: ${real}`);
  }
  await access(path.join(repairsReal, parts[0]!, "snapshot.json")).catch(() => {
    throw new Error(`candidate root has no controller snapshot record: ${real}`);
  });
  return real;
}

/** Reject paths that resolve outside root or traverse a symlink. */
export async function assertInsideCandidate(rootReal: string, absolutePath: string): Promise<void> {
  const target = path.resolve(absolutePath);
  const rel = path.relative(rootReal, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path outside repair candidate: ${absolutePath}`);
  }
  let current = rootReal;
  for (const segment of rel === "" ? [] : rel.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new Error(`symlink in repair candidate path rejected: ${absolutePath}`);
    }
  }
}

export function createCandidateCodingTools(rootReal: string): ToolDefinition[] {
  const guard = (p: string) => assertInsideCandidate(rootReal, p);
  const tools: unknown[] = [
    createReadToolDefinition(rootReal, {
      operations: {
        async readFile(p) {
          await guard(p);
          return readFile(p);
        },
        async access(p) {
          await guard(p);
          await access(p, constants.R_OK);
        },
      },
    }),
    createEditToolDefinition(rootReal, {
      operations: {
        async readFile(p) {
          await guard(p);
          return readFile(p);
        },
        async writeFile(p, content) {
          await guard(p);
          await writeFile(p, content, "utf8");
        },
        async access(p) {
          await guard(p);
          await access(p, constants.R_OK | constants.W_OK);
        },
      },
    }),
    createWriteToolDefinition(rootReal, {
      operations: {
        async writeFile(p, content) {
          await guard(p);
          await writeFile(p, content, "utf8");
        },
        async mkdir(dir) {
          await guard(dir);
          await mkdir(dir, { recursive: true });
        },
      },
    }),
    createLsToolDefinition(rootReal, {
      operations: {
        async exists(p) {
          await guard(p);
          return (await lstat(p).catch(() => undefined)) !== undefined;
        },
        async stat(p) {
          await guard(p);
          return stat(p);
        },
        async readdir(p) {
          await guard(p);
          return readdir(p);
        },
      },
    }),
  ];
  return tools as ToolDefinition[];
}
