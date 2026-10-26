// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { afterEach, describe, it } from "vitest";
import { createScope } from "@graphloom/testkit";
import { CONDITIONS, runCell } from "./matrix.js";

const scope = createScope();
afterEach(() => scope.dispose());

describe("hello end to end under each realistic condition (#144)", () => {
  it.each(CONDITIONS.filter((c) => c.graphs?.includes("hello") ?? true).map((c) => [c.id, c] as const))("%s", async (_id, condition) => {
    await runCell(scope, "hello", condition);
  }, 60_000);
});
