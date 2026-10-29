// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { execFileAsync } from "./git.js";
import type { TestScope } from "./scope.js";

export interface HttpsGitServer {
  /** `https://localhost:<port>/<name>` for a bare repository `<root>/<name>`. */
  url(name: string): string;
  /** The self-signed certificate: `http.sslCAInfo` in the fetching repository's own config. */
  caFile: string;
  close(): Promise<void>;
}

/**
 * A local smart-HTTPS Git server over `git http-backend`, for tests of code
 * that fetches only over https. It serves every bare repository under
 * `root`, read-only through the CGI, with a certificate made for the test.
 */
export async function startHttpsGit(scope: TestScope, root: string): Promise<HttpsGitServer> {
  const dir = await scope.tempDir("gl-https-git-");
  const key = path.join(dir, "key.pem");
  const caFile = path.join(dir, "cert.pem");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", caFile, "-days", "2",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const backend = (await execFileAsync("git", ["--exec-path"])).stdout.trim();
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(caFile) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "https://localhost");
      const child = spawn(path.join(backend, "git-http-backend"), [], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
          REMOTE_ADDR: "127.0.0.1",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        if (split < 0) {
          res.writeHead(500).end();
          return;
        }
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of all.subarray(0, split).toString("utf8").split("\r\n")) {
          const [name, ...value] = line.split(": ");
          if (name === undefined || name === "") continue;
          if (name.toLowerCase() === "status") status = Number(value.join(": ").split(" ")[0]);
          else headers[name] = value.join(": ");
        }
        res.writeHead(status, headers).end(all.subarray(split + 4));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const closed = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
  scope.defer(async () => {
    server.closeAllConnections();
    await closed();
  });
  await writeFile(path.join(dir, "port"), String(port));
  return {
    url: (name) => `https://localhost:${port}/${name}`,
    caFile,
    async close() {
      server.closeAllConnections();
      await closed();
    },
  };
}
