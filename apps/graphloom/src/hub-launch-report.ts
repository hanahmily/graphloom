// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { IntakeError, UpgradeRefusedError } from "@graphloom/controller";
import { RequestRefusedError, type HubLaunchReport, type HubRefusalCause } from "@graphloom/sdk";
import { boundedText, writePrivateJsonOrText } from "./hub-input.js";

/** Where a managed launch reports its own end (docs/design-run-hub.md §6.1). */
export function launchReportPath(hubDirectory: string, submissionId: string, launchId: string): string {
  if (!/^s-[a-f0-9-]{36}$/.test(submissionId) || !/^l-[a-f0-9-]{36}$/.test(launchId)) throw new Error("invalid launch report identity");
  return path.join(hubDirectory, "submissions", submissionId, "launches", `${launchId}.json`);
}

/**
 * The structured cause of a refusal, or undefined: an error type that says the
 * request was refused before it changed the run. Never read from message text.
 */
export function refusalOf(error: unknown): { cause: HubRefusalCause; reason: string } | undefined {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
  if (error instanceof RequestRefusedError) return { cause: error.refusal, reason };
  if (error instanceof IntakeError) return { cause: "invalid-task", reason };
  if (error instanceof UpgradeRefusedError) return { cause: "upgrade-refused", reason };
  return undefined;
}

export async function writeLaunchReport(hubDirectory: string, submissionId: string, report: HubLaunchReport): Promise<void> {
  const file = launchReportPath(hubDirectory, submissionId, report.launchId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateJsonOrText(file, JSON.stringify(report));
}

/** A launch's report, or undefined when it wrote none (it was killed) or one that is not valid. */
export async function readLaunchReport(hubDirectory: string, submissionId: string, launch: { id: string; generation: number }): Promise<HubLaunchReport | undefined> {
  let value: unknown;
  try { value = JSON.parse(await boundedText(launchReportPath(hubDirectory, submissionId, launch.id), 8192)); }
  catch { return undefined; }
  return validLaunchReport(value, launch) ? value : undefined;
}

const CAUSES = new Set<string>(["invalid-task", "invalid-scenario", "invalid-remedy", "upgrade-refused"]);
const text = (value: unknown, max: number): boolean => typeof value === "string" && value.length > 0 && value.length <= max;
export function validLaunchReport(value: unknown, launch: { id: string; generation: number }): value is HubLaunchReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Partial<HubLaunchReport>;
  if (report.protocolVersion !== 1 || report.launchId !== launch.id || report.generation !== launch.generation || !text(report.endedAt, 64)) return false;
  if (!["completed", "refused", "error"].includes(String(report.outcome))) return false;
  if (report.outcome === "refused" && !(report.refusal && CAUSES.has(report.refusal.cause) && text(report.refusal.reason, 1024))) return false;
  if (report.error !== undefined && !text(report.error, 1024)) return false;
  if (report.command !== undefined && !(text(report.command.id, 256) && typeof report.command.applied === "boolean")) return false;
  return true;
}
