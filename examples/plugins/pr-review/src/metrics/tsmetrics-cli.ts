#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// tsmetrics --head <dir> --hunks <file|-> [--generated <globs>]
//
// Prints one graphloom-metrics-v1 document (see tools/README.md).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseHunkFile } from "./hunks.js";
import { runTsMetrics } from "./tsmetrics.js";

function main(): number {
  const { values } = parseArgs({
    options: {
      head: { type: "string" },
      hunks: { type: "string" },
      generated: { type: "string", default: "" },
    },
  });
  if (values.head === undefined || values.hunks === undefined) {
    process.stderr.write("usage: tsmetrics --head <dir> --hunks <file|-> [--generated <globs>]\n");
    return 2;
  }
  try {
    const hunks = parseHunkFile(readFileSync(values.hunks === "-" ? 0 : values.hunks, "utf8"));
    const globs = (values.generated ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g !== "");
    process.stdout.write(`${JSON.stringify(runTsMetrics(values.head, hunks, globs))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`tsmetrics: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = main();
