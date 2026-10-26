// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * What a test owns: every builder registers its cleanup here, and one
 * `dispose()` (in `afterEach`) undoes them all, newest first. A cleanup that
 * fails does not stop the others; the first failure is rethrown at the end.
 */
export interface TestScope {
  /** Run `fn` on dispose, before anything deferred earlier. */
  defer(fn: () => unknown): void;
  /** A fresh directory under the OS temp dir, removed on dispose. */
  tempDir(prefix?: string): Promise<string>;
  dispose(): Promise<void>;
}

export function createScope(): TestScope {
  const deferred: Array<() => unknown> = [];
  return {
    defer(fn) {
      deferred.push(fn);
    },
    async tempDir(prefix = "gl-testkit-") {
      const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
      deferred.push(() => rm(dir, { recursive: true, force: true }));
      return dir;
    },
    async dispose() {
      let first: unknown;
      while (deferred.length > 0) {
        try {
          await deferred.pop()!();
        } catch (err) {
          first ??= err;
        }
      }
      if (first !== undefined) throw first;
    },
  };
}
