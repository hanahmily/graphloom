#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// tscover --root <checkout> --workspace <dir> --coverage <coverage-final.json> --spec <file>
//
// Reduces Istanbul's coverage-final.json to the graphloom-coverage-v1 facts of the changed functions
// (docs/design-code-quality-metrics.md §2.3), and names the coverage provider the workspace resolves.
// Runs inside the Docker sandbox, beside `vitest`, with nothing but Node.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseSpec, rangesOf, reduceIstanbul } from "./coverage.js";

/** `@vitest/coverage-v8@<version>` as the workspace resolves it, or undefined. */
function providerOf(workspace: string): string | undefined {
  try {
    const require = createRequire(`${workspace}/`);
    const pkg = JSON.parse(readFileSync(require.resolve("@vitest/coverage-v8/package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? `@vitest/coverage-v8@${pkg.version}` : undefined;
  } catch {
    return undefined;
  }
}

function main(): number {
  const { values } = parseArgs({ options: { root: { type: "string" }, workspace: { type: "string", default: "." }, coverage: { type: "string" }, spec: { type: "string" } } });
  if (values.root === undefined || values.coverage === undefined || values.spec === undefined) {
    process.stderr.write("usage: tscover --root <checkout> --workspace <dir> --coverage <coverage-final.json> --spec <file>\n");
    return 2;
  }
  try {
    const spec = parseSpec(readFileSync(values.spec, "utf8"));
    const json = JSON.parse(readFileSync(values.coverage, "utf8")) as unknown;
    const provider = providerOf(path.resolve(values.root, values.workspace ?? "."));
    const lines = [...(provider !== undefined ? [`provider ${provider}`] : []), ...reduceIstanbul(json, path.resolve(values.root), rangesOf(spec.functions))];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`tscover: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = main();
