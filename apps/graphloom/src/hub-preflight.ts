// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `hub submit`'s preflight (docs/design-run-hub.md §3.3): before it queues a
 * submission, the hub runs the doctor for the task in its own environment, the
 * one the run will inherit, and refuses the submission when a check the run
 * needs fails. Warnings never refuse. A rehearsal needs less: its agents,
 * supervisor and (unless `--commands run`) commands are stand-ins, so only the
 * host checks and the task's plugin count, and the task's environment checks
 * with `--commands run`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HubRehearsal } from "@graphloom/sdk";
import type { DoctorCheck, DoctorReport } from "./doctor.js";

export interface PreflightVerdict {
  /** The failing checks this submission needs: any one refuses it. */
  failures: DoctorCheck[];
  /** The warnings among the checks it needs: reported, never refusing. */
  warnings: DoctorCheck[];
  /** Failing checks a rehearsal does not need (its stand-ins replace what they check). */
  ignored: DoctorCheck[];
}

/** Whether a rehearsal needs this check: the host's, the task's plugin, and its environment checks when commands run for real. */
export function rehearsalNeeds(check: DoctorCheck, rehearsal: HubRehearsal): boolean {
  if (check.section === "host") return true;
  if (check.section !== "task") return false;
  if (check.name === "plugin") return true;
  return check.name.startsWith("environment ") && rehearsal.commands === "run";
}

/** The preflight's verdict on the hub's doctor report for a submission (a rehearsal when `rehearsal` is given). */
export function preflightVerdict(report: DoctorReport, rehearsal?: HubRehearsal): PreflightVerdict {
  const needed = (check: DoctorCheck) => rehearsal === undefined || rehearsalNeeds(check, rehearsal);
  return {
    failures: report.checks.filter((check) => check.status === "fail" && needed(check)),
    warnings: report.checks.filter((check) => check.status === "warn" && needed(check)),
    ignored: report.checks.filter((check) => check.status === "fail" && !needed(check)),
  };
}

/** The refusal a failing preflight answers with: each failing check and its fix, then how to see all or skip it. */
export function preflightRefusal(verdict: PreflightVerdict, taskPath: string, rehearsal: boolean): string {
  const one = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
  const failures = verdict.failures.slice(0, 6);
  return [
    `preflight refused the ${rehearsal ? "rehearsal " : ""}submission: ${verdict.failures.length} check${verdict.failures.length === 1 ? "" : "s"} the run needs fail${verdict.failures.length === 1 ? "s" : ""} in the hub's environment (nothing was queued)`,
    ...failures.flatMap((check) => [`  fail  ${check.name}: ${one(check.detail)}`, ...(check.fix !== undefined ? [`        fix: ${one(check.fix)}`] : [])]),
    ...(verdict.failures.length > failures.length ? [`  ... ${verdict.failures.length - failures.length} more`] : []),
    `Every check: graphloom hub doctor --task ${taskPath}. A tool or variable the service lacks: graphloom hub service --capture-env (--token-env-file for tokens), then restart the service. --no-preflight submits anyway.`,
  ].join("\n");
}

/** One line for a passing preflight: the warnings it saw, by name. */
export function preflightNote(verdict: PreflightVerdict, cached: boolean): string {
  const warned = verdict.warnings.map((check) => check.name);
  return `preflight: passed in the hub's environment${cached ? " (cached)" : ""}${warned.length ? `; warnings: ${warned.join(", ")} (graphloom hub doctor --task shows them)` : ""}${verdict.ignored.length ? `; not needed by a rehearsal: ${verdict.ignored.map((check) => check.name).join(", ")}` : ""}`;
}

/**
 * Passing preflights for a short time, keyed by the task's bytes, the rehearsal
 * mode and the hub's environment fingerprint, so resubmitting the same task is
 * fast. A failure is never remembered: the operator fixes it and submits again.
 */
export class PreflightCache {
  private readonly passed = new Map<string, { expires: number; verdict: PreflightVerdict }>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  /** The key of a task (read now) under a mode and an environment fingerprint; undefined when the task cannot be read. */
  async key(taskPath: string, rehearsal: HubRehearsal | undefined, fingerprint: string): Promise<string | undefined> {
    let bytes: Buffer;
    try { bytes = await readFile(taskPath); } catch { return undefined; }
    return createHash("sha256").update(JSON.stringify([taskPath, createHash("sha256").update(bytes).digest("hex"), rehearsal === undefined ? "run" : `rehearsal:${rehearsal.commands ?? "stub"}`, fingerprint])).digest("hex");
  }
  get(key: string): PreflightVerdict | undefined {
    const entry = this.passed.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= this.now()) { this.passed.delete(key); return undefined; }
    return entry.verdict;
  }
  remember(key: string, verdict: PreflightVerdict): void {
    if (verdict.failures.length > 0) return;
    for (const [old, entry] of this.passed) if (entry.expires <= this.now()) this.passed.delete(old);
    if (this.passed.size >= 256) this.passed.delete(this.passed.keys().next().value!);
    this.passed.set(key, { expires: this.now() + this.ttlMs, verdict });
  }
}

/**
 * The hub environment's fingerprint for the cache: its variables and the
 * runner and supervisor config files the doctor reads. In memory only.
 */
export async function environmentFingerprint(env: NodeJS.ProcessEnv, files: Array<string | undefined>): Promise<string> {
  const hash = createHash("sha256");
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`${name}=${value ?? ""}\0`);
  for (const file of files) {
    if (file === undefined) continue;
    hash.update(`${file}\0`);
    hash.update(await readFile(file).catch(() => Buffer.from("\0missing")));
  }
  return hash.digest("hex");
}
