import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * SHA-256 of the code an executor runs: one module file, or a package tree
 * (relative paths and bytes, excluding `node_modules` and `.git`). A tree
 * with symlinks is rejected so the digest covers every byte it names. The
 * tree form matches the controller's repair digest.
 */
export async function digestExecutorSource(source: string): Promise<string> {
  const h = createHash("sha256");
  if ((await stat(source)).isFile()) {
    h.update(await readFile(source));
    return h.digest("hex");
  }
  const root = await realpath(source);
  for (const rel of (await listFiles(root)).sort()) {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(prefix ? path.join(root, prefix) : root)) {
    if (name === "node_modules" || name === ".git") continue;
    const rel = prefix ? path.join(prefix, name) : name;
    const info = await lstat(path.join(root, rel));
    if (info.isSymbolicLink()) {
      throw new Error(`executor source contains symlink: ${rel.split(path.sep).join("/")}`);
    }
    if (info.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (info.isFile()) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}
