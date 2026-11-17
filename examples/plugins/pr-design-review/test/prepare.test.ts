// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { validateTaskPlan, type PrepareTaskInput } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { prepareTask } from "../src/prepare.js";
import { requestedPull } from "../src/kit/request.js";
import { parseProfile } from "../src/kit/profile.js";
import { BANYANDB } from "./support.js";

const input = (args: string[]): PrepareTaskInput => ({ args, profile: BANYANDB, repo: { path: "/r", remotes: [{ name: "upstream", url: "https://github.com/apache/skywalking-banyandb.git" }] } }) as unknown as PrepareTaskInput;
const R = "refs/graphloom/pr-design-review/apache/skywalking-banyandb/1234";

describe("graphloom task new pr-design-review (design-pr-review-split §7.1)", () => {
  it("writes refs only under refs/graphloom/pr-design-review/, and its task in its own -design directory", () => {
    const reply = prepareTask(input(["apache/skywalking-banyandb#1234"]));
    if ("refused" in reply) throw new Error(reply.refused);
    expect(reply.steps).toEqual([
      { kind: "fetch", remote: "upstream", refspec: "refs/pull/1234/head", intoRef: `${R}/head` },
      { kind: "fetch", remote: "upstream", refspec: "refs/heads/main", intoRef: `${R}/base` },
      { kind: "resolve", name: "headSha", revParse: `${R}/head` },
      { kind: "updateRef", from: "${headSha}", to: `${R}/heads/\${headSha}` },
      { kind: "resolve", name: "mergeBase", mergeBase: [`${R}/head`, `${R}/base`] },
      { kind: "writeTask", path: "reviews/skywalking-banyandb-1234-design/task.yaml", fields: { base: "${mergeBase}", request: "Design review on apache/skywalking-banyandb#1234 at ${headSha}." } },
    ]);
    const refs = reply.steps.flatMap((s) => [("intoRef" in s ? s.intoRef : undefined), ("to" in s ? s.to : undefined)]).filter((r): r is string => r !== undefined);
    expect(refs.every((r) => r.startsWith("refs/graphloom/pr-design-review/"))).toBe(true);
    expect(() => validateTaskPlan(reply, "pr-design-review")).not.toThrow();
    expect(() => validateTaskPlan(reply, "pr-review")).toThrow();
    expect(reply.summary).toBe("design review of apache/skywalking-banyandb#1234 against main");
  });

  it("asks every question with --all-questions, takes --base and the pull request's URL", () => {
    const reply = prepareTask(input(["https://github.com/apache/skywalking-banyandb/pull/1234", "--base", "release-0.9", "--all-questions"]));
    if ("refused" in reply) throw new Error(reply.refused);
    expect(reply.steps[1]).toMatchObject({ refspec: "refs/heads/release-0.9" });
    expect(reply.steps.at(-1)).toMatchObject({ fields: { request: "Design review on apache/skywalking-banyandb#1234 at ${headSha}, asking every question." } });
  });

  it("refuses --no-report and --review, and a profile that sets rounds", () => {
    expect(prepareTask(input(["apache/skywalking-banyandb#1234", "--no-report"]))).toEqual({ refused: expect.stringContaining("--no-report is not an option of pr-design-review: it is pr-review's") });
    expect(prepareTask(input(["apache/skywalking-banyandb#1234", "--review"]))).toEqual({ refused: expect.stringContaining("--review is not an option of pr-design-review") });
    expect(prepareTask({ ...input(["apache/skywalking-banyandb#1234"]), profile: { ...BANYANDB, rounds: "both" } } as PrepareTaskInput)).toEqual({ refused: expect.stringContaining("rounds is gone") });
  });

  it("the run reads the request it writes, and refuses pr-review's", () => {
    const profile = parseProfile(BANYANDB, "pr-design-review");
    const head = "a".repeat(40);
    expect(requestedPull(`Design review on apache/skywalking-banyandb#1234 at ${head}, asking every question.`, profile, "pr-design-review")).toEqual({ mode: "review", owner: "apache", repo: "skywalking-banyandb", number: 1234, head, askAll: true });
    expect(requestedPull(`Review on apache/skywalking-banyandb#1234 at ${head}.`, profile, "pr-design-review")).toEqual({ problem: expect.stringContaining("graphloom task new pr-design-review writes it") });
  });
});
