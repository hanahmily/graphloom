---
name: graphloom-watch
description: Watch a running GraphLoom run with graphloom watch, which does the watching in code and wakes the agent only for a report - an important move (stage entered or accepted, supervisor episode, quota pause, resume), a 15-minute heartbeat, or something needing attention (a stop, a human needed, a stall, a budget over 80%, a repeated failure, a dead controller). Claude Code runs it as a background command and re-arms; Codex and opencode loop in the foreground and re-arm silently on a timeout. Relays moves and heartbeats in one or two lines; on attention reports and asks the user. Never diagnoses, fixes or resumes a run, answers its questions, or changes a budget. Use after graphloom-run, when a message starting with [graphloom watch] arrives, or when the user asks how a run is doing.
---

# Watch a GraphLoom run

Input: the run's state directory (or run id with `--state-root`). graphloom-run
records it in `.graphloom-watch/run`. Below, `<run>` is that reference. Run
every command from the task directory: `graphloom watch` keeps its cursor and
snapshot in `.graphloom-watch/` beside the task, so nothing is reported twice.

## Hard rules

- **Watch only.** Never `graphloom resume`, `graphloom stop`, `graphloom
  switch-model`, or change a budget. When the run stops, report why and ask
  the user what to do; do not diagnose, fix, resume or answer the run's
  questions on your own. The user decides, and may ask for graphloom-triage.
- Ask before anything outward-facing (push, pull request, issue creation,
  release).
- Never print or ask for a token or secret; do not dump environment variables.
- Read run state only through `graphloom watch` (and, when the user asks for
  detail, `graphloom inspect` and `graphloom stats`); never edit `state.json`
  (nor hand-parse and rewrite it).
- Use only commands and flags `graphloom --help` lists.
- Never decide liveness with `pgrep`, `ps | grep` or `kill -0`: a `pgrep -f`
  pattern matches its own shell and hid a stop for two hours once. `graphloom
  watch` reads the durable state and the controller's owner claim.

## 1. What `graphloom watch` does

`graphloom watch <run>` holds the rules; you do not diff snapshots, call
`graphloom inspect` or `graphloom stats`, or write prose about nothing. It
returns only when it has a report, each a short message whose first line is
`[graphloom watch] <kind> · run <id> · <status> · <stage>#<attempt>`:

- `move`: a stage entered (or a new attempt) or accepted, a supervisor
  episode started or ended, a quota pause started or ended, the run resumed.
  Moves within a minute arrive as one report.
- `heartbeat`: nothing reported for 15 minutes while running; status, stage,
  elapsed time, invocations used, age of the last evidence.
- `attention`: the run stopped (reason, retryable or final, blocker, and any
  question it asks, quoted), a reconciliation waits for a human, no new
  evidence for 45 minutes outside a quota wait, a budget over 80%, a repeated
  identical failure, or the controller died.

Exit 0: a report was printed. Exit 2: the timeout elapsed, nothing to report.
Exit 3: the controller died with the state still running (also an attention
report). Exit 1: an error; show it and stop.

## 2. Arm it

**Claude Code.** Run in the background (the Bash tool's background option);
you are notified when it exits:

```sh
graphloom watch <run> --until report --json
```

After relaying the report (section 3), re-arm the same command, unless the run
stopped.

**Codex and opencode.** No background-command notifications: loop in the
foreground, one call at a time (a 9-minute timeout keeps each call within the
shell tool's limits):

```sh
graphloom watch <run> --until report --timeout 9m
```

Exit 2 means nothing to report: run the command again at once, with no prose,
no `graphloom inspect` and no `graphloom stats`. Exit 0 is a report: handle it,
then run it again unless the run stopped.

**A message from the HAPI watcher.** When graphloom-run started a detached
watcher (it runs inside a HAPI session), reports arrive as messages beginning
with `[graphloom watch]`. Do not arm anything; handle the message by its last
line, as below.

## 3. On a report

Follow the report's last line.

- `move` or `heartbeat` (it ends "Relay this to the user in one or two
  lines. Make no tool calls."): say it to the user in one or two lines and make
  no tool calls. Then re-arm.
- `attention` (it ends "Report this to the user and ask what to do next. Do
  not resume, fix, or answer the run's questions."): say plainly what needs
  attention, quote any blocker or question verbatim, and ask the user what to
  do next; then end your turn. Do not re-arm after a stop, do not resume, do
  not start graphloom-triage or graphloom-deliver yourself, and do not answer
  the run's questions: offer them as next steps (triage for a stop the user
  wants diagnosed, deliver for `succeeded`). For a stall, a budget over 80% or
  a repeated failure on a run that is still running, report it, ask, and
  re-arm only if the user says to keep watching. Never propose raising a
  budget here; that is a triage decision after diagnosis.

With `--json` the output is `{ outcome, reports, summary }`; each report's
`message` is the text above, `kind` is `move`, `heartbeat` or `attention`.
