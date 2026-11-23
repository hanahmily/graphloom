#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Prints, comma-separated, the full-tier test groups (apps/graphloom/test/tiers.ts) a change touches: the groups a pull
// request's CI runs on top of the PR tier.
//
// Usage: scripts/ci/test-groups.mjs <base-ref>     changed paths from `git diff --name-only <base-ref>...HEAD`
//        scripts/ci/test-groups.mjs --stdin        changed paths one per line on stdin
// Needs a Node that strips TypeScript types (22.18+, 23.6+), since it loads tiers.ts directly.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { groupsFor } from "../../apps/graphloom/test/tiers.ts";

const arg = process.argv[2];
if (arg === undefined) {
  console.error("usage: test-groups.mjs <base-ref> | --stdin");
  process.exit(2);
}
const listing = arg === "--stdin" ? readFileSync(0, "utf8") : execFileSync("git", ["diff", "--name-only", `${arg}...HEAD`], { encoding: "utf8" });
const changed = listing.split("\n").map((line) => line.trim()).filter(Boolean);
console.log(groupsFor(changed).join(","));
