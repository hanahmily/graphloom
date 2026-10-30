// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { writeScopeExceptions, writeScopeExcludes, writeScopeIncludes } from "@graphloom/sdk";
import type { CodingSessionOptions } from "./harness.js";

/** The job's scope as guidance for the agent; the controller observes what actually changed. */
export function scopeNotes(options: CodingSessionOptions): string[] {
  if (options.readOnly) {
    return options.readOnlySandboxed === true
      ? ["This job is read-only: do not change files in the worktree. You may run shell commands (for example git show <rev>:<path> and git grep); the filesystem is mounted read-only, so a write fails."]
      : ["This job is read-only: do not change files in the worktree."];
  }
  if (options.writeScope !== undefined && options.writeScope.length > 0) {
    const includes = writeScopeIncludes(options.writeScope);
    const excludes = writeScopeExcludes(options.writeScope);
    const allowed = includes.includes(".") ? "You may change files anywhere in the worktree" : `Change only these paths: ${includes.join(", ")}`;
    const exceptions = writeScopeExceptions(options.writeScope);
    const except = exceptions.length > 0 ? ` Inside them you may still change: ${exceptions.join(", ")}.` : "";
    return [excludes.length > 0 ? `${allowed}, except these, which you must not change: ${excludes.join(", ")}.${except}` : `${allowed}.`];
  }
  return [];
}

export function bounded(text: string, max = 4_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `resultSchema` may be an inline JSON object schema or just a schema name. */
export function inlineObjectSchema(resultSchema: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(resultSchema);
    if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A schema name.
  }
  return undefined;
}
