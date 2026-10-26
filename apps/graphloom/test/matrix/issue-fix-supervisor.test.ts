// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { afterEach, describe, it } from "vitest";
import { createScope, goVersion } from "@graphloom/testkit";
import { CONDITIONS, runCell } from "./matrix.js";

const scope = createScope();
afterEach(() => scope.dispose());

// The provider-fault conditions of the issue-fix matrix (see issue-fix.test.ts).
describe.skipIf(goVersion() === undefined)("issue-fix end to end under each supervisor provider fault (#144)", () => {
  it.each(CONDITIONS.filter((c) => c.supervisor !== undefined && (c.graphs?.includes("issue-fix") ?? true)).map((c) => [c.id, c] as const))("%s", async (_id, condition) => {
    await runCell(scope, "issue-fix", condition);
  }, 120_000);
});
