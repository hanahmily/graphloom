// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Third-party notices and the license check (docs/design-release.md §2.8).
 *
 *   node scripts/release/notices.mjs --root <tree> [--allowlist release/license-allowlist.json]
 *        [--out <THIRD_PARTY_NOTICES>] [--node-license <node/LICENSE>] [--node-version <v>] [--self]
 *
 * Reads every package under `<root>/node_modules` (nested `node_modules`
 * too), and with `--self` the package at `<root>` itself. Workspace links
 * (GraphLoom's own packages) are skipped: `LICENSE` and `NOTICE` cover them.
 * Fails, listing every offender, when a package's license is missing,
 * unparseable, or not allowed. With `--out` it writes the notices: name,
 * version, SPDX license, and license text per package, then Node's own
 * `LICENSE`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, readJson, runMain } from "./lib.mjs";

/** License families that no allowlist or exception can admit. */
export const NEVER_ALLOWED = ["GPL", "LGPL", "AGPL", "SSPL", "UNLICENSED"];

export function loadAllowlist(file) {
  const list = readJson(file);
  if (!Array.isArray(list.allowed) || !list.allowed.every((id) => typeof id === "string")) throw new Error(`${file}: allowed must be an array of SPDX ids`);
  const exceptions = list.exceptions ?? [];
  for (const e of exceptions) {
    if (typeof e.package !== "string" || typeof e.reason !== "string" || e.reason.trim() === "") {
      throw new Error(`${file}: every exception needs a package and a reason`);
    }
  }
  return { allowed: new Set(list.allowed), denied: [...new Set([...NEVER_ALLOWED, ...(list.denied ?? [])])], exceptions };
}

function isDenied(id, denied) {
  const upper = id.toUpperCase();
  return denied.some((d) => upper === d.toUpperCase() || upper.startsWith(`${d.toUpperCase()}-`));
}

/** Parses an SPDX expression into a tree; throws on anything unparseable. */
export function parseSpdx(expression) {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+:-]+/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, "") || tokens.length === 0) {
    throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
  }
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = tokens[i++];
    if (t === "(") {
      const inner = or();
      if (tokens[i++] !== ")") throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
      return inner;
    }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/i.test(t)) throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
    if (/^(LicenseRef|DocumentRef)-/i.test(t) || /^SEE$/i.test(t)) throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
    const id = t.replace(/\+$/, "");
    // `X WITH exception` grants at least X; judge it as X.
    if (peek() !== undefined && /^WITH$/i.test(peek())) {
      i++;
      if (tokens[i++] === undefined) throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
    }
    return { id };
  };
  const and = () => {
    let left = primary();
    while (peek() !== undefined && /^AND$/i.test(peek())) {
      i++;
      left = { and: [left, primary()] };
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (peek() !== undefined && /^OR$/i.test(peek())) {
      i++;
      left = { or: [left, and()] };
    }
    return left;
  };
  const tree = or();
  if (i !== tokens.length) throw new Error(`unparseable license expression: ${JSON.stringify(expression)}`);
  return tree;
}

function satisfies(tree, allowed, denied) {
  if (tree.id !== undefined) return !isDenied(tree.id, denied) && allowed.has(tree.id);
  if (tree.or) return tree.or.some((t) => satisfies(t, allowed, denied));
  return tree.and.every((t) => satisfies(t, allowed, denied));
}

function ids(tree) {
  if (tree.id !== undefined) return [tree.id];
  return (tree.or ?? tree.and).flatMap(ids);
}

/** The declared license of a package.json as one expression string, or undefined when it declares none. */
export function declaredLicense(pkg) {
  const one = (l) => (typeof l === "string" ? l : l && typeof l.type === "string" ? l.type : undefined);
  if (pkg.license !== undefined) return one(pkg.license) ?? "";
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const parts = pkg.licenses.map(one);
    if (parts.some((p) => p === undefined)) return "";
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  }
  return undefined;
}

/**
 * Judges one package's license: `{ ok, reason?, exception? }`. An exception
 * names the package (and optionally its version) and the exact declared
 * license (`null` for none); it admits that license, never a denied one.
 */
export function judgeLicense({ name, version, license }, policy) {
  const exception = policy.exceptions.find(
    (e) => e.package === name && (e.version === undefined || e.version === version) && (e.license === undefined ? false : e.license === (license ?? null)),
  );
  if (license === undefined || license.trim() === "") {
    return exception ? { ok: true, exception } : { ok: false, reason: "no license declared" };
  }
  let tree;
  try {
    tree = parseSpdx(license.trim());
  } catch (err) {
    if (exception && !NEVER_ALLOWED.some((d) => new RegExp(`\\b${d}\\b`, "i").test(license))) return { ok: true, exception };
    return { ok: false, reason: err.message };
  }
  if (satisfies(tree, policy.allowed, policy.denied)) return { ok: true };
  if (exception) {
    const widened = new Set([...policy.allowed, ...ids(tree)]);
    if (satisfies(tree, widened, policy.denied)) return { ok: true, exception };
  }
  const denied = ids(tree).filter((id) => isDenied(id, policy.denied));
  return { ok: false, reason: denied.length > 0 ? `disallowed license ${license} (never allowed: ${denied.join(", ")})` : `license ${license} is not on the allowlist` };
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)(\b|[.-]|$)/i;

