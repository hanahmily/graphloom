// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { openHub, type Hub, type HubDriver } from "@graphloom/hub";
import type { HubHealth, HubInput, HubResumeRemedy, HubRetryPolicy, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import { object, integer, type HubServiceConfig } from "./hub-config.js";
import { HubHttpError, readJson } from "./hub-client.js";
import { captureHubInput, inputDigest, writePrivateJsonOrText } from "./hub-input.js";
import { createHubRuntime, readSubmissionMonitor, cacheMonitor, type HubMonitorCache } from "./hub-runtime.js";
import { withHubSnapshot } from "./hub-observe.js";
import { HubInstallationRetention, inputReferences } from "./hub-retention.js";
import { selfInstall } from "./ownership.js";
import { HubEvents } from "./hub-events.js";
import { parseListQuery, readLiveRequest, searchHub, type LiveRequest } from "./hub-history.js";
import { runHubDoctor, summarizeHubEnvironment } from "./hub-environment.js";

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
  captureInput?: (file: string) => Promise<HubInput>;
  observe?: (submission: HubSubmission) => Promise<MonitorSnapshot>;
  /** The environment the hub's doctor and status summary see; production: the hub process's own, which its runs inherit. */
  environment?: NodeJS.ProcessEnv;
}

/** Owner-only HTTP over Unix: no network listener or arbitrary command endpoint. */
export async function serveHub(options: HubServiceOptions): Promise<HubService> {
  const { config } = options;
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
    return { ...(summary.graph !== undefined ? { graph: summary.graph } : {}), request: summary, stateDir: path.join(config.directory, "runs", submission.runId) };
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
  const timer = setInterval(() => { void capture(); }, Math.min(config.pollIntervalMs, 1000));
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
    return withHubSnapshot(current?.snapshot, submission, scheduler.list(), new Date().toISOString(), current?.error);
  };
  let version: string | undefined;
  try { version = selfInstall().record.version; } catch { version = undefined; }
  let closing = false;
  const environment = options.environment ?? process.env;
  let doctoring = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://hub.local");
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const status = scheduler.list();
        const counts: HubHealth["counts"] = {};
        for (const item of status.submissions) counts[item.state] = (counts[item.state] ?? 0) + 1;
        const summary = await summarizeHubEnvironment(environment, config).catch((error: unknown) => ({ pathHead: [], pathEntries: 0, tools: [], variables: [], warnings: [], error: String(error).slice(0, 1024) }));
        const health: HubHealth = {
          ...status, socket: config.socket, ...(version !== undefined ? { version } : {}), counts, archivedEntries: scheduler.archived().length, environment: summary,
          ...(scheduler.archiveIndexError ? { archiveIndexError: scheduler.archiveIndexError } : {}),
          ...((monitoringError || historyError) ? { monitoringError: (monitoringError ?? historyError)! } : {}), ...(retentionError ? { retentionError } : {}), closing,
        };
        return respond(response, 200, health);
      }
      if (closing) throw new HubHttpError("hub is shutting down", 503);
      if (url.pathname === "/v1/submissions") {
        if (request.method === "GET") {
          const filter = parseListQuery(url.searchParams);
          const status = scheduler.list();
          if (filter === undefined) return respond(response, 200, status);
          const live = new Map<string, LiveRequest>();
          for (const item of status.submissions) live.set(item.id, await liveRequest(item));
          return respond(response, 200, searchHub(status, scheduler.archived(), live, filter));
        }
        if (request.method === "POST") {
          const body = await payload(request, ["taskPath", "key"]);
          const file = text(body.taskPath, "taskPath");
          if (!path.isAbsolute(file)) throw new HubHttpError("taskPath must be absolute on the hub's machine", 400);
          const key = body.key === undefined ? undefined : text(body.key, "key", 256);
          const input = await (options.captureInput?.(file) ?? captureHubInput(file, config));
          const submit = () => scheduler.submit({ input, requestDigest: inputDigest(input), ...(key !== undefined ? { key } : {}) });
          const result = retention ? await retention.protect(inputReferences({ input }), submit) : await submit();
          await capture();
          return respond(response, 202, result);
        }
      }
      if (url.pathname === "/v1/doctor" && request.method === "POST") {
        // The doctor's checks in the hub's own environment: what its runs find, not what the caller's shell has.
        const body = await payload(request, ["taskPath"]);
        const taskPath = body.taskPath === undefined ? undefined : text(body.taskPath, "taskPath");
        if (taskPath !== undefined && !path.isAbsolute(taskPath)) throw new HubHttpError("taskPath must be absolute on the hub's machine", 400);
        if (doctoring) throw new HubHttpError("the hub is already running a doctor; try again when it finishes", 409);
        doctoring = true;
        try { return respond(response, 200, await runHubDoctor(environment, config, taskPath)); }
        finally { doctoring = false; }
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
          if (action === undefined) return respond(response, 200, submission);
          if (action === "snapshot") return respond(response, 200, await monitor(submission));
          if (action === "logs") return respond(response, 200, await readLogs(config.directory, submission.id, url.searchParams));
        }
        if (request.method === "POST") {
          const body = await payload(request, action === "resume" ? ["commandId", "remedy"] : action === "policy" ? ["commandId", "retry", "renew"] : ["commandId"]);
          const commandId = body.commandId === undefined ? undefined : text(body.commandId, "commandId", 256);
          const command = commandId === undefined ? {} : { commandId };
          let result: unknown;
          if (action === "pause") result = await scheduler.pause(id, command);
          else if (action === "cancel") result = await scheduler.cancel(id, command);
          else if (action === "resume") result = await scheduler.resume(id, { ...command, ...(body.remedy !== undefined ? { remedy: object(body.remedy, "remedy") as HubResumeRemedy } : {}) });
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
async function readLogs(directory: string, id: string, query: URLSearchParams): Promise<HubLogPage> {
  const stream = query.get("stream") ?? "stderr";
  if (!["stdout", "stderr"].includes(stream)) throw new Error("log stream must be stdout or stderr");
  const offset = integer(Number(query.get("offset") ?? 0), "offset");
  const logs = path.join(directory, "submissions", id, "logs");
  const entries = await readdir(logs).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const candidates = await Promise.all(entries.filter((name) => /^l-[a-f0-9-]{36}\.(stdout|stderr)\.log$/.test(name) && name.endsWith(`.${stream}.log`)).map(async (name) => ({ name, at: (await lstat(path.join(logs, name))).mtimeMs })));
  candidates.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  const requested = query.get("launch");
  if (requested !== null && !/^l-[a-f0-9-]{36}$/.test(requested)) throw new Error("invalid launch ID");
  const launchId = requested ?? candidates[0]?.name.split(".")[0] ?? null;
  if (launchId === null) return { launchId, stream, offset, nextOffset: offset, text: "", capped: false };
  const handle = await open(path.join(logs, `${launchId}.${stream}.log`), "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(32 * 1024, Math.max(0, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return { launchId, stream, offset, nextOffset: offset + bytesRead, text: buffer.subarray(0, bytesRead).toString("utf8"), capped: size >= 1024 * 1024 };
  } finally { await handle.close(); }
}
