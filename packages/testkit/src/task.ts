import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitRepo, exampleBundle, type GitRepo, type GitRepoOptions } from "./git.js";
import type { TestScope } from "./scope.js";

/** Run budgets as task YAML spells them (any subset). */
export interface TaskBudgets {
  agentInvocations?: number;
  jobs?: number;
  decisions?: number;
  corrections?: number;
  activeMs?: number;
  waitMs?: number;
}

/**
 * Where the task file sits relative to the repository it names:
 *
 * - `beside`: `<dir>/task.yaml` names `repo: ./<repoName>`, the tidy shape
 *   most tests use.
 * - `subdirectory`: the task file lives in a directory *inside* the
 *   repository (`<repo>/examples/task.yaml`, committed with its plugins
 *   directory and config) and names `repo: .`, as
 *   `examples/issue-fix-graphloom-task.yaml` does in this checkout (#127).
 */
export type TaskLayout = "beside" | "subdirectory";

export interface TaskWorkspaceOptions extends GitRepoOptions {
  graph: string;
  request: string;
  /** The graph bundle to install under the task's `plugins/<graph>` (a symlink). Default: the example bundle. */
  bundle?: string;
  /**
   * The task's `config:`, relative to the task file. With `value`, that file
   * is written there; without, the path is named as it is (a profile shipped
   * in the bundle, say).
   */
  config?: { name: string; value?: unknown };
  budgets?: TaskBudgets;
  layout?: TaskLayout;
  /** Repository directory name under the workspace (`beside` layout). Default `repo`. */
  repoName?: string;
  /** Directory inside the repository holding the task (`subdirectory` layout). Default `examples`. */
  taskSubdirectory?: string;
}

export interface TaskWorkspace {
  /** The scratch directory everything lives under. */
  dir: string;
  repo: GitRepo;
  taskPath: string;
  /** The directory holding the task file. */
  taskDir: string;
  /** Run state, outside the repository. */
  stateRoot: string;
  /** The installed bundle path (`<taskDir>/plugins/<graph>`). */
  bundlePath: string;
  /** Absolute path of the task config file, when there is one. */
  configPath?: string;
}

/** A Git repository and a task file naming it, with the graph bundle installed beside the task. */
export async function createTaskWorkspace(scope: TestScope, options: TaskWorkspaceOptions): Promise<TaskWorkspace> {
  const dir = await scope.tempDir(`gl-${options.graph}-`);
  const layout = options.layout ?? "beside";
  const repoDir = path.join(dir, options.repoName ?? "repo");
  const repo = await createGitRepo(repoDir, options);
  const taskDir = layout === "subdirectory" ? path.join(repoDir, options.taskSubdirectory ?? "examples") : dir;
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  const bundlePath = path.join(taskDir, "plugins", options.graph);
  await symlink(options.bundle ?? exampleBundle(options.graph), bundlePath);
  let configPath: string | undefined;
  if (options.config !== undefined) {
    configPath = path.join(taskDir, options.config.name);
  }
  if (configPath !== undefined && options.config?.value !== undefined) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(options.config.value, null, 2)}\n`);
  }
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, taskYaml({ ...options, repo: layout === "subdirectory" ? "." : `./${path.basename(repoDir)}` }));
  if (layout === "subdirectory") {
    // Tracked like GraphLoom's own examples/: the task, its config and its plugins link are part of the repository.
    await repo.commit("add the task", { paths: [path.relative(repoDir, taskDir)] });
  }
  return { dir, repo, taskPath, taskDir, stateRoot: path.join(dir, "state"), bundlePath, ...(configPath !== undefined ? { configPath } : {}) };
}

function taskYaml(options: TaskWorkspaceOptions & { repo: string }): string {
  const lines = [`graph: ${options.graph}`, `repo: ${options.repo}`];
  if (options.config !== undefined) lines.push(`config: ${options.config.name}`);
  lines.push(`request: ${JSON.stringify(options.request)}`);
  const budgets = Object.entries(options.budgets ?? {}).filter(([, v]) => v !== undefined);
  if (budgets.length > 0) {
    lines.push("budgets:");
    for (const [name, value] of budgets) lines.push(`  ${name}: ${value}`);
  }
  return `${lines.join("\n")}\n`;
}
