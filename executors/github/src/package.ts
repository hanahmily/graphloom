// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { fileURLToPath } from "node:url";
import type { ExecutorBinding, ExecutorPackageManifest } from "@graphloom/sdk";
import { GITHUB_API_URL_ENV } from "./client.js";

/** Credential binding name the write executors (and authenticated reads) request. */
export const GITHUB_CREDENTIAL = "github";

/** Qualified ids served by this package. */
export const GITHUB_EXECUTOR_IDS = [
  "graphloom.github/list-issues",
  "graphloom.github/list-pulls",
  "graphloom.github/get-issue",
  "graphloom.github/get-pull",
  "graphloom.github/get-file",
  "graphloom.github/list-issue-comments",
  "graphloom.github/list-labels",
  "graphloom.github/list-milestones",
  "graphloom.github/list-pull-files",
  "graphloom.github/list-pull-commits",
  "graphloom.github/list-pull-reviews",
  "graphloom.github/list-pull-review-comments",
  "graphloom.github/list-review-threads",
  "graphloom.github/list-check-runs",
  "graphloom.github/create-issue-comment",
  "graphloom.github/create-pull",
  "graphloom.github/create-pull-review",
  "graphloom.github/add-labels",
  "graphloom.github/remove-labels",
  "graphloom.github/update-issue",
] as const;

/** Host-facing declaration; the host runs `entryModule` in an executor process and never imports it. */
export const githubExecutorPackage: ExecutorPackageManifest = {
  name: "@graphloom/executor-github",
  entryModule: fileURLToPath(new URL("./executors.js", import.meta.url)),
  executorIds: GITHUB_EXECUTOR_IDS,
  credentials: [GITHUB_CREDENTIAL],
  configEnv: [GITHUB_API_URL_ENV],
};

/** `--offline`'s stand-in entry module (docs/design-graph-rehearsal.md §4.6): swapped in for `githubExecutorPackage.entryModule` to replay recorded reads instead of making real ones. */
export const githubRehearsalModule = fileURLToPath(new URL("./rehearsal/github-standin.js", import.meta.url));

export interface GitHubBindingOptions {
  /** Token for the `github` credential binding. */
  token?: string;
  /**
   * Allow write executors (comments, reviews, pull requests, labels, edits).
   * Off by default: installing the package grants only reads.
   */
  allowWrites?: boolean;
  /** GitHub API base URL (GitHub Enterprise or a test server). */
  baseUrl?: string;
}

/** Translate GitHub-specific operator settings into a generic executor binding. */
export function githubBinding(options: GitHubBindingOptions = {}): ExecutorBinding {
  return {
    allowedEffects: options.allowWrites === true ? ["read", "write"] : ["read"],
    ...(options.token !== undefined ? { credentials: { [GITHUB_CREDENTIAL]: options.token } } : {}),
    ...(options.baseUrl !== undefined ? { env: { [GITHUB_API_URL_ENV]: options.baseUrl } } : {}),
  };
}
