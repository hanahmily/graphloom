/**
 * issue-fix's rehearsal scenarios (docs/design-graph-rehearsal.md §4.4/§4.5).
 *
 * The go-test scenario is banyandb-fix's, unchanged, for the banyandb profile:
 * recorded verbatim with `graphloom rehearse --record-from` from a real,
 * successful live run (Claude Code planned, implemented and confirmed the
 * fix; Codex reviewed the code in open-code-review's delegation mode), not
 * hand-written — the real models' own replies are the
 * most realistic stand-in data available, and CI rehearses on exactly this,
 * never a hand-authored guess at what a model would say. The real review
 * first hit a transient open-code-review misconfiguration (excluding the new
 * test file by its own default path filter) and recovered on a second pass;
 * that retry is part of the real happy path, not trimmed away.
 *
 * One gap the controller's own evidence model cannot close:
 * `pkg/timestamp/scheduler.go` and `scheduler_test.go`'s bytes, below, are
 * not `--record-from`'s own output. Fix's RED/GREEN requirements validate by
 * running real commands against the real checkout, never by the graph
 * `observe()`-ing the implementer's written files (only `observe()` turns a
 * file's bytes into replayable evidence — packages/controller/src/loop.ts),
 * so the real run never recorded them. Copied by hand, byte for byte, from
 * the live run's own worktree the moment it succeeded — the real bytes an
 * agent actually wrote, not a guess at them.
 */
import type { GraphRehearsal } from "@graphloom/sdk";
import { parseProfile } from "./profile.js";
import { FIX_STAGE, REVIEW_STAGE } from "./constants.js";

const CHANGES_AFTER = "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Report long-running scheduled actions (e.g. backups) as `running` instead of incorrectly logging them as `timed out`.\n- Older fix.\n\n## 0.11.0\n\n- Old.\n";
const SCHEDULER_FIXED = '// Licensed under the Apache License, Version 2.0.\n\npackage timestamp\n\n// Status reports a scheduled action after it has run for minutes.\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\tif running {\n\t\t\treturn "running"\n\t\t}\n\t\treturn "timed out"\n\t}\n\treturn "ok"\n}\n';
const SCHEDULER_TEST = '// Licensed under the Apache License, Version 2.0.\n\npackage timestamp\n\nimport "testing"\n\nfunc TestStatus(t *testing.T) {\n\ttests := []struct {\n\t\tname    string\n\t\tminutes int\n\t\trunning bool\n\t\twant    string\n\t}{\n\t\t{"under limit", generatedLimit - 1, false, "ok"},\n\t\t{"still running at limit", generatedLimit, true, "running"},\n\t\t{"not running at limit", generatedLimit, false, "timed out"},\n\t}\n\tfor _, tt := range tests {\n\t\tt.Run(tt.name, func(t *testing.T) {\n\t\t\tif got := Status(tt.minutes, tt.running); got != tt.want {\n\t\t\t\tt.Errorf("Status(%d, %v) = %q, want %q", tt.minutes, tt.running, got, tt.want)\n\t\t\t}\n\t\t})\n\t}\n}\n';

