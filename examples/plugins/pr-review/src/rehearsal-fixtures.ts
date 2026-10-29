// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Go sources the Questions and Answers rehearsal scenarios replay as the
 * pull request's head files (design §16), with the changed-line hunks their
 * static measurements are taken over. The recorded `gometrics` documents for
 * them are in rehearsal-docs.ts, regenerated and compared by a test.
 */

/** `answer-finds-existing-helper`: a new ParseTTL; the base has `ParseDuration` elsewhere. */
export const RETENTION_TTL_GO = `// Licensed under the Apache License, Version 2.0.

package retention

// ParseTTL parses a retention such as "7d" into hours.
func ParseTTL(s string) (int, error) {
	if len(s) < 2 {
		return 0, errShort
	}
	n := 0
	for _, c := range s[:len(s)-1] {
		if c < '0' || c > '9' {
			return 0, errDigit
		}
		n = n*10 + int(c-'0')
	}
	return n * 24, nil
}
`;

/** `answer-no-library-with-whole-repo-search`: a new back-off helper no declared library provides. */
export const BACKOFF_GO = `// Licensed under the Apache License, Version 2.0.

package retry

import "time"

const maxDelay = time.Minute

// Backoff returns the delay before attempt n: base doubled each time, capped.
func Backoff(attempt int, base time.Duration) time.Duration {
	d := base << attempt
	if d > maxDelay || d <= 0 {
		return maxDelay
	}
	return d
}
`;

/** `answer-checker-contradicts`: a new jitter helper; a vendored directory has an equivalent. */
export const JITTER_GO = `// Licensed under the Apache License, Version 2.0.

package spread

import (
	"math/rand"
	"time"
)

// Jitter spreads d by up to a fifth either way.
func Jitter(d time.Duration) time.Duration {
	span := int64(d) / 5
	if span <= 0 {
		return d
	}
	return d + time.Duration(rand.Int63n(2*span)-span)
}
`;

/** `missing-test`: a new exported function no test references. */
export const LIMIT_GO = `// Licensed under the Apache License, Version 2.0.

package quota

// Limit clamps a requested quota at zero.
func Limit(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// Burst allows twice the quota for a short burst.
func Burst(n int) int {
	return Limit(n) * 2
}
`;

/** `crap-upper-bound`: a modified function of complexity 6. */
export const SYNC_GO = `// Licensed under the Apache License, Version 2.0.

package offline

// Sync reconciles the local state with the remote one.
func Sync(items []string, force bool) error {
	for _, it := range items {
		if it == "" {
			continue
		}
		if force && it == "all" {
			return reset()
		}
		switch it {
		case "a", "b":
			touch(it)
		}
	}
	return nil
}
`;

/** The head-side lines Sync's diff changes (the `force` branch). */
export const SYNC_CHANGED = { start: 11, end: 13 } as const;

export const NEW_HEAD_FILES: Readonly<Record<string, string>> = {
  "pkg/retention/ttl.go": RETENTION_TTL_GO,
  "pkg/retry/backoff.go": BACKOFF_GO,
  "pkg/spread/jitter.go": JITTER_GO,
  "pkg/quota/limit.go": LIMIT_GO,
  "pkg/offline/sync.go": SYNC_GO,
};
