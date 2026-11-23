---
name: graphloom-watch
description: Watch a running GraphLoom run with graphloom watch, which does the watching in code and wakes the agent only for a report - an important move (stage entered or accepted, supervisor episode, quota pause, resume), a 15-minute heartbeat, or something needing attention (a stop, a human needed, a stall, a budget over 80%, a repeated failure, a dead controller). Claude Code runs it as a background command and re-arms; Codex and opencode loop in the foreground and re-arm silently on a timeout. Relays moves and heartbeats in one or two lines; on attention reports and asks the user. Never diagnoses, fixes or resumes a run, answers its questions, or changes a budget. For a hub submission it reads the hub state, so a stop the hub continues by itself is relayed, not raised. Use after graphloom-run, when a message starting with [graphloom watch] arrives, or when the user asks how a run is doing.
---

# Watch a GraphLoom run

Input: the run's state directory (or run id with `--state-root`). graphloom-run
records it in `.graphloom-watch/run`. Below, `<run>` is that reference. Run
every command from the task directory: `graphloom watch` keeps its cursor and
snapshot in `.graphloom-watch/` beside the task, so nothing is reported twice.
A run submitted to the hub also has `.graphloom-watch/submission` (its
submission id); section 4 adds what that changes.

## Hard rules

- **Watch only.** Never `graphloom resume`, `graphloom stop`, `graphloom
  switch-model`, a hub control command (`graphloom hub pause`, `cancel`,
  `resume`, `limit`, `policy`, `archive`), or change a budget. When the run
  stops, report why and ask
  the user what to do; do not diagnose, fix, resume or answer the run's
  questions on your own. The user decides, and may ask for graphloom-triage.
- Ask before anything outward-facing (push, pull request, issue creation,
  release).
- Never print or ask for a token or secret; do not dump environment variables.
- Read run state only through `graphloom watch`, for a hub submission also
  `graphloom hub list` and `graphloom hub inspect` (and, when the user asks
  for detail, `graphloom inspect` and `graphloom stats`);
  never edit `state.json` (nor hand-parse and rewrite it).
- Use only commands and flags `graphloom --help` lists.
- Never decide liveness with `pgrep`, `ps | grep` or `kill -0`: a `pgrep -f`
  pattern matches its own shell and hid a stop for two hours once. `graphloom
  watch` reads the durable state and the controller's owner claim.

## 1. What `graphloom watch` does

`graphloom watch <run>` holds the rules; you do not diff snapshots, call
`graphloom inspect` or `graphloom stats`, or write prose about nothing. It
returns only when it has a report, each a short message whose first line is
`[graphloom watch] <kind> · run <id> · <status> · <stage>#<attempt>`:

- `move`: a stage entered (or a new attempt) or accepted, the supervisor
  entering a supervisor-only node or that node settling, a supervisor
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
you are notified when it exits. This is only the watcher: if the tool's time
limit ends it, it just exits and you re-arm it, which never affects the run
(the run itself is started detached, see graphloom-run):

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

## 4. A hub submission

The hub (see graphloom-hub) queues a submission until a slot is free, and
continues its run by itself after a provider cooldown or a transient failure:
the run stops, the submission is `waiting`, and the hub relaunches the same
run later. `graphloom watch` reports such a stop like any other and returns at
once while the run is not running, so for a hub submission the hub's state
decides what a stop means. `graphloom hub watch` is the user's live terminal
view and never exits; do not arm it.

Write, once, a helper that waits while the hub starts or continues the
submission by itself (bounded, default 9 minutes) and prints its hub state
(it needs `jq`; without it, ask the user):

```sh
cat > .graphloom-watch/hub-wait.sh <<'EOF'
id=$(cat "$(dirname "$0")/submission"); n=0
while :; do
  s=$(graphloom hub list --json | jq -r --arg id "$id" '.submissions[] | select(.id == $id) | if .state == "running" and .observation.status != "running" then "starting" else .state end')
  case "$s" in queued|starting|stopping|waiting) ;; *) break ;; esac
  n=$((n + 1)); [ "$n" -ge "${1:-9}" ] && break
  sleep 60
done
echo "hub state: ${s:-unknown}"
EOF
```

Run `sh .graphloom-watch/hub-wait.sh` the way section 2 runs `graphloom
watch` (Claude Code in the background, Codex and opencode in the
foreground), and act on its line:

- `queued`, `starting`, `stopping` or `waiting`: the hub is still on it; run
  it again, silently.
- `running`: the run works. On its first start, record its state directory,
  `~/.local/state/graphloom/hub/runs/<runId>` (from `graphloom hub list`), in
  `.graphloom-watch/run`, then arm `graphloom watch` as in section 2.
- `paused`, `blocked`, `failed`, `canceled`, `succeeded` or `unknown`: an
  attention. Read `graphloom hub inspect <submission>` (overview: status,
  `Blocker`, `Next eligible`), quote the blocker, and ask the user what to do
  (`unknown`: the hub is unreachable or the submission archived; see
  graphloom-hub section 1). Offer graphloom-deliver for `succeeded`.

**When `graphloom watch` reports the run stopped**, before treating it as an
attention, look at the hub with `graphloom hub list`. If the submission is
`waiting` or `queued`, or still `running` or `stopping` while it settles,
the hub continues it: relay the stop reason and `Next eligible` (from
`graphloom hub inspect <submission>`) in one line, do not ask, and go back to
`hub-wait.sh`. Any other state is the attention above.

**Inside a HAPI session**, graphloom-run starts one detached loop instead,
which watches each launch and messages the session; handle its messages as
in section 3. A `[graphloom watch]` stop of a hub submission that the hub
continues (as above) is relayed in one line, with nothing armed:

```sh
cat > .graphloom-watch/hub-hapi.sh <<'EOF'
cd "$(dirname "$0")/.." || exit 1
while :; do
  s=$(sh .graphloom-watch/hub-wait.sh)
  case "$s" in
    "hub state: running") graphloom watch "$(cat .graphloom-watch/run)" --until stop --notify 'hapi ping-peer "$HAPI_SESSION_ID" --message-file -' ;;
    "hub state: queued"|"hub state: starting"|"hub state: stopping"|"hub state: waiting") ;;
    *) break ;;
  esac
done
printf '[graphloom watch] attention · submission %s · %s\nReport this to the user and ask what to do next. Do not resume, fix, or answer its questions.\n' "$(cat .graphloom-watch/submission)" "$s" | hapi ping-peer "$HAPI_SESSION_ID" --message-file -
EOF
setsid nohup sh .graphloom-watch/hub-hapi.sh >/dev/null 2>&1 &
```

It needs `.graphloom-watch/run` before the run's first start: write the
state directory from the submission's run id first.
