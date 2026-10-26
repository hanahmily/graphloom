// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildPluginHost } from "@graphloom/plugin-host";
import { createPiSupervisorSession } from "@graphloom/supervisor";
import {
  EXTREME_BUDGETS,
  FAULTS,
  NODE_MAX_TIMER_MS,
  bumpBundleVersion,
  copyBundle,
  createScope,
  createTaskWorkspace,
  exampleBundle,
  helloAgents,
  ignoreGraphloomDir,
  slowBundle,
  startFakeProvider,
  trackUnderGraphloomDir,
  watchProcessWarnings,
  type ProviderFault,
} from "./index.js";

const scope = createScope();
afterEach(() => scope.dispose());

const ctx = (operationId: string) => ({ runId: "testkit", operationId, expectedStateRevision: 0 });

describe("task workspaces", () => {
  it("puts the task beside the repository by default, and removes everything on dispose", async () => {
    const own = createScope();
    const ws = await createTaskWorkspace(own, { graph: "hello", request: "Create GREETING.txt.", budgets: { jobs: 3 } });
    expect(await readFile(ws.taskPath, "utf8")).toBe('graph: hello\nrepo: ./repo\nrequest: "Create GREETING.txt."\nbudgets:\n  jobs: 3\n');
    expect(await realpath(ws.bundlePath)).toBe(await realpath(exampleBundle("hello")));
    expect(await ws.repo.git("status", "--porcelain")).toBe("");
    await own.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("can put the task in a committed subdirectory of the repository, naming it repo: .", async () => {
    const ws = await createTaskWorkspace(scope, { graph: "hello", request: "Create GREETING.txt.", layout: "subdirectory", config: { name: "profile.json", value: { a: 1 } } });
    expect(ws.taskDir).toBe(path.join(ws.repo.path, "examples"));
    expect(await readFile(ws.taskPath, "utf8")).toContain("repo: .\nconfig: profile.json\n");
    expect((await ws.repo.git("ls-files", "examples")).split("\n")).toEqual(["examples/plugins/hello", "examples/profile.json", "examples/task.yaml"]);
    expect(await ws.repo.git("status", "--porcelain")).toBe("");
  });

  it("ignores .graphloom/ at the repository root, or tracks files under it", async () => {
    const ws = await createTaskWorkspace(scope, { graph: "hello", request: "x" });
    await ignoreGraphloomDir(ws.repo);
    expect(await ws.repo.git("check-ignore", ".graphloom/issues.json")).toBe(".graphloom/issues.json");
    const tracked = await trackUnderGraphloomDir(ws.repo);
    expect(await ws.repo.git("ls-files", ".graphloom")).toBe(tracked.join("\n"));
    expect(await ws.repo.git("status", "--porcelain")).toBe("");
  });

  it("names budgets past setTimeout's limit, and sees a timer overflow", async () => {
    expect(EXTREME_BUDGETS.activeMs).toBeGreaterThan(NODE_MAX_TIMER_MS);
    expect(EXTREME_BUDGETS.waitMs).toBeGreaterThan(NODE_MAX_TIMER_MS);
    const watch = watchProcessWarnings();
    try {
      clearTimeout(setTimeout(() => undefined, NODE_MAX_TIMER_MS + 1));
      await new Promise((r) => setImmediate(r));
      expect(watch.timerOverflows()).toBe(1);
    } finally {
      watch.dispose();
    }
  });
});

describe("graph bundles", () => {
  it("bumps a private copy to a new version of the same graph", async () => {
    const bundle = await copyBundle(scope, exampleBundle("hello"));
    expect(await bumpBundleVersion(bundle, "9.9.9")).toEqual({ from: "0.1.0", to: "9.9.9" });
    expect(JSON.parse(await readFile(path.join(bundle, "graphloom.manifest.json"), "utf8"))).toMatchObject({ graphId: "hello", version: "9.9.9" });
    const host = await createChildPluginHost({ entryModule: path.join(bundle, "dist", "index.js"), activeVersion: "hello@9.9.9", generation: 1, cwd: bundle });
    try {
      const described = await host.describe(ctx("describe"));
      expect(described.ok && described.value).toMatchObject({ graphId: "hello", version: "9.9.9" });
    } finally {
      await host.close();
    }
    // The checkout's own bundle is untouched.
    expect(JSON.parse(await readFile(path.join(exampleBundle("hello"), "graphloom.manifest.json"), "utf8")).version).toBe("0.1.0");
  });

  it("makes a slow plugin child whose load failure reaches the host only after it exited", async () => {
    const bundle = await slowBundle(scope, exampleBundle("hello"), { loadDelayMs: 50, stdoutDelayMs: 100, failLoad: "broken import" });
    const manifest = JSON.parse(await readFile(path.join(bundle, "graphloom.manifest.json"), "utf8")) as { entryPoints: { createGraph: string } };
    const host = await createChildPluginHost({ entryModule: path.join(bundle, manifest.entryPoints.createGraph), activeVersion: "hello@0.1.0", generation: 1, cwd: bundle });
    try {
      const described = await host.describe(ctx("describe"));
      expect(described.ok).toBe(false);
      expect(!described.ok && described.observation.message).toBe("failed to load plugin: broken import");
    } finally {
      await host.close();
    }
  });
});

describe("scripted agents", () => {
  it("answer hello's jobs by purpose, failing the first work job when asked", async () => {
    const ws = await createTaskWorkspace(scope, { graph: "hello", request: "x" });
    const agents = helloAgents({ failWork: 1 });
    const job = { stageId: "write", kind: "agent" as const, purpose: "work" as const, instruction: "write" };
    const run = { runId: "r", operationId: "o", generation: 1, worktreePath: ws.repo.path, artifactDir: ws.dir };
    expect(await agents.runJob(job, run)).toMatchObject({ status: "failed", runId: "r" });
    expect(await agents.runJob(job, run)).toMatchObject({ status: "ok" });
    expect(await readFile(path.join(ws.repo.path, "GREETING.txt"), "utf8")).toBe("Hello, GraphLoom!\n");
    expect(agents.jobs).toHaveLength(2);
  });
});

describe("the fake provider", () => {
  async function session(provider: string, faults: ProviderFault[] = []) {
    const fake = await startFakeProvider(scope, { provider, faults, decide: () => ({ text: "decided" }) });
    const dir = await scope.tempDir("gl-testkit-session-");
    const s = await createPiSupervisorSession({
      runId: "testkit",
      sessionDir: path.join(dir, "sessions"),
      agentDir: fake.agentDir,
      cwd: dir,
      provider: fake.provider,
      modelId: fake.modelId,
      thinkingLevel: "high",
      promptTimeoutMs: 5_000,
    });
    scope.defer(() => s.close());
    return { fake, s };
  }

  it("serves its faults in order through the real Pi session, which classifies each", async () => {
    const { fake, s } = await session("minimax-cn", [FAULTS.transient500, FAULTS.quota429NoReset, FAULTS.droppedToolCall]);
    await s.prompt("one").catch(() => undefined);
    expect(s.lastReplyFailure?.()).toMatchObject({ failureClass: "transient" });
    await s.prompt("two").catch(() => undefined);
    const quota = s.lastReplyFailure?.();
    expect(quota).toMatchObject({ failureClass: "quota" });
    expect(quota?.retryAt).toBeUndefined();
    await s.prompt("three").catch(() => undefined);
    expect(s.lastReplyFailure?.()).toMatchObject({ failureClass: "interrupted", undeliveredTokens: 576 });
    expect(fake.served).toEqual(["http-error:500", "http-error:429", "dropped-tool-call"]);
  });

  it("refuses a request that replays empty-signature thinking as text, as Pi does for a provider without allowEmptySignature", async () => {
    const plain = await session("plain-anthropic", [FAULTS.emptySignatureThinking]);
    expect(await plain.s.prompt("first")).toBe("decided");
    await plain.s.prompt("second").catch(() => undefined);
    expect(plain.fake.violations).toEqual(["an empty-signature thinking block was replayed as text the model said"]);

    const minimax = await session("minimax-cn", [FAULTS.emptySignatureThinking]);
    expect(await minimax.s.prompt("first")).toBe("decided");
    expect(await minimax.s.prompt("second")).toBe("decided");
    expect(minimax.fake.violations).toEqual([]);
  });
});
