// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { checkHubStateFormat, openHub, type Hub, type HubDriver } from "@graphloom/hub";
import type { HubHealth, HubInput, HubRehearsal, HubRehearsalVerdict, HubResumeRemedy, HubRetryPolicy, HubStatus, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import { parseRehearsalSettings, readHubVerdict, rehearsalLine } from "./hub-rehearsal.js";
import { object, integer, type HubServiceConfig } from "./hub-config.js";
import { HubHttpError, readJson } from "./hub-client.js";
import { captureHubInput, inputDigest, writePrivateJsonOrText } from "./hub-input.js";
import { createHubRuntime, readSubmissionMonitor, cacheMonitor, type HubMonitorCache } from "./hub-runtime.js";
import { withHubSnapshot } from "./hub-observe.js";
import { HubInstallationRetention, inputReferences } from "./hub-retention.js";
import { resolveOperatorPlugin } from "./hub-plugin.js";
import { selfInstall } from "./ownership.js";
import { HubEvents } from "./hub-events.js";
import { parseListQuery, readLiveRequest, searchHub, type LiveRequest } from "./hub-history.js";
import { hubRunEnvironment, runHubDoctor, summarizeHubEnvironment, type HubDoctorResult } from "./hub-environment.js";
import { environmentFingerprint, PreflightCache, preflightNote, preflightRefusal, preflightVerdict } from "./hub-preflight.js";
import { runnerConfigPath } from "./runner-config.js";
import { supervisorConfigPath } from "./supervisor-config.js";
import { memoryChecks, summarizeHubMemory, withMemoryChecks } from "./hub-memory.js";

export interface HubService {
  hub: Hub;
  socket: string;
  close(): Promise<void>;
}
export interface HubServiceOptions {
  config: HubServiceConfig;
  /** Tests replace effects at the driver seam, never through a production CLI flag. */
  driver?: HubDriver;
  cache?: Map<string, HubMonitorCache>;
  captureInput?: (file: string, rehearsal?: HubRehearsal) => Promise<HubInput>;
  /** Tests replace how a `--update-plugin` resume resolves the operator's plugin link. */
  resolvePlugin?: (submission: HubSubmission) => Promise<{ bundlePath: string; bundleDigest: string }>;
  observe?: (submission: HubSubmission) => Promise<MonitorSnapshot>;
  /** The environment the hub's doctor and status summary see; production: the hub process's own, which its runs inherit. */
  environment?: NodeJS.ProcessEnv;
  /** Tests replace the doctor the hub runs (`hub doctor`, the submit preflight); production runs this installation's. */
  doctor?: (taskPath: string | undefined) => Promise<HubDoctorResult>;
  /**
   * Called once when a requested restart finds the hub idle (docs/design-run-hub.md §9.2):
   * `hub serve` under its systemd unit exits so systemd starts the installed version.
   * Absent, the hub refuses a restart request (it cannot restart itself).
   */
  onIdleRestart?: () => void;
}

/** Owner-only HTTP over Unix: no network listener or arbitrary command endpoint. */
export async function serveHub(options: HubServiceOptions): Promise<HubService> {
  const { config } = options;
  // A state format newer than this GraphLoom reads is refused before anything is written (§9.2).
  await checkHubStateFormat(config.directory);
  await privateDirectory(config.directory);
  await privateDirectory(path.dirname(config.socket));
  // Retention is a production process effect, like the real driver. Synthetic drivers
  // exercise queue/transport behavior without touching an operator installation.
  let hub: Hub | undefined;
  const retention = options.driver === undefined
    ? await HubInstallationRetention.open(config.directory, [selfInstall().record.root, process.execPath], () => hub?.list().submissions)
    : undefined;
  let retentionError: string | undefined;
  const runtime = options.driver === undefined ? createHubRuntime(config, () => { void hub?.tick().catch(() => undefined); }) : undefined;
  const cache = options.cache ?? runtime?.cache ?? new Map<string, HubMonitorCache>();
  // Captured tasks are immutable, so what each one asked for is read once per submission.
  const requests = new Map<string, LiveRequest>();
  const liveRequest = async (submission: HubSubmission): Promise<LiveRequest> => {
    let found = requests.get(submission.id);
    if (!found) { found = await readLiveRequest(submission.input.taskFile); requests.set(submission.id, found); }
    return found;
  };
  const describeArchive = async (submission: HubSubmission) => {
    const { summary } = await liveRequest(submission);
    const verdict = submission.input.rehearsal !== undefined ? await readHubVerdict(config.directory, submission.runId) : undefined;
    return {
      ...(summary.graph !== undefined ? { graph: summary.graph } : {}), request: summary, stateDir: path.join(config.directory, "runs", submission.runId),
      ...(verdict !== undefined ? { rehearsalVerdict: verdict.verdict } : {}),
    };
  };
  /** A list reply with each rehearsal submission's recorded verdict (§12.3), read from beside its run. */
  const withRehearsals = async (status: HubStatus): Promise<HubStatus> => {
    const rehearsals: Record<string, HubRehearsalVerdict> = {};
    for (const item of status.submissions) {
      if (item.input.rehearsal === undefined) continue;
      const verdict = await readHubVerdict(config.directory, item.runId);
      if (verdict !== undefined) rehearsals[item.id] = verdict;
    }
    return Object.keys(rehearsals).length > 0 ? { ...status, rehearsals } : status;
  };
  try { hub = await openHub({ directory: config.directory, config, driver: options.driver ?? runtime!.driver, describeArchive }); }
  catch (error) { await retention?.close().catch(() => undefined); throw error; }
  const scheduler = hub;
  let events: HubEvents;
  let monitoringError: string | undefined;
  let historyError: string | undefined;
  try { events = await HubEvents.open(config.directory, scheduler.list().hubId); }
  catch (error) { historyError = `durable event history unavailable: ${String(error)}`; events = HubEvents.volatile(scheduler.list().hubId); }
  let capturing = false;
  const capture = async () => {
    if (capturing) return;
    capturing = true;
    try {
      try { await retention?.refresh(); retentionError = undefined; }
      catch (error) { retentionError = String(error); }
      await events.capture(scheduler.list()); monitoringError = undefined;
    }
    catch (error) { monitoringError = error instanceof Error ? error.message : String(error); }
    finally { capturing = false; }
  };
  await capture();
  const timer = setInterval(() => { void capture().then(restartIfIdle); }, Math.min(config.pollIntervalMs, 1000));
  timer.unref();
  const refreshes = new Map<string, Promise<void>>();
  const monitor = async (submission: HubSubmission): Promise<MonitorSnapshot> => {
    const cached = cache.get(submission.id);
    if (submission.generation > 0 && (!cached?.snapshot || !submission.launch || Date.now() - (cached.refreshedAt ?? 0) >= config.pollIntervalMs)) {
      let pending = refreshes.get(submission.id);
      if (!pending) {
        pending = (async () => {
          try {
            if (options.observe) cacheMonitor(cache, submission.id, { snapshot: await options.observe(submission) });
            else {
              const result = await (runtime?.monitor(submission) ?? readSubmissionMonitor(submission));
              if (result.snapshot) cacheMonitor(cache, submission.id, { snapshot: result.snapshot });
              else cacheMonitor(cache, submission.id, { ...cache.get(submission.id), error: result.monitoringError ?? "owning runtime did not provide a monitoring snapshot" });
            }
          } catch (error) { cacheMonitor(cache, submission.id, { ...cache.get(submission.id), error: error instanceof Error ? error.message : String(error) }); }
        })().finally(() => refreshes.delete(submission.id));
        refreshes.set(submission.id, pending);
      }
      await pending;
    }
    const current = cache.get(submission.id);
    // Before the run's state exists, its graph is the captured task's.
    const graph = current?.snapshot?.run.graph === undefined ? (await liveRequest(submission)).summary.graph : undefined;
    const snapshot = withHubSnapshot(current?.snapshot, submission, scheduler.list(), new Date().toISOString(), current?.error, graph !== undefined ? { graph } : {});
    if (submission.input.rehearsal !== undefined && snapshot.hub !== undefined) {
      snapshot.hub.rehearsal = rehearsalLine(submission.input.rehearsal, await readHubVerdict(config.directory, submission.runId));
    }
    return snapshot;
  };
  let version: string | undefined;
  try { version = selfInstall().record.version; } catch { version = undefined; }
  let closing = false;
  const environment = options.environment ?? process.env;
  let doctoring = false;
  // Doctor runs, the endpoint's and the submit preflight's, one at a time.
  let doctorQueue: Promise<unknown> = Promise.resolve();
  const serialDoctor = <T>(run: () => Promise<T>): Promise<T> => { const next = doctorQueue.then(run); doctorQueue = next.catch(() => undefined); return next; };
  const doctor = options.doctor ?? ((taskPath: string | undefined) => runHubDoctor(environment, config, taskPath));
  const preflights = new PreflightCache();
  let fingerprint: Promise<string> | undefined;
  /** The submit preflight (§3.3): the hub's doctor for the task; a failing check the run needs refuses it, before anything is captured. */
  const preflight = async (taskPath: string, rehearsal: HubRehearsal | undefined): Promise<string> => {
    const runEnv = hubRunEnvironment(environment, config);
    fingerprint ??= environmentFingerprint(environment, [runnerConfigPath(runEnv).file, supervisorConfigPath(runEnv).file]);
    const key = await preflights.key(taskPath, rehearsal, await fingerprint);
    const known = key !== undefined ? preflights.get(key) : undefined;
    if (known !== undefined) return preflightNote(known, true);
    const verdict = preflightVerdict((await serialDoctor(() => doctor(taskPath))).report, rehearsal);
    if (verdict.failures.length > 0) throw new HubHttpError(preflightRefusal(verdict, taskPath, rehearsal !== undefined), 422);
    if (key !== undefined) preflights.remember(key, verdict);
    return preflightNote(verdict, false);
  };
  // A restart when idle (§9.2): no new launch starts; once nothing runs, the hub hands over to systemd.
  let restart: { requestedAt: string; reason: string } | undefined;
  let restarting = false;
  const restartIfIdle = () => {
    if (restart === undefined || restarting || closing || scheduler.list().occupiedSlots > 0) return;
    restarting = true;
    options.onIdleRestart?.();
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://hub.local");
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const status = scheduler.list();
        const counts: HubHealth["counts"] = {};
        const rehearsalCounts: HubHealth["rehearsalCounts"] = {};
        for (const item of status.submissions) {
          counts[item.state] = (counts[item.state] ?? 0) + 1;
          if (item.input.rehearsal !== undefined) rehearsalCounts[item.state] = (rehearsalCounts[item.state] ?? 0) + 1;
        }
        const summary = await summarizeHubEnvironment(environment, config).catch((error: unknown) => ({ pathHead: [], pathEntries: 0, tools: [], variables: [], warnings: [], error: String(error).slice(0, 1024) }));
        const memory = await summarizeHubMemory(config, status.maxConcurrentRuns, status.submissions, scheduler.archived());
        const health: HubHealth = {
          ...status, socket: config.socket, ...(version !== undefined ? { version } : {}), counts, rehearsalCounts, archivedEntries: scheduler.archived().length, environment: summary, memory,
          ...(scheduler.archiveIndexError ? { archiveIndexError: scheduler.archiveIndexError } : {}),
          ...((monitoringError || historyError) ? { monitoringError: (monitoringError ?? historyError)! } : {}), ...(retentionError ? { retentionError } : {}), closing,
          ...(restart !== undefined ? { restart } : {}),
        };
        return respond(response, 200, health);
      }
      if (closing) throw new HubHttpError("hub is shutting down", 503);
      if (url.pathname === "/v1/submissions") {
        if (request.method === "GET") {
          const filter = parseListQuery(url.searchParams);
          const status = scheduler.list();
          if (filter === undefined) return respond(response, 200, await withRehearsals(status));
          const live = new Map<string, LiveRequest>();
          for (const item of status.submissions) live.set(item.id, await liveRequest(item));
          return respond(response, 200, await withRehearsals(searchHub(status, scheduler.archived(), live, filter)));
        }
        if (request.method === "POST") {
          const body = await payload(request, ["taskPath", "key", "rehearsal", "preflight"]);
          const file = text(body.taskPath, "taskPath");
          if (!path.isAbsolute(file)) throw new HubHttpError("taskPath must be absolute on the hub's machine", 400);
          const key = body.key === undefined ? undefined : text(body.key, "key", 256);
          if (body.preflight !== undefined && typeof body.preflight !== "boolean") throw new HubHttpError("preflight must be a boolean", 400);
          // A rehearsal submission (§12): its settings are part of the captured input, so of its digest and key scope.
          let rehearsal: HubRehearsal | undefined;
          try { rehearsal = body.rehearsal === undefined ? undefined : parseRehearsalSettings(body.rehearsal); }
          catch (error) { throw new HubHttpError(error instanceof Error ? error.message : String(error), 400); }
          // A key the hub already holds answers with its submission (or a conflict): no preflight for a retry.
          const preflightLine = body.preflight === true && !(key !== undefined && scheduler.knowsKey(key, rehearsal !== undefined)) ? await preflight(file, rehearsal) : undefined;
          const captured = await (options.captureInput?.(file, rehearsal) ?? captureHubInput(file, config, process.env, rehearsal));
          const input: HubInput = rehearsal !== undefined ? { ...captured, rehearsal } : captured;
          const submit = () => scheduler.submit({ input, requestDigest: inputDigest(input), ...(key !== undefined ? { key } : {}) });
          const result = retention ? await retention.protect(inputReferences({ input }), submit) : await submit();
          await capture();
          return respond(response, 202, preflightLine !== undefined ? { ...result, preflight: preflightLine } : result);
        }
      }
      if (url.pathname === "/v1/doctor" && request.method === "POST") {
        // The doctor's checks in the hub's own environment: what its runs find, not what the caller's shell has.
        const body = await payload(request, ["taskPath"]);
        const taskPath = body.taskPath === undefined ? undefined : text(body.taskPath, "taskPath");
        if (taskPath !== undefined && !path.isAbsolute(taskPath)) throw new HubHttpError("taskPath must be absolute on the hub's machine", 400);
        if (doctoring) throw new HubHttpError("the hub is already running a doctor; try again when it finishes", 409);
        doctoring = true;
        try {
          const result = await serialDoctor(() => doctor(taskPath));
          // The doctor's child cannot see the hub's cgroups as the hub does: the memory checks are the hub's own (§9.1).
          const status = scheduler.list();
          result.report.checks = withMemoryChecks(result.report.checks, memoryChecks(await summarizeHubMemory(config, status.maxConcurrentRuns, status.submissions)));
          return respond(response, 200, result);
        }
        finally { doctoring = false; }
      }
      if (url.pathname === "/v1/restart" && request.method === "POST") {
        // A restart when idle (§9.2), asked for after an upgrade: hold new launches, restart once none runs.
        const body = await payload(request, ["when", "reason"]);
        if (body.when !== "idle") throw new HubHttpError("when must be \"idle\"", 400);
        const reason = body.reason === undefined ? "a restart was requested" : text(body.reason, "reason", 512);
        if (options.onIdleRestart === undefined) throw new HubHttpError("this hub cannot restart itself (it is not running under its systemd unit); restart it yourself when it is idle", 409);
        restart ??= { requestedAt: new Date().toISOString(), reason };
        scheduler.holdNewLaunches(`restart when idle: ${restart.reason}`);
        const occupied = scheduler.list().occupiedSlots;
        restartIfIdle();
        return respond(response, 202, { restart, occupiedSlots: occupied, ...(occupied === 0 ? { now: true } : {}) });
      }
      if (url.pathname === "/v1/limit" && request.method === "POST") {
        const body = await payload(request, ["limit"]);
        const result = await scheduler.setLimit(integer(body.limit, "limit", 0, 1024));
        await capture(); return respond(response, 200, result);
      }
      if (url.pathname === "/v1/events" && request.method === "GET") {
        await capture();
        const since = url.searchParams.has("since") ? integer(Number(url.searchParams.get("since")), "since") : undefined;
        return respond(response, 200, events.read(since, url.searchParams.get("submission") ?? undefined));
      }
      const match = /^\/v1\/submissions\/([^/]+)(?:\/(snapshot|pause|resume|cancel|archive|policy|logs))?$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const action = match[2];
        if (request.method === "POST" && action === "archive") {
          const body = await payload(request, ["commandId"]);
          if (body.commandId !== undefined) text(body.commandId, "commandId", 256);
          const archived = await scheduler.archive(id);
          cache.delete(archived.id); requests.delete(archived.id);
          await capture(); return respond(response, 202, archived);
        }
        const submission = scheduler.inspect(id);
        if (request.method === "GET") {
          if (action === undefined) {
            const verdict = submission.input.rehearsal !== undefined ? await readHubVerdict(config.directory, submission.runId) : undefined;
            return respond(response, 200, verdict !== undefined ? { ...submission, rehearsalVerdict: verdict } : submission);
          }
          if (action === "snapshot") return respond(response, 200, await monitor(submission));
          if (action === "logs") return respond(response, 200, await readLogs(config.directory, submission.id, url.searchParams, submission.launch?.id));
        }
        if (request.method === "POST") {
          const body = await payload(request, action === "resume" ? ["commandId", "remedy"] : action === "policy" ? ["commandId", "retry", "renew"] : ["commandId"]);
          const commandId = body.commandId === undefined ? undefined : text(body.commandId, "commandId", 256);
          const command = commandId === undefined ? {} : { commandId };
          let result: unknown;
          if (action === "pause") result = await scheduler.pause(id, command);
          else if (action === "cancel") result = await scheduler.cancel(id, command);
          else if (action === "resume") {
            let remedy = body.remedy !== undefined ? object(body.remedy, "remedy") as HubResumeRemedy : undefined;
            if (remedy !== undefined && Object.hasOwn(remedy, "plugin")) throw new HubHttpError("remedy.plugin is set by the hub, not a client", 400);
            // --update-plugin follows the operator's task's plugin link to the bundle it names now (§4.2).
            // A retried command ID is answered from the hub's record, never resolved again.
            if (remedy?.updatePlugin === true && !(commandId !== undefined && await scheduler.knownCommand(id, commandId))) {
              const plugin = await (options.resolvePlugin ?? resolveOperatorPlugin)(submission).catch((error: unknown) => { throw new HubHttpError(error instanceof Error ? error.message : String(error), 400); });
              remedy = { ...remedy, plugin };
            }
            const resume = () => scheduler.resume(id, { ...command, ...(remedy !== undefined ? { remedy } : {}) });
            result = retention && remedy?.plugin ? await retention.protect([remedy.plugin.bundlePath], resume) : await resume();
          }
          else if (action === "archive") result = await scheduler.archive(id);
          else if (action === "policy") result = await scheduler.updatePolicy(id, object(body.retry, "retry") as unknown as HubRetryPolicy, { ...command, ...(body.renew === true ? { renew: true } : {}) });
          else throw new HubHttpError("unknown submission operation", 404);
          await capture(); return respond(response, 202, result);
        }
      }
      throw new HubHttpError("unknown hub endpoint", 404);
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HubHttpError ? error.status : /conflict|already|owned/.test(message) ? 409 : /unknown hub submission/.test(message) ? 404 : 400;
      respond(response, status, { error: message.slice(0, 2048) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  try {
    await removeStaleSocket(config.socket);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.socket, () => { server.off("error", reject); resolve(); }); });
    await chmod(config.socket, 0o600);
    await writePrivateJsonOrText(path.join(config.directory, "endpoint.json"), JSON.stringify({ protocolVersion: 1, hubId: scheduler.list().hubId, socket: config.socket }));
  } catch (error) {
    clearInterval(timer); server.close(); await scheduler.close({ graceMs: 0 }); await retention?.close().catch(() => undefined); throw error;
  }
  return {
    hub: scheduler, socket: config.socket,
    async close() {
      if (closing) return;
      closing = true; clearInterval(timer);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      let failure: unknown;
      try { await scheduler.close(); } catch (error) { failure = error; }
      try { await retention?.close(); } catch (error) { failure ??= error; }
      await stopped;
      await unlink(config.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (failure !== undefined) throw failure;
    },
  };
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new HubHttpError("response exceeds the hub size limit; request fewer details", 413);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(bytes), "cache-control": "no-store" });
  response.end(bytes);
}
async function payload(request: IncomingMessage, keys: string[]): Promise<Record<string, unknown>> {
  const value = object(await readJson(request, 64 * 1024), "request");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new HubHttpError(`unknown request field: ${key}`, 400);
  return value;
}
function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > max) throw new HubHttpError(`invalid ${name}`, 400);
  return value;
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error(`hub directory must be owned by this user with mode 0700: ${directory}`);
}
async function removeStaleSocket(socket: string): Promise<void> {
  try {
    const stat = await lstat(socket);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`refusing to replace non-owned socket path ${socket}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const active = await new Promise<boolean>((resolve, reject) => {
    const client = createConnection(socket);
    client.setTimeout(1000, () => client.destroy(new Error("existing hub socket did not respond")));
    client.once("connect", () => { client.destroy(); resolve(true); });
    client.once("error", (error: NodeJS.ErrnoException) => ["ECONNREFUSED", "ENOENT"].includes(error.code ?? "") ? resolve(false) : reject(error));
  });
  if (active) throw new Error(`another service is listening at ${socket}`);
  await unlink(socket);
}

export interface HubLogPage { launchId: string | null; stream: string; offset: number; nextOffset: number; text: string; capped: boolean; }
/** A launch's log page: the requested launch's, else the active launch's, else the latest one written. */
async function readLogs(directory: string, id: string, query: URLSearchParams, active?: string): Promise<HubLogPage> {
  const stream = query.get("stream") ?? "stderr";
  if (!["stdout", "stderr"].includes(stream)) throw new Error("log stream must be stdout or stderr");
  const offset = integer(Number(query.get("offset") ?? 0), "offset");
  const logs = path.join(directory, "submissions", id, "logs");
  const entries = await readdir(logs).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const candidates = await Promise.all(entries.filter((name) => /^l-[a-f0-9-]{36}\.(stdout|stderr)\.log$/.test(name) && name.endsWith(`.${stream}.log`)).map(async (name) => ({ name, at: (await lstat(path.join(logs, name))).mtimeMs })));
  candidates.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  const requested = query.get("launch");
  if (requested !== null && !/^l-[a-f0-9-]{36}$/.test(requested)) throw new Error("invalid launch ID");
  const current = active !== undefined && candidates.some((item) => item.name === `${active}.${stream}.log`) ? active : undefined;
  const launchId = requested ?? current ?? candidates[0]?.name.split(".")[0] ?? null;
  if (launchId === null) return { launchId, stream, offset, nextOffset: offset, text: "", capped: false };
  const handle = await open(path.join(logs, `${launchId}.${stream}.log`), "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(32 * 1024, Math.max(0, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return { launchId, stream, offset, nextOffset: offset + bytesRead, text: buffer.subarray(0, bytesRead).toString("utf8"), capped: size >= 1024 * 1024 };
  } finally { await handle.close(); }
}
