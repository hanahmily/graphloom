// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { goTestRunner } from "./go-test.js";
import type { RegressionRunner, RunnerId } from "./types.js";
import { vitestRunner } from "./vitest.js";

export type { RegressionOutcome, RegressionRunner, RegressionTestRef, RunnerId, TestOutcome } from "./types.js";

/** The built-in regression runners a profile can select by `regression.runner`. */
export const RUNNERS: Readonly<Record<RunnerId, RegressionRunner>> = {
  "go-test": goTestRunner,
  vitest: vitestRunner,
};

export function runnerById(id: string): RegressionRunner | undefined {
  return Object.prototype.hasOwnProperty.call(RUNNERS, id) ? RUNNERS[id as RunnerId] : undefined;
}
