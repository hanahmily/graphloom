// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Failure classification from an agent run's failure text: usage limits (with their reset) and transient provider errors. */
export { classifyQuota, parseResetAt, type QuotaFailure } from "./quota.js";
export { classifyTransient, FAILURE_SHAPE, retryAfterMs, type TransientFailure } from "./transient.js";
