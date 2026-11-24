// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestExecutorSource } from "@graphloom/runner";
import type { HubInput, HubLaunch, HubSubmission } from "@graphloom/sdk";
import type { HubServiceConfig } from "../src/hub-config.js";
import { hubRequest } from "../src/hub-client.js";
import { materializeHubTask } from "../src/hub-input.js";
import { preparePluginLink, settlePluginLink } from "../src/hub-plugin.js";
import { serveHub } from "../src/hub-server.js";
import { SocketTestDriver } from "./hub-test-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** The hub's real plugin-link seam on the fake driver: relink before a launch, reconcile after it drains. */
class PluginLinkDriver extends SocketTestDriver {
  override async prepare(launch: HubLaunch, submission?: HubSubmission) {
    await preparePluginLink(launch, submission!);
    return super.prepare(launch);
  }
  settleInput = settlePluginLink;
  /** The fake controller stops the run for an operator decision, with `manifest` as its plugin pin. */
  async stopWithPin(hub: string, submission: HubSubmission, manifest: string): Promise<void> {
    await writeRunPin(hub, submission.runId, manifest);
    this.executions.set(submission.launch!.id, { execution: "drained", ownerGone: true, externalStopped: true,
      observation: { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 1, status: "stopped", continuation: { kind: "operator", cause: "pin-drift", evidenceRefs: [] }, blocker: "needs the operator" } });
  }
}

async function writeRunPin(hub: string, runId: string, manifest: string): Promise<void> {
  await mkdir(path.join(hub, "runs", runId), { recursive: true });
  const manifestDigest = createHash("sha256").update(await readFile(path.join(manifest, "graphloom.manifest.json"), "utf8"), "utf8").digest("hex");
  await writeFile(path.join(hub, "runs", runId, "state.json"), JSON.stringify({ runId, intake: { bundle: { bundlePath: "unused", manifestDigest } } }));
}

/** Two installed GraphLoom versions, each with the `hello` plugin, and an operator task linking one. */
async function installation() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-hub-plugin-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const plugin = async (version: string) => {
    const directory = path.join(root, "install", "versions", version, "examples", "plugins", "hello");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "graphloom.manifest.json"), JSON.stringify({ graphId: "hello", version, sdkProtocol: 1, entry: "index.js" }));
    await writeFile(path.join(directory, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
    return directory;
  };
  const v1 = await plugin("0.1.0");
  const v2 = await plugin("0.2.0");
  const tasks = path.join(root, "tasks", "hello");
  await mkdir(path.join(tasks, "plugins"), { recursive: true });
  await mkdir(path.join(root, "repo"));
  const task = path.join(tasks, "task.yaml");
  const text = "graph: hello\nrepo: ../../repo\nrequest: Say hello.\n";
  await writeFile(task, text);
  const operatorLink = path.join(tasks, "plugins", "hello");
  await symlink(v1, operatorLink, "dir");
  const input: HubInput = {
    task: text, taskDigest: createHash("sha256").update(text).digest("hex"), taskPath: task, repoPath: path.join(root, "repo"), baseCommit: "a".repeat(40),
    bundlePath: v1, bundleDigest: await digestExecutorSource(v1), pluginLink: operatorLink, runtimePath: "/runtime/main.js", runtimeDigest: "c".repeat(64),
  };
  const directory = path.join(root, "hub");
  await mkdir(directory, { mode: 0o700 });
  const config: HubServiceConfig = { directory, socket: path.join(directory, "hub.sock"), cgroupRoot: "/not-used", maxConcurrentRuns: 1,
    retry: { automatic: false, maxAutomaticResumes: 0, maxElapsedMs: 60000, baseDelayMs: 1000, maxDelayMs: 10000 }, pollIntervalMs: 1000, shutdownGraceMs: 0 };
  const driver = new PluginLinkDriver();
  const service = await serveHub({ config, driver, environment: { HOME: root, PATH: process.env.PATH }, captureInput: async () => input });
  cleanups.push(() => service.close());
  // Submit, start, and stop the run blocked on v1, as a real initial launch would leave it.
  const submitted = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task }, service.socket);
  await service.hub.tick();
  const started = service.hub.inspect(submitted.id);
  await materializeHubTask(started.input);
  await driver.stopWithPin(directory, started, v1);
  await service.hub.tick();
  expect(service.hub.inspect(submitted.id).state).toBe("blocked");
  const privateLink = path.join(directory, "submissions", submitted.id, "plugins", "hello");
  return { root, v1, v2, operatorLink, privateLink, directory, driver, service, id: submitted.id };
}

