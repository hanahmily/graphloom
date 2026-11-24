// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { HubArchiveEntry, HubArchivedSubmission, HubConfig, HubContinuation, HubObservation, HubResumeRemedy, HubRetryPolicy, HubStatus, HubSubmission } from "@graphloom/sdk";
import { acquireHubLock } from "./lock.js";
import { HubArchiveIndex } from "./archive.js";
import { assertCapacity, durableWrite, HubStore, syncDirectory, validateConfig } from "./store.js";
import type { HubSnapshot } from "./store.js";
import type { HubDriver, HubSubmitRequest, OpenHubOptions } from "./types.js";

export const DEFAULT_HUB_CONFIG: HubConfig = {
  maxConcurrentRuns: 2,
  retry: { automatic: true, maxAutomaticResumes: 5, maxElapsedMs: 86400000, baseDelayMs: 30000, maxDelayMs: 1800000 },
  pollIntervalMs: 5000,
  shutdownGraceMs: 60000,
};
const automaticCauses = new Set(["provider-cooldown", "executor-retry", "transient-provider", "transient-launch", "controller-crash", "service-interruption", "initialization-failed"]);
const operatorCauses = new Set(["approval", "authority", "budget", "pin-drift", "reconciliation", "unknown", "operator-stop"]);
const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 1024);
const terminal = (s: HubSubmission): boolean => ["succeeded", "failed", "canceled"].includes(s.state);
const incompleteInitialization = (s: HubSubmission): boolean => s.observation?.continuation?.kind === "automatic" && s.observation.continuation.cause === "initialization-failed";
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function openHub(options: OpenHubOptions): Promise<Hub> {
  let lockLost = false;
  let handleLoss = () => { lockLost = true; };
  const lock = await acquireHubLock(options.directory, () => handleLoss());
  const release = lock.release;
  try {
    const store = new HubStore(path.resolve(options.directory));
    let snapshot = await store.load();
    if (snapshot && options.config) {
      const config = { ...snapshot.config, ...options.config, maxConcurrentRuns: snapshot.config.maxConcurrentRuns, retry: { ...snapshot.config.retry, ...options.config.retry } };
      validateConfig(config);
      snapshot = { ...snapshot, config };
      await store.save(snapshot);
    }
    if (!snapshot) {
      const config = { ...DEFAULT_HUB_CONFIG, ...options.config, retry: { ...DEFAULT_HUB_CONFIG.retry, ...options.config?.retry } };
      validateConfig(config);
      snapshot = { schemaVersion: 1, hubId: `h-${randomUUID()}`, config, sequence: 0, submissions: {}, tombstones: [] };
      await store.save(snapshot);
    }
    for (const submission of Object.values(snapshot.submissions)) await store.command(submission, "");
    await options.driver.probe({ lockPid: lock.pid });
    if (lockLost) throw new Error("kernel hub lock lost during startup");
    const archiveIndex = await HubArchiveIndex.open(path.resolve(options.directory), snapshot.hubId, options.archiveIndexBounds);
    const hub = new Hub(store, snapshot, options, release, archiveIndex);
    handleLoss = () => hub.lockLost();
    // Startup reconciliation is complete before the caller can accept work.
    await hub.tick();
    hub.startPolling();
    return hub;
  } catch (error) { await release(); throw error; }
}