const GO_TEST_REHEARSAL: GraphRehearsal = {
  scenarios: {
    happy: {
      results: {
        "decision-record-v2": [
          {
            output: {
              title: 'scheduler: report long-running scheduled actions as "running" instead of "timed out"',
              status: "ready",
              change: 'The scheduler no longer reports a scheduled action as "timed out" merely because it ran past the check interval: an action that has not errored or been cancelled is reported as "running", and "timed out" is kept for an action that actually timed out.',
              summary:
                "BanyanDB's scheduler runs periodic/background actions (the mechanism backing scheduled backups) and polls each action's completion on a fixed check interval. When that interval elapses before the action's goroutine has returned, the monitor currently treats elapsed wall-clock time alone as proof of failure and logs/reports the action as \"timed out\", even though the action has not errored or been cancelled and is simply still executing. Because real backups routinely run past five minutes, every such backup trips this false-positive and gets logged as a timeout while it continues running to completion in the background. The fix is to stop conflating \"still executing past the check interval\" with \"timed out\": when the interval elapses and the action has not returned an error and has not been cancelled, the monitor should classify/log it as \"running\" (matching whatever existing in-progress status vocabulary the scheduler already uses), and reserve \"timed out\" for cases where the action actually returns a timeout/cancellation-class error or an explicit deadline on the action itself expires.",
              productionCaller:
                "The scheduler's action-status monitor/poll loop that runs registered scheduled jobs (the path that backs BanyanDB's scheduled-backup feature) and, once its check interval elapses without the action's completion signal firing, currently emits the \"action timed out\" classification. I could not confirm the exact file in this session (repository search via a dispatched exploration agent had not returned before this plan had to be finalized) — expected to live in a scheduler-oriented package (e.g. something under pkg/ or banyand/backup) rather than inside the backup logic itself, since the issue describes this as a generic scheduler behavior. Must be verified against current main before implementation.",
              decisions: [
                {
                  point: "What status should be reported for a scheduled action that has exceeded the monitor's check interval but has not errored or been cancelled?",
                  tier: "behaviour",
                  options: [
                    'Log/report the action as "running" while it is still executing without error (per the issue and bot comment)',
                    "Raise the fixed check-interval/timeout to a larger constant so backups rarely cross it",
                    "Make the check interval/timeout a configurable setting",
                  ],
                  chosen: 'Classify and log a still-executing, non-errored, non-cancelled action as "running" instead of "timed out" once the check interval elapses.',
                  basis:
                    "Directly stated by the bot comment on the issue: 'A running backup is not an error; report it as running.' This is the conservative reading: it changes only the status label/log line emitted by the monitor loop, not the scheduler's execution, cancellation, retry, or shutdown behavior. Reach: the scheduler's own Stop/shutdown path must still be able to cancel or wait out an in-flight action exactly as before — this change only affects what gets logged while the action is still running, not how Close/Stop interacts with it. If the current code also *acts* on 'timed out' (e.g., cancels the action's context, marks it failed, or triggers a retry) rather than only logging it, those call sites must be found and left untouched for still-running actions, since converting 'timed out' to 'running' here must not also suppress a real failure path for actions that are genuinely cancelled or erroring — this call-site audit could not be completed in this session (see openQuestions) and is a risk if no existing test exercises it. If the action is one that never returns at all (a true hang/deadlock), relabeling the periodic check as 'running' rather than 'timed out' means a hang would now be reported as perpetually 'running' instead of eventually surfacing as an error, unless a separate hard-deadline/cancellation mechanism already exists elsewhere in the scheduler — this is flagged as a follow-up risk rather than blocking the fix, since the issue explicitly asks for the 'running' label for the in-progress case.",
                },
                {
                  point: "Does the periodic poll loop structure change, or only the label it emits when the interval elapses without completion?",
                  tier: "implementation",
                  options: [
                    "Keep the existing periodic poll/check-interval loop and only change what status gets logged/returned when the interval elapses without completion",
                    "Rewrite the monitor to block until completion with no periodic status emission at all",
                  ],
                  chosen: 'Keep the existing poll loop; change only the classification emitted when the interval elapses without completion (and without error/cancellation) from "timed out" to "running".',
                  basis: "Smallest, most reversible change consistent with the existing polling architecture; avoids restructuring how the scheduler awaits action completion or touching its shutdown/cancellation plumbing.",
                },
                {
                  point: 'Should "timed out" remain a possible status at all?',
                  tier: "implementation",
                  options: [
                    "Keep \"timed out\" only for genuine cancellation/deadline-expiry outcomes (the action itself returns a timeout-class error, or an explicit context deadline on the action expires)",
                    'Remove the "timed out" status/log path from the scheduler entirely',
                  ],
                  chosen: 'Keep "timed out" for genuine cancellation/deadline-expiry outcomes only; stop deriving it purely from the periodic check interval elapsing.',
                  basis: "Conservative: preserves the existing status vocabulary and behavior for actions that really are aborted, and changes behavior only for the specific false-positive the issue describes (a successfully-progressing action being mislabeled).",
                },
              ],
              test: {
                package: "the scheduler package containing the action-status monitor backing scheduled backups (exact path not confirmed in this session — likely under pkg/ or banyand/backup; confirm against current main before implementing)",
                name: 'a new test (or, if the package uses a Ginkgo suite, a new spec under its existing TestXxx entrypoint) that schedules/executes an action whose function blocks past the monitor\'s check interval without returning an error, and asserts the monitor\'s reported/logged status is "running" (not "timed out") while the action is still in flight, transitioning to the success status once the action later returns',
                expectedValueSource:
                  "The bot comment on apache/skywalking#14111 ('A running backup is not an error; report it as running.') is the direct source of the expected behavior/status string; cross-check the exact string/constant against whatever existing \"running\"/in-progress status constant the scheduler already defines elsewhere, rather than inventing a new literal, so the test asserts the same value the rest of the codebase uses.",
              },
              openQuestions: [
                "Is the mis-reported \"timed out\" state only emitted to logs, or is it also surfaced through a persisted/queryable status (e.g. a backup-status API, CLI output, or a metrics/property value)? If it is exposed externally, changing the emitted value from \"timed out\" to \"running\" is a product-visible change (new/changed status value) and should be confirmed with maintainers; this plan assumes the conservative log-only interpretation based on the issue's own wording ('log action timed out').",
                "The exact source location of the scheduler's status/timeout check (e.g. under banyand/backup or a shared scheduler package) needs to be confirmed against the current main branch — this session's automated repository search did not complete before the plan had to be finalized, so file/line citations above are hypotheses, not verified facts.",
                "Does the current 'timed out' path only log, or does it also cancel the action's context, mark it failed, or trigger a retry? If it takes action beyond logging, those call sites need to be identified and left intact for genuinely cancelled/erroring actions so this fix doesn't also suppress real failure handling.",
                "Is this scheduler/monitor shared by other periodic actions besides backup (e.g. data lifecycle or stage-migration jobs)? If so, confirm the fix should apply uniformly rather than being backup-specific.",
                "Does any other mechanism already guard against a truly hung (never-returning) action, or does the elapsed-interval check that currently produces 'timed out' serve as the only such safety net? If it's the only one, relabeling it as 'running' makes a genuine hang invisible forever — worth flagging to maintainers even though the issue's explicit ask is to stop mislabeling in-progress work.",
              ],
              followUps: [
                "If other scheduled actions share this monitor loop, verify whether they exhibit the same false-timeout bug and apply the same fix, or file a separate issue if they're handled by different code.",
                "Consider a periodic lower-severity 'still running, elapsed Xs' log line for operability on long backups, instead of a single status flip — adjacent enhancement, not required by this issue.",
                "Confirm with maintainers whether a genuinely hung (never-completing) action needs its own distinct detection/alerting path, since this fix removes the only mechanism that currently (incorrectly) flags long-running actions as abnormal.",
              ],
              needsE2E: false,
              scopeExceptions: [],
            },
          },
          {
            output: {
              title: 'scheduler: report long-running scheduled actions as "running" instead of "timed out"',
              status: "ready",
              change: '`Status` in `pkg/timestamp/scheduler.go` now returns "running" when the time limit is reached while the action is still running, instead of "timed out". It still returns "timed out" when the action is no longer running. Backups that run past five minutes are therefore no longer logged as timeouts. A regression test covers the three cases.',
              summary:
                'In `pkg/timestamp/scheduler.go`, `Status(minutes int, running bool) string` ignored its `running` parameter entirely: once elapsed minutes reached `generatedLimit` (5), it always returned "timed out", even when the action was still executing without error. This is exactly the bug in apache/skywalking#14111 — a backup running past five minutes was logged as timed out purely because of elapsed time, never because it actually failed or was cancelled. The fix adds a branch so that when the limit is reached and the action is still running, `Status` returns "running"; it only returns "timed out" when the action is no longer running (i.e., it was actually aborted/stopped without completing), per the issue\'s bot comment: "A running backup is not an error; report it as running."',
              productionCaller:
                "`pkg/timestamp.Status` in `pkg/timestamp/scheduler.go:6` — verified by direct inspection and by `grep`, this is the only production code in the repository that classifies a scheduled action's elapsed-time status; it has no other caller in this repository (the fixture repo contains no scheduler monitor loop, goroutine, or logging call site around it — `Status` itself is the production entry point under test).",
              decisions: [
                {
                  point: "What status should be reported for a scheduled action that has reached the time limit but has not errored or been cancelled (running == true)?",
                  tier: "behaviour",
                  options: [
                    'Return "running" while the action is still executing without error (per the issue and bot comment)',
                    "Raise `generatedLimit` so actions rarely cross it",
                    "Make the limit configurable",
                  ],
                  chosen: 'When `minutes >= generatedLimit` and `running` is true, return "running" instead of "timed out".',
                  basis:
                    "Directly stated by the bot comment: 'A running backup is not an error; report it as running.' Conservative: only adds one new branch using the already-passed `running` parameter; does not change the function signature, the `ok` branch, or the `timed out` branch for the not-running case. Reach: `Status` is a pure, synchronous function with no goroutines, context, shutdown/Close path, or concurrency in this repository — `grep` confirms its only caller is the new test, so there is no shutdown/cancellation/retry call site elsewhere in this repo that depends on the old 'timed out at limit while still running' behavior. Covered by TestStatus's \"still running at limit\" case.",
                },
                {
                  point: "What should `Status` return when the limit is reached and the action is no longer running (running == false)?",
                  tier: "implementation",
                  options: [
                    'Keep returning "timed out" for this case (unchanged from current behavior)',
                    "Return a different value (e.g. distinguish success-after-limit from real timeout)",
                  ],
                  chosen: 'Unchanged: return "timed out" when `minutes >= generatedLimit` and `running` is false.',
                  basis:
                    'The issue only describes the false-positive for an action that is still running; it says nothing about the not-running case, so per the conservative rule ("unchanged behaviour for everything the issue does not name") this branch is left exactly as before. Covered by TestStatus\'s "not running at limit" case.',
                },
                {
                  point: "Does the fix need to use run.Go / goroutine-management conventions instead of raw goroutines?",
                  tier: "implementation",
                  options: ["Use the repository's goroutine-lifecycle helper if the fix touches concurrency", "N/A — no concurrency is involved"],
                  chosen:
                    "N/A: `Status` is a synchronous pure function; `grep` across the repository found no goroutines, no `pkg/run` package, and no concurrency anywhere in this codebase, so no goroutine-management convention applies to this change.",
                  basis: "Verified by searching the repository tree (`find`/`grep`) — only `pkg/timestamp/scheduler.go` and its new test exist in this fixture; there is no `pkg/run` or goroutine to manage.",
                },
              ],
              test: {
                package: "./pkg/timestamp",
                name: "TestStatus",
                expectedValueSource:
                  'The issue\'s bot comment (\'A running backup is not an error; report it as running.\') is the direct source for the new "still running at limit" → "running" expectation. The "under limit" → "ok" and "not running at limit" → "timed out" expectations come from the pre-existing, unchanged behavior of `Status` for those branches (verified against the pre-fix source, not invented to match the new code).',
              },
              openQuestions: [
                'This repository is a minimal fixture containing only `pkg/timestamp/scheduler.go` with no caller, logger, or status-API consumer around `Status`. In the full apache/skywalking-banyandb codebase, confirm whether the real scheduler\'s "timed out"/"running" classification is only logged or also surfaced through a persisted/queryable status (backup-status API, CLI, metrics) — if externally exposed there, adding a new "running" value could be a product-visible change needing maintainer sign-off; nothing in this repository\'s scope exposes such a surface, so no product decision is blocked here.',
                'If an action legitimately never completes (hangs), it will now report "running" forever once past the limit instead of eventually surfacing as "timed out" — this fixture has no separate hard-deadline/hang-detection mechanism. Confirm with maintainers whether the real scheduler has (or needs) an independent hang-detection path, since this fix intentionally removes the only signal that previously (incorrectly) flagged long-running-but-healthy actions as abnormal.',
              ],
              followUps: [
                "In the full banyandb codebase, verify whether other scheduled actions besides backup share the same status-classification logic and need the same fix.",
                'Consider a periodic lower-severity "still running, elapsed N min" log line for operability on long backups, instead of a single status value — adjacent enhancement, not required by this issue.',
                "Confirm whether a genuinely hung (never-completing) action needs its own distinct detection/alerting path in the real scheduler, per the openQuestion above.",
              ],
              needsE2E: false,
              scopeExceptions: [],
            },
            // The controller's own evidence never captures a work dispatch's
            // file writes unless the graph observe()s them (see the file
            // header); CHANGES.md is recorded because the changelog-entry
            // validator reads it back that way, but scheduler.go and
            // scheduler_test.go are not — their bytes here are the real ones
            // copied by hand from the live run's own worktree.
            effects: [
              { path: "pkg/timestamp/scheduler.go", bytes: SCHEDULER_FIXED },
              { path: "pkg/timestamp/scheduler_test.go", bytes: SCHEDULER_TEST },
              { path: "CHANGES.md", bytes: CHANGES_AFTER },
            ],
          },
        ],
        "code-review-v2": [
          {
            // The real review's first pass: open-code-review's own default path
            // filter excludes *_test.go from delegation (a real, documented
            // default, not a stub) and the model reported it, honestly, as
            // incomplete coverage rather than silently passing. The second
            // pass below is the real recovery after an operator fix, not a
            // hand-smoothed retry.
            output: {
              comments: [],
              prior: [],
              summary: {
                total_files: 1,
                reviewed_files: 0,
                skipped: [
                  {
                    path: "pkg/timestamp/scheduler_test.go",
                    reason:
                      "Required rule resolution failed: the supplied ocr is a stub that always returns an empty preview and rejects delegate rule with exit code 1. This Go test was added per instruction; the requested delegation review remains incomplete.",
                  },
                ],
              },
            },
          },
          {
            output: { comments: [], prior: [], summary: { total_files: 2, reviewed_files: 2, skipped: [] } },
          },
        ],
      },
      expect: { status: "succeeded", receipts: [FIX_STAGE, REVIEW_STAGE] },
    },
  },
};

