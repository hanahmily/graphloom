// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentExecutables } from "./registry.js";
import { containerIdentity } from "./sandbox-docker.js";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gl-agent-bin-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("agent CLIs a hidden home must still show", () => {
  it("finds a CLI on PATH, its real target, and the package an npm-style install runs from", () => {
    const home = path.join(root, "home");
    const pkg = path.join(home, ".npm-global", "lib", "node_modules", "@vendor", "claude-code");
    const bin = path.join(home, ".npm-global", "bin");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), "{}");
    writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(path.join(pkg, "cli.js"), path.join(bin, "claude"));
    const found = agentExecutables({ PATH: `${bin}:/nonexistent` }, home);
    expect(found).toContain(path.join(bin, "claude"));
    expect(found).toContain(path.join(pkg, "cli.js"));
    expect(found).toContain(pkg);
  });

  it("honours an absolute GRAPHLOOM_*_BIN and never exposes a directory that holds the home", () => {
    const home = path.join(root, "home2");
    const binary = path.join(home, ".local", "share", "codex", "codex");
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "", { mode: 0o755 });
    // A package.json above the home must not pull the home itself (or its parents) into the exposed set.
    writeFileSync(path.join(root, "package.json"), "{}");
    const found = agentExecutables({ GRAPHLOOM_CODEX_BIN: binary, PATH: "" }, home);
    expect(found).toContain(binary);
    for (const p of found) expect(home === p || home.startsWith(`${p}${path.sep}`), p).toBe(false);
  });

  it("finds nothing when the CLIs are not installed", () => {
    expect(agentExecutables({ PATH: path.join(root, "empty") }, path.join(root, "home3"))).toEqual([]);
  });
});

describe("the container's user", () => {
  it("is the operator's own ids under a rootful daemon, and container root (the operator) under a rootless one", () => {
    expect(containerIdentity(false, 1000, 1001)).toEqual({ uid: 1000, gid: 1001 });
    expect(containerIdentity(true, 1000, 1001)).toEqual({ uid: 0, gid: 0 });
  });
});
