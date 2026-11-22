// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSubmission } from "@graphloom/sdk";
import { hubCommand, hubServiceUnit } from "../src/hub-cli.js";
import { openSubscriptions } from "../src/hub-subscriptions.js";
import { hubRequest } from "../src/hub-client.js";
import { socketEnvironment } from "./hub-test-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });
async function invoke(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await hubCommand(args);
    return { code, out: [...log.mock.calls.map(call => call.join(" ")), ...writes.mock.calls.map(call => String(call[0]))].join("\n"), err: error.mock.calls.map(call => call.join(" ")).join("\n") };
  } finally { log.mockRestore(); error.mockRestore(); writes.mockRestore(); }
}

describe("hub command over a Unix socket", () => {
  it("submits idempotently, renders plain/native panels, and watches one initial frame", async () => {
    const { socket, service } = await socketEnvironment(cleanups);
    const common = ["--socket", socket];
    const first = await invoke(["submit", "/tasks/a.yaml", "--key", "review-key", ...common]);
    const item = JSON.parse(first.out) as HubSubmission;
    expect(first.err).toContain("submission key: review-key");
    expect(JSON.parse((await invoke(["submit", "/tasks/a.yaml", "--key=review-key", ...common])).out).id).toBe(item.id);
    await service.hub.tick();
    const plain = await invoke(["inspect", item.id, ...common]);
    expect(plain.code).toBe(0); expect(plain.out).toContain("GraphLoom overview"); expect(plain.out).toContain(item.runId);
    expect(plain.out).not.toContain("\u001b");
    vi.stubEnv("NO_COLOR", undefined);
    const colored = await invoke(["inspect", item.id, "--format=markdown", "--chat-renderer=katex", ...common]);
    expect(colored.out).toContain("\\textcolor"); expect(colored.out).toContain("$$");
    const once = await invoke(["watch", item.id, "--json", "--once", ...common]);
    const records = once.out.split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({ type: "snapshot", snapshot: { run: { id: item.runId } } });
    expect((await invoke(["watch", "--plain", "--once", ...common])).out).toContain("occupied 1/3");
  });

  it("applies explicit policy changes and preserves equals-form approval input", async () => {
    const { socket, service } = await socketEnvironment(cleanups, 0);
    const item = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml" }, socket);
    const common = ["--socket", socket];
    const policy = await invoke(["policy", item.id, "--automatic=false", "--max-automatic-resumes=2", "--command-id", "policy-1", ...common]);
    expect(policy.err).toContain("policy-1");
    expect(service.hub.inspect(item.id).retry).toMatchObject({ automatic: false, maxAutomaticResumes: 2 });
    await invoke(["pause", item.id, "--command-id=pause-1", ...common]);
    await invoke(["resume", item.id, "--approve=approval-1", "--input=choice=yes", "--command-id=resume-1", ...common]);
    expect(service.hub.inspect(item.id).pendingCommand?.remedy).toMatchObject({ approve: "approval-1", inputs: { choice: "yes" } });
  });

  it("resolves an uncertain delivery through the explicit operator command", async () => {
    let subscriptionId = ""; let reportId = "";
    const { socket, deliveries } = await socketEnvironment(cleanups, 0, async directory => {
      const subscriptions = await openSubscriptions(directory, { deliver: async () => ({ state: "uncertain", reason: "response lost" }) });
      subscriptionId = (await subscriptions.add({ sessionId: "fixture-session" })).id;
      await subscriptions.tick({ cursor: 0, gap: false, events: [] }, { hubId: "fixture", occupiedSlots: 0, maxConcurrentRuns: 0, submissions: [] });
      reportId = subscriptions.list()[0]!.reports[0]!.id;
    });
    expect(JSON.parse((await invoke(["resolve-report", subscriptionId, "--report", reportId, "--outcome", "accepted", "--socket", socket])).out)).toEqual({ resolved: true });
    const subscriptions = JSON.parse((await invoke(["subscriptions", "--socket", socket])).out);
    expect(subscriptions[0].reports[0]).toMatchObject({ id: reportId, state: "accepted", attempts: 1 });
    expect(deliveries).toHaveLength(0);
  });

  it.each([
    ["list", "--format", "json"], ["list", "unexpected"], ["service", "unexpected"],
    ["inspect", "s", "--format", "bogus"], ["inspect", "s", "--format", "text", "--chat-renderer", "katex"],
    ["inspect", "s", "--panel", "unknown"], ["inspect", "s", "--attempt", "2"],
    ["inspect", "s", "--job", "op", "--follow-current"], ["inspect", "s", "--width", "20", "--width", "30"],
    ["watch", "--json", "--plain"], ["logs", "s", "--stream", "other"],
    ["pause", "s", "--approve", "approval"], ["resume", "s", "--input", "choice=yes"],
    ["resume", "s", "--approve", "a", "--decline", "b"], ["resume", "s", "--approve", "a", "--input", "choice=yes", "--input", "choice=no"],
    ["resolve-report", "s"], ["resolve-report", "s", "--report", "r", "--outcome", "retry"],
    ["submit", "a", "--key="], ["policy", "s", "--automatic", "maybe"], ["policy", "s"], ["unknown"],
  ])("rejects invalid commands before a transport request: %j", async (...args) => {
    await expect(invoke([...args, "--socket", "/nonexistent-hub.sock"])).rejects.not.toThrow("cannot reach hub");
  });

  it("prints a delegated foreground user service without executing it", () => {
    const unit = hubServiceUnit('/tmp/config with "quotes" and %percent.json');
    expect(unit).toContain("Delegate=yes"); expect(unit).toContain("KillMode=mixed"); expect(unit).toContain("hub serve --config");
    expect(unit).toContain("%%percent.json"); expect(unit).toContain('\\"quotes\\"');
  });
});
