// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfile, ProfileError } from "../src/kit/profile.js";
import { BANYANDB, root } from "./support.js";

const design = (over: Record<string, unknown>) => parseProfile({ ...BANYANDB, ...over }, "pr-design-review");
const refusal = (over: Record<string, unknown>): string => {
  try {
    design(over);
  } catch (err) {
    if (err instanceof ProfileError) return err.message;
    throw err;
  }
  return "accepted";
};
/** pr-review's own shipped profile, which holds the round-2 keys too. */
const PR_REVIEW = JSON.parse(readFileSync(path.join(root, "..", "pr-review", "profiles", "banyandb.json"), "utf8")) as Record<string, unknown>;

describe("the design review's profile parser (design-pr-review-split §7.2)", () => {
  it("reads the shipped profile: static metrics only, no note by default", () => {
    const p = design({});
    expect(p.metrics).toMatchObject({ staticOnly: true, coverage: false, mutation: { enabled: false } });
    expect(p.comments).toEqual({ designPassedNote: false });
  });

  it("accepts pr-review's keys unread, so one profile serves both graphs", () => {
    const shared = { ...PR_REVIEW, review: { repro: { enabled: "not even a boolean" } }, rules: "anything", checks: 42, comments: { minSeverity: "P2", nits: true, maxComments: 10, suggestions: false } };
    const p = parseProfile(shared, "pr-design-review");
    // Unread: the sandbox, coverage and the reviewers' harnesses change nothing here.
    expect(p.metrics.coverage).toBe(false);
    expect(p.metrics.sandbox).toBeUndefined();
    expect(p.questions.similarity).toBe(0.5);
    expect(parseProfile({ ...BANYANDB, questions: { ...(BANYANDB.questions as object), similarity: "high", maxCandidates: -1 } }, "pr-design-review").questions.maxCandidates).toBe(5);
    expect(parseProfile({ ...BANYANDB, harnesses: { ...(BANYANDB.harnesses as object), "reviewer-security": "codex", "verifier-security": "codex" } }, "pr-design-review").roles.answerer).toBe("claude-code");
  });

  it("refuses rounds, naming the two graphs", () => {
    for (const rounds of ["both", "review-only"]) expect(refusal({ rounds })).toBe("pr-design-review profile: rounds is gone: a run of pr-design-review is round 1 (the design review) and a run of pr-review is round 2 (the PR review); drop rounds and run the graph you want (review-only meant: run pr-review)");
  });

  it("refuses comments.questions and any key neither graph reads", () => {
    expect(refusal({ comments: { questions: true } })).toContain("comments.questions is not a field");
    expect(refusal({ comments: { colour: "blue" } })).toContain("comments.colour is not a field");
    expect(refusal({ surprise: 1 })).toContain("pr-design-review profile: surprise is not a field");
    expect(refusal({ metrics: { coverage: true, typescript: { files: ["**/*.ts"] }, nonsense: 1 } })).toContain("metrics.nonsense is not a field");
    expect(refusal({ harnesses: { reviewer: "codex" } })).toContain("harnesses.reviewer is not a role");
  });

  it("reads comments.designPassedNote and comments.footer", () => {
    expect(design({ comments: { designPassedNote: true, footer: "Reviewed by GraphLoom." } }).comments).toEqual({ designPassedNote: true, footer: "Reviewed by GraphLoom." });
    expect(refusal({ comments: { designPassedNote: "yes" } })).toContain("comments.designPassedNote must be true or false");
    expect(refusal({ comments: { footer: "<!-- graphloom-design-review: x -->" } })).toContain("comments.footer must be text");
  });

  it("pr-review 1.x's parser refuses rounds too and accepts this graph's keys unread", () => {
    expect(() => parseProfile({ ...PR_REVIEW, rounds: "review-only" })).toThrow("rounds is gone");
    expect(parseProfile({ ...PR_REVIEW, comments: { designPassedNote: true } }).comments).toEqual({ designPassedNote: false });
    expect(parseProfile(PR_REVIEW).metrics.staticOnly).toBeUndefined();
  });
});
