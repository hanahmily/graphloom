// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { scopeNotes } from "./assignment.js";
import type { CodingSessionOptions } from "./harness.js";

const base: CodingSessionOptions = { cwd: "/w", readOnly: false, tools: [], reserveModelCall: async () => true };

describe("scope notes", () => {
  it("tells the agent which paths it must not change", () => {
    expect(scopeNotes({ ...base, writeScope: [".", "!api/proto", "!go.mod"] })).toEqual([
      "You may change files anywhere in the worktree, except these, which you must not change: api/proto, go.mod.",
    ]);
    expect(scopeNotes({ ...base, writeScope: ["pkg", "!pkg/gen"] })).toEqual([
      "Change only these paths: pkg, except these, which you must not change: pkg/gen.",
    ]);
    expect(scopeNotes({ ...base, writeScope: [".", "!generated", "+generated/licenses"] })).toEqual([
      "You may change files anywhere in the worktree, except these, which you must not change: generated. Inside them you may still change: generated/licenses.",
    ]);
    expect(scopeNotes({ ...base, writeScope: ["notes.md"] })).toEqual(["Change only these paths: notes.md."]);
  });

  it("says a read-only job's shell is allowed only when the sandbox enforces read-only", () => {
    expect(scopeNotes({ ...base, readOnly: true })).toEqual(["This job is read-only: do not change files in the worktree."]);
    const [note] = scopeNotes({ ...base, readOnly: true, readOnlySandboxed: true });
    expect(note).toContain("do not change files in the worktree");
    expect(note).toContain("git show <rev>:<path>");
    expect(note).toContain("mounted read-only");
  });
});
