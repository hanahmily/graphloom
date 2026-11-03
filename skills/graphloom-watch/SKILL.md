---
name: graphloom-watch
description: Periodic progress check of a running GraphLoom run. Arms graphloom wait --until progress (a background command in Claude Code, a foreground loop in Codex and opencode), and on each wake snapshots graphloom stats --json and inspect, diffs against the previous snapshot in a watch file, and reports only the deltas - stage and attempt, stages accepted, budget use against limits, new supervisor episodes with one-line reasons, waiting states such as a quota pause with its reset time. Flags a stall, any budget over 80%, a repeated identical failure, or a run waiting for a human; on a stop, summarizes why and asks the user what to do next. Never diagnoses, fixes or resumes a run, answers its questions, or changes a budget. Use after graphloom-run, or when the user asks how a run is doing.
---

# Watch a GraphLoom run

Input: the run's state directory (or run id with `--state-root`). graphloom-run
records it in `.graphloom-watch/run`. Below, `<run>` is that reference and
`.graphloom-watch/` is the watch directory beside the task.

## Hard rules

- **Watch only.** Never `graphloom resume`, `graphloom stop`, `graphloom
  switch-model`, or change a budget. When the run stops, summarize why and ask
  the user what to do; do not diagnose, fix, resume or answer the run's
  questions on your own. The user decides, and may ask for graphloom-triage.
- Ask before anything outward-facing (push, pull request, issue creation,
  release).
- Never print or ask for a token or secret; do not dump environment variables.
- Read run state only through `graphloom inspect`, `graphloom stats` and
  `graphloom wait`; never edit `state.json` (nor hand-parse and rewrite it).
- Use only commands and flags `graphloom --help` lists.
- Never decide liveness with `pgrep`, `ps | grep` or `kill -0`: a `pgrep -f`
  pattern matches its own shell and hid a stop for two hours once. `graphloom
  wait` reads the durable state and the controller's owner claim; the
  `--on-stop` marker (`.graphloom-watch/stopped`) is the push signal.

## 1. Arm the wake-up

`graphloom wait <run> --until progress` returns when something meaningful
happens: `stage_entered`, `receipt_accepted`, `receipts_invalidated`,
`episode_started`, `episode_ended` (with the supervisor's one-line reason),
`quota_pause` (with `resetAt`), `budget_threshold` (a budget at 80% of the
run's budget), `run_resumed`, `run_stopped`. With `--json` it prints
`{ outcome, events, summary, cursor }`. Pass the last `cursor` back with
`--since` so nothing is reported twice or lost. Exit 0: events or the run is
not running; 2: timeout, nothing new (the cursor is unchanged); 3: the
controller died with the state still running; 1: error.

**Claude Code.** Run in the background (the Bash tool's background option);
you are notified when it exits:

```sh
graphloom wait <run> --until progress --since "$(cat .graphloom-watch/cursor 2>/dev/null)" --timeout 20m --json > .graphloom-watch/wake.json
```

On the first arm there is no cursor yet: leave `--since` out. For hands-off
periodic checks the user can also start `/loop 30m /graphloom-watch <run>`.

**Codex and opencode.** No background-command notifications: loop in the
foreground, one wait at a time, reporting after each return (a 10-minute
timeout keeps each call within the shell tool's limits):

```sh
graphloom wait <run> --until progress --since "$(cat .graphloom-watch/cursor)" --timeout 10m --json
```

On the first arm there is no cursor yet: leave `--since` out. The `--on-stop`
marker file is the push signal in every agent: check
`.graphloom-watch/stopped` on every wake.

## 2. On each wake

1. Read the wait output (`wake.json`, or the foreground output). Save its
   `cursor` to `.graphloom-watch/cursor`.
2. Snapshot the run:

   ```sh
   graphloom stats <run> --json
   graphloom inspect <run>
   ```

3. Load the previous snapshot from `.graphloom-watch/snapshot.json` and
   compare. Keep in the new snapshot: time, status, mode, `current` stage and
   attempt, stages complete, each budget's `used`/`granted`/`left`, supervisor
   episode count, the last few episode triggers and reasons (from the wait
   events), remedy count, evidence record count, and `lastEvidenceAt` (the time
   the evidence count last went up). Write it back.
4. Report **only the deltas**, a few lines:
   - stage / attempt change ("review, attempt 2 (was fix#1)");
   - stages newly accepted (`receipt_accepted`, stage complete or not);
   - budget use against limits for budgets that moved ("agentInvocations
     412/1200, 34%");
   - each new supervisor episode, with its trigger and one-line outcome;
   - waiting states: a quota pause with `resetAt` ("waiting for the harness
     quota until 14:05 UTC; nothing to do"), `summary.waiting` reconcile.
5. Nothing changed: one quiet line, such as "run 1a2b running, review#1, no
   change in 20m", then re-arm.

## 3. Flags (say them first, plainly)

- **Stall**: no new evidence for more than 45 minutes while running and not
  in a quota wait (`summary.waiting`). Suggest the user look; do not act.
- **Budget > 80%**: any `budget_threshold` event or snapshot ratio over 0.8.
  State the number and which stage is spending it. Never propose raising it
  here; that is a triage decision after diagnosis.
- **Repeated identical failure**: the same stage re-entered with the same
  invalidated requirements, or consecutive episodes with the same trigger
  code and message. Name the stage and the repeated failure.
- **Waiting for a human**: the run stopped, or `summary.waiting.kind` is
  `reconcile` (a usage limit cut off a job with possible effects).

## 4. Stopped

When `summary.status` is not `running`, a `run_stopped` event arrives, the
marker file exists, or wait exits 3: stop arming. Report status, stop reason,
retryable or final, the blocker, and any question the stop asks, quoted
verbatim from `graphloom inspect`. Then ask the user what to do next and end
your turn. Do not resume, do not start graphloom-triage or graphloom-deliver
yourself, and do not answer the run's questions: offer them as next steps
(triage for a stop the user wants diagnosed, deliver for `succeeded`).
