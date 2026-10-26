// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it, vi } from "vitest";
import { createBuiltinExecutorRunner } from "./builtin.js";
import { createScriptedRunner } from "./scripted.js";

vi.mock("./sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox.js")>()),
  assertSandboxSupported: () => {
    throw new Error("permission model unavailable");
  },
}));

describe("createBuiltinExecutorRunner without the Node permission model", () => {
  const manifest = {
    name: "@graphloom/executor-x",
    entryModule: "/unused/executors.js",
    executorIds: ["graphloom.x/run"],
  };
  const fallback = createScriptedRunner({ jobs: [] });

  it("serves unrestricted packages, which do not use the sandbox", () => {
    expect(() =>
      createBuiltinExecutorRunner({
        packages: [{ manifest: { ...manifest, isolation: "unrestricted" }, allowUnrestricted: true }],
        fallback,
      }),
    ).not.toThrow();
  });

  it("still refuses a configuration with a sandboxed package", () => {
    expect(() => createBuiltinExecutorRunner({ packages: [{ manifest }], fallback })).toThrow(
      "permission model unavailable",
    );
  });
});
