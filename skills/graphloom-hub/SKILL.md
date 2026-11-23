---
name: graphloom-hub
description: Drive GraphLoom runs through the run hub, the operator's systemd user service that queues submissions under a concurrency limit and continues them automatically. Checks the hub is reachable (never starts it), submits a checked task with graphloom hub submit, reports status with hub list and hub inspect panels, pauses, cancels, resumes (with --approve, --decline, --reconciled, --update-plugin, --upgrade remedies the user chose), reads launch logs, sets the concurrency limit, archives finished submissions, and searches past and archived submissions with hub list filters. Every control action only on the user's yes; never diagnoses, fixes or answers a run's questions. Use when the user wants to submit, check, stop, resume or find runs on the hub.
---

# Drive runs through the GraphLoom hub

The hub (`graphloom hub serve`) is a daemon the operator runs as a systemd
user service. It keeps a durable queue of **submissions**, starts at most
`maxConcurrentRuns` runs at once (one **run slot** each), and continues a run
by itself after a provider cooldown or a transient failure, within the
submission's retry policy. A submission keeps one run id across every resume.
Every `graphloom hub` command talks to it over a Unix socket
(`$XDG_RUNTIME_DIR/graphloom/hub.sock`; `GRAPHLOOM_HUB_SOCKET` names another).

## Hard rules

- **Never start, stop or restart the hub.** No `graphloom hub serve`, no
  `systemctl --user start|stop|restart`. The hub is the operator's service;
  when it is unreachable, say so and give the operator the command (section 1).
- **Control only on a yes.** `hub submit`, `hub pause`, `hub cancel`,
  `hub resume`, `hub limit`, `hub policy` and `hub archive` change what runs.
  Show the exact command and run it only after the user says yes to it.
  `hub cancel` cannot be undone. `hub limit` affects every queued run.
- **Report; never diagnose, fix or answer.** On a blocked, failed or paused
  submission, quote its blocker and ask the user what to do; offer
  graphloom-triage for a diagnosis. Never answer an approval or a question the
  run asks, never pass `--reconciled` without the user having reconciled,
  never renew a retry allowance or raise a budget on your own.
- **No placeholder reaches a run.** Task-writing rules are graphloom-run's
  (an unfilled `<...>`, `TODO`, `TBD` is a question for the user).
- Ask before anything outward-facing (push, pull request, issue creation,
  release).
- Never print or ask for a token or secret. A hub run gets its tokens from
  the hub service's environment, not from your shell.
- Read run state only through `graphloom hub status`, `graphloom hub list`,
  `graphloom hub inspect`,
  `graphloom inspect`, `graphloom stats` and `graphloom wait`;
  never edit `state.json` or the hub's `scheduler.json`.
- Use only commands and flags `graphloom --help` and `graphloom hub --help`
  list.
- Never decide liveness with `pgrep`, `ps | grep` or `kill -0` (a `pgrep -f`
  pattern matches its own shell and once hid a stop for two hours): the hub's
  scheduling state and the run's durable state are the truth.

## 1. Is the hub reachable?

```sh
graphloom hub status
```

Exit 0: the hub answers and has no fault. It prints `Hub <id> · healthy`,
the GraphLoom version it runs, its socket, `Limit <n> · occupied <n>/<limit> ·
queued <n>`, and per-state counts. A `Retention error:`, `Monitoring error:`
or `Archive index error:` line is worth quoting to the user, but the hub still
admits work.

Exit 3: the hub answers but is `FAULTED` (a persistence or reconciliation
fault, printed as `Fault: ...`) or shutting down. It admits nothing new until
the operator fixes it; quote the fault.

Exit 1 (`cannot reach hub at <socket>`): no hub is serving that socket.
Tell the user, and that the operator starts the service, for example:

```sh
systemctl --user status graphloom-hub.service
systemctl --user start graphloom-hub.service
```

(the unit is whatever name the operator installed `graphloom hub service`'s
output under; `journalctl --user -u graphloom-hub.service` shows why it
stopped). Do not run the start yourself. Until it serves, a new run can still
start directly with graphloom-run, outside the hub's limit; the user chooses.

In a script, `graphloom hub status --json` prints `reachable` and `healthy`
(and, when reachable, `version`, `counts`, `fault`). A hub older than
`hub status` refuses the command (`unknown hub command status`); then fall
back to `graphloom hub list`: exit 0 means reachable, and a `Fault:` line is a
fault.

## 2. Submit a run

**Write and check the task** exactly as graphloom-run sections 1 and 2 say
(fresh base, `graphloom task new` for graphs that prepare their own task,
`graphloom check task.yaml`, `graphloom doctor --task task.yaml`). Confirm
the task with the user.

