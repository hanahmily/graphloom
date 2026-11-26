// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubStatus, HubSubmission } from "@graphloom/sdk";
import { hubCommand, hubServiceUnit, listFilter, pointInTime } from "../src/hub-cli.js";
import { hubRequest } from "../src/hub-client.js";
import { execFileAsync, repoRoot } from "./cli-env.js";
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

  it.each([
    ["list", "--format", "json"], ["list", "unexpected"], ["service", "unexpected"],
    ["inspect", "s", "--format", "bogus"], ["inspect", "s", "--format", "text", "--chat-renderer", "katex"],
    ["inspect", "s", "--panel", "unknown"], ["inspect", "s", "--attempt", "2"],
    ["inspect", "s", "--job", "op", "--follow-current"], ["inspect", "s", "--width", "20", "--width", "30"],
    ["watch", "--json", "--plain"], ["logs", "s", "--stream", "other"],
    ["pause", "s", "--approve", "approval"], ["resume", "s", "--input", "choice=yes"],
    ["resume", "s", "--approve", "a", "--decline", "b"], ["resume", "s", "--approve", "a", "--input", "choice=yes", "--input", "choice=no"],
    ["subscribe", "session"], ["subscriptions"], ["unsubscribe", "s"], ["resolve-report", "s"],
    ["submit", "a", "--key="], ["policy", "s", "--automatic", "maybe"], ["policy", "s"], ["unknown"],
  ])("rejects invalid commands before a transport request: %j", async (...args) => {
    await expect(invoke([...args, "--socket", "/nonexistent-hub.sock"])).rejects.not.toThrow("cannot reach hub");
  });

  it("searches with list filters, newest first, and includes archived submissions only on --archived", async () => {
    const { socket } = await socketEnvironment(cleanups, 0);
    const common = ["--socket", socket];
    const a = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/a.yaml", key: "fix-widgets-1" }, socket);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: "/tasks/b.yaml", key: "review-gadgets-2" }, socket);
    await invoke(["cancel", a.id, ...common]);
    await invoke(["archive", a.id, ...common]);
    const live = await invoke(["list", "--since", "1h", "--limit", "5", ...common]);
    expect(live.code).toBe(0);
    expect(live.out).toContain("1 matching submission");
    expect(live.out).toContain(`${b.id}  queued`); expect(live.out).toContain("hello  Test one graph.");
    expect(live.out).not.toContain(a.id);
    const all = await invoke(["list", "--archived", "--grep", "test ONE", ...common]);
    const lines = all.out.split("\n");
    expect(lines[0]).toContain("2 matching submissions");
    expect(lines[1]).toContain(b.id); expect(lines[2]).toContain(`${a.id}  canceled (archived)`);
    const json = JSON.parse((await invoke(["list", "--archived", "--key", "widgets", "--state", "canceled", "--state", "failed", "--json", ...common])).out) as HubStatus;
    expect(json.submissions).toEqual([]); expect(json.archived?.map((entry) => entry.id)).toEqual([a.id]);
    expect(JSON.parse((await invoke(["list", "--archived", "--until", "2000-01-01", "--json", ...common])).out)).toMatchObject({ submissions: [], archived: [], matched: 0 });
    expect((await invoke(["list", "--repo", "nowhere", ...common])).out).toContain("No matching submissions.");
    // Without a filter the queue listing is unchanged.
    expect((await invoke(["list", ...common])).out).toMatch(new RegExp(`^Hub h-[^\\n]+\\n${b.id}  queued`));
  });

  it("reports hub status with exit 0 healthy, 1 unreachable and 3 faulted", async () => {
    const { socket, service } = await socketEnvironment(cleanups, 2);
    const text = await invoke(["status", "--socket", socket]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^Hub h-\S+ · healthy/); expect(text.out).toContain(`Socket: ${socket}`); expect(text.out).toContain("Limit 2 · occupied 0/2 · queued 0");
    const json = JSON.parse((await invoke(["status", "--json", "--socket", socket])).out) as Record<string, unknown>;
    expect(json).toMatchObject({ reachable: true, healthy: true, socket, maxConcurrentRuns: 2, occupiedSlots: 0, submissions: 0, counts: {}, archivedEntries: 0 });
    const missing = `${socket}.missing`;
    const down = await invoke(["status", "--socket", missing]);
    expect(down.code).toBe(1); expect(down.err).toContain(`cannot reach hub at ${missing}`);
    expect(JSON.parse((await invoke(["status", "--json", "--socket", missing])).out)).toMatchObject({ reachable: false, healthy: false, socket: missing });
    service.hub.lockLost();
    const faulted = await invoke(["status", "--socket", socket]);
    expect(faulted.code).toBe(3); expect(faulted.out).toContain("FAULTED"); expect(faulted.out).toContain("Fault: kernel hub lock lost");
    expect(JSON.parse((await invoke(["status", "--json", "--socket", socket])).out)).toMatchObject({ reachable: true, healthy: false, fault: expect.stringContaining("lock lost") });
  });

  it("lists every hub command, --stage and --follow-current in help, and prints one command's help", async () => {
    const all = await invoke(["--help"]);
    expect(all.code).toBe(0);
    for (const command of ["status", "list", "inspect", "watch", "pause", "cancel", "archive", "resume"]) expect(all.out).toContain(`graphloom hub ${command} `);
    for (const flag of ["--stage <stage>", "--follow-current", "--archived", "--grep <text>", "--state <state>"]) expect(all.out).toContain(flag);
    const one = await invoke(["list", "--help"]);
    expect(one.code).toBe(0);
    expect(one.out.split("\n")[0]).toMatch(/^graphloom hub list \[--state/);
    expect(one.out).toContain("newest first"); expect(one.out).not.toContain("graphloom hub submit");
    const help = (await execFileAsync(process.execPath, [path.join(repoRoot, "apps/graphloom/dist/main.js"), "--help"])).stdout;
    const lines = help.split("\n");
    expect(lines[0]).toBe("graphloom — TypeScript harness");
    const hubLines = lines.filter((line) => line.includes("graphloom hub "));
    expect(hubLines.length).toBeGreaterThanOrEqual(14);
    expect(hubLines.filter((line) => /^ {2}graphloom hub [a-z]/.test(line))).toHaveLength(15);
    expect(lines.findIndex((line) => line.startsWith("  graphloom hub status"))).toBeGreaterThan(lines.indexOf("Usage:"));
  });

  it.each([
    ["list", "--state", "bogus"], ["list", "--since", "yesterday"], ["list", "--limit", "0"], ["list", "--since", "2026-11-02", "--until", "2026-11-01"],
    ["status", "extra"], ["status", "--archived"], ["inspect", "s", "--archived"],
  ])("rejects invalid search and status arguments before a transport request: %j", async (...args) => {
    await expect(invoke([...args, "--socket", "/nonexistent-hub.sock"])).rejects.not.toThrow("cannot reach hub");
  });

  it("resolves --since/--until durations against the caller's clock", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(pointInTime("2h", now, "since")).toBe("2026-11-23T10:00:00.000Z");
    expect(pointInTime("3d", now, "since")).toBe("2026-11-20T12:00:00.000Z");
    expect(pointInTime("2026-11-01", now, "since")).toBe("2026-11-01T00:00:00.000Z");
    expect(listFilter({ repo: "widgets", state: ["blocked", "failed"], archived: true, limit: "20" }, now)).toEqual({ repo: "widgets", states: ["blocked", "failed"], archived: true, limit: 20 });
    expect(listFilter({ repo: "/" }, now).repo).toBe("/");
  });

  it("prints a delegated foreground user service without executing it", () => {
    const unit = hubServiceUnit('/tmp/config with "quotes" and %percent.json');
    expect(unit).toContain("Delegate=yes"); expect(unit).toContain("KillMode=mixed"); expect(unit).toContain("hub serve --config");
    expect(unit).toContain("%%percent.json"); expect(unit).toContain('\\"quotes\\"');
  });
});

