// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { pathToFileURL } from "node:url";
import type { CodingHarness } from "./harness.js";
import { createCodingAgentExecutor } from "./run.js";

/** Module path or specifier of the harness adapter; it must export `harness`. */
export const CODING_HARNESS_ENV = "GRAPHLOOM_CODING_HARNESS";

async function loadHarness(): Promise<CodingHarness> {
  const spec = process.env[CODING_HARNESS_ENV];
  if (!spec) throw new Error(`${CODING_HARNESS_ENV} is not configured`);
  const mod = (await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec)) as { harness?: CodingHarness };
  if (!mod.harness || typeof mod.harness.createSession !== "function") {
    throw new Error(`${spec} does not export a coding harness`);
  }
  return mod.harness;
}

export const executors = [createCodingAgentExecutor(loadHarness)];
