import { createHash, randomUUID } from "node:crypto";
import { chmod, constants as fsConstants, copyFile, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { EnvironmentCommand } from "@graphloom/sdk";

/**
 * Run-scoped cache of environment preparation output.
 *
 * A prepare command that declares `inputs` and `outputs` globs is keyed by the
 * digest of the input files' contents (read in the checkout, before the command
 * runs) plus its argv. After a successful run its outputs are saved here; a
 * later checkout with the same key gets them copied back instead of running
 * the command. The cache lives in the run's state directory, which only the
 * controller writes: jobs never receive a path into it, and entries are
 * restored by copying, never linking. Everything read from or written into a
 * checkout is checked with lstat and never followed through a symbolic link,
 * because a job (possibly confined, possibly not) controls that tree.
 */

const execFileAsync = promisify(execFile);

export function prepareCacheDir(stateDir: string): string {
  return path.join(stateDir, "prepare-cache");
}

/** True when the command declares what it reads and what it writes, so its output can be reused. */
export function isCacheable(command: EnvironmentCommand): command is EnvironmentCommand & { inputs: string[]; outputs: string[] } {
  return (command.inputs?.length ?? 0) > 0 && (command.outputs?.length ?? 0) > 0;
}

/** The part of a command the command executor accepts. */
export function commandSpec(command: EnvironmentCommand): { id: string; argv: string[]; timeoutMs?: number } {
  return { id: command.id, argv: [...command.argv], ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}) };
}

type Entry = { path: string; type: "file"; mode: number; sha256: string } | { path: string; type: "link"; target: string };

interface Manifest {
  version: 1;
  entries: Entry[];
}

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEEP_ENTRIES_PER_COMMAND = 4;

/** A glob over `/`-separated repository-relative paths: `**`, `*`, `?`; a leading `!` excludes. */
function compile(pattern: string): { negate: boolean; regex: RegExp; prefix: string; segments: string[] } {
  const negate = pattern.startsWith("!");
  const glob = negate ? pattern.slice(1) : pattern;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
  }
  const segments = glob.split("/");
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?]/.test(segment)) break;
    fixed.push(segment);
  }
  const wild = segments.every((s) => !/[*?]/.test(s));
  return { negate, regex: new RegExp(`^${source}$`), prefix: wild ? glob : fixed.join("/"), segments };
}

function assertSafeRel(rel: string): void {
  if (rel === "" || path.isAbsolute(rel) || rel.split("/").some((s) => s === ".." || s === "" || s === ".")) throw new Error(`unsafe path ${rel}`);
}

function segmentRegex(segment: string): RegExp {
  return compile(segment).regex;
}

/** True when the glob could match something strictly below the directory `rel`. */
function couldMatchBelow(globSegments: string[], rel: string): boolean {
  const parts = rel.split("/");
  for (const [i, part] of parts.entries()) {
    const g = globSegments[i];
    if (g === undefined) return false;
    if (g === "**") return true;
    if (!segmentRegex(g).test(part)) return false;
  }
  return globSegments.length > parts.length;
}

/**
 * Files and symbolic links under `root` the patterns select, sorted, and the
 * symbolic links met on any path that could match an include pattern (the
 * link itself, a linked directory, or a linked parent of a literal path).
 * Walks with lstat only: a symbolic link to a directory is never entered, so
 * what lies behind it is not in the result and the caller must not trust the
 * result as complete when `symlinks` is not empty.
 */
export async function scanFiles(root: string, patterns: string[]): Promise<{ files: string[]; symlinks: string[] }> {
  const compiled = patterns.map(compile);
  const include = compiled.filter((c) => !c.negate);
  const exclude = compiled.filter((c) => c.negate);
  const found = new Set<string>();
  const links = new Set<string>();
  const roots = new Set(include.map((c) => c.prefix));
  const visit = async (rel: string): Promise<void> => {
    const abs = rel === "" ? root : path.join(root, rel);
    const stat = await lstat(abs).catch(() => undefined);
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      for (const entry of await readdir(abs)) {
        const child = rel === "" ? entry : `${rel}/${entry}`;
        if (child === ".git") continue;
        await visit(child);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      if (include.some((c) => c.regex.test(rel) || couldMatchBelow(c.segments, rel))) links.add(rel);
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    if (include.some((c) => c.regex.test(rel)) && !exclude.some((c) => c.regex.test(rel))) found.add(rel);
  };
  for (const start of roots) {
    if (start !== "") assertSafeRel(start);
    // A parent that is itself a symlink must not be walked through.
    const through = start === "" ? undefined : await symlinkParent(root, start);
    if (through !== undefined) {
      links.add(through);
      continue;
    }
    await visit(start);
  }
  return { files: [...found].sort(), symlinks: [...links].sort() };
}

export async function matchFiles(root: string, patterns: string[]): Promise<string[]> {
  return (await scanFiles(root, patterns)).files;
}

/** The first symbolic link among the parent directories of `rel`, if any. */
async function symlinkParent(root: string, rel: string): Promise<string | undefined> {
  let current = root;
  const walked: string[] = [];
  for (const part of rel.split("/").slice(0, -1)) {
    current = path.join(current, part);
    walked.push(part);
    const stat = await lstat(current).catch(() => undefined);
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) return walked.join("/");
  }
  return undefined;
}

