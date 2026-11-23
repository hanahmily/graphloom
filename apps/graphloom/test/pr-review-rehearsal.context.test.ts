// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-review rehearsal's context scenarios other than the prelude (full tier; test/tiers.ts).

import { scenarios } from "./pr-review-rehearsal.js";

scenarios({ contexts: ["design-review", "design-review-earlier-head", "design-review-unusable-delta", "no-report"] });
