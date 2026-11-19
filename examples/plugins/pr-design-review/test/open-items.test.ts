// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { Answer } from "../src/answers.js";
import { htmlPagesFrom } from "../src/html.js";
import { recordedNecessityJson } from "../src/kit/parts.js";
import type { Question } from "../src/questions.js";
import { addedOtherRehearsal } from "../src/rehearsal.js";
import { OPEN_ITEMS_LABEL, openItems, recordedRound1 } from "../src/round1.js";
import { BANYANDB, qaOf, simulate } from "./support.js";

// apache/skywalking-banyandb#1485 (run 2baa5d23-ebc): N1 necessary, every required question answered, and two design-level
// `other` questions partially answered. Round 1 had 2 open items and the review said "Changes requested: 2 open", while the
// briefing said "Questions that need the author: 0", in green: it counted only `needs author` answers.
const ADDED = [
  { item: "W1", text: "What aggregation contract should operators use across instances to tell dropped rows from retried observations?" },
  { item: "W1", text: "How should the group label handle nonexistent group names so that its metric cardinality stays bounded?" },
];
const partialOther = (q: Question, _s: unknown, _r: unknown, dflt: Answer): Answer => (q.type === "other" ? { ...dflt, status: "partially answered", answer: "Part of it is settled by the code; the rest is the author's design choice." } : dflt);

describe("the briefing counts round 1's open items, the gate's own (#1485)", () => {
  const sim = simulate({ scenario: addedOtherRehearsal(BANYANDB, ADDED, partialOther), maxSteps: 900, through: "end" });
  const others = qaOf(sim).questions.filter((q) => q.type === "other");
  const r1 = recordedRound1(sim.evidence);
  const issues = r1.state === "read" ? r1.value.issues : [];

  it("has the shape of #1485: two partially answered `other` questions, every other question answered, N1 necessary", () => {
    expect(others.map((q) => q.answer?.status)).toEqual(["partially answered", "partially answered"]);
    expect(qaOf(sim).questions.filter((q) => q.type !== "other" && q.type !== "necessity").every((q) => q.answer?.status === "answered")).toBe(true);
    expect(issues.map((x) => [x.id, x.kinds])).toEqual(others.map((q) => [q.id, ["partial"]]));
  });

  it("review.md says 2, the number round1.json holds and the posted review's first line carries", () => {
    const md = sim.qa!.markdown;
    expect(md).toContain(`- ${OPEN_ITEMS_LABEL}: 2\n`);
    expect(md).not.toContain("Questions that need the author");
    expect(issues).toHaveLength(2);
    for (const q of others) expect(md).toMatch(new RegExp(`^- \\*\\*${q.id} \\[other\\] partially answered\\*\\*`, "m"));
    expect(String(sim.github.creates[0]?.body ?? "").split("\n")[0]).toBe("Changes requested: 2 open");
  });

  it("review.html and review-appendix.html say 2 as well, from the same function", () => {
    const necessity = recordedNecessityJson(sim.evidence);
    const pages = htmlPagesFrom(sim.written!.json, sim.qa!.json, necessity.state === "read" ? necessity.value : undefined)!;
    expect(pages.appendix).toContain(`<span class="label">${OPEN_ITEMS_LABEL}</span> <span class="badge bad">2</span>`);
    expect(pages.appendix).toContain(`<h2>${OPEN_ITEMS_LABEL}</h2> <span class="muted">2 of`);
    expect(pages.review).toContain(`<strong>2</strong><small>${OPEN_ITEMS_LABEL.toLowerCase()}</small>`);
    const files = JSON.parse(sim.written!.json).files as Array<{ path: string; previousPath: string | null }>;
    expect(openItems({ qa: sim.qa!.json, necessity: necessity.state === "read" ? necessity.value : undefined, files })?.map((x) => x.id)).toEqual(issues.map((x) => x.id));
  });
});
