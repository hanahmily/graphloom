// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export const VERSION_PATH = "VERSION";
export const CHANGELOG_PATH = "CHANGELOG.md";

export const BUMP_STAGE = "bump";
export const CHANGELOG_STAGE = "changelog";
export const REVIEW_STAGE = "review";

export const REQUIREMENT_VERSION = "version-file";
export const REQUIREMENT_ENTRY = "changelog-entry";
export const REQUIREMENT_SCOPE = "release-scope";
export const REQUIREMENT_REVIEW = "release-review";

/** Corrections the graph dispatches itself in one stage before it asks the supervisor. */
export const MAX_STAGE_CORRECTIONS = 1;