/** One serialized durable writer owns every slot transition. Views are immutable copies. */
export class Hub {
  private serial: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private fault: string | undefined;
  private closing = false;
  private closed = false;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly random: () => number;
  private readonly deadlines = new Map<string, number>();
  private readonly driver: HubDriver;
  constructor(private readonly store: HubStore, private snapshot: HubSnapshot, private readonly options: OpenHubOptions, private readonly release: () => Promise<void>, private readonly archiveIndex: HubArchiveIndex) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.driver = options.driver;
    for (const submission of Object.values(snapshot.submissions)) this.rememberDeadline(submission);
  }
  lockLost(): void {
    this.fault = "kernel hub lock lost; execution stopped and admission disabled";
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const s of Object.values(this.snapshot.submissions)) if (s.launch) void this.driver.kill(copy(s.launch), copy(s)).catch(() => undefined);
    void this.driver.close?.();
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("hub is closed"));
    const result = this.serial.then(fn);
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async commit(change: (next: HubSnapshot) => void): Promise<void> {
    if (this.fault) throw new Error(`hub persistence fault: ${this.fault}`);
    const next = copy(this.snapshot);
    change(next);
    assertCapacity(next);
    try { await this.store.save(next); } catch (error) {
      this.fault = message(error);
      throw error;
    }
    this.snapshot = next;
  }
  private get(id: string): HubSubmission {
    const submission = (Object.hasOwn(this.snapshot.submissions, id) ? this.snapshot.submissions[id] : undefined) ?? Object.values(this.snapshot.submissions).find((s) => s.runId === id);
    if (!submission) throw new Error(`unknown hub submission ${id}`);
    return submission;
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private occupied(): number { return Object.values(this.snapshot.submissions).filter((s) => s.launch).length; }
  list(): HubStatus {
    return copy({ hubId: this.snapshot.hubId, maxConcurrentRuns: this.snapshot.config.maxConcurrentRuns, occupiedSlots: this.occupied(), submissions: Object.values(this.snapshot.submissions).sort((a, b) => a.queueSequence - b.queueSequence), ...(this.fault ? { fault: this.fault } : {}) });
  }
  inspect(id: string): HubSubmission { return copy(this.get(id)); }
  /** The bounded archive index, oldest first (docs/design-run-hub.md §4.1). */
  archived(): HubArchiveEntry[] { return this.archiveIndex.list(); }
  /** Why the archive index started empty, when its file was unreadable. */
  get archiveIndexError(): string | undefined { return this.archiveIndex.loadError; }
  startPolling(): void {
    if (this.options.autoPoll === false || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.snapshot.config.pollIntervalMs);
    this.timer.unref();
  }
  async submit(request: HubSubmitRequest): Promise<HubSubmission | HubArchivedSubmission> {
    request = copy(request);
    return this.enqueue(async () => {
      if (this.closing) throw new Error("hub is shutting down");
      validateSubmit(request);
      if (request.key !== undefined) {
        const existing = Object.values(this.snapshot.submissions).find((s) => s.key === request.key) ?? this.snapshot.tombstones.find((s) => s.key === request.key);
        if (existing) {
          if (existing.requestDigest !== request.requestDigest || existing.contentDigest !== canonicalDigest(request.input)) throw new Error("idempotency key conflicts with a different request");
          return copy(existing);
        }
      }
      const id = `s-${randomUUID()}`;
      const directory = path.join(this.store.directory, "submissions", id);
      const { task, config, ...metadata } = request.input;
      const stored = { ...metadata, taskFile: path.join(directory, "task.yaml"), ...(config === undefined ? {} : { configFile: path.join(directory, "config.json") }) };
      const submission: HubSubmission = {
        id, runId: `hub-${randomUUID()}`, hubId: this.snapshot.hubId, acceptedAt: this.stamp(), updatedAt: this.stamp(), requestDigest: request.requestDigest, contentDigest: canonicalDigest(request.input),
        ...(request.key === undefined ? {} : { key: request.key }), input: stored, desiredAction: "execute", state: "queued", queueSequence: this.snapshot.sequence + 1,
        generation: 0, automaticResumes: 0, retry: copy(this.snapshot.config.retry), failureRepeats: 0, progressRevision: 0, journalBytes: 0,
      };
      // Capacity rejection is an ordinary admission error, not a store fault.
      const preview = copy(this.snapshot);
      preview.submissions[id] = submission;
      assertCapacity(preview);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // File fsync alone does not persist this new submission directory's entry.
      await syncDirectory(path.dirname(directory));
      await durableWrite(stored.taskFile, task);
      if (config !== undefined && stored.configFile) await durableWrite(stored.configFile, config);
      await this.commit((next) => { next.sequence++; next.submissions[id] = submission; });
      // Acceptance does not wait for execution. The serialized scheduler runs afterward.
      this.wake();
      return copy(submission);
    });
  }
  private wake(): void { if (!this.closing && this.options.autoPoll !== false) queueMicrotask(() => { void this.tick().catch(() => undefined); }); }
  async setLimit(limit: number): Promise<HubStatus> {
    return this.enqueue(async () => {
      validateConfig({ ...this.snapshot.config, maxConcurrentRuns: limit });
      await this.commit((next) => { next.config.maxConcurrentRuns = limit; });
      this.wake();
      return this.list();
    });
  }
  pause(id: string, options: { commandId?: string } = {}): Promise<HubSubmission> { return this.command(id, "pause", options.commandId); }
  cancel(id: string, options: { commandId?: string } = {}): Promise<HubSubmission> { return this.command(id, "cancel", options.commandId); }
  /** Whether this submission already recorded `commandId`; a retried command is answered from the record. */
  knownCommand(id: string, commandId: string): Promise<boolean> {
    return this.enqueue(async () => (await this.store.command(this.get(id), commandId)) !== undefined);
  }
  resume(id: string, options: { commandId?: string; remedy?: HubResumeRemedy } = {}): Promise<HubSubmission> { return this.command(id, "resume", options.commandId, options.remedy); }
  private command(id: string, kind: "pause" | "cancel" | "resume", commandId: string = randomUUID(), remedy?: HubResumeRemedy): Promise<HubSubmission> {
    return this.enqueue(async () => {
      bounded(commandId, "command id", 256);
      validateRemedy(remedy);
      const submission = this.get(id);
      // The hub-resolved plugin bundle is not part of the client's request: a retried command ID matches without it.
      const { plugin: _plugin, ...requested } = remedy ?? {};
      const requestDigest = canonicalDigest({ kind, remedy: remedy === undefined ? undefined : requested });
      const previous = await this.store.command(submission, commandId);
      if (previous) {
        if (previous.digest !== requestDigest) throw new Error("command ID conflicts with a different command");
        return this.inspect(id);
      }
      if (submission.desiredAction === "cancel") throw new Error("canceled submissions cannot be resumed or changed");
      if (submission.state === "succeeded") throw new Error("completed submissions cannot be restarted");
      if (kind === "resume" && remedy && incompleteInitialization(submission)) throw new Error("resume remedies cannot be applied before initialization; retry without a remedy");
      if (kind === "resume" && remedy && (submission.launch || submission.pendingCommand)) throw new Error("a remedy needs a drained submission with no pending command");
      const command = { id: commandId, kind, acceptedAt: this.stamp(), ...(remedy ? { remedy: copy(remedy) } : {}) };
      const cursor = await this.store.journal(submission, { commandId, digest: requestDigest, acceptedAt: command.acceptedAt });
      await this.commit((next) => {
        const s = next.submissions[submission.id]!;
        s.journalBytes = cursor;
        s.updatedAt = this.stamp();
        s.desiredAction = kind === "pause" ? "hold" : kind === "cancel" ? "cancel" : "execute";
        delete s.blocker;
        if (kind === "resume") {
          if (!s.launch && s.state !== "queued") {
            s.queueSequence = ++next.sequence;
            s.state = "queued";
          }
          if (!s.launch) {
            delete s.eligibleAt;
            delete s.automaticPending;
          }
          if (!s.launch || s.launch.stopRequestedAt) s.pendingCommand = command;
        } else {
          delete s.pendingCommand;
          delete s.automaticPending;
          delete s.eligibleAt;
          if (s.launch) {
            s.launch.stopRequestedAt = this.stamp();
            s.launch.stopReason = kind;
            s.launch.stopCommandId = commandId;
            s.state = "stopping";
          } else s.state = kind === "pause" ? "paused" : "canceled";
        }
      });
      this.rememberDeadline(this.get(id));
      // The desired state is durable before signalling; failures leave a held reservation.
      if (kind !== "resume") await this.signalStop(submission.id);
      this.wake();
      return this.inspect(id);
    });
  }
  async updatePolicy(id: string, policy: HubRetryPolicy, options: { commandId?: string; renew?: boolean } = {}): Promise<HubSubmission> {
    return this.enqueue(async () => {
      validateConfig({ ...this.snapshot.config, retry: policy });
      const s = this.get(id);
      if (s.launch) throw new Error("policy changes require a drained submission");
      const commandId = options.commandId ?? randomUUID();
      bounded(commandId, "command id", 256);
      const requestDigest = canonicalDigest({ policy, renew: options.renew === true });
      const previous = await this.store.command(s, commandId);
      if (previous) {
        if (previous.digest !== requestDigest) throw new Error("command ID conflicts with a different command");
        return this.inspect(id);
      }
      const cursor = await this.store.journal(s, { commandId, digest: requestDigest, acceptedAt: this.stamp() });
      await this.commit((next) => {
        const item = next.submissions[s.id]!;
        item.retry = copy(policy); item.journalBytes = cursor;
        if (options.renew) { item.automaticResumes = 0; item.failureRepeats = 0; delete item.retryStartedAt; delete item.failureFingerprint; }
      });
      return this.inspect(id);
    });
  }
  async archive(id: string): Promise<HubArchivedSubmission> {
    return this.enqueue(async () => {
      const archived = this.snapshot.tombstones.find((entry) => entry.id === id || entry.runId === id);
      if (archived) return copy(archived);
      const s = this.get(id);
      if (!terminal(s) || s.launch) throw new Error("only terminal drained submissions can be archived");
      const tombstone: HubArchivedSubmission = { archived: true, id: s.id, runId: s.runId, requestDigest: s.requestDigest, contentDigest: s.contentDigest, ...(s.key ? { key: s.key } : {}) };
      if (this.fault) throw new Error(`hub persistence fault: ${this.fault}`);
      // History first: a crash before the snapshot commits leaves an index entry for a
      // still-live submission, which searches skip; the reverse would lose the entry.
      let described: Pick<HubArchiveEntry, "graph" | "request" | "stateDir"> = {};
      try { described = await this.options.describeArchive?.(copy(s)) ?? {}; } catch { described = {}; }
      const blocker = s.blocker ?? s.observation?.blocker;
      await this.archiveIndex.add({
        archived: true, id: s.id, runId: s.runId, ...(s.key ? { key: s.key } : {}),
        ...(described.graph !== undefined ? { graph: described.graph } : {}),
        repoPath: s.input.repoPath, taskPath: s.input.taskPath, requestDigest: s.requestDigest,
        ...(described.request !== undefined ? { request: described.request } : {}),
        acceptedAt: s.acceptedAt, settledAt: s.updatedAt, archivedAt: this.stamp(), state: s.state as HubArchiveEntry["state"],
        ...(described.stateDir !== undefined ? { stateDir: described.stateDir } : {}),
        ...(blocker ? { blocker } : {}),
      });
      await this.commit((next) => { delete next.submissions[s.id]; next.tombstones.push(tombstone); });
      return tombstone;
    });
  }
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    // Potentially slow owning-runtime reads never occupy the mutation writer. Polls coalesce.
    const active = Object.values(this.snapshot.submissions).filter((s) => s.launch).map(copy);
    const results: { submission: HubSubmission; result?: Awaited<ReturnType<HubDriver["inspect"]>>; error?: string }[] = [];
    let cursor = 0;
    const inspect = async () => {
      while (cursor < active.length) {
        const submission = active[cursor++]!;
        try { results.push({ submission, result: await this.driver.inspect(submission.launch!, submission) }); }
        catch (error) { results.push({ submission, error: message(error) }); }
      }
    };
    this.polling = Promise.all(Array.from({ length: Math.min(4, active.length) }, inspect))
      .then(() => this.enqueue(() => this.tickInside(results)))
      .finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async tickInside(observed: { submission: HubSubmission; result?: Awaited<ReturnType<HubDriver["inspect"]>>; error?: string }[]): Promise<void> {
    if (this.fault) return;
    for (const item of observed) {
      const s = this.snapshot.submissions[item.submission.id];
      if (!s?.launch || s.launch.id !== item.submission.launch?.id || s.launch.generation !== item.submission.launch.generation) continue;
      const result = item.result;
      if (!result) { await this.blockLaunch(s.id, `execution inspection failed: ${item.error}`); continue; }
      if (result.observation && !validObservation(result.observation)) {
        await this.blockLaunch(s.id, "owning runtime returned an invalid continuation observation");
        continue;
      }
      const observation = result.observation;
      if (result.execution === "drained" && result.ownerGone && result.externalStopped) {
        await this.settle(s.id, observation);
      } else {
        await this.commit((next) => {
          const current = next.submissions[s.id]!;
          if (observation && observation.stateRevision >= (current.observation?.stateRevision ?? 0)) current.observation = observation;
          if (current.launch?.failure) {
            current.state = "blocked";
            current.blocker = current.launch.failure.message;
          } else if (result.execution === "uncertain" || !result.externalStopped && result.execution === "drained") {
            current.blocker = (result.reason ?? "execution drainage is not verified").slice(0, 1024);
          } else if (!current.launch?.stopRequestedAt) {
            current.state = current.launch?.phase === "granted" ? "running" : "starting";
            delete current.blocker;
          }
        });
        const current = this.get(s.id);
        if (current.launch?.stopRequestedAt) {
          await this.signalStop(s.id);
          if (this.now() - Date.parse(current.launch.stopRequestedAt) >= this.snapshot.config.shutdownGraceMs) {
            try { await this.driver.kill(copy(current.launch), copy(current)); }
            catch (error) { await this.blockLaunch(s.id, `forced cleanup failed: ${message(error)}`); }
          }
        }
      }
    }
    if (this.closing || this.fault) return;
    await this.promoteReady();
    while (this.occupied() < this.snapshot.config.maxConcurrentRuns) {
      const candidate = Object.values(this.snapshot.submissions).filter((s) => s.state === "queued" && s.desiredAction === "execute" && !s.launch && this.ready(s)).sort((a, b) => a.queueSequence - b.queueSequence)[0];
      if (!candidate) break;
      if (candidate.automaticPending && !this.retryAllowed(candidate)) {
        await this.commit((next) => { const s = next.submissions[candidate.id]!; s.state = "blocked"; s.blocker = "automatic retry allowance or elapsed deadline exhausted"; });
        continue;
      }
      await this.launch(candidate.id);
    }
  }
  private ready(s: HubSubmission): boolean {
    return (!s.eligibleAt || Date.parse(s.eligibleAt) <= this.now()) && (!this.deadlines.has(s.id) || this.deadlines.get(s.id)! <= this.monotonic());
  }
  private rememberDeadline(s: HubSubmission): void {
    if (s.eligibleAt) this.deadlines.set(s.id, this.monotonic() + Math.max(0, Date.parse(s.eligibleAt) - this.now()));
    else this.deadlines.delete(s.id);
  }
  private async promoteReady(): Promise<void> {
    const ready = Object.values(this.snapshot.submissions).filter((s) => s.state === "waiting" && s.desiredAction === "execute" && this.ready(s));
    if (!ready.length) return;
    await this.commit((next) => { for (const item of ready) { const s = next.submissions[item.id]!; s.state = "queued"; s.queueSequence = ++next.sequence; } });
  }
  private async blockLaunch(id: string, reason: string): Promise<void> {
    await this.commit((next) => { const s = next.submissions[id]!; s.state = "blocked"; s.blocker = reason.slice(0, 1024); });
  }
  private async signalStop(id: string): Promise<void> {
    const s = this.get(id);
    if (!s.launch?.stopReason || !s.launch.stopCommandId) return;
    try { await this.driver.stop(copy(s.launch), copy(s), s.launch.stopReason, s.launch.stopCommandId); }
    catch (error) { await this.blockLaunch(id, `stop request failed; reservation retained: ${message(error)}`); }
  }
  private retryAllowed(s: HubSubmission): boolean {
    return s.retry.automatic && s.automaticResumes < s.retry.maxAutomaticResumes && s.failureRepeats < 3 && (!s.retryStartedAt || this.now() < Date.parse(s.retryStartedAt) + s.retry.maxElapsedMs);
  }
  private async settle(id: string, observation?: HubObservation): Promise<void> {
    const before = this.get(id);
    // The driver reconciles input it changed for this launch (a plugin update) before the record settles.
    let inputUpdate: { bundlePath: string; bundleDigest: string } | undefined;
    let inputFailure: string | undefined;
    if (this.driver.settleInput) {
      try {
        inputUpdate = await this.driver.settleInput(copy(before.launch!), copy(before));
        if (inputUpdate !== undefined && !validPluginBundle(inputUpdate)) throw new Error("driver returned an invalid plugin bundle");
      } catch (error) { inputUpdate = undefined; inputFailure = `plugin reconciliation failed: ${message(error)}`.slice(0, 1024); }
    }
    const cursor = await this.store.journal(before, { commandId: `launch:${before.launch!.id}`, digest: digest(before.launch), acceptedAt: this.stamp(), event: "settled", launch: before.launch!, ...(observation ? { observation } : {}) });
    await this.commit((next) => {
      const s = next.submissions[id]!;
      const launch = s.launch!;
      const launchFailure = launch.failure?.message;
      s.journalBytes = cursor;
      delete s.launch;
      delete s.blocker;
      s.updatedAt = this.stamp();
      if (observation) s.observation = observation;
      if (inputUpdate) { s.input.bundlePath = inputUpdate.bundlePath; s.input.bundleDigest = inputUpdate.bundleDigest; }
      if (s.desiredAction !== "execute") { s.state = s.desiredAction === "hold" ? "paused" : "canceled"; return; }
      // An unreconciled plugin input admits no further launch, not even an already accepted resume; only a completed run ignores it.
      if (inputFailure && !(observation?.continuation?.kind === "complete" && observation.status === "succeeded")) {
        delete s.pendingCommand; s.state = "blocked"; s.blocker = inputFailure; return;
      }
      if (s.pendingCommand?.kind === "resume") { s.state = "queued"; s.queueSequence = ++next.sequence; return; }
      if (launch.phase !== "granted" && launchFailure) { s.state = "blocked"; s.blocker = launchFailure; return; }
      if (launch.phase !== "granted") { s.state = "queued"; s.queueSequence = ++next.sequence; return; }
      const continuation = observation?.continuation;
      if (continuation?.kind === "complete" && observation?.status === "succeeded") { s.state = "succeeded"; return; }
      if (continuation?.kind === "terminal") { s.state = "failed"; s.blocker = continuation.cause; return; }
      const interruptionId = launch.stopReason === "service-interruption" ? launch.stopCommandId : launch.command?.kind === "service-interruption" ? launch.command.id : undefined;
      if (interruptionId && launch.mode !== "reconcile" && continuation?.kind === "operator" && continuation.cause === "reconciliation") {
        s.state = "queued"; s.queueSequence = ++next.sequence; s.reconciliationPending = true;
        s.pendingCommand = { id: interruptionId, kind: "service-interruption", acceptedAt: this.stamp() };
        delete s.automaticPending;
        return;
      }
      if (continuation?.kind === "operator") { s.state = "blocked"; s.blocker = observation?.blocker ?? continuation.cause; return; }
      const planned = interruptionId && continuation?.kind === "automatic" && continuation.cause === "service-interruption" && continuation.interruptionCommandId === interruptionId;
      if (planned) {
        s.state = "queued"; s.queueSequence = ++next.sequence;
        if (launch.mode === "reconcile") delete s.reconciliationPending; else s.reconciliationPending = true;
        s.pendingCommand = { id: interruptionId, kind: "service-interruption", acceptedAt: this.stamp() };
        delete s.automaticPending;
        return;
      }
      if (!continuation || continuation.kind !== "automatic" || continuation.cause === "service-interruption") {
        // Read-only inspection cannot establish crash safety. Reconciliation stays inside a slot.
        if (!observation) {
          s.reconciliationPending = true;
          this.scheduleRetry(s, { kind: "automatic", cause: "controller-crash", fingerprint: `unobserved:${s.runId}`, stateRevision: s.observation?.stateRevision ?? 0 }, observation);
        } else { s.state = "blocked"; s.blocker = "owning controller did not authorize automatic continuation"; }
        return;
      }
      this.scheduleRetry(s, continuation, observation);
    });
    this.rememberDeadline(this.get(id));
  }
  private scheduleRetry(s: HubSubmission, continuation: Extract<HubContinuation, { kind: "automatic" }>, observation?: HubObservation): void {
    if (observation && observation.progressRevision > s.progressRevision) { s.failureRepeats = 0; delete s.failureFingerprint; s.progressRevision = observation.progressRevision; }
    s.failureRepeats = s.failureFingerprint === continuation.fingerprint ? s.failureRepeats + 1 : 1;
    s.failureFingerprint = continuation.fingerprint;
    s.retryStartedAt ??= this.stamp();
    if (!this.retryAllowed(s)) { s.state = "blocked"; s.blocker = "automatic retry allowance, repeated fingerprint, or elapsed deadline exhausted"; return; }
    const delay = Math.min(s.retry.maxDelayMs, s.retry.baseDelayMs * 2 ** Math.min(s.automaticResumes, 30));
    const jitter = delay * Math.min(1, Math.max(0, this.random())) * 0.2;
    const notBefore = continuation.notBefore ? Date.parse(continuation.notBefore) : 0;
    const eligible = Math.max(this.now() + delay + jitter, notBefore + (notBefore ? 1000 + 1000 * Math.max(0, Math.min(1, this.random())) : 0));
    if (eligible >= Date.parse(s.retryStartedAt) + s.retry.maxElapsedMs) { s.state = "blocked"; s.blocker = "continuation time exceeds the retry deadline"; return; }
    s.eligibleAt = new Date(eligible).toISOString();
    s.state = "waiting";
    s.automaticPending = true;
  }
  private async launch(id: string): Promise<void> {
    await this.commit((next) => {
      const s = next.submissions[id]!;
      const failureDriven = s.automaticPending === true;
      const automatic = failureDriven || s.pendingCommand?.kind === "service-interruption";
      // An explicit resume must carry its one-use remedy to normal controller admission.
      // The controller still reconciles existing effects before applying that remedy.
      const mode = incompleteInitialization(s) ? "initial" : s.reconciliationPending ? s.pendingCommand?.kind === "resume" ? "resume" : "reconcile" : s.observation ? "resume" : "initial";
      s.generation++;
      s.launch = {
        id: `l-${randomUUID()}`, generation: s.generation, mode,
        phase: "reserved", reservedAt: this.stamp(), automatic,
        ...(s.pendingCommand ? { command: s.pendingCommand } : {}),
        ...(automatic && s.observation?.continuation?.kind === "automatic" ? { continuationFingerprint: s.observation.continuation.fingerprint } : automatic && s.failureFingerprint ? { continuationFingerprint: s.failureFingerprint } : {}),
      };
      if (failureDriven) s.automaticResumes++;
      delete s.pendingCommand; delete s.automaticPending; delete s.reconciliationPending; delete s.eligibleAt;
      s.state = "starting";
    });
    this.deadlines.delete(id);
    try {
      let s = this.get(id);
      const identity = await this.driver.prepare(copy(s.launch!), copy(s));
      if (!identity.bootId || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^\d+$/.test(identity.startTime)) throw new Error("driver returned invalid Linux process identity");
      await this.commit((next) => { const launch = next.submissions[id]!.launch!; launch.identity = identity; launch.phase = "prepared"; });
      await this.commit((next) => { const launch = next.submissions[id]!.launch!; launch.phase = "granted"; launch.grantedAt = this.stamp(); });
      s = this.get(id);
      await this.driver.grant(copy(s.launch!), copy(s));
      await this.commit((next) => { next.submissions[id]!.state = "running"; });
    } catch (error) {
      // No speculative replacement: even a rejected spawn can have created descendants.
      if (!this.fault) await this.commit((next) => {
        const s = next.submissions[id]!;
        const reason = `launch failed; containment must be reconciled: ${message(error)}`.slice(0, 1024);
        s.launch!.failure = { occurredAt: this.stamp(), message: reason };
        s.state = "blocked";
        s.blocker = reason;
      });
    }
  }
  async close(options: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.closing = true;
    try {
      await this.enqueue(async () => {
        for (const item of Object.values(this.snapshot.submissions)) {
          if (!item.launch || item.launch.stopReason) continue;
          const commandId = randomUUID();
          await this.commit((next) => {
            const s = next.submissions[item.id]!;
            s.launch!.stopReason = "service-interruption"; s.launch!.stopCommandId = commandId; s.launch!.stopRequestedAt = this.stamp(); s.state = "stopping";
          });
          await this.signalStop(item.id);
        }
      });
      const until = performance.now() + (options.graceMs ?? this.snapshot.config.shutdownGraceMs);
      while (this.occupied() && performance.now() < until && !this.fault) { await this.tick(); await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, until - performance.now())))); }
      for (const s of Object.values(this.snapshot.submissions)) if (s.launch) {
        try { await this.driver.kill(copy(s.launch), copy(s)); } catch { /* Reservation persists for restart reconciliation. */ }
      }
      if (!this.fault) await this.tick();
    } finally {
      await this.driver.close?.();
      this.closed = true;
      await this.release();
    }
  }
}

