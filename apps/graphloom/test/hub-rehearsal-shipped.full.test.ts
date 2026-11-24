// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Every scenario of every shipped graph, direct and through a temporary hub (full tier; test/tiers.ts).

import { shippedHubSuite } from "./hub-rehearsal-shipped.js";

shippedHubSuite((_graph, scenarios) => scenarios, 1_800_000);
