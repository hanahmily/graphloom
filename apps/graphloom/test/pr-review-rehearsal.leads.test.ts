// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-review rehearsal's scenarios on the measured leads (full tier; test/tiers.ts).

import { scenarios } from "./pr-review-rehearsal.js";

scenarios({ draft: ["complex-function", "reuse-lead", "untested-feature", "crap-upper-bound"] });