function bounded(value: unknown, label: string, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || value.includes("\0")) throw new Error(`invalid ${label}`);
}
function validateSubmit(request: HubSubmitRequest): void {
  if (!/^[a-f0-9]{64}$/.test(request.requestDigest)) throw new Error("requestDigest must be SHA-256");
  if (request.key !== undefined) bounded(request.key, "idempotency key", 256);
  if (!request.input || typeof request.input !== "object") throw new Error("submission input is required");
  bounded(request.input.task, "task bytes", 2 * 1024 * 1024);
  if (request.input.config !== undefined) bounded(request.input.config, "config bytes", 2 * 1024 * 1024);
  for (const key of ["taskPath", "repoPath", "bundlePath", "runtimePath"] as const) {
    bounded(request.input[key], key, 1024);
    if (!path.isAbsolute(request.input[key])) throw new Error(`${key} must be absolute`);
  }
  if (request.input.pluginLink !== undefined) {
    bounded(request.input.pluginLink, "pluginLink", 1024);
    if (!path.isAbsolute(request.input.pluginLink)) throw new Error("pluginLink must be absolute");
  }
  for (const key of ["baseCommit", "bundleDigest", "runtimeDigest"] as const) bounded(request.input[key], key, 256);
  const { task: _task, config: _config, ...metadata } = request.input;
  if (Buffer.byteLength(JSON.stringify(metadata)) > 4096) throw new Error("submission metadata exceeds 4 KiB");
}
function validateRemedy(remedy: HubResumeRemedy | undefined): void {
  if (!remedy) return;
  if (typeof remedy !== "object" || Array.isArray(remedy) || Buffer.byteLength(JSON.stringify(remedy)) > 2048) throw new Error("resume remedy exceeds its 2 KiB bound");
  const booleanKeys = new Set(["reconciled", "updateExecutors", "updatePlugin", "upgrade"]);
  const stringKeys = new Set(["approve", "decline", "supervisor", "reason"]);
  for (const [key, value] of Object.entries(remedy)) {
    if (booleanKeys.has(key) && typeof value === "boolean") continue;
    if (stringKeys.has(key) && typeof value === "string" && value.length > 0) continue;
    if (key === "inputs" && value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string")) continue;
    if (key === "plugin" && validPluginBundle(value)) continue;
    throw new Error(`unknown or invalid resume remedy ${key}`);
  }
  if (remedy.approve && remedy.decline) throw new Error("cannot approve and decline the same resume");
  if (remedy.plugin && remedy.updatePlugin !== true) throw new Error("a resume plugin bundle needs updatePlugin");
}
function validPluginBundle(value: unknown): value is { bundlePath: string; bundleDigest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 2 && entries.every(([key, item]) => (key === "bundlePath" || key === "bundleDigest") && typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 1024 && !item.includes("\0"))
    && path.isAbsolute((value as { bundlePath: string }).bundlePath);
}
function validObservation(observation: HubObservation): boolean {
  if (observation.protocolVersion !== 1 || !Number.isSafeInteger(observation.stateRevision) || observation.stateRevision < 0 || !Number.isSafeInteger(observation.progressRevision) || observation.progressRevision < 0 || !Number.isFinite(Date.parse(observation.observedAt)) || typeof observation.status !== "string" || Buffer.byteLength(JSON.stringify(observation)) > 4096) return false;
  const c = observation.continuation;
  if (!c) return true;
  if (c.kind === "complete") return observation.status === "succeeded";
  if (c.kind === "terminal") return ["failed", "initialization-failed"].includes(c.cause);
  if (c.kind === "operator") return operatorCauses.has(c.cause) && Array.isArray(c.evidenceRefs) && c.evidenceRefs.every((e) => typeof e === "string");
  if (c.kind === "automatic" && c.cause === "initialization-failed" && (observation.status !== "initialization-failed" || observation.stateRevision !== 0 || observation.progressRevision !== 0)) return false;
  return c.kind === "automatic" && automaticCauses.has(c.cause) && typeof c.fingerprint === "string" && c.fingerprint.length > 0 && c.fingerprint.length <= 512 && c.stateRevision === observation.stateRevision && (!c.notBefore || Number.isFinite(Date.parse(c.notBefore)));
}

/** Used under the controller lock immediately before managed side effects. */
export async function assertHubGrant(directory: string, grant: { hubId: string; submissionId: string; runId: string; generation: number; launchId: string }, options: { allowStopping?: boolean } = {}): Promise<void> {
  const snapshot = await new HubStore(directory).load();
  const s = snapshot?.submissions[grant.submissionId];
  if (!s || s.hubId !== grant.hubId || s.runId !== grant.runId || s.launch?.id !== grant.launchId || s.launch.generation !== grant.generation || s.launch.phase !== "granted" || (!options.allowStopping && (s.desiredAction !== "execute" || s.launch.stopRequestedAt))) throw new Error("managed launch grant is absent, stale, or withdrawn");
  // Reading the captured files here also rejects removed/corrupt intake directories.
  await readFile(s.input.taskFile);
}

function canonicalDigest(value: unknown): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
    return v;
  };
  return digest(ordered(value));
}
