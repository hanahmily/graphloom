// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectPanels, renderPanels, type ChatRenderer, type MonitorFormat } from "@graphloom/monitor";
import type { HubHealth, HubSchedulingState, HubStatus, HubSubmission, HubRetryPolicy, MonitorPanelKind, MonitorSnapshot, PanelSelection } from "@graphloom/sdk";
import { hubPaths, integer, loadHubConfig } from "./hub-config.js";
import { hubRequest } from "./hub-client.js";
import { HUB_LIST_LIMIT_MAX, HUB_STATES, listQuery, type HubListFilter } from "./hub-history.js";
import { serveHub, type HubLogPage } from "./hub-server.js";
import type { HubEventPage } from "./hub-events.js";
import { parseRemedy } from "./hub-managed.js";
import { installRoot } from "./version.js";

export const HUB_USAGE = [
  "graphloom hub serve [--config <file>]",
  "graphloom hub service [--config <file>]",
  "graphloom hub status [--json] [--socket <path>]",
  "graphloom hub submit <task.yaml> [--key <id>] [--socket <path>]",
  "graphloom hub list [--state <state> ...] [--graph <id>] [--repo <path|text>] [--key <text>] [--since <iso|duration>] [--until <iso|duration>] [--grep <text>] [--limit <n>] [--archived] [--json] [--socket <path>]",
  "graphloom hub inspect <submission> [--panel <overview|topology|stages|jobs|activity|job|usage|output>] [--format <text|ansi|markdown|json>] [--chat-renderer <auto|plain|katex>] [--job <operation-id>|--follow-current] [--attempt <n>] [--stage <stage>] [--width <columns>] [--cursor <cursor>] [--page-size <n>]",
  "graphloom hub watch [<submission>] [--panel <kind>] [--job <operation-id>|--follow-current] [--attempt <n>] [--stage <stage>] [--plain|--json] [--since <cursor>] [--once]",
  "graphloom hub logs <submission> [--stream <stdout|stderr>] [--follow] [--launch <id>]",
  "graphloom hub limit <n>",
  "graphloom hub policy <submission> [--automatic <true|false>] [--max-automatic-resumes <n>] [--max-elapsed-ms <n>] [--base-delay-ms <n>] [--max-delay-ms <n>] [--renew] [--command-id <id>]",
  "graphloom hub pause <submission> [--command-id <id>]",
  "graphloom hub cancel <submission> [--command-id <id>]",
  "graphloom hub archive <submission> [--command-id <id>]",
  "graphloom hub resume <submission> [--command-id <id>] [--reconciled] [--approve <id> [--input <name>=<value> ...]|--decline <id> [--reason <text>]] [--upgrade] [--update-plugin] [--update-executors] [--supervisor <harness>]",
];
/** One paragraph per command for `graphloom hub <command> --help`. */
const HUB_HELP: Record<string, string> = {
  serve: "Runs the hub in the foreground (normally under the systemd user service).",
  service: "Prints a systemd user unit for the hub; installs nothing.",
  status: "Reports whether the hub is reachable and healthy: id, socket, version, limit, slot and state counts, faults.\nExit 0 healthy, 1 unreachable, 3 faulted or shutting down.",
  submit: "Submits a task to the queue; the same --key and task return the same submission.",
  list: "Lists submissions in queue order. Any filter, --limit or --archived searches instead, newest first:\n--state is repeatable (any of); --repo is an exact path (starting with /, . or ~) or a substring;\n--key is a substring; --since/--until bound acceptance time by an ISO time or a duration ago\n(90s, 10m, 2h, 3d, 1w); --grep is case-insensitive text in the request or the blocker (an archived\nentry keeps only the request's first line); --archived adds the archive index.",
  inspect: "Renders a submission's monitoring panels. --stage narrows to one stage's neighbourhood;\n--follow-current selects the current stage's running job (instead of --job).",
  watch: "Live view of all submissions or one; never exits without --once.",
  logs: "Reads the latest (or --launch) launch's stderr or stdout.",
  limit: "Sets the hub-wide concurrency limit.",
  policy: "Changes a submission's automatic retry policy; --renew restores its allowance.",
  pause: "Holds a submission and cooperatively stops its run.",
  cancel: "Permanently withdraws a submission and drains its run.",
  archive: "Moves a terminal, drained submission out of the queue into the bounded archive index.",
  resume: "Lifts a hold or requests another attempt, with an optional operator remedy.",
};
const PANELS: MonitorPanelKind[] = ["overview", "topology", "stages", "jobs", "activity", "job", "usage", "output"];
const FORMATS: MonitorFormat[] = ["text", "ansi", "markdown", "json"];
const RENDERERS: ChatRenderer[] = ["auto", "plain", "katex"];
const valueFlags = ["config", "socket", "key", "format", "chat-renderer", "job", "attempt", "stage", "cursor", "page-size", "width", "since", "until", "graph", "repo", "grep", "limit", "stream", "launch", "command-id", "approve", "decline", "reason", "supervisor", "automatic", "max-automatic-resumes", "max-elapsed-ms", "base-delay-ms", "max-delay-ms"];
const booleanFlags = ["json", "plain", "once", "follow", "reconciled", "upgrade", "update-plugin", "update-executors", "follow-current", "renew", "archived", "help"];
const repeatable = ["panel", "input", "state"];

