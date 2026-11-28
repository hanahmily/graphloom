// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { confinementUnsupported, packageClosure } from "@graphloom/runner";
import type { ChildPluginHostOptions } from "@graphloom/plugin-host";

/**
 * Where the loop evaluator's hook child runs (docs/design-loop.md section 14.9): a bubblewrap sandbox with
 * its own pid namespace and `/proc` (the evaluator's environment, which holds the read token, is not visible),
 * no network, no home, an empty `/tmp` as its working directory, and read-only access to nothing but the
 * system's `/usr` (node's shared libraries), node itself, the plugin host's worker with the packages it
 * imports, and the bundle. A hook is pure data in, data out; it needs nothing else.
 */

/** Why this machine cannot confine the hook child, or undefined when it can. Injectable for tests. */
export type ConfinementProbe = () => Promise<string | undefined>;

export const defaultConfinementProbe: ConfinementProbe = confinementUnsupported;

/** The system trees node's shared libraries live in; each is a link on a merged-usr host and a directory elsewhere. */
const SYSTEM_TREES = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
/** The loader cache is the one file of /etc a dynamically linked node needs. */
const SYSTEM_FILES = ["/etc/ld.so.cache"];

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The mounts that make `paths` readable at the same locations: the real location bound read-only, and what led
 * there (a link, or a link in an ancestor) recreated, so the path resolves as it does on the host.
 */
function readOnlyMounts(paths: readonly string[]): string[] {
  const reals = new Set<string>();
  const aliases = new Map<string, string>();
  for (const given of paths) {
    const abs = path.resolve(given);
    if (!existsSync(abs)) continue;
    const real = realpathSync(abs);
    reals.add(real);
    if (real !== abs) aliases.set(abs, real);
  }
  // Parents first, and a path inside an already bound tree is already there.
  const roots = [...reals].sort((a, b) => a.length - b.length).filter((p, i, all) => !all.slice(0, i).some((q) => under(p, q)));
  const args: string[] = [];
  for (const r of roots) args.push("--ro-bind", r, r);
  for (const [alias, real] of aliases) {
    if (roots.some((r) => under(alias, r))) continue;
    if (lstatSync(alias).isSymbolicLink()) args.push("--symlink", real, alias);
    else args.push("--ro-bind", real, alias);
  }
  return args;
}

/**
 * The launcher that runs the plugin worker under bubblewrap, for `createChildPluginHost`. The environment the
 * caller gives the child is passed on as is (the evaluator gives it `PATH` only); bubblewrap and the worker
 * both start with it, so the sandbox's pid 1 holds nothing else either.
 */
export function confinedHookLauncher(options: { bundle: string; env: NodeJS.ProcessEnv }): NonNullable<ChildPluginHostOptions["launcher"]> {
  return ([node, workerModule, entryModule]) => {
    const bundle = path.resolve(options.bundle);
    const system: string[] = [];
    for (const tree of SYSTEM_TREES) {
      const stat = lstatOrUndefined(tree);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) system.push("--symlink", readlinkSync(tree), tree);
      else system.push("--ro-bind", tree, tree);
    }
    for (const file of SYSTEM_FILES) if (existsSync(file)) system.push("--ro-bind", file, file);
    const readable = [node, workerModule, entryModule, bundle, ...packageClosure([workerModule])];
    const env = Object.entries(options.env).flatMap(([k, v]) => (v === undefined ? [] : ["--setenv", k, v]));
    return {
      command: "bwrap",
      args: [
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--die-with-parent",
        "--new-session",
        "--cap-drop", "ALL",
        "--clearenv",
        ...env,
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        ...system,
        ...readOnlyMounts(readable),
        // The sandbox's root is an in-memory directory tree: made read-only, so nothing is written outside /tmp.
        "--remount-ro", "/",
        "--chdir", "/tmp",
        "--",
        node,
        workerModule,
        entryModule,
      ],
    };
  };
}

function lstatOrUndefined(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}