describe("recorded launch memory once the launch has ended (docs/design-run-hub.md §6.2)", () => {
  const GiB = 1024 ** 3;
  const flat = (text: string) => text.replace(/[│|]/g, " ").replace(/\s+/g, " ");
  it("shows the latest finished launch's recorded peak in inspect (text, markdown, JSON), list, the submission, status and the archive", async () => {
    const { socket, service, driver } = await socketEnvironment(cleanups, 2);
    const common = ["--socket", socket];
    const killed = JSON.parse((await invoke(["submit", "/tasks/a.yaml", ...common])).out) as HubSubmission;
    const quiet = JSON.parse((await invoke(["submit", "/tasks/b.yaml", ...common])).out) as HubSubmission;
    await service.hub.tick();
    const launchA = service.hub.inspect(killed.id).launch!.id; const launchB = service.hub.inspect(quiet.id).launch!.id;
    const complete = { protocolVersion: 1 as const, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 1, status: "succeeded" as const, continuation: { kind: "complete" as const } };
    driver.executions.set(launchA, { execution: "drained", ownerGone: true, externalStopped: true, observation: complete, memory: { oom: 1, oomKill: 2, oomGroupKill: 1, maxBytes: 6 * GiB, highBytes: 4 * GiB, peakBytes: 6 * GiB } });
    driver.executions.set(launchB, { execution: "drained", ownerGone: true, externalStopped: true, observation: complete, memory: { oom: 0, oomKill: 0, oomGroupKill: 0, maxBytes: 6 * GiB, highBytes: 4 * GiB, peakBytes: 5 * GiB } });
    await service.hub.tick();
    const recordedAt = service.hub.inspect(killed.id).lastLaunchMemory!.recordedAt;

    const text = flat((await invoke(["inspect", killed.id, "--panel", "usage", "--width", "240", ...common])).out);
    expect(text).toContain(`Recorded launch memory peak (launch ${launchA}, at its end ${recordedAt}; limit 6 GiB, throttled above 4 GiB): ${6 * GiB} bytes; settled`);
    expect(text).toContain("Recorded launch processes OOM-killed: 2 processes");
    expect(text).toContain(`no launch is running; recorded at the end of launch ${launchA} (${recordedAt}): peak 6 GiB of 6 GiB (throttled above 4 GiB), 2 processes OOM-killed at its memory.max`);
    const markdown = flat((await invoke(["inspect", killed.id, "--panel", "usage", "--format", "markdown", "--width", "240", ...common])).out);
    expect(markdown).toContain(`recorded at the end of launch ${launchA} (${recordedAt}): peak 6 GiB of 6 GiB`);
    expect(markdown).toContain("Recorded launch memory peak");
    const json = JSON.parse((await invoke(["inspect", killed.id, "--panel", "usage", "--format", "json", ...common])).out) as { panels: Array<{ content: { usage: { metrics: Array<{ id: string; value: number | null }>; coverage: string } } }> };
    const metrics = Object.fromEntries(json.panels[0]!.content.usage.metrics.map((metric) => [metric.id, metric.value]));
    expect(metrics).toMatchObject({ "recorded-memory-peak": 6 * GiB, "recorded-memory-limit": 6 * GiB, "recorded-memory-high": 4 * GiB, "recorded-memory-oom-kills": 2 });
    expect(json.panels[0]!.content.usage.coverage).toContain(`launch ${launchA}`);

    const record = { launchId: launchA, recordedAt, peak: 6 * GiB, high: 4 * GiB, max: 6 * GiB, oom: 1, oomKills: 2 };
    expect((await hubRequest<HubSubmission>("GET", `/v1/submissions/${killed.id}`, undefined, socket)).lastLaunchMemory).toEqual(record);
    const listed = JSON.parse((await invoke(["list", "--json", ...common])).out) as HubStatus;
    expect(listed.submissions.find((item) => item.id === killed.id)!.lastLaunchMemory).toEqual(record);
    expect(listed.submissions.find((item) => item.id === quiet.id)!.lastLaunchMemory).toMatchObject({ launchId: launchB, peak: 5 * GiB, oomKills: 0 });
    // The text list stays compact: only the OOM-killed launch is marked.
    const lines = (await invoke(["list", ...common])).out.split("\n");
    expect(lines.find((line) => line.startsWith(killed.id))).toContain(`OOM-killed: peak 6 GiB of 6 GiB (launch ${launchA})`);
    expect(lines.find((line) => line.startsWith(quiet.id))).not.toContain("OOM");

    const status = (await invoke(["status", ...common])).out;
    expect(status).toContain(`Recorded launch peaks: highest 6 GiB of 6 GiB (${killed.id} ${launchA}, ${recordedAt}) over the latest finished launch of 2 submissions (live and archived) · 1 OOM-killed`);
    await invoke(["archive", killed.id, ...common]);
    const archived = await hubRequest<HubStatus>("GET", "/v1/submissions?archived=true", undefined, socket);
    expect(archived.archived!.find((entry) => entry.id === killed.id)!.lastLaunchMemory).toEqual(record);
    const health = JSON.parse((await invoke(["status", "--json", ...common])).out) as { memory: { recorded: unknown } };
    expect(health.memory.recorded).toEqual({ launches: 2, withPeak: 2, highest: { submissionId: killed.id, launchId: launchA, recordedAt, peak: 6 * GiB, max: 6 * GiB }, oomKilled: 1 });
  });

  it("keeps the live view while a launch runs, with the previous launch's recorded peak beside it", async () => {
    const { socket, service, driver } = await socketEnvironment(cleanups, 1);
    const common = ["--socket", socket];
    const item = JSON.parse((await invoke(["submit", "/tasks/a.yaml", ...common])).out) as HubSubmission;
    await service.hub.tick();
    const first = service.hub.inspect(item.id).launch!.id;
    // The launch is OOM-killed at its limit; the hub retries it once.
    driver.executions.set(first, { execution: "drained", ownerGone: true, externalStopped: true, memory: { oom: 1, oomKill: 3, oomGroupKill: 1, maxBytes: 6 * GiB, peakBytes: 6 * GiB },
      observation: { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 0, status: "stopped", continuation: { kind: "automatic", cause: "controller-crash", fingerprint: "crash", stateRevision: 1 } } });
    await service.hub.tick();
    expect(service.hub.inspect(item.id)).toMatchObject({ state: "waiting", lastLaunchMemory: { launchId: first, oomKills: 3 } });
    await service.hub.resume(item.id); await service.hub.tick();
    expect(service.hub.inspect(item.id).launch?.id).not.toBe(first);
    const json = JSON.parse((await invoke(["inspect", item.id, "--panel", "usage", "--format", "json", ...common])).out) as { panels: Array<{ content: { usage: { metrics: Array<{ id: string; value: number | null; label: string }>; coverage?: string } } }> };
    const usage = json.panels[0]!.content.usage;
    expect(usage.metrics.map((metric) => metric.id)).toEqual(["previous-launch-memory-peak", "tokens"]);
    expect(usage.metrics[0]).toMatchObject({ value: 6 * GiB, label: expect.stringContaining(`launch ${first}, at its end`) });
    expect(usage.metrics[0]!.label).toContain("3 OOM-killed");
    expect(usage.coverage ?? "").not.toContain("no launch is running");
  });
});