export async function hubCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true, options: {
    ...Object.fromEntries(valueFlags.map((name) => [name, { type: "string" as const }])),
    ...Object.fromEntries(booleanFlags.map((name) => [name, { type: "boolean" as const }])),
    ...Object.fromEntries(repeatable.map((name) => [name, { type: "string" as const, multiple: true as const }])),
  } });
  const values: Record<string, string | boolean | string[] | undefined> = parsed.values;
  const command = parsed.positionals[0];
  const operand = parsed.positionals[1];
  const flag = (name: string) => typeof values[name] === "string" ? values[name] as string : undefined;
  const yes = (name: string) => values[name] === true;
  const socket = flag("socket") ?? hubPaths().socket;
  const need = () => { if (!operand || parsed.positionals.length !== 2) throw new Error(`hub ${command} needs one argument`); return operand; };
  if (!command || command === "help" || yes("help")) {
    if (command && Object.hasOwn(HUB_HELP, command)) console.log([...HUB_USAGE.filter((line) => line.startsWith(`graphloom hub ${command} `)), "", HUB_HELP[command]].join("\n"));
    else console.log(HUB_USAGE.join("\n"));
    return command || yes("help") ? 0 : 2;
  }
  const allowed: Record<string, string[]> = {
    serve: ["config", "socket"], service: ["config"], submit: ["key", "socket"], status: ["json", "socket"], limit: ["socket"],
    list: ["json", "socket", "state", "graph", "repo", "key", "since", "until", "grep", "limit", "archived"],
    pause: ["command-id", "socket"], cancel: ["command-id", "socket"], archive: ["command-id", "socket"],
    resume: ["command-id", "socket", "reconciled", "approve", "input", "decline", "reason", "upgrade", "update-plugin", "update-executors", "supervisor"],
    inspect: ["socket", "panel", "format", "chat-renderer", "job", "attempt", "stage", "cursor", "page-size", "width", "follow-current"],
    watch: ["socket", "panel", "job", "attempt", "stage", "cursor", "page-size", "width", "follow-current", "plain", "json", "once", "since"],
    logs: ["socket", "stream", "follow", "launch"],
    policy: ["socket", "command-id", "automatic", "max-automatic-resumes", "max-elapsed-ms", "base-delay-ms", "max-delay-ms", "renew"],
  };
  if (!allowed[command]) throw new Error(`unknown hub command ${command}`);
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (!allowed[command]!.includes(token.name)) throw new Error(`--${token.name} is not valid for hub ${command}`);
    if (seen.has(token.name) && !repeatable.includes(token.name)) throw new Error(`--${token.name} is given twice`);
    if (token.value !== undefined && token.value.length === 0) throw new Error(`--${token.name} needs a nonempty value`);
    seen.add(token.name);
  }
  if (["service", "list", "status"].includes(command) && parsed.positionals.length !== 1) throw new Error(`hub ${command} takes no positional arguments`);

  if (command === "serve") {
    if (parsed.positionals.length !== 1) throw new Error("hub serve takes configuration through --config");
    const config = await loadHubConfig(flag("config"));
    if (flag("socket") !== undefined) config.socket = path.resolve(socket);
    const service = await serveHub({ config });
    console.log(JSON.stringify({ event: "hub-ready", socket: service.socket, hubId: service.hub.list().hubId }));
    await new Promise<void>((resolve, reject) => {
      let shutting = false;
      const stop = () => {
        if (shutting) return;
        shutting = true;
        void service.close().then(resolve, reject).finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
      };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
    });
    return 0;
  }
  if (command === "service") {
    console.log(hubServiceUnit(path.resolve(flag("config") ?? hubPaths().config)));
    return 0;
  }
  if (command === "submit") {
    const file = path.resolve(need());
    const key = flag("key") ?? randomUUID();
    console.error(`submission key: ${key}`);
    console.log(JSON.stringify(await hubRequest("POST", "/v1/submissions", { taskPath: file, key }, socket), null, 2));
    return 0;
  }
  if (command === "status") return hubStatus(socket, yes("json"));
  if (command === "list") {
    const query = listQuery(listFilter(values, Date.now())).toString();
    const status = await hubRequest<HubStatus>("GET", `/v1/submissions${query ? `?${query}` : ""}`, undefined, socket);
    console.log(yes("json") ? JSON.stringify(status, null, 2) : query ? formatHubSearch(status) : formatHubList(status)); return 0;
  }
  if (command === "limit") {
    const limit = integer(Number(need()), "limit", 0, 1024);
    console.log(formatHubList(await hubRequest<HubStatus>("POST", "/v1/limit", { limit }, socket))); return 0;
  }
  if (["pause", "resume", "cancel", "archive"].includes(command)) {
    const id = need();
    const commandId = flag("command-id") ?? randomUUID();
    console.error(`command id: ${commandId}`);
    const remedyArgs = ["reconciled", "approve", "input", "decline", "reason", "upgrade", "update-plugin", "update-executors", "supervisor"].flatMap(name => {
      const value = values[name];
      return value === true ? [`--${name}`] : typeof value === "string" ? [`--${name}`, value] : Array.isArray(value) ? value.flatMap(item => [`--${name}`, item]) : [];
    });
    const remedy = command === "resume" ? parseRemedy(remedyArgs) : undefined;
    console.log(JSON.stringify(await hubRequest("POST", `/v1/submissions/${encodeURIComponent(id)}/${command}`, { commandId, ...(remedy !== undefined ? { remedy } : {}) }, socket), null, 2)); return 0;
  }
  if (command === "policy") {
    const id = need();
    const updates = ["automatic", "max-automatic-resumes", "max-elapsed-ms", "base-delay-ms", "max-delay-ms"].filter(name => flag(name) !== undefined);
    if (!updates.length && !yes("renew")) throw new Error("hub policy needs at least one policy setting or --renew");
    if (flag("automatic") !== undefined && !["true", "false"].includes(flag("automatic")!)) throw new Error("--automatic must be true or false");
    const retry: HubRetryPolicy = { ...(await hubRequest<HubSubmission>("GET", `/v1/submissions/${encodeURIComponent(id)}`, undefined, socket)).retry };
    if (flag("automatic") !== undefined) retry.automatic = flag("automatic") === "true";
    for (const [option, key, min, max] of [
      ["max-automatic-resumes", "maxAutomaticResumes", 0, 10000], ["max-elapsed-ms", "maxElapsedMs", 1, Number.MAX_SAFE_INTEGER],
      ["base-delay-ms", "baseDelayMs", 1, 86400000], ["max-delay-ms", "maxDelayMs", 1, 86400000],
    ] as const) if (flag(option) !== undefined) retry[key] = integer(Number(flag(option)), option, min, max);
    if (retry.maxDelayMs < retry.baseDelayMs) throw new Error("max-delay-ms must be at least base-delay-ms");
    const commandId = flag("command-id") ?? randomUUID(); console.error(`command id: ${commandId}`);
    console.log(JSON.stringify(await hubRequest("POST", `/v1/submissions/${encodeURIComponent(id)}/policy`, { commandId, retry, renew: yes("renew") }, socket), null, 2));
    return 0;
  }
  const kinds = (values.panel ?? []) as string[];
  if (kinds.some((kind) => !PANELS.includes(kind as MonitorPanelKind))) throw new Error(`--panel must be one of ${PANELS.join(", ")}`);
  if (flag("attempt") !== undefined && flag("job") === undefined) throw new Error("--attempt requires --job");
  if (yes("follow-current") && flag("job") !== undefined) throw new Error("--follow-current and --job are alternative selections");
  const selection: PanelSelection = {
    ...(kinds.length ? { kinds: kinds as MonitorPanelKind[] } : {}),
    ...(flag("job") !== undefined ? { operationId: flag("job")! } : {}),
    ...(flag("stage") !== undefined ? { stageId: flag("stage")! } : {}),
    ...(flag("attempt") !== undefined ? { attempt: integer(Number(flag("attempt")), "attempt", 1) } : {}),
    ...(flag("cursor") !== undefined ? { cursor: flag("cursor")! } : {}),
    ...(flag("page-size") !== undefined ? { pageSize: integer(Number(flag("page-size")), "page-size", 1, 200) } : {}),
    ...(yes("follow-current") ? { followCurrent: true } : {}),
  };
  if (command === "inspect") {
    const id = need();
    const format = flag("format") ?? "text";
    const renderer = flag("chat-renderer") ?? "auto";
    if (!FORMATS.includes(format as MonitorFormat)) throw new Error(`--format must be ${FORMATS.join(", ")}`);
    if (!RENDERERS.includes(renderer as ChatRenderer)) throw new Error(`--chat-renderer must be ${RENDERERS.join(", ")}`);
    if (flag("chat-renderer") !== undefined && format !== "markdown") throw new Error("--chat-renderer requires --format markdown");
    const snapshot = await hubRequest<MonitorSnapshot>("GET", `/v1/submissions/${encodeURIComponent(id)}/snapshot`, undefined, socket);
    const report = await renderPanels(projectPanels(snapshot, selection), { format: format as MonitorFormat, ...(format === "markdown" ? { chatRenderer: renderer as ChatRenderer } : {}), width: integer(Number(flag("width") ?? process.stdout.columns ?? 80), "width", 20, 240), noColor: process.env.NO_COLOR !== undefined });
    console.log(report.output);
    for (const reason of report.fallbackReasons) console.error(`rendering: ${reason}`);
    return 0;
  }
  if (command === "watch") {
    if (parsed.positionals.length > 2 || yes("json") && yes("plain")) throw new Error("hub watch accepts one optional submission and either --json or --plain");
    await watchHub(socket, operand, { selection, json: yes("json"), plain: yes("plain"), once: yes("once"), ...(flag("width") !== undefined ? { width: integer(Number(flag("width")), "width", 20, 240) } : {}), ...(flag("since") !== undefined ? { since: integer(Number(flag("since")), "since") } : {}) });
    return 0;
  }
  if (command === "logs") {
    const id = need();
    let offset = 0;
    let launch = flag("launch");
    const stream = flag("stream") ?? "stderr";
    if (!["stdout", "stderr"].includes(stream)) throw new Error("--stream must be stdout or stderr");
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on("SIGINT", stop);
    try {
      do {
        const query = new URLSearchParams({ offset: String(offset), stream, ...(launch ? { launch } : {}) });
        const page = await hubRequest<HubLogPage>("GET", `/v1/submissions/${encodeURIComponent(id)}/logs?${query}`, undefined, socket);
        process.stdout.write(safeText(page.text));
        offset = page.nextOffset; launch = page.launchId ?? undefined;
        if (page.capped) { console.error("launch log reached its retention cap"); break; }
        if (!yes("follow")) break;
        await delay(1000, abort.signal);
      } while (!abort.signal.aborted);
    } finally { process.off("SIGINT", stop); }
    return 0;
  }
  throw new Error(`unknown hub command ${command}`);
}

