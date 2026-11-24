// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { lstat, open, readlink, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { parseTaskYaml, readInstalledBundlePin, type IntakePin } from "@graphloom/controller";
import { digestExecutorSource } from "@graphloom/runner";
import type { HubLaunch, HubStoredInput, HubSubmission } from "@graphloom/sdk";
import { boundedText } from "./hub-input.js";

/**
 * A hub run reads its plugin through a private link, `submissions/<s>/plugins/<graph>`,
 * which the controller pins as the bundle path. The link names the bundle recorded in
 * the submission's input; only an accepted `--update-plugin` moves it
 * (docs/design-run-hub.md §4.2).
 */
export interface PluginBundle { bundlePath: string; bundleDigest: string }

async function capturedGraph(input: HubStoredInput): Promise<string> {
  return parseTaskYaml(await boundedText(input.taskFile, 256 * 1024)).graph;
}

/** The operator's task's plugin link, unresolved; older submissions did not record it. */
export function operatorPluginLink(input: HubStoredInput, graph: string): string {
  return input.pluginLink ?? path.join(path.dirname(input.taskPath), "plugins", graph);
}

function privatePluginLink(input: HubStoredInput, graph: string): string {
  return path.join(path.dirname(input.taskFile), "plugins", graph);
}

/**
 * Resolves the plugin the operator's task names now, for a hub `--update-plugin`.
 * Refuses, with the reason, a link that is gone, points nowhere, or names no bundle
 * of this graph; the controller's plugin-update rules still apply at the resume.
 */
export async function resolveOperatorPlugin(submission: Pick<HubSubmission, "input">): Promise<PluginBundle> {
  const { input } = submission;
  const graph = await capturedGraph(input);
  const link = operatorPluginLink(input, graph);
  const fix = `point it at the installed plugin (for example ~/.local/share/graphloom/versions/<version>/examples/plugins/${graph}), then resume again`;
  try { await lstat(link); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`--update-plugin: the task's plugin link ${link} is gone; ${fix}`);
    throw error;
  }
  let target: string;
  try { target = await realpath(link); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const named = await readlink(link).catch(() => undefined);
    throw new Error(`--update-plugin: the task's plugin link ${link} points nowhere${named !== undefined ? ` (${named})` : ""}; ${fix}`);
  }
  if (!(await stat(target)).isDirectory()) throw new Error(`--update-plugin: the task's plugin link ${link} names ${target}, which is not a plugin bundle directory; ${fix}`);
  let manifest: { graphId?: unknown };
  try { manifest = JSON.parse(await boundedText(path.join(target, "graphloom.manifest.json"), 1024 * 1024)) as { graphId?: unknown }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`--update-plugin: ${target} (the task's plugin link ${link}) has no graphloom.manifest.json; ${fix}`);
    throw new Error(`--update-plugin: cannot read the manifest at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pinned = await manifestGraph(input.bundlePath);
  if (pinned !== undefined && manifest.graphId !== pinned) throw new Error(`--update-plugin: the task's plugin link ${link} names graph ${String(manifest.graphId)}, not this run's ${pinned}; a plugin update keeps the graph`);
  return { bundlePath: target, bundleDigest: await digestExecutorSource(target) };
}

async function manifestGraph(bundle: string): Promise<string | undefined> {
  try {
    const value = (JSON.parse(await boundedText(path.join(bundle, "graphloom.manifest.json"), 1024 * 1024)) as { graphId?: unknown }).graphId;
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

/**
 * Before a launch: an `--update-plugin` resume points the private link at the bundle
 * accepted with it (unchanged since); any other resume keeps the run's pinned bundle.
 */
export async function preparePluginLink(launch: HubLaunch, submission: HubSubmission): Promise<void> {
  if (launch.mode === "initial") return; // The child materializes the link from the recorded input.
  const { input } = submission;
  const link = privatePluginLink(input, await capturedGraph(input));
  if (!await exists(link)) return; // Nothing to align; the controller reports a missing bundle.
  const plugin = launch.command?.remedy?.updatePlugin === true ? launch.command.remedy.plugin : undefined;
  if (plugin !== undefined) {
    if (await digestExecutorSource(plugin.bundlePath).catch(() => undefined) !== plugin.bundleDigest) {
      throw new Error(`the plugin at ${plugin.bundlePath} changed or vanished after hub resume --update-plugin accepted it; resume --update-plugin again`);
    }
    await pointLink(link, plugin.bundlePath);
    return;
  }
  // A plain resume keeps the pin: realign a link an interrupted update left behind.
  if (await resolvedOrUndefined(link) === input.bundlePath) return;
  if (await linkMatchesRunPin(link, submission)) return;
  await pointLink(link, input.bundlePath);
}

/**
 * After a launch drained: when the private link names another bundle than the
 * recorded one, the controller either accepted the update (its pin is the link's
 * manifest: record the new bundle) or refused it (point the link back).
 */
export async function settlePluginLink(_launch: HubLaunch, submission: HubSubmission): Promise<PluginBundle | undefined> {
  const { input } = submission;
  const link = privatePluginLink(input, await capturedGraph(input));
  if (!await exists(link)) return undefined;
  const target = await resolvedOrUndefined(link);
  if (target === input.bundlePath) return undefined;
  if (target !== undefined && await linkMatchesRunPin(link, submission)) {
    return { bundlePath: target, bundleDigest: await digestExecutorSource(target) };
  }
  await pointLink(link, input.bundlePath);
  return undefined;
}

/** True when the bundle at the run's pinned path (the private link) is exactly the run's pin: manifest and entry. */
async function linkMatchesRunPin(link: string, submission: HubSubmission): Promise<boolean> {
  const pinned = await runBundlePin(submission);
  if (pinned === undefined || path.resolve(pinned.bundlePath) !== path.resolve(link)) return false;
  try {
    const installed = await readInstalledBundlePin(pinned);
    return installed.manifestDigest === pinned.manifestDigest && installed.entryDigest === pinned.entryDigest;
  } catch { return false; }
}

async function runBundlePin(submission: HubSubmission): Promise<IntakePin["bundle"] | undefined> {
  const hub = path.dirname(path.dirname(path.dirname(submission.input.taskFile)));
  let state: { runId?: unknown; intake?: { bundle?: IntakePin["bundle"] } };
  try { state = JSON.parse(await boundedText(path.join(hub, "runs", submission.runId, "state.json"), 64 * 1024 * 1024)) as typeof state; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (state.runId !== submission.runId) throw new Error("managed run identity does not match its submission");
  const bundle = state.intake?.bundle;
  return bundle !== undefined && typeof bundle.bundlePath === "string" && typeof bundle.manifestDigest === "string" && typeof bundle.entryDigest === "string" ? bundle : undefined;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function resolvedOrUndefined(link: string): Promise<string | undefined> {
  try { return await realpath(link); }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}

/** Replaces the link atomically and syncs its directory. */
async function pointLink(link: string, target: string): Promise<void> {
  if (!(await lstat(link)).isSymbolicLink()) throw new Error(`hub plugin link is not a symbolic link: ${link}`);
  if (await resolvedOrUndefined(link) === target) return;
  const temporary = `${link}.${randomUUID()}.tmp`;
  try {
    await symlink(target, temporary, "dir");
    await rename(temporary, link);
  } finally { await unlink(temporary).catch(() => undefined); }
  const directory = await open(path.dirname(link), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