async function hasSymlinkParent(root: string, rel: string): Promise<boolean> {
  return (await symlinkParent(root, rel)) !== undefined;
}

async function readNoFollow(file: string): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function digestFile(file: string): Promise<string> {
  return createHash("sha256").update(await readNoFollow(file)).digest("hex");
}

/**
 * The cache key for `command` in `root`: a digest of its argv, its declared
 * globs and the content of every input file. `bypass` (with the reason) when
 * the command must run: no input file exists, or an input is a symbolic link,
 * whose target's content cannot be hashed without crossing the no-follow
 * boundary and would otherwise let a changed target restore stale output.
 */
export async function cacheKey(
  root: string,
  command: EnvironmentCommand & { inputs: string[]; outputs: string[] },
): Promise<{ key: string } | { bypass: string }> {
  const { files, symlinks } = await scanFiles(root, command.inputs);
  if (symlinks.length > 0) return { bypass: `declared input ${symlinks[0]} is a symbolic link` };
  if (files.length === 0) return { bypass: "no declared input file exists" };
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ v: 1, argv: command.argv, inputs: command.inputs, outputs: command.outputs }));
  for (const rel of files) {
    const abs = path.join(root, rel);
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) return { bypass: `declared input ${rel} is a symbolic link` };
    hash.update(`\0${rel}\0${await digestFile(abs)}`);
  }
  return { key: hash.digest("hex") };
}

/** Remove one saved entry, e.g. when the preparation it came from turned out not to be clean. */
export async function dropEntry(stateDir: string, id: string, key: string): Promise<void> {
  await rm(entryDir(stateDir, id, key), { recursive: true, force: true }).catch(() => undefined);
}

