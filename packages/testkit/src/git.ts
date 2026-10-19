import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** The GraphLoom checkout this package was built in. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** An example graph bundle in this checkout (`examples/plugins/<graph>`). */
export function exampleBundle(graph: string): string {
  return path.join(repoRoot, "examples", "plugins", graph);
}

export interface GitRepo {
  /** The repository's top level. */
  path: string;
  /** Run git in the repository; resolves to trimmed stdout. */
  git(...args: string[]): Promise<string>;
  /** Write files (relative paths, parents created) without staging them. */
  write(files: Record<string, string | Buffer>): Promise<void>;
  /** Stage everything (`-f` stages ignored paths too) and commit. */
  commit(message: string, options?: { force?: boolean; paths?: string[] }): Promise<void>;
}

export interface GitRepoOptions {
  files?: Record<string, string | Buffer>;
  /** The repository's own commit identity (delivery commits as it). */
  identity?: { name: string; email: string };
  branch?: string;
}

/** `git init` at `dir` (created if missing) with `files` committed as the first commit. */
export async function createGitRepo(dir: string, options: GitRepoOptions = {}): Promise<GitRepo> {
  await mkdir(dir, { recursive: true });
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const identity = options.identity ?? { name: "Maintainer", email: "maintainer@example.com" };
  await git("init", "-q", "-b", options.branch ?? "main");
  await git("config", "user.email", identity.email);
  await git("config", "user.name", identity.name);
  await git("config", "commit.gpgsign", "false");
  const repo: GitRepo = {
    path: dir,
    git,
    async write(files) {
      for (const [name, bytes] of Object.entries(files)) {
        const at = path.join(dir, name);
        await mkdir(path.dirname(at), { recursive: true });
        await writeFile(at, bytes);
      }
    },
    async commit(message, commitOptions = {}) {
      await git("add", ...(commitOptions.force === true ? ["-f"] : []), "--", ...(commitOptions.paths ?? ["."]));
      await git("commit", "-q", "--allow-empty", "-m", message);
    },
  };
  await repo.write(options.files ?? { "README.md": "repo\n" });
  await repo.commit("init");
  return repo;
}