const SCOPE_TEST = "packages/sdk/src/scope-exclusion.test.ts";
const SCOPE_TEST_NAME = "writeScopeAllows forbids a path below an excluded directory";
const SCOPE_TEST_BYTES = `import { describe, expect, it } from "vitest";\nimport { writeScopeAllows } from "./scope.js";\n\ndescribe("writeScopeAllows", () => {\n  it("forbids a path below an excluded directory", () => {\n    expect(writeScopeAllows("legacy/go/main.go", [".", "!legacy"])).toBe(false);\n  });\n});\n`;
const VITEST_RECORD = {
  title: "Forbid paths below an excluded directory",
  status: "ready",
  change: "A write scope that excludes a directory now forbids every path below it, not only the directory itself. A regression test pins that.",
  summary: "An excluded directory in a write scope must forbid every path below it; the regression test pins that.",
  test: { package: SCOPE_TEST, name: SCOPE_TEST_NAME, expectedValueSource: "the issue: an excluded directory covers everything below it" },
  productionCaller: "packages/sdk/src/scope.ts writeScopeAllows",
  decisions: [],
  openQuestions: [],
  followUps: [],
  needsE2E: false,
  scopeExceptions: [],
};

/**
 * Hand-written, not recorded: no live run of a vitest profile exists yet. Its
 * replies satisfy the contracts and the vitest runner's rules, so the static
 * check (L0) walks them through the real validators; a full rehearsal (L1)
 * would also run the profile's real commands in the target repository.
 */
const VITEST_REHEARSAL: GraphRehearsal = {
  scenarios: {
    happy: {
      results: {
        "decision-record-v2": [{ output: VITEST_RECORD, effects: [{ path: SCOPE_TEST, bytes: SCOPE_TEST_BYTES }] }],
        "code-review-v2": [{ output: { comments: [], prior: [], summary: { total_files: 1, reviewed_files: 1, skipped: [] } } }],
      },
      expect: { status: "succeeded", receipts: [FIX_STAGE, REVIEW_STAGE] },
    },
  },
};

/**
 * The rehearsal for the run's profile (the task's config): the plugin host
 * calls this with the pinned config. A config that is not a usable profile
 * gets the go-test scenario; describe() refuses such a config anyway.
 */
export function rehearsal(config: unknown): GraphRehearsal {
  let runner: string;
  try {
    runner = parseProfile(config).runner.id;
  } catch {
    runner = "go-test";
  }
  return runner === "vitest" ? VITEST_REHEARSAL : GO_TEST_REHEARSAL;
}
