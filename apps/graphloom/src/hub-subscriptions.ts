// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HubStatus, MonitorPanelKind } from "@graphloom/sdk";
import { boundedText, writePrivateJsonOrText } from "./hub-input.js";
import type { HubEvent, HubEventPage } from "./hub-events.js";

const MAX_SUBSCRIPTIONS = 32;
const MAX_REPORTS = 8;
const REPORT_BYTES = 1024;
const COALESCE_MS = 60000;
const HEARTBEAT_MS = 15 * 60000;
const MAX_ATTEMPTS = 5;
const PANEL_KINDS = new Set<MonitorPanelKind>(["overview", "topology", "stages", "jobs", "activity", "job", "usage", "output"]);
export interface HubSubscriptionInput { sessionId: string; submissionId?: string; panels?: MonitorPanelKind[]; wake?: boolean; }
export interface HubDelivery { sessionId: string; wake: boolean; reportId: string; text: string; }
export type HubDeliveryResult = { state: "accepted" } | { state: "failed" | "uncertain"; reason: string };
export interface HubSubscriptionReport {
  id: string;
  cursor: number;
  createdAt: string;
  text: string;
  state: "queued" | "sending" | "accepted" | "failed" | "uncertain";
  attempts: number;
  nextAttemptAt: string;
  error?: string;
}
export interface HubSubscription {
  id: string;
  sessionId: string;
  submissionId?: string;
  panels: MonitorPanelKind[];
  wake: boolean;
  createdAt: string;
  cursor: number;
  initialized: boolean;
  lastReportAt: string;
  pendingSince?: string;
  pending: HubEvent[];
  pendingCount: number;
  droppedReports: number;
  reports: HubSubscriptionReport[];
}
export interface HubSubscriptionsOptions {
  deliver?: (delivery: HubDelivery) => Promise<HubDeliveryResult>;
  /** Plain panel text only. Delivery capability is explicitly plain, never implicit KaTeX. */
  render?: (subscription: HubSubscription, status: HubStatus, events: HubEvent[]) => Promise<string>;
  now?: () => number;
}
interface Store { version: 1; subscriptions: HubSubscription[]; }

export async function openSubscriptions(directory: string, options: HubSubscriptionsOptions = {}): Promise<HubSubscriptions> {
  const file = path.join(directory, "subscriptions.json");
  let state: Store;
  try { state = JSON.parse(await boundedText(file, 1024 * 1024)) as Store; validateStore(state); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { version: 1, subscriptions: [] };
  }
  let changed = false;
  for (const subscription of state.subscriptions) for (const report of subscription.reports) if (report.state === "sending") {
    report.state = "uncertain";
    report.error = "daemon stopped during delivery; inspect the destination before retrying";
    changed = true;
  }
  if (changed) await writePrivateJsonOrText(file, JSON.stringify(state));
  return new HubSubscriptions(file, state, options);
}