function entryDir(stateDir: string, id: string, key: string): string {
  if (!COMMAND_ID.test(id) || !/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid prepare cache entry");
  return path.join(prepareCacheDir(stateDir), id, key);
}

/**
 * Why `command`'s declared outputs cannot be cached faithfully in `root`, or
 * undefined: a symbolic link hides part of what an output glob selects (its
 * subtree is never entered, so it could be neither saved nor cleared), or a
 * declared output is a file the repository tracks.
 */
export async function outputsBlocked(root: string, command: { outputs: string[] }): Promise<string | undefined> {
  const { files, symlinks } = await scanFiles(root, command.outputs);
  const hidden = symlinks.find((link) => !files.includes(link));
  if (hidden !== undefined) return `declared output ${hidden} is behind a symbolic link`;
  if (files.length === 0) return undefined;
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  const tracked = new Set(stdout.split("\0"));
  const hit = files.find((rel) => tracked.has(rel));
  return hit !== undefined ? `declared output ${hit} is tracked by the repository` : undefined;
}

/**
 * Save the outputs of a successful run of `command` in `root` under `key`.
 * Returns `saved: false` with a reason when nothing could be saved faithfully
 * (no output, an output that is not a regular file or a contained relative
 * symbolic link, a symbolic link hiding part of an output glob, a tracked
 * output); the command then simply runs again next time.
 */
export async function saveOutputs(args: {
  stateDir: string;
  root: string;
  command: EnvironmentCommand & { inputs: string[]; outputs: string[] };
  key: string;
}): Promise<{ saved: boolean; reason?: string }> {
  const { stateDir, root, command, key } = args;
  const final = entryDir(stateDir, command.id, key);
  const parent = path.dirname(final);
  const tmp = path.join(parent, `.tmp-${randomUUID()}`);
  const skip = async (reason: string) => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { saved: false, reason };
  };
  try {
    const blocked = await outputsBlocked(root, command);
    if (blocked !== undefined) return await skip(blocked);
    const files = await matchFiles(root, command.outputs);
    if (files.length === 0) return await skip("the command wrote none of its declared outputs");
    await mkdir(path.join(tmp, "files"), { recursive: true });
    const entries: Entry[] = [];
    for (const [i, rel] of files.entries()) {
      assertSafeRel(rel);
      const abs = path.join(root, rel);
      const stat = await lstat(abs);
      if (stat.isSymbolicLink()) {
        const target = await readlink(abs);
        if (!linkStaysInside(rel, target)) return await skip(`output ${rel} is a symbolic link that leaves the checkout`);
        entries.push({ path: rel, type: "link", target });
      } else if (stat.isFile()) {
        const content = await readNoFollow(abs);
        await writeFile(path.join(tmp, "files", String(i)), content, { mode: 0o600 });
        entries.push({ path: rel, type: "file", mode: stat.mode & 0o777, sha256: createHash("sha256").update(content).digest("hex") });
      } else {
        return await skip(`output ${rel} is not a regular file`);
      }
    }
    const manifest: Manifest = { version: 1, entries };
    await writeFile(path.join(tmp, "manifest.json"), JSON.stringify(manifest), "utf8");
    try {
      await rename(tmp, final);
    } catch {
      // Another checkout saved the same key first; its entry is equivalent.
      await rm(tmp, { recursive: true, force: true });
    }
    await prune(parent);
    return { saved: true };
  } catch (err) {
    return await skip(`could not save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function discard(tmp: string): Promise<false> {
  await rm(tmp, { recursive: true, force: true });
  return false;
}

/** A relative link whose target stays inside the checkout. */
function linkStaysInside(rel: string, target: string): boolean {
  if (target === "" || path.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
  return resolved !== ".." && !resolved.startsWith("../");
}

async function prune(parent: string): Promise<void> {
  const names = (await readdir(parent)).filter((n) => !n.startsWith(".tmp-"));
  if (names.length <= KEEP_ENTRIES_PER_COMMAND) return;
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await lstat(path.join(parent, n))).mtimeMs })));
  dated.sort((a, b) => b.t - a.t);
  for (const old of dated.slice(KEEP_ENTRIES_PER_COMMAND)) await rm(path.join(parent, old.n), { recursive: true, force: true });
}

/**
 * Copy the entry for `key` into `root`. Returns the number of entries restored,
 * or undefined when there is no usable entry (missing, or it no longer matches
 * its recorded digests) and the command must run.
 */
export async function restoreOutputs(args: { stateDir: string; root: string; command: EnvironmentCommand; key: string }): Promise<number | undefined> {
  const { stateDir, root, command, key } = args;
  const dir = entryDir(stateDir, command.id, key);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) return undefined;
  try {
    // Verify the whole entry before writing anything.
    for (const [i, entry] of manifest.entries.entries()) {
      assertSafeRel(entry.path);
      if (entry.type === "file") {
        if ((await digestFile(path.join(dir, "files", String(i)))) !== entry.sha256) throw new Error("digest mismatch");
      } else if (entry.type !== "link" || !linkStaysInside(entry.path, entry.target)) {
        throw new Error("bad entry");
      }
      // A destination that is now a directory (or a parent that is now a file) would need a
      // recursive removal that can reach tracked files: treat the entry as a miss, before
      // anything in the checkout is touched.
      const st = await lstat(path.join(root, entry.path)).catch(() => undefined);
      if (st?.isDirectory()) throw new Error(`${entry.path} is a directory in this checkout`);
    }
    // Leave exactly what a real run would: clear whatever already matches the declared outputs first.
    const existing = await scanFiles(root, command.outputs ?? []);
    for (const rel of existing.files) {
      assertSafeRel(rel);
      await rm(path.join(root, rel), { force: true });
    }
    for (const [i, entry] of manifest.entries.entries()) {
      if (await hasSymlinkParent(root, entry.path)) throw new Error(`${entry.path} is under a symbolic link`);
      const dst = path.join(root, entry.path);
      await rm(dst, { force: true });
      await mkdir(path.dirname(dst), { recursive: true });
      if (entry.type === "link") {
        await symlink(entry.target, dst);
      } else {
        await copyFile(path.join(dir, "files", String(i)), dst, fsConstants.COPYFILE_EXCL);
        await chmod(dst, entry.mode);
      }
    }
    return manifest.entries.length;
  } catch {
    // An unusable entry is a miss; the command regenerates over whatever was copied.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}
