// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import type { TestScope } from "./scope.js";

/**
 * Put `dir` first on this process's PATH until the scope is disposed, so
 * commands the run starts (environment checks, executors) find the
 * stand-ins there. PATH is process-wide: a test file using this must not run
 * its tests concurrently.
 */
export function prependPath(scope: TestScope, dir: string): void {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved ?? ""}`;
  scope.defer(() => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  });
}