export function formatHubList(status: HubStatus): string {
  return [`Hub ${status.hubId} · occupied ${status.occupiedSlots}/${status.maxConcurrentRuns}${status.occupiedSlots > status.maxConcurrentRuns ? " · new starts held" : ""}`,
    ...(status.fault ? [`Fault: ${safeText(status.fault)}`] : []),
    ...status.submissions.map((item) => `${item.id}  ${item.state.padEnd(10)}  ${item.runId}${item.blocker ? `  ${safeText(item.blocker).replace(/\s+/g, " ")}` : ""}`),
    ...(status.submissions.length ? [] : ["No submissions."]),
  ].join("\n");
}

/** `hub list`'s search flags as a filter; times and local paths resolve here, on the caller's clock and filesystem. */
export function listFilter(values: Record<string, string | boolean | string[] | undefined>, now: number): HubListFilter {
  const text = (name: string) => typeof values[name] === "string" ? values[name] as string : undefined;
  const states = (values.state ?? []) as string[];
  for (const state of states) if (!HUB_STATES.includes(state as HubSchedulingState)) throw new Error(`--state must be one of ${HUB_STATES.join(", ")}`);
  const repo = text("repo");
  const limit = text("limit");
  const filter: HubListFilter = {
    ...(states.length ? { states: states as HubSchedulingState[] } : {}),
    ...(text("graph") !== undefined ? { graph: text("graph")! } : {}),
    ...(repo !== undefined ? { repo: /^[/.~]/.test(repo) ? localPath(repo) : repo } : {}),
    ...(text("key") !== undefined ? { key: text("key")! } : {}),
    ...(text("since") !== undefined ? { since: pointInTime(text("since")!, now, "since") } : {}),
    ...(text("until") !== undefined ? { until: pointInTime(text("until")!, now, "until") } : {}),
    ...(text("grep") !== undefined ? { grep: text("grep")! } : {}),
    ...(limit !== undefined ? { limit: integer(Number(limit), "limit", 1, HUB_LIST_LIMIT_MAX) } : {}),
    ...(values.archived === true ? { archived: true } : {}),
  };
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) throw new Error("--since is after --until");
  return filter;
}
function localPath(value: string): string {
  const absolute = path.resolve(value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);
  try { return realpathSync(absolute); } catch { return absolute; }
}
/** An ISO time, or a duration before `now`: `90s`, `10m`, `2h`, `3d`, `1w`. */
export function pointInTime(value: string, now: number, name: string): string {
  const units = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 };
  const duration = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value.trim());
  if (duration) return new Date(now - Number(duration[1]) * units[duration[2] as keyof typeof units]).toISOString();
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  throw new Error(`--${name} must be an ISO time (2026-11-01, 2026-11-01T12:00:00Z) or a duration (90s, 10m, 2h, 3d, 1w)`);
}