**Mind what the hub does not take from your shell.** The run's command jobs
and its runner config's token variables (`github.tokenEnv`, `writeTokenEnv`)
come from the **hub service's environment**, and the service's `PATH` is the
toolchain. When the repository pins a toolchain your shell would prefix on
`PATH`, or the graph needs a token the user would export, ask the user
whether the service's environment provides it (never read it); if not, start
this run directly with graphloom-run. The same holds for the agents' logins:
Claude Code finds its login through `CLAUDE_CONFIG_DIR` (and Codex through
`CODEX_HOME`) when the user sets one in their shell profile; the service needs
the same value, or the run's agent jobs fail to authenticate (`401 … OAuth
access token is invalid`). When a hub run's first agent job fails that way,
tell the user which variable the service lacks; don't retry the run.

**Submit** with a key that names the work, so a retry after an uncertain
reply never makes a second run, and record the submission beside the task:

```sh
graphloom hub submit task.yaml --key fix-widgets-42
mkdir -p .graphloom-watch
printf '%s\n' <submission-id> > .graphloom-watch/submission
```

stderr prints `submission key: <key>`; stdout is the submission as JSON
(`id`, `runId`, `state`, `queueSequence`). After a timeout or lost reply, run
the same command with the same key: the same task returns the same
submission; a different task with that key is refused. Without `--key` every
submit is a new run. The task, profile, base commit and bundle are captured
at submission; editing them later changes nothing for it, and a bundle or
runtime config that changes before the first start blocks the submission.

**Hand over** to graphloom-watch, which watches hub submissions too. The
run's state directory is `~/.local/state/graphloom/hub/runs/<runId>`
(`$XDG_STATE_HOME`, or the hub config's `directory`, moves it); it exists once
the run has started.

## 3. Status

| State | Means |
|---|---|
| `queued` | Waiting for a slot (or its eligible time) |
| `starting`, `running` | Holds a slot; the run is launching or working |
| `stopping` | A pause or cancel is draining the run |
| `waiting` | Stopped safely; the hub continues it at `Next eligible` by itself (cooldown or automatic retry). Nothing to do |
| `paused` | Held by an operator `hub pause`; holds no slot |
| `blocked` | Needs a person: an approval, reconciliation, budget, pin drift, a failed launch, or the retry allowance is spent; the blocker says which |
| `succeeded`, `failed`, `canceled` | Terminal |

```sh
graphloom hub inspect <submission>
graphloom hub inspect <submission> --panel overview --panel topology
graphloom hub inspect <submission> --panel usage
graphloom hub inspect <submission> --panel stages --panel jobs
graphloom hub inspect <submission> --panel activity
graphloom hub inspect <submission> --panel job --job <operation-id> --attempt 2
graphloom hub inspect <submission> --panel output --job <operation-id>
```

`<submission>` is the submission id or the run id. Without `--panel` it shows
`overview`: status, graph, current stage and attempt, `Blocker`,
`Next eligible`, hub slots. `topology` is the live path and the declared
graph; `stages` and `jobs` are progress; `usage` is budgets, model calls,
tokens and CPU/memory with their coverage; `activity` is recent events;
`job` and `output` are one job's detail and output (name it with `--job`, an
operation id from `jobs`). Default `--format text` is for you; to show a panel
in chat use `--format markdown` (plain unless the user asked for
`--chat-renderer katex` and their host renders it); `--format json` is for
`jq`. A truncated panel names the `--cursor <cursor>` or `--page-size <n>`
that continues it. A one-line status from `hub list` is usually enough; open
panels when the user asks for detail.

`graphloom hub watch` (all submissions) and `graphloom hub watch <submission>`
are the user's live terminal views; they never exit by themselves, so suggest
them to the user rather than running them. For one snapshot through it, use
`graphloom hub watch <submission> --once --plain`.

## 4. Logs

```sh
graphloom hub logs <submission>
graphloom hub logs <submission> --stream stdout
```

The latest launch's stderr (default) or stdout, bounded; `--launch <id>` names
an earlier launch. `--follow` keeps streaming and never exits: suggest it to
the user for their terminal, do not run it as a tool call.

## 5. Stop: pause or cancel

| | `graphloom hub pause <submission>` | `graphloom hub cancel <submission>` |
|---|---|---|
| Running work | Stopped cooperatively at a safe point, drained | Stopped and drained |
| Afterwards | `paused`; no slot; no automatic resume | `canceled`, permanently |
| Continue | `graphloom hub resume <submission>` | Only with a new submission, which is a new run |
| Kept | Run state, worktree, budgets | Run state and worktree (no run continues them) |

Pause is what the user almost always means by "stop". Both reply at once with
the accepted command (stderr: `command id: <id>`); the state shows `stopping`
until drained. A pause or cancel wins over any scheduled automatic retry.
On a hub run, `graphloom stop` is the same as `hub pause`.

## 6. Resume

```sh
graphloom hub resume <submission>
graphloom hub resume <submission> --approve <approval-id> --input <name>=<value>
graphloom hub resume <submission> --decline <approval-id> --reason "<why>"
graphloom hub resume <submission> --reconciled
graphloom hub resume <submission> --update-plugin
graphloom hub resume <submission> --update-executors
graphloom hub resume <submission> --upgrade
graphloom hub resume <submission> --supervisor <harness>
```

A plain resume lifts a pause or asks for another attempt; it joins the queue
behind ready work and never bypasses the limit. A remedy means exactly what it
means for `graphloom resume` (see graphloom-triage) and is applied once by the
run's owning GraphLoom under the run lock:

- `--approve <id>` (with each declared `--input <name>=<value>`) and
  `--decline <id>` record the user's decision on a declared approval. Only the
  user decides; ask which, and for the input values. Never guess.
- `--reconciled` only after the user reconciled the worktree and external
  state; `--update-plugin`, `--update-executors`, `--upgrade`, `--supervisor`
  only for the cause triage found.
- A remedy needs a drained submission with no pending command, and a run that
  initialized. A submission blocked by `initialization-failed` takes only a
  plain `hub resume`. `succeeded` and `canceled` submissions cannot resume.

The reply is the accepted command, not the result; follow it with
`hub list` or graphloom-watch. `graphloom resume` on a hub run is routed to
the hub too, and refuses `--on-stop`.

**Retry allowance.** Automatic resumes are bounded per submission (default 5
in 24 hours; three identical failures without progress block). A submission
blocked with `automatic retry allowance ... exhausted` stays blocked until the
user decides. Renewing it is a policy change, only after the cause is known
(graphloom-triage) and on the user's yes:

```sh
graphloom hub policy <submission> --renew
graphloom hub policy <submission> --automatic false
```

## 7. Concurrency limit

```sh
graphloom hub limit 3
```

Sets the hub-wide `maxConcurrentRuns` at once and durably. Lowering it never
kills a run: `hub list` shows `occupied 4/2 · new starts held` until runs
finish. `0` admits nothing new; current runs finish. Raising it starts queued
runs at once. It applies to every user of this hub: ask first.

## 8. Archive

```sh
graphloom hub archive <submission>
```

Only a `succeeded`, `failed` or `canceled` submission whose run has drained.
It leaves `hub list`'s queue; its run state, worktree and branch stay; its key
stays reserved (submitting the same task with it returns the archived result,
never a new run). The hub keeps a compact entry for it in its archive index
(id, run id, key, graph, repository, task path, request first line, times,
final state, state directory, blocker), which `hub list --archived` searches.
The index is bounded (the newest 5,000 entries); older entries drop out of
search, but their runs stay on disk. Ask first.

## 9. Search past submissions

`graphloom hub list` with any filter searches, newest first; `--archived`
adds archived submissions (marked `(archived)`):

```sh
graphloom hub list --state blocked --state failed
graphloom hub list --repo widgets --since 3d
graphloom hub list --repo . --limit 10
graphloom hub list --graph issue-fix --grep "flaky test" --archived
graphloom hub list --key fix-widgets-42 --archived
graphloom hub list --since 2026-11-01 --until 2026-11-08 --archived --limit 50
```

| Flag | Matches |
|---|---|
| `--state <s>` | Any of the given states (repeat it); an archived entry's final state |
| `--graph <id>` | The task's graph |
| `--repo <path-or-text>` | A path (starting with `/`, `.` or `~`) is the exact repository; other text is part of its path |
| `--key <text>` | Part of the idempotency key |
| `--since`, `--until` | Accepted at or after / at or before an ISO time, or a duration ago (`90s`, `10m`, `2h`, `3d`, `1w`) |
| `--grep <text>` | Text in the request or the blocker, any case (an archived entry keeps only the request's first line) |
| `--limit <n>` | The newest `n` matches; the header says `<n> of <total>` |

Each line is `<acceptedAt>  <submission>  <state>  <runId>  <graph>
<request first line>`, then `blocker: ...` when there is one. `--json` gives
the same matches as `submissions` (full records), `summaries` (graph and
request line per submission), `archived` (index entries, each with
`stateDir`) and `matched`. Reach for `jq` on `--json` only for a field the
flags do not cover (for example `automaticResumes` or `launch.failure`):

```sh
graphloom hub list --state blocked --json | jq '.submissions[] | {id, automaticResumes, failureRepeats, launch}'
```

For a hub older than these flags (`--state is not valid for hub list`), fall
back to `graphloom hub list --json | jq '.submissions[] | select(...)'`; it
returns only the queue, not archived submissions.

For one run's history, open its state: `graphloom inspect <runId> --state-root
~/.local/state/graphloom/hub/runs` (status, stop reason, path, visits,
remedies) and `graphloom stats <runId> --state-root
~/.local/state/graphloom/hub/runs` (what each stage used). An archived
entry's `stateDir` names that directory. A submission archived before the hub
had its archive index, or evicted from it, is found only there, by run id:
list `~/.local/state/graphloom/hub/runs/` and inspect the candidates.
