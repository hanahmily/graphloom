// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { PrepareTaskInput, PrepareTaskReply, TaskPlanStep } from "@graphloom/sdk";
import { GRAPH_ID } from "./constants.js";
import { parseProfile, ProfileError } from "./profile.js";

const USAGE = "graphloom task new pr-review <owner/repo#N | https://github.com/owner/repo/pull/N> --profile <name|path> [--base <branch>] [--review] [--repo <clone>]";
const NAME = "[A-Za-z0-9_.-]{1,100}";

/** The pull request an argument names: `owner/repo#N` or its URL. */
export function parsePullArgument(text: string): { owner: string; repo: string; number: number } | undefined {
  const m = new RegExp(`^(?:(${NAME})/(${NAME})#(\\d{1,9})|https://github\\.com/(${NAME})/(${NAME})/pull/(\\d{1,9})/?)$`).exec(text);
  if (m === null) return undefined;
  const number = Number(m[3] ?? m[6]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { owner: (m[1] ?? m[4])!, repo: (m[2] ?? m[5])!, number };
}

/**
 * `graphloom task new pr-review …` (design §3.1): the plan that fetches the
 * pull request's head and its base branch into the graph's own ref namespace,
 * pins the head by sha, and writes the task. Pure over its input: it reads no
 * file, runs no process and has no network; the CLI validates and runs the plan.
 */
export function prepareTask(input: PrepareTaskInput): PrepareTaskReply {
  if (input.profile === undefined) return { refused: `pr-review needs a profile: ${USAGE}` };
  let profile;
  try {
    profile = parseProfile(input.profile);
  } catch (err) {
    if (err instanceof ProfileError) return { refused: `the profile is not usable: ${err.message}` };
    throw err;
  }

  let pull: ReturnType<typeof parsePullArgument>;
  let base = profile.baseBranch;
  let review = false;
  const positional: string[] = [];
  for (let i = 0; i < input.args.length; i += 1) {
    const arg = input.args[i]!;
    if (arg === "--review") {
      review = true;
    } else if (arg === "--base" || arg.startsWith("--base=")) {
      const value = arg === "--base" ? input.args[(i += 1)] : arg.slice("--base=".length);
      if (value === undefined || value === "" || value.startsWith("-")) return { refused: `--base needs a branch name; usage: ${USAGE}` };
      base = value;
    } else if (arg.startsWith("-")) {
      return { refused: `unknown argument ${JSON.stringify(arg)}; usage: ${USAGE}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return { refused: `name exactly one pull request; usage: ${USAGE}` };
  pull = parsePullArgument(positional[0]!);
  if (pull === undefined) return { refused: `${JSON.stringify(positional[0])} is not a pull request: use owner/repo#N or https://github.com/owner/repo/pull/N` };
  const { owner, repo, number } = pull;
  if (`${owner}/${repo}`.toLowerCase() !== profile.project.toLowerCase()) {
    return { refused: `${owner}/${repo} is not this profile's project (${profile.project}); name a pull request of ${profile.project}, or another profile` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes("..") || base.endsWith("/") || base.endsWith(".lock")) {
    return { refused: `${JSON.stringify(base)} is not a branch name` };
  }
  if ([owner, repo].some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return { refused: `${owner}/${repo} cannot name refs (a component starts with . or ends with .lock)` };
  }

  // The repository's remote for the project, else the URL itself.
  const url = new RegExp(`^https://github\\.com/${owner}/${repo}(?:\\.git)?/?$`, "i");
  const remote = input.repo.remotes.find((r) => url.test(r.url))?.name ?? `https://github.com/${owner}/${repo}.git`;

  const R = `refs/graphloom/${GRAPH_ID}/${owner}/${repo}/${number}`;
  const steps: TaskPlanStep[] = [
    { kind: "fetch", remote, refspec: `refs/pull/${number}/head`, intoRef: `${R}/head` },
    { kind: "fetch", remote, refspec: `refs/heads/${base}`, intoRef: `${R}/base` },
    { kind: "resolve", name: "headSha", revParse: `${R}/head` },
    { kind: "updateRef", from: "${headSha}", to: `${R}/heads/\${headSha}` },
    { kind: "resolve", name: "mergeBase", mergeBase: [`${R}/head`, `${R}/base`] },
    {
      kind: "writeTask",
      path: `reviews/${repo}-${number}/task.yaml`,
      fields: { base: "${mergeBase}", request: `${review ? "Review" : "Report"} on ${owner}/${repo}#${number} at \${headSha}.` },
    },
  ];
  return { summary: `${review ? "review" : "report-only review"} of ${owner}/${repo}#${number} against ${base}`, steps };
}