/** A search reply: one line per match, newest first, archived entries marked. */
export function formatHubSearch(status: HubStatus): string {
  const one = (value: string) => safeText(value).replace(/\s+/g, " ").trim();
  const rows = [
    ...status.submissions.map((item) => ({ at: item.acceptedAt, id: item.id, state: item.state, runId: item.runId, graph: status.summaries?.[item.id]?.graph, line: status.summaries?.[item.id]?.firstLine, blocker: item.blocker ?? item.observation?.blocker, archived: false })),
    ...(status.archived ?? []).map((entry) => ({ at: entry.acceptedAt, id: entry.id, state: entry.state, runId: entry.runId, graph: entry.graph, line: entry.request?.firstLine, blocker: entry.blocker, archived: true })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const matched = status.matched ?? rows.length;
  return [`Hub ${status.hubId} · ${rows.length === matched ? `${matched}` : `${rows.length} of ${matched}`} matching submission${matched === 1 ? "" : "s"}`,
    ...(status.fault ? [`Fault: ${safeText(status.fault)}`] : []),
    ...rows.map((row) => [row.at, row.id, `${row.state}${row.archived ? " (archived)" : ""}`.padEnd(21), row.runId, row.graph ?? "-", row.line ? one(row.line) : "-", ...(row.blocker ? [`blocker: ${one(row.blocker)}`] : [])].join("  ")),
    ...(rows.length ? [] : ["No matching submissions."]),
  ].join("\n");
}

/** `hub status`: exit 0 healthy, 1 unreachable, 3 faulted or shutting down. */
async function hubStatus(socket: string, json: boolean): Promise<number> {
  let health: HubHealth;
  try { health = await hubRequest<HubHealth>("GET", "/v1/health", undefined, socket); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ reachable: false, healthy: false, socket, error: message }, null, 2));
    else console.error(message);
    return 1;
  }
  const counts: Partial<Record<HubSchedulingState, number>> = { ...health.counts };
  if (health.counts === undefined) for (const item of health.submissions) counts[item.state] = (counts[item.state] ?? 0) + 1;
  const healthy = !health.fault && health.closing !== true;
  if (json) {
    const { submissions, ...rest } = health;
    console.log(JSON.stringify({ reachable: true, healthy, ...rest, socket: health.socket ?? socket, counts, submissions: submissions.length }, null, 2));
  } else console.log(formatHubStatus({ ...health, counts }, socket));
  return healthy ? 0 : 3;
}
export function formatHubStatus(health: HubHealth, socket: string): string {
  const counts = health.counts ?? {};
  const states = HUB_STATES.filter((state) => counts[state]).map((state) => `${state} ${counts[state]}`);
  return [
    `Hub ${health.hubId} · ${health.fault ? "FAULTED" : health.closing ? "shutting down" : "healthy"}${health.version ? ` · GraphLoom ${health.version}` : ""}`,
    `Socket: ${health.socket ?? socket}`,
    `Limit ${health.maxConcurrentRuns} · occupied ${health.occupiedSlots}/${health.maxConcurrentRuns}${health.occupiedSlots > health.maxConcurrentRuns ? " · new starts held" : ""} · queued ${counts.queued ?? 0}`,
    `Submissions: ${health.submissions.length}${states.length ? ` (${states.join(", ")})` : ""}${health.archivedEntries !== undefined ? ` · archive index ${health.archivedEntries}` : ""}`,
    ...(health.fault ? [`Fault: ${safeText(health.fault)}`] : []),
    ...(health.retentionError ? [`Retention error: ${safeText(health.retentionError)}`] : []),
    ...(health.monitoringError ? [`Monitoring error: ${safeText(health.monitoringError)}`] : []),
    ...(health.archiveIndexError ? [`Archive index error: ${safeText(health.archiveIndexError)}`] : []),
  ].join("\n");
}

