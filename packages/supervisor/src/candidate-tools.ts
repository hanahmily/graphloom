import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi's full coding toolset, granted to the supervisor on a repair candidate
 * with the candidate root as its working directory. The tools are not confined
 * to it. The controller stops the run if the patch changed the live install,
 * the run worktree, or the run state, then checks the candidate, builds and
 * tests it, has it reviewed independently, and re-digests the live install
 * before activation.
 */
export const CANDIDATE_CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

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

export function createCandidateCodingTools(rootReal: string): ToolDefinition[] {
  const tools = [
    createReadToolDefinition(rootReal),
    createBashToolDefinition(rootReal),
    createEditToolDefinition(rootReal),
    createWriteToolDefinition(rootReal),
    createGrepToolDefinition(rootReal),
    createFindToolDefinition(rootReal),
    createLsToolDefinition(rootReal),
  ] as unknown as ToolDefinition[];
  return tools.map((tool) => rootedAt(tool, rootReal));
}

/** Tool names an independent reviewer gets: read-only, no shell, no edits. */
export const CANDIDATE_REVIEW_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/**
 * Read-only tools for an independent repair reviewer, rooted at the candidate:
 * no bash, no edit, no write, so a reviewer session cannot itself change the
 * candidate it judges.
 */
export function createCandidateReviewTools(rootReal: string): ToolDefinition[] {
  const tools = [
    createReadToolDefinition(rootReal),
    createGrepToolDefinition(rootReal),
    createFindToolDefinition(rootReal),
    createLsToolDefinition(rootReal),
  ] as unknown as ToolDefinition[];
  return tools.map((tool) => rootedAt(tool, rootReal));
}

/** Pi's tools prefer the session's `ctx.cwd` over their factory cwd. */
function rootedAt(tool: ToolDefinition, rootReal: string): ToolDefinition {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        new Proxy(ctx ?? {}, {
          get: (target, key, receiver) => (key === "cwd" ? rootReal : Reflect.get(target, key, receiver)),
        }) as typeof ctx,
      ),
  };
}
