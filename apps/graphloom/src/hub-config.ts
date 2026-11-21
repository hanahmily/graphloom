// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubConfig } from "@graphloom/sdk";

export interface HubServiceConfig extends HubConfig {
  directory: string;
  socket: string;
  cgroupRoot: string;
  runnerConfig?: string;
  supervisorConfig?: string;
}

export function hubPaths(env: NodeJS.ProcessEnv = process.env): { directory: string; socket: string; config: string } {
  const home = env.HOME ?? os.homedir();
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return {
    directory: path.resolve(env.GRAPHLOOM_HUB_STATE || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "graphloom", "hub")),
    socket: path.resolve(env.GRAPHLOOM_HUB_SOCKET || path.join(runtime, "graphloom", "hub.sock")),
    config: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "graphloom", "hub.json"),
  };
}

export async function loadHubConfig(file?: string, env: NodeJS.ProcessEnv = process.env): Promise<HubServiceConfig> {
  const defaults = hubPaths(env);
  const source = path.resolve(file ?? defaults.config);
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(source, "utf8")); }
  catch (error) { if (file !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = object(raw, "hub configuration");
  const allowed = new Set(["maxConcurrentRuns", "retry", "pollIntervalMs", "shutdownGraceMs", "directory", "socket", "cgroupRoot", "runnerConfig", "supervisorConfig"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown hub configuration field: ${key}`);
  const retry = object(value.retry ?? {}, "hub retry policy");
  for (const key of Object.keys(retry)) if (!["automatic", "maxAutomaticResumes", "maxElapsedMs", "baseDelayMs", "maxDelayMs"].includes(key)) throw new Error(`unknown hub retry field: ${key}`);
  if (retry.automatic !== undefined && typeof retry.automatic !== "boolean") throw new Error("retry.automatic must be boolean");
  const resolve = (v: unknown, fallback?: string): string => {
    if (v === undefined && fallback !== undefined) return fallback;
    if (typeof v !== "string" || !v || v.includes("\0")) throw new Error("hub paths must be nonempty strings");
    return path.resolve(path.dirname(source), v);
  };
  const config: HubServiceConfig = {
    maxConcurrentRuns: integer(value.maxConcurrentRuns ?? 2, "maxConcurrentRuns", 0, 1024),
    retry: {
      automatic: retry.automatic !== false,
      maxAutomaticResumes: integer(retry.maxAutomaticResumes ?? 5, "maxAutomaticResumes", 0, 10_000),
      maxElapsedMs: integer(retry.maxElapsedMs ?? 86_400_000, "maxElapsedMs", 1, Number.MAX_SAFE_INTEGER),
      baseDelayMs: integer(retry.baseDelayMs ?? 30_000, "baseDelayMs", 1, 86_400_000),
      maxDelayMs: integer(retry.maxDelayMs ?? 1_800_000, "maxDelayMs", 1, 86_400_000),
    },
    pollIntervalMs: integer(value.pollIntervalMs ?? 5000, "pollIntervalMs", 100, 60_000),
    shutdownGraceMs: integer(value.shutdownGraceMs ?? 60_000, "shutdownGraceMs", 100, 3_600_000),
    directory: resolve(value.directory, defaults.directory),
    socket: resolve(value.socket, defaults.socket),
    cgroupRoot: resolve(value.cgroupRoot, await currentCgroup()),
    ...(value.runnerConfig !== undefined ? { runnerConfig: resolve(value.runnerConfig) } : {}),
    ...(value.supervisorConfig !== undefined ? { supervisorConfig: resolve(value.supervisorConfig) } : {}),
  };
  if (config.retry.maxDelayMs < config.retry.baseDelayMs) throw new Error("maxDelayMs must be at least baseDelayMs");
  if (Buffer.byteLength(config.socket) > 100) throw new Error("hub socket path exceeds 100 bytes; choose a shorter socket path");
  return config;
}

async function currentCgroup(): Promise<string> {
  const line = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find((v) => v.startsWith("0::"));
  if (line === undefined) throw new Error("the hub needs Linux cgroup v2 and a delegated subtree");
  return path.join("/sys/fs/cgroup", line.slice(3));
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}
