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
    expect(scopeNotes({ ...base, writeScope: ["notes.md"] })).toEqual(["Change only these paths: notes.md."]);
  });
});
