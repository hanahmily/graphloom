// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-review rehearsal's scenarios on corrections, hostile input, a missing sandbox and the state lifecycle (full
// tier; test/tiers.ts).

import { scenarios } from "./pr-review-rehearsal.js";

scenarios({ draft: ["report-corrections", "injection", "sandbox-unavailable", "state-lifecycle"] });
