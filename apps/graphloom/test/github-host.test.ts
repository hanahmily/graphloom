import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { githubEvidence, githubRunner, runGitHub } from "./github-runner.js";

// Host-side guarantees for the built-in GitHub package: it runs in its own
// executor process with only the operator's grants, and results never carry the token.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.dirname(path.dirname(githubExecutorPackage.entryModule));
const TOKEN = "ghp_fake_secret_token_value";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(): Promise<FakeGitHub> {
  const server = await startFakeGitHub({
    issues: Array.from({ length: 3 }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, state: "open" as const, labels: [] })),
  });
  cleanups.push(() => server.close());
  return server;
}

const comment = { owner: "acme", repo: "app", issueNumber: 3, body: "Triage: needs repro", idempotencyKey: "triage-3" };

describe("built-in GitHub package under the host runner", () => {
  it("refuses writes unless the operator grants them, even with a token", async () => {
    const server = await fake();
    const result = await runGitHub(githubRunner({ baseUrl: server.baseUrl, token: TOKEN }), "create-issue-comment", comment);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("executor graphloom.github/create-issue-comment effect write is not granted");
    expect(server.requests).toHaveLength(0);
  });

  it("rejects malformed input in the executor process before any request", async () => {
    const server = await fake();
    const result = await runGitHub(githubRunner({ baseUrl: server.baseUrl }), "list-issues", {
      owner: "acme",
      repo: "../etc",
      maxPages: 50,
    });
    expect(result.summary).toMatch(/input failed schema validation/);
    expect(server.requests).toHaveLength(0);
  });

  it("redacts the token even when GitHub echoes it back", async () => {
    const server = await fake();
    const result = await runGitHub(githubRunner({ baseUrl: server.baseUrl, token: TOKEN }), "get-issue", {
      owner: "acme",
      repo: "app",
      number: 401,
    });
    expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.summary).toBe("GitHub GET /repos/acme/app/issues/401 returned 401: Bad credentials: Bearer [REDACTED]");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reconciles by marker after the executor process is killed mid-POST", async () => {
    const server = await fake();
    server.hangAfterNextWrite();
    const crashed = await runGitHub(
      githubRunner({ baseUrl: server.baseUrl, token: TOKEN, allowWrites: true, timeoutMs: 1_500 }),
      "create-issue-comment",
      comment,
    );
    expect(crashed.summary).toMatch(/timed out/);
    expect(server.comments.get(3)).toHaveLength(1);

    const retried = await runGitHub(
      githubRunner({ baseUrl: server.baseUrl, token: TOKEN, allowWrites: true }),
      "create-issue-comment",
      comment,
    );
    expect(githubEvidence(retried)).toMatchObject({ outcome: "reconciled", idempotencyKey: "triage-3" });
    expect(server.comments.get(3)).toHaveLength(1);
  });

  it("loads an upgraded install without rebuilding the host and honors the pinned version", async () => {
    const server = await fake();
    const install = await mkdtemp(path.join(os.tmpdir(), "gl-gh-install-"));
    cleanups.push(() => rm(install, { recursive: true, force: true }));
    await cp(path.join(packageRoot, "dist"), path.join(install, "dist"), { recursive: true });
    const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(install, "package.json"), JSON.stringify({ ...pkg, version: "0.2.0" }), "utf8");
    await symlink(path.join(repoRoot, "node_modules"), path.join(install, "node_modules"));

    const upgraded = githubRunner({
      baseUrl: server.baseUrl,
      manifest: { ...githubExecutorPackage, entryModule: path.join(install, "dist", "executors.js") },
    });
    const result = await runGitHub(upgraded, "list-issues", { owner: "acme", repo: "app" });
    expect(result.status).toBe("ok");
    expect(githubEvidence(result).executor).toEqual({ package: "@graphloom/executor-github", version: "0.2.0" });

    const stalePin = await runGitHub(upgraded, "list-issues", { owner: "acme", repo: "app" }, { version: "2" });
    expect(stalePin.summary).toBe("executor graphloom.github/list-issues pinned version 2 but installed 1");
  });
});
