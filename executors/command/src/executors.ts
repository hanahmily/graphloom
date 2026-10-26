// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Entry module the host loads in an executor process. */
import { createCommandExecutor } from "./run.js";

export const executors = [createCommandExecutor()];
