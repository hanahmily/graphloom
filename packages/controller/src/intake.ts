import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@graphloom/sdk";
import { assertSafeGraphId } from "./ids.js";

const execFileAsync = promisify(execFile);

export interface TaskFile {
  graph: string;
  repo: string;
  request: string;
}

export interface BundlePin {
  graphId: string;
  version: string;
  bundlePath: string;
  sdkProtocol: number;
  digests: Record<string, unknown>;
  manifestRaw: string;
  manifestDigest: string;
}

export interface IntakePin {
  taskPath: string;
  taskDir: string;
  task: TaskFile;
  repoPath: string;
  pinnedHead: string;
  bundle: BundlePin;
  grants: { sourceRepair: boolean; validatorSubstitution: boolean };
  budgets: {
    agentInvocations: number;
    jobs: number;
    decisions: number;
    corrections: number;
  };
}

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

/** Parse minimal task.yaml (graph / repo / request). */
export function parseTaskYaml(text: string): TaskFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let graph: string | undefined;
  let repo: string | undefined;
  let request: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || line.trim() === "") {
      continue;
    }

    const graphMatch = /^graph:\s*(.+?)\s*$/.exec(line);
    if (graphMatch) {
      graph = unquote(graphMatch[1]!);
      continue;
    }
    const repoMatch = /^repo:\s*(.+?)\s*$/.exec(line);
    if (repoMatch) {
      repo = unquote(repoMatch[1]!);
      continue;
    }

    if (/^request:\s*\|\s*$/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        if (bodyLine.length === 0) {
          body.push("");
          i += 1;
          continue;
        }
        if (/^[^\s]/.test(bodyLine)) {
          i -= 1;
          break;
        }
        body.push(bodyLine.replace(/^ {2}/, "").replace(/^\t/, ""));
        i += 1;
      }
      request = body.join("\n").replace(/\n+$/, "");
      continue;
    }

    const requestInline = /^request:\s*(.+?)\s*$/.exec(line);
    if (requestInline) {
      request = unquote(requestInline[1]!);
    }
  }

  if (!graph || !repo || request === undefined || request === "") {
    throw new IntakeError("task.yaml must declare graph, repo, and request");
  }
  try {
    assertSafeGraphId(graph);
  } catch (err) {
    throw new IntakeError(err instanceof Error ? err.message : String(err));
  }
  return { graph, repo, request };
}

export async function intakeTask(taskPath: string): Promise<IntakePin> {
  const absoluteTask = path.resolve(taskPath);
  await assertExists(absoluteTask, "file");
  const taskDir = path.dirname(absoluteTask);
  const task = parseTaskYaml(await readFile(absoluteTask, "utf8"));

  const repoPath = resolveUnderBase(taskDir, task.repo, "repo");
  await assertExists(repoPath, "directory");

  const bundlePath = resolveUnderBase(
    path.join(taskDir, "plugins"),
    task.graph,
    "graph bundle",
  );
  await assertExists(bundlePath, "directory");

  const manifestPath = path.join(bundlePath, "graphloom.manifest.json");
  await assertExists(manifestPath, "file");
  const manifestRaw = await readFile(manifestPath, "utf8");
  let manifest: {
    graphId?: string;
    version?: string;
    sdkProtocol?: number;
    digests?: Record<string, unknown>;
  };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    throw new IntakeError("manifest is not valid JSON");
  }
  if (manifest.graphId !== task.graph) {
    throw new IntakeError(
      `manifest graphId ${JSON.stringify(manifest.graphId)} does not match task graph ${JSON.stringify(task.graph)}`,
    );
  }
  if (typeof manifest.version !== "string" || typeof manifest.sdkProtocol !== "number") {
    throw new IntakeError("manifest missing version or sdkProtocol");
  }
  if (manifest.sdkProtocol !== PROTOCOL_VERSION) {
    throw new IntakeError(
      `manifest sdkProtocol ${manifest.sdkProtocol} != host ${PROTOCOL_VERSION}`,
    );
  }

  const pinnedHead = await gitRevParse(repoPath, "HEAD");

  return {
    taskPath: absoluteTask,
    taskDir,
    task,
    repoPath,
    pinnedHead,
    bundle: {
      graphId: manifest.graphId,
      version: manifest.version,
      bundlePath,
      sdkProtocol: manifest.sdkProtocol,
      digests: manifest.digests ?? {},
      manifestRaw,
      manifestDigest: sha256(manifestRaw),
    },
    grants: { sourceRepair: false, validatorSubstitution: false },
    budgets: {
      agentInvocations: 32,
      jobs: 64,
      decisions: 128,
      corrections: 8,
    },
  };
}

/** Resolve relative path under base; reject traversal and absolute escapes. */
export function resolveUnderBase(baseDir: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) {
    throw new IntakeError(`${label} must be a relative path`);
  }
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.split(path.sep).includes("..")) {
    throw new IntakeError(`${label} path traversal rejected: ${relative}`);
  }
  const resolved = path.resolve(baseDir, normalized);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new IntakeError(`${label} escapes task directory`);
  }
  return resolved;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function assertExists(p: string, _kind: "file" | "directory"): Promise<void> {
  try {
    await access(p);
  } catch {
    throw new IntakeError(`missing ${_kind}: ${p}`);
  }
}

async function gitRevParse(repoPath: string, rev: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", rev], { cwd: repoPath });
  return stdout.trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
