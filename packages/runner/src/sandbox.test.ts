// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { netArgs, sandboxNodeArgs } from "./sandbox.js";

describe("the executor sandbox's network", () => {
  it("passes --allow-net only to a Node that knows it", () => {
    expect(netArgs(new Set(["--allow-net", "--permission"]))).toEqual(["--allow-net"]);
    expect(netArgs(new Set(["--permission"]))).toEqual([]);
  });

  it("lets a confined executor connect out, as before the permission model had a network scope", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-sandbox-net-"));
    const server = createServer((socket) => socket.end("hello"));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const script = path.join(dir, "connect.mjs");
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "connect", type: "module" }));
      await writeFile(script, `import { connect } from "node:net";\nconst s = connect(${port}, "127.0.0.1");\ns.on("data", (d) => { process.stdout.write(String(d)); s.end(); });\ns.on("error", (e) => { process.stderr.write(String(e.code ?? e)); process.exit(2); });\n`);
      const child = spawn(process.execPath, [...sandboxNodeArgs([script]), script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      // Node 25+ warns on stderr that --allow-net is experimental; only a denied connection is a failure.
      expect({ code, out }, err).toEqual({ code: 0, out: "hello" });
      expect(err).not.toContain("ERR_ACCESS_DENIED");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
