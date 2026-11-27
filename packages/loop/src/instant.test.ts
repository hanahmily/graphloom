// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { validInstant } from "./instant.js";

describe("validInstant", () => {
  it.each(["2026-03-04T05:06:07Z", "2026-03-04T05:06:07.123Z", "2026-03-04T05:06:07.5Z", "2028-02-29T23:59:59Z", "2000-02-29T00:00:00Z"])("accepts %s", (v) => {
    expect(validInstant(v)).toBe(true);
  });
  it.each(["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "2026-13-01T00:00:00Z", "2026-03-04T05:06:07", "2026-03-04T05:06:07+01:00", "", 5, null, undefined])("rejects %j", (v) => {
    expect(validInstant(v)).toBe(false);
  });
});