async function watchHub(socket: string, id: string | undefined, options: { selection: PanelSelection; json: boolean; plain: boolean; once: boolean; since?: number; width?: number }): Promise<void> {
  const terminal = process.stdout.isTTY === true && !options.plain && !options.json;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let cursor = options.since;
  let first = true;
  let lastPlain = "";
  const paint = (text: string) => process.stdout.write(terminal ? `\u001b[H\u001b[2J${text}\n` : `${text}\n`);
  if (terminal) process.stdout.write("\u001b[?1049h\u001b[?25l");
  try {
    do {
      try {
        const query = new URLSearchParams({ ...(cursor !== undefined ? { since: String(cursor) } : {}), ...(id ? { submission: id } : {}) });
        const events = await hubRequest<HubEventPage>("GET", `/v1/events?${query}`, undefined, socket);
        cursor = events.cursor;
        if (options.json) {
          if (first || events.gap) paint(JSON.stringify({ type: "snapshot", cursor, gap: events.gap, snapshot: await hubRequest("GET", id ? `/v1/submissions/${encodeURIComponent(id)}/snapshot` : "/v1/submissions", undefined, socket) }));
          for (const event of events.events) paint(JSON.stringify({ type: "event", ...event }));
        } else if (id) {
          const snapshot = await hubRequest<MonitorSnapshot>("GET", `/v1/submissions/${encodeURIComponent(id)}/snapshot`, undefined, socket);
          const report = await renderPanels(projectPanels(snapshot, { kinds: ["overview", "topology"], ...options.selection }), { format: terminal ? "ansi" : "text", width: Math.max(20, Math.min(240, options.width ?? process.stdout.columns ?? 80)), noColor: process.env.NO_COLOR !== undefined });
          if (terminal || first || events.gap || events.events.length) paint(`${events.gap ? "Event gap; refreshed snapshot.\n" : ""}${report.output}`);
        } else {
          const text = formatHubList(await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, socket));
          if (terminal || first || text !== lastPlain) paint(text);
          lastPlain = text;
        }
        first = false;
      } catch (error) {
        if (options.once) throw error;
        paint(options.json ? JSON.stringify({ type: "disconnected", cursor, error: String(error) }) : `Disconnected/stale: ${safeText(String(error))}`);
      }
      if (options.once) break;
      await delay(5000, abort.signal);
    } while (!abort.signal.aborted);
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (terminal) process.stdout.write("\u001b[?25h\u001b[?1049l");
  }
}
function safeText(value: string): string { return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  });
}
export function hubServiceUnit(config: string): string {
  const quote = (value: string) => `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  return `[Unit]\nDescription=GraphLoom run hub\n\n[Service]\nType=exec\nExecStart=${quote(process.execPath)} ${quote(path.join(installRoot(), "apps", "graphloom", "dist", "main.js"))} hub serve --config ${quote(config)}\nRestart=on-failure\nRestartSec=5\nDelegate=yes\nKillMode=mixed\nTimeoutStopSec=90\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
