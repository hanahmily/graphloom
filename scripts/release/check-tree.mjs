// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Content checks on an assembled release tree (docs/design-release.md §2.3,
 * §6 step 6).
 *
 *   node scripts/release/check-tree.mjs --root <tree> [--platform linux-x64] [--libc glibc] [--forbid <string>]...
 *
 * Fails, listing every problem, when the tree contains anything §2.3
 * excludes, a package whose `os`/`cpu`/`libc` excludes the release platform, a symlink that leaves the tree or dangles, a `.env*` file, a
 * credential-shaped string, an absolute interpreter path in a shebang, or
 * any `--forbid` string (the staging directory, the maintainer's home, the
 * checkout path).
 */
import { readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain, walk } from "./lib.mjs";
import { foreignPackages, parseTarget } from "./prune-tree.mjs";

/** Core packages ship only `package.json` and `dist/` (§2.3). */
export const DIST_ONLY = ["packages/sdk", "packages/agent-harness", "packages/controller", "packages/plugin-host", "packages/supervisor", "packages/runner", "apps/graphloom"];

/** Paths §2.3 excludes, relative to the tree root. */
export const EXCLUDED = ["packages/testkit", "docs", ".github", "examples/skywalking-banyandb", "graphloom", "examples/graphloom", "release-out"];

/** Directory names never shipped anywhere outside `node_modules`: run state and caches. */
const EXCLUDED_NAMES = new Set(["graphloom-state", ".git", "coverage", ".cache", ".vite", ".vitest"]);

/** Credential shapes: GitHub tokens, OpenAI/Anthropic-style keys, AWS access keys, Slack tokens, private keys. */
export const CREDENTIAL_PATTERNS = [
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "sk- API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}/ },
];

/** Placeholder keys that vendors print in their own documentation, such as AWS's `AKIAIOSFODNN7EXAMPLE`. */
function isDocumentedExample(match) {
  return /EXAMPLE$/i.test(match);
}

/** Interpreters a shipped shebang may name: only lookups that work on any Linux host. */
const PORTABLE_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s|\/bin\/(?:ba)?sh\b|\/usr\/bin\/(?:ba)?sh\b)/;

const MAX_SCAN_BYTES = 256 * 1024 * 1024;

export async function checkTree(root, { forbid = [], platform = "linux-x64", libc = "glibc" } = {}) {
  const problems = [];
  for (const { rel, reason } of foreignPackages(root, parseTarget(platform, libc))) {
    problems.push(`package for another platform (${reason}, release is ${platform}): ${rel}`);
  }
  const rootAbs = path.resolve(root);
  const rootReal = await realpath(rootAbs);
  const entries = await walk(rootAbs);
  const isUnder = (rel, prefix) => rel === prefix || rel.startsWith(`${prefix}/`);

  for (const prefix of EXCLUDED) {
    if (entries.some((e) => isUnder(e.rel, prefix))) problems.push(`excluded path present: ${prefix}`);
  }
  for (const pkg of DIST_ONLY) {
    for (const e of entries) {
      if (!e.rel.startsWith(`${pkg}/`)) continue;
      const sub = e.rel.slice(pkg.length + 1);
      if (!sub.includes("/") && sub !== "package.json" && sub !== "dist") problems.push(`core package ships more than package.json and dist/: ${e.rel}`);
    }
  }

  problems.push(...(await checkSkills(rootAbs, entries)));

  const needles = forbid.filter((s) => s.length > 0).map((s) => ({ s, b: Buffer.from(s) }));
  for (const e of entries) {
    const parts = e.rel.split("/");
    const inModules = parts.includes("node_modules");
    const base = parts[parts.length - 1];
    if (e.stat.isDirectory() && EXCLUDED_NAMES.has(base) && (!inModules || base === ".cache" || base === ".vite" || base === ".vitest")) {
      problems.push(`excluded directory present: ${e.rel}`);
    }
    if (/^\.env(\.|$)/.test(base)) problems.push(`.env file present: ${e.rel}`);
    // GraphLoom's own build caches; a dependency may ship one of its own in its published files.
    if (e.stat.isFile() && !inModules && base.endsWith(".tsbuildinfo")) problems.push(`build cache present: ${e.rel}`);
    if (e.stat.isSymbolicLink()) {
      const target = await readlink(e.abs);
      if (path.isAbsolute(target)) {
        problems.push(`absolute symlink: ${e.rel} -> ${target}`);
        continue;
      }
      const real = await realpath(e.abs).catch(() => undefined);
      if (real === undefined) problems.push(`dangling symlink: ${e.rel} -> ${target}`);
      else if (real !== rootReal && !real.startsWith(rootReal + path.sep)) problems.push(`symlink leaves the tree: ${e.rel} -> ${target}`);
      continue;
    }
    if (!e.stat.isFile() || e.stat.size > MAX_SCAN_BYTES) continue;
    const bytes = await readFile(e.abs);
    for (const { s, b } of needles) {
      if (bytes.includes(b)) problems.push(`contains the host path ${s}: ${e.rel}`);
    }
    if (bytes[0] === 0x23 && bytes[1] === 0x21) {
      const line = bytes.subarray(0, Math.max(0, bytes.indexOf(0x0a)) || 200).toString("utf8");
      if (!PORTABLE_SHEBANG.test(line)) problems.push(`non-portable shebang ${JSON.stringify(line)}: ${e.rel}`);
    }
    // Text files only: compiled binaries are matched by forbidden paths above, not by key shapes.
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const { name, re } of CREDENTIAL_PATTERNS) {
      const global = new RegExp(re.source, "g");
      if ([...text.matchAll(global)].some((m) => !isDocumentedExample(m[0]))) problems.push(`credential-shaped string (${name}): ${e.rel}`);
    }
  }
  return problems;
}

/**
 * The shipped agent skills (docs/design-agent-skills.md §3): every directory
 * under `skills/` holds a `SKILL.md` whose frontmatter names that directory and
 * has a description, and none carries an install marker (those are written
 * only into an agent's skill directory).
 */
export async function checkSkills(rootAbs, entries) {
  const problems = [];
  const dirs = entries.filter((e) => e.stat.isDirectory() && /^skills\/[^/]+$/.test(e.rel));
  for (const d of dirs) {
    const name = d.rel.slice("skills/".length);
    const text = await readFile(path.join(rootAbs, d.rel, "SKILL.md"), "utf8").catch(() => undefined);
    if (text === undefined) {
      problems.push(`skill without SKILL.md: ${d.rel}`);
      continue;
    }
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    const field = (key) => front?.split("\n").find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    if (field("name") !== name) problems.push(`skill frontmatter name is not its directory (${name}): ${d.rel}/SKILL.md`);
    if (!field("description")) problems.push(`skill frontmatter has no description: ${d.rel}/SKILL.md`);
  }
  for (const e of entries) if (e.rel.startsWith("skills/") && path.basename(e.rel) === ".graphloom-skill.json") problems.push(`install marker shipped: ${e.rel}`);
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2), { multiple: ["forbid"] });
    if (!flags.root) throw new Error("usage: check-tree.mjs --root <tree> [--forbid <string>]...");
    const problems = await checkTree(flags.root, { forbid: flags.forbid ?? [], platform: flags.platform ?? "linux-x64", libc: flags.libc ?? "glibc" });
    if (problems.length > 0) throw new Error(`release tree check failed (${problems.length}):\n  ${problems.join("\n  ")}`);
    console.error(`tree: ${path.resolve(flags.root)} passes the content checks`);
  });
}
