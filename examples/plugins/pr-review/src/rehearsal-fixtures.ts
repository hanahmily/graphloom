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

/**
 * `state-lifecycle`: a #1443-like change. A write callback now counts the events it stored and keeps the first
 * failure, and replies with an error when the batch stored nothing. Lines the pull request adds start with `+ `.
 */
const STREAM_WRITE_MARKED = `// Licensed under the Apache License, Version 2.0.

package stream

// Rev handles a batch of write events and replies to the liaison.
func (w *writeCallback) Rev(message bus.Message) (resp bus.Message) {
\tevents, ok := message.Data().([]any)
\tif !ok {
\t\tw.l.Warn().Msg("invalid event data type")
\t\treturn
\t}
+ \tstored := 0
+ \tvar firstErr error
\tfor i := range events {
\t\tvar writeEvent *streamv1.InternalWriteRequest
\t\tswitch e := events[i].(type) {
\t\tcase *streamv1.InternalWriteRequest:
\t\t\twriteEvent = e
\t\tcase []byte:
\t\t\twriteEvent = &streamv1.InternalWriteRequest{}
\t\t\tif err := proto.Unmarshal(e, writeEvent); err != nil {
\t\t\t\tw.l.Error().Err(err).Msg("failed to unmarshal write event")
+ \t\t\t\tif firstErr == nil {
+ \t\t\t\t\tfirstErr = err
+ \t\t\t\t}
\t\t\t\tcontinue
\t\t\t}
\t\tdefault:
\t\t\tw.l.Warn().Msg("unsupported event type")
+ \t\t\tif firstErr == nil {
+ \t\t\t\tfirstErr = errUnsupportedEvent
+ \t\t\t}
\t\t\tcontinue
\t\t}
\t\tif err := w.handle(writeEvent); err != nil {
\t\t\tw.l.Error().Err(err).Msg("cannot handle write event")
+ \t\t\tif firstErr == nil {
+ \t\t\t\tfirstErr = err
+ \t\t\t}
\t\t\tcontinue
\t\t}
+ \t\tstored++
\t}
\tw.flushGroups()
+ \tif stored == 0 && firstErr != nil {
+ \t\treturn bus.NewMessage(message.ID(), common.NewErrorWithStatus(modelv1.Status_STATUS_INTERNAL_ERROR, firstErr.Error()))
+ \t}
\treturn
}
`;

const streamLines = STREAM_WRITE_MARKED.replace(/\n$/, "").split("\n");

/** The file as the head has it. */
export const STREAM_WRITE_GO = `${streamLines.map((l) => (l.startsWith("+ ") ? l.slice(2) : l)).join("\n")}\n`;

/** The file as the base has it: the head without the lines the pull request adds. */
export const STREAM_WRITE_BASE_GO = `${streamLines.filter((l) => !l.startsWith("+ ")).join("\n")}\n`;

/** Head-side line numbers the pull request adds to it. */
export const STREAM_ADDED_LINES: readonly number[] = streamLines.flatMap((l, i) => (l.startsWith("+ ") ? [i + 1] : []));

/** The head-side ranges of those lines (consecutive lines merge), for the metrics tools. */
export const STREAM_CHANGED: ReadonlyArray<{ start: number; end: number }> = STREAM_ADDED_LINES.reduce<Array<{ start: number; end: number }>>((out, n) => {
  const last = out.at(-1);
  if (last !== undefined && last.end + 1 === n) last.end = n;
  else out.push({ start: n, end: n });
  return out;
}, []);

export const STREAM_PATH = "banyand/stream/write_standalone.go";

/**
 * A design statement of the base repository, as the `necessity-unnecessary` scenario cites it: line 172 of BanyanDB's
 * docs/concept/tsdb.md, "Write Path" (copied, so a test can hold the scenario's quote to this text).
 */
export const WRITE_PATH_DOC = {
  path: "docs/concept/tsdb.md",
  line: 172,
  text: "When a shard receives a write request, the data is written to a buffer as a memory part; the series index (and, for indexed tags, the inverted index) is updated as well. A background worker periodically flushes the memory part to disk. After a flush completes, it triggers a merge operation to combine parts and remove invalid data.",
  quote: "A background worker periodically flushes the memory part to disk.",
} as const;

export const NEW_HEAD_FILES: Readonly<Record<string, string>> = {
  "pkg/retention/ttl.go": RETENTION_TTL_GO,
  "pkg/retry/backoff.go": BACKOFF_GO,
  "pkg/spread/jitter.go": JITTER_GO,
  "pkg/quota/limit.go": LIMIT_GO,
  "pkg/offline/sync.go": SYNC_GO,
  [STREAM_PATH]: STREAM_WRITE_GO,
};

/** `report`: a modified registerFlags that gains a flag and a sweep. Lines the pull request adds are FLAGS_ADDED_LINES. */
export const FLAGS_GO = `// Licensed under the Apache License, Version 2.0.

package server

import (
	"os"

	"github.com/spf13/cobra"
)

// registerFlags adds the server's flags.
func registerFlags(cmd *cobra.Command) {
	cmd.Flags().String("listen", ":17912", "listen address")
	cmd.Flags().Int("retention-days", 7, "default retention in days")
	if os.Getenv("BYDB_RETENTION_DAYS") != "" {
		schedule("0 3 * * *")
	}
}
`;

/** The head-side lines the `report` pull request adds to FLAGS_GO. */
export const FLAGS_ADDED_LINES: readonly number[] = [14, 15, 16, 17];

const without = (text: string, lines: readonly number[]): string => `${text.replace(/\n$/, "").split("\n").filter((_, i) => !lines.includes(i + 1)).join("\n")}\n`;

/** The files the modified-function scenarios have at the base: the head without the lines the pull request adds. */
export const FLAGS_BASE_GO = without(FLAGS_GO, FLAGS_ADDED_LINES);
export const SYNC_BASE_GO = without(SYNC_GO, [SYNC_CHANGED.start, SYNC_CHANGED.start + 1, SYNC_CHANGED.end]);

/** The modified files' text at the base, by path: what `git show <base>:<path>` prints for them in a rehearsal. */
export const BASE_FILES: Readonly<Record<string, string>> = {
  "banyand/cmd/server/flags.go": FLAGS_BASE_GO,
  "pkg/offline/sync.go": SYNC_BASE_GO,
  [STREAM_PATH]: STREAM_WRITE_BASE_GO,
};