describe("hub resume --update-plugin", () => {
  it("moves a blocked run to the plugin the operator's link names now; a plain resume keeps the pinned one", async () => {
    const { v1, v2, operatorLink, privateLink, directory, driver, service, id } = await installation();
    expect(await realpath(privateLink)).toBe(v1);
    // The operator installs a newer GraphLoom and repoints the task's link at its plugin.
    await unlink(operatorLink);
    await symlink(v2, operatorLink, "dir");

    // A plain resume keeps the run's pinned plugin exactly.
    await hubRequest("POST", `/v1/submissions/${id}/resume`, { commandId: "plain" }, service.socket);
    await service.hub.tick();
    let current = service.hub.inspect(id);
    expect(current.launch?.command?.remedy).toBeUndefined();
    expect(await realpath(privateLink)).toBe(v1);
    await driver.stopWithPin(directory, current, v1);
    await service.hub.tick();
    current = service.hub.inspect(id);
    expect(current.state).toBe("blocked");
    expect(current.input.bundlePath).toBe(v1);
    expect(await realpath(privateLink)).toBe(v1);

    // --update-plugin re-resolves the operator's link; the controller accepts the new pin.
    const accepted = await hubRequest<HubSubmission>("POST", `/v1/submissions/${id}/resume`, { commandId: "update", remedy: { updatePlugin: true, upgrade: true } }, service.socket);
    expect(accepted.pendingCommand?.remedy?.plugin).toEqual({ bundlePath: v2, bundleDigest: await digestExecutorSource(v2) });
    expect(accepted.input.bundlePath).toBe(v1);
    await service.hub.tick();
    current = service.hub.inspect(id);
    expect(await realpath(privateLink)).toBe(v2);
    await driver.stopWithPin(directory, current, v2);
    await service.hub.tick();
    current = service.hub.inspect(id);
    expect(current.input.bundlePath).toBe(v2);
    expect(current.input.bundleDigest).toBe(await digestExecutorSource(v2));
    expect(await realpath(privateLink)).toBe(v2);

    // Later plain resumes stay on the new pin.
    await hubRequest("POST", `/v1/submissions/${id}/resume`, { commandId: "plain-again" }, service.socket);
    await service.hub.tick();
    expect(await realpath(privateLink)).toBe(v2);
  });

  it("points the run back at its pinned plugin when the controller refuses the update", async () => {
    const { v1, v2, operatorLink, privateLink, directory, driver, service, id } = await installation();
    await unlink(operatorLink);
    await symlink(v2, operatorLink, "dir");
    await hubRequest("POST", `/v1/submissions/${id}/resume`, { remedy: { updatePlugin: true } }, service.socket);
    await service.hub.tick();
    expect(await realpath(privateLink)).toBe(v2);
    // The controller refused (for example, a changed stage list): its pin stays v1.
    await driver.stopWithPin(directory, service.hub.inspect(id), v1);
    await service.hub.tick();
    const current = service.hub.inspect(id);
    expect(current.state).toBe("blocked");
    expect(current.input.bundlePath).toBe(v1);
    expect(await realpath(privateLink)).toBe(v1);
  });

  it("refuses with a reason when the operator's plugin link is dangling or gone, and rejects a client-chosen bundle", async () => {
    const { root, v2, operatorLink, privateLink, v1, service, id } = await installation();
    await unlink(operatorLink);
    await symlink(path.join(root, "install", "versions", "9.9.9", "examples", "plugins", "hello"), operatorLink, "dir");
    await expect(hubRequest("POST", `/v1/submissions/${id}/resume`, { remedy: { updatePlugin: true } }, service.socket))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/plugin link .* points nowhere .*9\.9\.9.*point it at the installed plugin/) });
    await unlink(operatorLink);
    await expect(hubRequest("POST", `/v1/submissions/${id}/resume`, { remedy: { updatePlugin: true } }, service.socket))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining(`plugin link ${operatorLink} is gone`) });
    await expect(hubRequest("POST", `/v1/submissions/${id}/resume`, { remedy: { updatePlugin: true, plugin: { bundlePath: v2, bundleDigest: "d".repeat(64) } } }, service.socket))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("set by the hub") });
    const current = service.hub.inspect(id);
    expect(current.state).toBe("blocked");
    expect(current.pendingCommand).toBeUndefined();
    expect(await readlink(privateLink)).toBe(v1);
  });

  it("refuses a link that names another graph's plugin", async () => {
    const { root, operatorLink, service, id } = await installation();
    const other = path.join(root, "other");
    await mkdir(other);
    await writeFile(path.join(other, "graphloom.manifest.json"), JSON.stringify({ graphId: "goodbye", version: "1.0.0" }));
    await unlink(operatorLink);
    await symlink(other, operatorLink, "dir");
    await expect(hubRequest("POST", `/v1/submissions/${id}/resume`, { remedy: { updatePlugin: true } }, service.socket))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("names graph goodbye, not this run's hello") });
  });
});
