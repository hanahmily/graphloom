// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What `graphloom task new <graph> <pull request> …` shares between the review graphs (design-pr-review-split §7.1): the
 * pull-request argument, the option loop (`--base`, the flags a graph accepts, the flags it refuses with a reason), the checks
 * of the owner, repository and base branch, the remote to fetch from, and the two-phase head plan of design §3.1 under the
 * graph's own ref namespace (`refs/graphloom/<graphId>/<owner>/<repo>/<N>/`). Each graph supplies its id, its usage line, its
 * task directory and its request. Pure over its input: it reads no file, runs no process and has no network.
 */
import type { PrepareTaskInput, PrepareTaskReply, TaskPlanStep } from "@graphloom/sdk";
import { parseProfile, ProfileError, type Profile, type ProfileGraph } from "./profile.js";

const NAME = "[A-Za-z0-9_.-]{1,100}";

/** The pull request an argument names: `owner/repo#N` or its URL. */
export function parsePullArgument(text: string): { owner: string; repo: string; number: number } | undefined {
  const m = new RegExp(`^(?:(${NAME})/(${NAME})#(\\d{1,9})|https://github\\.com/(${NAME})/(${NAME})/pull/(\\d{1,9})/?)$`).exec(text);
  if (m === null) return undefined;
  const number = Number(m[3] ?? m[6]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { owner: (m[1] ?? m[4])!, repo: (m[2] ?? m[5])!, number };
}

/** The graph's half of a pull-request task plan. */
export interface PullTaskSpec {
  /** The graph id, which names the ref namespace. */
  graphId: string;
  /** Which graph's keys the profile parser reads (`profile.ts`). */
  profileGraph: ProfileGraph;
  usage: string;
  /** Flags the graph accepts with no value, each recorded as set. */
  flags: readonly string[];
  /** Flags the graph accepts and ignores (kept so earlier invocations still work). */
  ignored?: readonly string[];
  /** Flags the graph refuses, with the reason. */
  refused?: Readonly<Record<string, string>>;
  /** The task file's path, relative to the operator's `--out`. */
  taskPath: (pull: { owner: string; repo: string; number: number }) => string;
  /** The task's request (`${headSha}` is resolved by the plan), and the plan's one-line summary. */
  request: (pull: { owner: string; repo: string; number: number }, set: ReadonlySet<string>) => string;
  summary: (pull: { owner: string; repo: string; number: number }, base: string, set: ReadonlySet<string>) => string;
}

/** The parsed arguments, or why they are refused. */
export type PullArgs = { refused: string } | { profile: Profile; pull: { owner: string; repo: string; number: number }; base: string; set: Set<string> };

/** The arguments of `task new` for a review graph, checked against the profile. */
export function parsePullArgs(input: PrepareTaskInput, spec: PullTaskSpec): PullArgs {
  if (input.profile === undefined) return { refused: `${spec.graphId} needs a profile: ${spec.usage}` };
  let profile: Profile;
  try {
    profile = parseProfile(input.profile, spec.profileGraph);
  } catch (err) {
    if (err instanceof ProfileError) return { refused: `the profile is not usable: ${err.message}` };
    throw err;
  }
  let base = profile.baseBranch;
  const set = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < input.args.length; i += 1) {
    const arg = input.args[i]!;
    if (spec.ignored?.includes(arg) === true) {
      // Accepted and ignored.
    } else if (spec.refused?.[arg] !== undefined) {
      return { refused: `${arg} is not an option of ${spec.graphId}: ${spec.refused[arg]}; usage: ${spec.usage}` };
    } else if (spec.flags.includes(arg)) {
      set.add(arg);
    } else if (arg === "--base" || arg.startsWith("--base=")) {
      const value = arg === "--base" ? input.args[(i += 1)] : arg.slice("--base=".length);
      if (value === undefined || value === "" || value.startsWith("-")) return { refused: `--base needs a branch name; usage: ${spec.usage}` };
      base = value;
    } else if (arg.startsWith("-")) {
      return { refused: `unknown argument ${JSON.stringify(arg)}; usage: ${spec.usage}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return { refused: `name exactly one pull request; usage: ${spec.usage}` };
  const pull = parsePullArgument(positional[0]!);
  if (pull === undefined) return { refused: `${JSON.stringify(positional[0])} is not a pull request: use owner/repo#N or https://github.com/owner/repo/pull/N` };
  const { owner, repo } = pull;
  if (`${owner}/${repo}`.toLowerCase() !== profile.project.toLowerCase()) {
    return { refused: `${owner}/${repo} is not this profile's project (${profile.project}); name a pull request of ${profile.project}, or another profile` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes("..") || base.endsWith("/") || base.endsWith(".lock")) {
    return { refused: `${JSON.stringify(base)} is not a branch name` };
  }
  if ([owner, repo].some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return { refused: `${owner}/${repo} cannot name refs (a component starts with . or ends with .lock)` };
  }
  return { profile, pull, base, set };
}

/**
 * The plan of design §3.1 for a review graph: fetch the pull request's head and its base branch into the graph's own ref
 * namespace, pin the head by sha, and write the task with the merge base as its base.
 */
export function pullTaskPlan(input: PrepareTaskInput, spec: PullTaskSpec): PrepareTaskReply {
  const parsed = parsePullArgs(input, spec);
  if ("refused" in parsed) return parsed;
  const { pull, base, set } = parsed;
  const { owner, repo, number } = pull;
  // The repository's remote for the project, else the URL itself.
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const url = new RegExp(`^https://github\\.com/${literal(owner)}/${literal(repo)}(?:\\.git)?/?$`, "i");
  const remote = input.repo.remotes.find((r) => url.test(r.url))?.name ?? `https://github.com/${owner}/${repo}.git`;

  const R = `refs/graphloom/${spec.graphId}/${owner}/${repo}/${number}`;
  const steps: TaskPlanStep[] = [
    { kind: "fetch", remote, refspec: `refs/pull/${number}/head`, intoRef: `${R}/head` },
    { kind: "fetch", remote, refspec: `refs/heads/${base}`, intoRef: `${R}/base` },
    { kind: "resolve", name: "headSha", revParse: `${R}/head` },
    { kind: "updateRef", from: "${headSha}", to: `${R}/heads/\${headSha}` },
    { kind: "resolve", name: "mergeBase", mergeBase: [`${R}/head`, `${R}/base`] },
    { kind: "writeTask", path: spec.taskPath(pull), fields: { base: "${mergeBase}", request: spec.request(pull, set) } },
  ];
  return { summary: spec.summary(pull, base, set), steps };
}