/** Delivery has its own bounded durable writer; it cannot hold a run slot. */
export class HubSubscriptions {
  private serial: Promise<unknown> = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private latest: { events: HubEventPage; status: HubStatus } | undefined;
  private readonly now: () => number;
  private readonly deliver: (delivery: HubDelivery) => Promise<HubDeliveryResult>;
  constructor(private file: string, private state: Store, private options: HubSubscriptionsOptions) {
    this.now = options.now ?? Date.now;
    this.deliver = options.deliver ?? deliverHapiReport;
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this.serial.then(fn);
    this.serial = promise.catch(() => undefined);
    return promise;
  }
  private async save(next: Store): Promise<void> {
    validateStore(next);
    await writePrivateJsonOrText(this.file, JSON.stringify(next));
    this.state = next;
  }
  list(): HubSubscription[] { return structuredClone(this.state.subscriptions); }
  /** Oldest committed cursor, for HubEvents.read(). No subscription means no history is requested. */
  cursor(): number { return this.state.subscriptions.length ? Math.min(...this.state.subscriptions.map((s) => s.cursor)) : 0; }
  add(input: HubSubscriptionInput): Promise<HubSubscription> {
    const copied = structuredClone(input);
    return this.enqueue(async () => {
      validateInput(copied);
      const panels = [...new Set<MonitorPanelKind>(copied.panels ?? ["overview"])];
      const existing = this.state.subscriptions.find((s) => s.sessionId === copied.sessionId && s.submissionId === copied.submissionId && s.wake === (copied.wake === true) && JSON.stringify(s.panels) === JSON.stringify(panels));
      if (existing) return structuredClone(existing);
      if (this.state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error("hub chat subscription limit reached (32)");
      const now = new Date(this.now()).toISOString();
      const subscription: HubSubscription = { id: `chat-${randomUUID()}`, sessionId: copied.sessionId, ...(copied.submissionId ? { submissionId: copied.submissionId } : {}), panels, wake: copied.wake === true, createdAt: now, cursor: 0, initialized: false, lastReportAt: now, pending: [], pendingCount: 0, droppedReports: 0, reports: [] };
      const next = structuredClone(this.state); next.subscriptions.push(subscription); await this.save(next);
      return structuredClone(subscription);
    });
  }
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.subscriptions.some((s) => s.id === id)) throw new Error(`unknown chat subscription ${id}`);
      const next = structuredClone(this.state); next.subscriptions = next.subscriptions.filter((s) => s.id !== id); await this.save(next);
    });
  }
  /** Concurrent polling replaces one pending frame instead of accumulating a delivery backlog. */
  tick(events: HubEventPage, status: HubStatus): Promise<void> {
    this.latest = { events: structuredClone(events), status: structuredClone(status) };
    if (this.ticking) return this.ticking;
    this.ticking = this.enqueue(async () => {
      const first = this.takeLatest();
      if (first) await this.process(first.events, first.status);
      const latest = this.takeLatest();
      if (latest) await this.process(latest.events, latest.status);
    }).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private takeLatest(): { events: HubEventPage; status: HubStatus } | undefined { const next = this.latest; this.latest = undefined; return next; }
  private async process(page: HubEventPage, status: HubStatus): Promise<void> {
    if (!this.state.subscriptions.length) return;
    if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.events) || page.events.length > 512) throw new Error("invalid subscription event page");
    const next = structuredClone(this.state);
    const now = this.now();
    for (const subscription of next.subscriptions) {
      const incoming = page.events.filter((event) => event.sequence > subscription.cursor && event.sequence <= page.cursor && (!subscription.submissionId || !event.submissionId || event.submissionId === subscription.submissionId));
      if (incoming.length) {
        subscription.pendingSince ??= new Date(now).toISOString();
        subscription.pending = [...subscription.pending, ...incoming].slice(-8).map((event) => ({ ...event, message: clean(event.message, 512) }));
        subscription.pendingCount = Math.min(1000000, subscription.pendingCount + incoming.length);
      }
      const gap = page.gap || page.cursor < subscription.cursor;
      const initial = !subscription.initialized;
      const immediate = incoming.some((event) => ["blocked", "failed"].includes(event.kind)) || Boolean(status.fault && incoming.some((event) => !event.submissionId));
      const coalesced = subscription.pendingSince !== undefined && now - Date.parse(subscription.pendingSince) >= COALESCE_MS;
      const heartbeat = now - Date.parse(subscription.lastReportAt) >= HEARTBEAT_MS;
      subscription.cursor = page.cursor;
      subscription.initialized = true;
      if (!initial && !gap && !immediate && !coalesced && !heartbeat) continue;
      const reportId = `report-${randomUUID()}`;
      let body: string;
      try { body = this.options.render ? await this.options.render(structuredClone(subscription), status, subscription.pending) : defaultReport(subscription, status); }
      catch (error) { body = `${defaultReport(subscription, status)}\nPanel rendering unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`; }
      if (gap) body = `Event history gap; this is the current snapshot.\n${body}`;
      if (subscription.pendingCount > subscription.pending.length) body += `\n${subscription.pendingCount - subscription.pending.length} earlier changes coalesced.`;
      if (subscription.droppedReports) body += `\n${subscription.droppedReports} older reports coalesced while delivery was unavailable.`;
      while (subscription.reports.length >= MAX_REPORTS) {
        const completed = subscription.reports.findIndex((report) => ["accepted", "failed"].includes(report.state));
        const replaceable = subscription.reports.findIndex((report) => report.state === "queued");
        const index = completed >= 0 ? completed : replaceable;
        // Preserve every uncertain in-flight outcome. Fail closed before overwriting its identity.
        if (index < 0) { subscription.droppedReports++; break; }
        const removed = subscription.reports.splice(index, 1)[0]!;
        if (removed.state === "queued") subscription.droppedReports++;
      }
      if (subscription.reports.length < MAX_REPORTS) {
        subscription.reports.push({ id: reportId, cursor: page.cursor, createdAt: new Date(now).toISOString(), text: reportText(reportId, now, body), state: "queued", attempts: 0, nextAttemptAt: new Date(now).toISOString() });
      }
      subscription.lastReportAt = new Date(now).toISOString();
      subscription.pending = []; subscription.pendingCount = 0; delete subscription.pendingSince;
    }
    await this.save(next);
    // At most one send per subscription per tick, independent from graph execution.
    for (const current of this.state.subscriptions) {
      // An unconfirmed accepted message is inspected by the operator before any later delivery.
      if (current.reports.some((report) => report.state === "uncertain")) continue;
      const report = current.reports.find((r) => r.state === "queued" && Date.parse(r.nextAttemptAt) <= now);
      if (!report) continue;
      const sending = structuredClone(this.state);
      const attempt = sending.subscriptions.find((s) => s.id === current.id)!.reports.find((r) => r.id === report.id)!;
      attempt.state = "sending"; attempt.attempts++;
      await this.save(sending);
      let result: HubDeliveryResult;
      try { result = await this.deliver({ sessionId: current.sessionId, wake: current.wake, reportId: report.id, text: report.text }); }
      catch (error) { result = { state: "uncertain", reason: String(error instanceof Error ? error.message : error) }; }
      const settled = structuredClone(this.state);
      const outcome = settled.subscriptions.find((s) => s.id === current.id)!.reports.find((r) => r.id === report.id)!;
      if (result.state === "accepted") { outcome.state = "accepted"; delete outcome.error; }
      else {
        outcome.error = clean(result.reason, 512);
        outcome.state = result.state === "uncertain" ? "uncertain" : outcome.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
        outcome.nextAttemptAt = new Date(now + Math.min(15 * 60000, 30000 * 2 ** (outcome.attempts - 1))).toISOString();
      }
      await this.save(settled);
    }
  }
}
function defaultReport(subscription: HubSubscription, status: HubStatus): string {
  const rows = [`Hub: ${status.occupiedSlots}/${status.maxConcurrentRuns} slots${status.fault ? `; ${status.fault}` : ""}`];
  const submissions = status.submissions.filter((s) => !subscription.submissionId || s.id === subscription.submissionId);
  if (!submissions.length) rows.push(subscription.submissionId ? "Submission is unavailable or archived." : "No retained submissions.");
  for (const s of submissions.slice(0, 5)) rows.push(`${s.runId}: ${s.state}${s.blocker ? `; ${s.blocker}` : ""}`);
  if (submissions.length > 5) rows.push(`${submissions.length - 5} further submissions.`);
  for (const event of subscription.pending.slice(-3)) rows.push(`${event.at}: ${event.message}`);
  return rows.join("\n");
}
function reportText(id: string, now: number, body: string): string {
  const prefix = `GraphLoom monitor ${id}\n${new Date(now).toISOString()} · static status snapshot\n`;
  const safe = clean(body, REPORT_BYTES - Buffer.byteLength(prefix) - 48).replace(/`/g, "'");
  return `${prefix}\n\`\`\`text\n${safe}\n\`\`\`\n`;
}
function clean(text: string, max: number): string {
  const safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  if (Buffer.byteLength(safe) <= max) return safe;
  return `${Buffer.from(safe).subarray(0, Math.max(0, max - 18)).toString("utf8").replace(/\ufffd$/, "")}\n[report shortened]`;
}
function validateInput(input: HubSubscriptionInput): void {
  if (typeof input.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(input.sessionId)) throw new Error("an explicit HAPI session ID is required");
  if (input.submissionId !== undefined && (typeof input.submissionId !== "string" || !/^s-[a-f0-9-]{36}$/.test(input.submissionId))) throw new Error("invalid subscription submission ID");
  if (input.panels !== undefined && (!Array.isArray(input.panels) || input.panels.length === 0 || input.panels.length > 8 || input.panels.some((panel) => !PANEL_KINDS.has(panel)))) throw new Error("invalid subscription panel selection");
  if (input.wake !== undefined && typeof input.wake !== "boolean") throw new Error("wake must be explicitly true or false");
}
function validateStore(state: Store): void {
  if (state?.version !== 1 || !Array.isArray(state.subscriptions) || state.subscriptions.length > MAX_SUBSCRIPTIONS || Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new Error("invalid subscription store");
  const ids = new Set<string>();
  for (const s of state.subscriptions) {
    validateInput(s);
    if (!s.id || ids.has(s.id) || !Number.isSafeInteger(s.cursor) || s.cursor < 0 || !Array.isArray(s.pending) || s.pending.length > 8 || !Array.isArray(s.reports) || s.reports.length > MAX_REPORTS || !Number.isFinite(Date.parse(s.lastReportAt))) throw new Error("invalid subscription cursor or report state");
    ids.add(s.id);
    for (const r of s.reports) if (typeof r.id !== "string" || typeof r.text !== "string" || Buffer.byteLength(r.text) > REPORT_BYTES || !["queued", "sending", "accepted", "failed", "uncertain"].includes(r.state) || !Number.isSafeInteger(r.attempts) || r.attempts < 0 || r.attempts > MAX_ATTEMPTS || !Number.isFinite(Date.parse(r.nextAttemptAt))) throw new Error("invalid persisted subscription report");
  }
}

/** Fixed argv; no terminal, shell, ambient session discovery, or implicit wake. */
export async function deliverHapiReport(delivery: HubDelivery): Promise<HubDeliveryResult> {
  return new Promise((resolve) => {
    const args = ["ping-peer", delivery.sessionId, "--message-file", "-", "--delivery-mode", "queue", ...(delivery.wake ? ["--wake"] : [])];
    const child = spawn("hapi", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let finished = false;
    const done = (result: HubDeliveryResult) => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ state: "uncertain", reason: "HAPI delivery timed out; inspect the destination before retrying" }); }, 15000);
    const capture = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4096); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", (error) => done({ state: "failed", reason: error.message }));
    child.once("close", (code) => done(code === 0 ? { state: "accepted" } : { state: "uncertain", reason: output.trim() || `HAPI exited ${code}; delivery unconfirmed` }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(delivery.text);
  });
}
