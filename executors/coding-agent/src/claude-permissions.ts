// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { lstat } from "node:fs/promises";
import path from "node:path";
import { writeScopeAllows } from "@graphloom/sdk";
import type { CodingSessionOptions } from "./harness.js";

type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Claude tool admission; arbitrary shell commands still require an unrestricted writer. */
export async function evaluateClaudePermission(
  toolName: unknown,
  input: unknown,
  options: CodingSessionOptions,
): Promise<PermissionDecision> {
  const deny = (message: string): PermissionDecision => ({ behavior: "deny", message });
  if (typeof toolName !== "string" || input === null || typeof input !== "object" || Array.isArray(input)) {
    return deny("Invalid tool request");
  }
  const record = input as Record<string, unknown>;
  const allow = (): PermissionDecision => ({ behavior: "allow", updatedInput: record });
  if (["Read", "Grep", "Glob", "StructuredOutput"].includes(toolName)) return allow();
  if (toolName === "Agent" || toolName === "Task") {
    // Delegation does not expand authority: each subagent tool request uses this same policy.
    return typeof record.prompt === "string" && record.prompt.trim().length > 0
      ? allow()
      : deny("Subagent prompt is required");
  }
  if (toolName.startsWith("mcp__graphloom__")) {
    const name = toolName.slice("mcp__graphloom__".length);
    const tool = options.tools.find((candidate) => candidate.name === name);
    if (!tool) return deny("Tool is not admitted for this job");
    if (options.readOnly && tool.effect !== "read") return deny("Read-only jobs cannot invoke write tools");
    return allow();
  }
  if (toolName === "Bash") {
    if (typeof record.command !== "string" || record.command.trim().length === 0) return deny("Shell command is required");
    return options.readOnly ? deny("Read-only jobs cannot execute shell commands") : allow();
  }
  const field = toolName === "NotebookEdit" ? "notebook_path"
    : ["Write", "Edit", "MultiEdit"].includes(toolName) ? "file_path" : undefined;
  if (field === undefined) return deny("Unknown tool is not admitted");
  if (options.readOnly) return deny("Read-only jobs cannot edit files");
  const requested = record[field];
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    return deny("File path is required");
  }
  const root = path.resolve(options.cwd);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return deny("File path is outside the job workspace");
  }
  if (relative.split(path.sep).includes(".git")) return deny("Git metadata cannot be edited");
  if (!writeScopeAllows(relative.split(path.sep).join("/"), options.writeScope ?? [])) {
    return deny("File path is outside the admitted write scope");
  }
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return deny("Symbolic links cannot be edited or traversed");
      if (stat.isFile() && stat.nlink > 1) return deny("Hard-linked files cannot be edited");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return deny("File path cannot be inspected safely");
    }
  }
  return allow();
}
