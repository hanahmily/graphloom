// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { parseArgs, stripVTControlCharacters } from "node:util";
import path from "node:path";
import { projectPanels, renderPanels, type ChatRenderer, type MonitorFormat } from "@graphloom/monitor";
import type { HubStatus, HubSubmission, HubRetryPolicy, MonitorPanelKind, MonitorSnapshot, PanelSelection } from "@graphloom/sdk";
import { hubPaths, integer, loadHubConfig } from "./hub-config.js";
import { hubRequest } from "./hub-client.js";
import { serveHub, type HubLogPage } from "./hub-server.js";
import type { HubEventPage } from "./hub-events.js";
import { parseRemedy } from "./hub-managed.js";
import { installRoot } from "./version.js";

export const HUB_USAGE = [
  "graphloom hub serve [--config <file>]",
  "graphloom hub service [--config <file>]",
  "graphloom hub submit <task.yaml> [--key <id>] [--socket <path>]",
  "graphloom hub list [--json] [--socket <path>]",
  "graphloom hub inspect <submission> [--panel <overview|topology|stages|jobs|activity|job|usage|output>] [--format <text|ansi|markdown|json>] [--chat-renderer <auto|plain|katex>] [--job <operation-id>] [--attempt <n>] [--width <columns>] [--cursor <cursor>] [--page-size <n>]",
  "graphloom hub watch [<submission>] [--panel <kind>] [--plain|--json] [--since <cursor>] [--once]",
  "graphloom hub logs <submission> [--stream <stdout|stderr>] [--follow] [--launch <id>]",
  "graphloom hub limit <n>",
  "graphloom hub policy <submission> [--automatic <true|false>] [--max-automatic-resumes <n>] [--max-elapsed-ms <n>] [--base-delay-ms <n>] [--max-delay-ms <n>] [--renew] [--command-id <id>]",
  "graphloom hub pause|cancel|archive <submission> [--command-id <id>]",
  "graphloom hub resume <submission> [--command-id <id>] [--reconciled] [--approve <id> [--input <name>=<value> ...]|--decline <id> [--reason <text>]] [--upgrade] [--update-plugin] [--update-executors] [--supervisor <harness>]",
  "graphloom hub subscribe <session-id> [--submission <id>] [--panel <kind>] [--wake]",
  "graphloom hub subscriptions",
  "graphloom hub unsubscribe <subscription-id>",
];
const PANELS: MonitorPanelKind[] = ["overview", "topology", "stages", "jobs", "activity", "job", "usage", "output"];
const FORMATS: MonitorFormat[] = ["text", "ansi", "markdown", "json"];
const RENDERERS: ChatRenderer[] = ["auto", "plain", "katex"];
const valueFlags = ["config", "socket", "key", "format", "chat-renderer", "job", "attempt", "stage", "cursor", "page-size", "width", "since", "stream", "launch", "command-id", "approve", "decline", "reason", "supervisor", "submission", "automatic", "max-automatic-resumes", "max-elapsed-ms", "base-delay-ms", "max-delay-ms"];
const booleanFlags = ["json", "plain", "once", "follow", "reconciled", "upgrade", "update-plugin", "update-executors", "follow-current", "wake", "renew", "help"];

export async function hubCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true, options: {
    ...Object.fromEntries(valueFlags.map((name) => [name, { type: "string" as const }])),
    ...Object.fromEntries(booleanFlags.map((name) => [name, { type: "boolean" as const }])),
    panel: { type: "string", multiple: true }, input: { type: "string", multiple: true },
  } });
  const values: Record<string, string | boolean | string[] | undefined> = parsed.values;
  const command = parsed.positionals[0];
  const operand = parsed.positionals[1];
  const flag = (name: string) => typeof values[name] === "string" ? values[name] as string : undefined;
  const yes = (name: string) => values[name] === true;
  const socket = flag("socket") ?? hubPaths().socket;
  const need = () => { if (!operand || parsed.positionals.length !== 2) throw new Error(`hub ${command} needs one argument`); return operand; };
  if (!command || command === "help" || yes("help")) { console.log(HUB_USAGE.join("\n")); return command || yes("help") ? 0 : 2; }
  const allowed: Record<string, string[]> = {
    serve: ["config", "socket"], service: ["config"], submit: ["key", "socket"], list: ["json", "socket"], limit: ["socket"],
    pause: ["command-id", "socket"], cancel: ["command-id", "socket"], archive: ["command-id", "socket"],
    resume: ["command-id", "socket", "reconciled", "approve", "input", "decline", "reason", "upgrade", "update-plugin", "update-executors", "supervisor"],
    inspect: ["socket", "panel", "format", "chat-renderer", "job", "attempt", "stage", "cursor", "page-size", "width", "follow-current"],
    watch: ["socket", "panel", "job", "attempt", "stage", "cursor", "page-size", "width", "follow-current", "plain", "json", "once", "since"],
    logs: ["socket", "stream", "follow", "launch"], subscribe: ["socket", "submission", "panel", "wake"], subscriptions: ["socket"], unsubscribe: ["socket"],
    policy: ["socket", "command-id", "automatic", "max-automatic-resumes", "max-elapsed-ms", "base-delay-ms", "max-delay-ms", "renew"],
  };
  if (!allowed[command]) throw new Error(`unknown hub command ${command}`);
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (!allowed[command]!.includes(token.name)) throw new Error(`--${token.name} is not valid for hub ${command}`);
    if (seen.has(token.name) && !["panel", "input"].includes(token.name)) throw new Error(`--${token.name} is given twice`);
    if (token.value !== undefined && token.value.length === 0) throw new Error(`--${token.name} needs a nonempty value`);
    seen.add(token.name);
  }
  if (["service", "list", "subscriptions"].includes(command) && parsed.positionals.length !== 1) throw new Error(`hub ${command} takes no positional arguments`);

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
  if (command === "list") {
    const status = await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, socket);
    console.log(yes("json") ? JSON.stringify(status, null, 2) : formatHubList(status)); return 0;
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
  if (command === "subscriptions") { console.log(JSON.stringify(await hubRequest("GET", "/v1/subscriptions", undefined, socket), null, 2)); return 0; }
  if (command === "subscribe") {
    console.log(JSON.stringify(await hubRequest("POST", "/v1/subscriptions", { sessionId: need(), ...(flag("submission") ? { submissionId: flag("submission") } : {}), ...(kinds.length ? { panels: kinds } : {}), wake: yes("wake") }, socket), null, 2)); return 0;
  }
  if (command === "unsubscribe") { console.log(JSON.stringify(await hubRequest("DELETE", `/v1/subscriptions/${encodeURIComponent(need())}`, undefined, socket), null, 2)); return 0; }
  throw new Error(`unknown hub command ${command}`);
}

export function formatHubList(status: HubStatus): string {
  return [`Hub ${status.hubId} · occupied ${status.occupiedSlots}/${status.maxConcurrentRuns}${status.occupiedSlots > status.maxConcurrentRuns ? " · new starts held" : ""}`,
    ...(status.fault ? [`Fault: ${safeText(status.fault)}`] : []),
    ...status.submissions.map((item) => `${item.id}  ${item.state.padEnd(10)}  ${item.runId}${item.blocker ? `  ${safeText(item.blocker).replace(/\s+/g, " ")}` : ""}`),
    ...(status.submissions.length ? [] : ["No submissions."]),
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
