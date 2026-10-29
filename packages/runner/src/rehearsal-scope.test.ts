// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REHEARSAL_SCENARIO_ENV } from "@graphloom/sdk";
import { rehearsalWritable } from "./confine.js";

const root = mkdtempSync(path.join(os.tmpdir(), "gl-rehearsal-scope-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the directory a confined rehearsal job's stand-in may write", () => {
  it("is the directory of the scenario file the environment names", () => {
    expect(rehearsalWritable({ [REHEARSAL_SCENARIO_ENV]: path.join(root, "scenario.json") })).toBe(root);
  });

  it("is nothing in a real run, where no scenario is named", () => {
    expect(rehearsalWritable({})).toBeUndefined();
    expect(rehearsalWritable({ [REHEARSAL_SCENARIO_ENV]: "" })).toBeUndefined();
  });

  it("is nothing for a directory that is missing or a link, which a mount would follow", () => {
    expect(rehearsalWritable({ [REHEARSAL_SCENARIO_ENV]: path.join(root, "missing", "scenario.json") })).toBeUndefined();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(rehearsalWritable({ [REHEARSAL_SCENARIO_ENV]: path.join(root, "link", "scenario.json") })).toBeUndefined();
  });
});