function licenseText(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && statSync(path.join(dir, n)).isFile());
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  return files.sort().map((f) => readFileSync(path.join(dir, f), "utf8").trimEnd()).join("\n\n");
}

/** Every third-party package installed under `<root>/node_modules`, depth first, deduplicated by name@version. */
export async function collectPackages(root) {
  const seen = new Map();
  const rootReal = realpathSync(root);
  const visitModules = async (modulesDir) => {
    let names;
    try {
      names = await readdir(modulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(modulesDir, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        await visitModules(full);
        continue;
      }
      await visitPackage(full, entry.isSymbolicLink());
    }
  };
  const visitPackage = async (dir, linked) => {
    if (linked) {
      // A workspace link: GraphLoom's own package, covered by LICENSE and NOTICE. A link that
      // resolves into some node_modules is a real third-party package installed by link.
      let real;
      try {
        real = realpathSync(dir);
      } catch {
        return;
      }
      if (!real.split(path.sep).includes("node_modules") && real.startsWith(rootReal + path.sep)) return;
      dir = real;
    }
    const manifest = path.join(dir, "package.json");
    if (!existsSync(manifest)) return;
    const pkg = readJson(manifest);
    const name = typeof pkg.name === "string" ? pkg.name : path.basename(dir);
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const key = `${name}@${version}`;
    if (!seen.has(key)) seen.set(key, { name, version, license: declaredLicense(pkg), dir });
    await visitModules(path.join(dir, "node_modules"));
  };
  await visitModules(path.join(root, "node_modules"));
  return [...seen.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/** Checks every package and returns `{ packages, problems }`; `self` adds the package at `root` itself. */
export async function checkLicenses(root, policy, { self = false } = {}) {
  const packages = await collectPackages(root);
  if (self) {
    const pkg = readJson(path.join(root, "package.json"));
    packages.unshift({ name: pkg.name, version: pkg.version ?? "", license: declaredLicense(pkg), dir: root, self: true });
  }
  const problems = [];
  for (const p of packages) {
    const verdict = judgeLicense(p, policy);
    p.verdict = verdict;
    if (!verdict.ok) problems.push(`${p.name}@${p.version}: ${verdict.reason}`);
  }
  return { packages, problems };
}

export function renderNotices(packages, { product = "GraphLoom", version, nodeLicense, nodeVersion } = {}) {
  const rule = "=".repeat(78);
  const out = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    `${product}${version ? ` ${version}` : ""} is licensed under the Apache License 2.0 (LICENSE, NOTICE).`,
    "It ships the following third-party packages, each under its own license, and",
    "the Node.js runtime, whose license follows the packages.",
    "",
  ];
  for (const p of packages.filter((x) => !x.self)) {
    out.push(rule, `${p.name}@${p.version}`, `License: ${p.license ?? "(none declared)"}`);
    if (p.verdict?.exception) out.push(`License exception: ${p.verdict.exception.reason}`);
    out.push("");
    out.push(licenseText(p.dir) ?? `(The package includes no license file; its package.json declares ${p.license ?? "no license"}.)`);
    out.push("");
  }
  if (nodeLicense !== undefined) {
    out.push(rule, `Node.js${nodeVersion ? ` ${nodeVersion}` : ""} (node/bin/node)`, "", nodeLicense.trimEnd(), "");
  }
  return `${out.join("\n")}\n`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2), { booleans: ["self"] });
    if (!flags.root) throw new Error("usage: notices.mjs --root <tree> [--allowlist <file>] [--out <file>] [--node-license <file>] [--node-version <v>] [--self]");
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const policy = loadAllowlist(path.resolve(flags.allowlist ?? path.join(repo, "release", "license-allowlist.json")));
    const root = path.resolve(flags.root);
    const { packages, problems } = await checkLicenses(root, policy, { self: flags.self === true });
    if (problems.length > 0) {
      throw new Error(`license check failed for ${problems.length} package(s):\n  ${problems.join("\n  ")}`);
    }
    const excepted = packages.filter((p) => p.verdict.exception);
    console.error(`licenses: ${packages.length} package(s) allowed${excepted.length > 0 ? `, ${excepted.length} by recorded exception` : ""}`);
    if (flags.out) {
      const version = existsSync(path.join(root, "package.json")) ? readJson(path.join(root, "package.json")).version : undefined;
      const nodeLicense = flags["node-license"] ? readFileSync(path.resolve(flags["node-license"]), "utf8") : undefined;
      await writeFile(path.resolve(flags.out), renderNotices(packages, { version, nodeLicense, nodeVersion: flags["node-version"] }));
      console.error(`licenses: wrote ${flags.out}`);
    }
  });
}
