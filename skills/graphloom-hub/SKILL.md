---
name: graphloom-hub
description: Drive GraphLoom runs through the run hub, the operator's systemd user service that queues submissions under a concurrency limit and continues them automatically. Checks the hub is reachable (never starts it), submits a checked task with graphloom hub submit, submits rehearsals (hub submit --rehearsal) that exercise the hub on stand-ins with no model calls, reports status with hub list and hub inspect panels, pauses, cancels, resumes (with --approve, --decline, --reconciled, --update-plugin, --upgrade remedies the user chose), reads launch logs, sets the concurrency limit, archives finished submissions, and searches past and archived submissions with hub list filters. Every control action only on the user's yes; never diagnoses, fixes or answers a run's questions. Use when the user wants to submit, check, stop, resume or find runs on the hub.
---

# Drive runs through the GraphLoom hub

The hub (`graphloom hub serve`) is the operator's systemd user service. It
keeps a durable queue of **submissions**, runs at most `maxConcurrentRuns` at
once (one **run slot** each), and continues a run by itself after a provider
cooldown or transient failure, within its retry policy. A submission keeps one
run id across every resume.
Every `graphloom hub` command talks to it over a Unix socket
(`$XDG_RUNTIME_DIR/graphloom/hub.sock`; `GRAPHLOOM_HUB_SOCKET` names another).

## Hard rules

- **Never start, stop or restart the hub.** No `graphloom hub serve`, no
  `systemctl --user start|stop|restart`: it is the operator's service; when
  unreachable, say so and give the operator the command (section 1).
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
- Read run state only through `graphloom hub status|list|inspect`,
  `graphloom inspect`, `graphloom stats` and `graphloom wait`;
  never edit `state.json` or the hub's `scheduler.json`.
- Use only commands and flags `graphloom --help` and `graphloom hub --help` list.
- Never decide liveness with `pgrep`, `ps | grep` or `kill -0` (a `pgrep -f`
  pattern matches its own shell): the hub's scheduling state and the run's
  durable state are the truth.

## 1. Is the hub reachable?

```sh
graphloom hub status
```

Exit 0: the hub answers with no fault: `Hub <id> · healthy`, its GraphLoom
version, socket, `Limit <n> · occupied <n>/<limit> · queued <n>`, per-state
counts. Quote any `Retention error:`, `Monitoring error:` or `Archive index
error:` line; the hub still admits work. `Installed: GraphLoom <v> is current,
the hub runs <old>`: the operator's `graphloom hub service --refresh` is due.
`Restart pending ...`: it restarts on the new version once running launches
finish, starting none meanwhile. Quote either.

Exit 3: the hub is `FAULTED` (persistence or reconciliation, `Fault: ...`) or
shutting down, and admits nothing new until the operator fixes it; quote it.

Exit 1 (`cannot reach hub at <socket>`): no hub serves that socket. Tell the
user the operator starts the service, for example:

```sh
systemctl --user status graphloom-hub.service
systemctl --user start graphloom-hub.service
```

(`journalctl --user -u graphloom-hub.service` shows why it stopped).
Never run the start yourself. Meanwhile a run can start directly with
graphloom-run, outside the hub's limit; the user chooses.

`graphloom hub status --json`: `reachable`, `healthy` (and `version`,
`counts`, `fault`). A hub older than `hub status` refuses it: use `graphloom
hub list` (exit 0: reachable; a `Fault:` line is a fault).

## 2. Submit a run

**Write and check the task** as graphloom-run sections 1 and 2 say (fresh
base, `graphloom task new` for graphs that prepare their own task,
`graphloom check task.yaml`, `graphloom doctor --task task.yaml`); confirm it
with the user.

**The hub does not take your shell's environment.** Command jobs, agent CLIs
and logins, and the runner config's token variables (`github.tokenEnv`,
`writeTokenEnv`) come from the **hub service's environment** (its `PATH` is
the toolchain). `graphloom hub doctor --task task.yaml` runs the doctor's
checks inside the hub: exit 1 means one fails there even if `graphloom
doctor` passes in your shell. `graphloom hub status` names the hub's `PATH`
head, where `claude`/`codex` resolve, the token variables set, a `Warning:`
per missing agent CLI. On a failure, quote it: the operator refreshes the
service's environment (`graphloom hub service --capture-env`,
`--token-env-file` for tokens, then a restart; never you), or the run starts
directly with graphloom-run. A missing `CLAUDE_CONFIG_DIR`/`CODEX_HOME`
fails agent jobs with `401 … OAuth access token is invalid`; name it, don't
retry.

**Submit** with a key that names the work, so a retry after an uncertain
reply never makes a second run, and record the submission beside the task:

```sh
graphloom hub submit task.yaml --key fix-widgets-42
mkdir -p .graphloom-watch
printf '%s\n' <submission-id> > .graphloom-watch/submission
```

First the hub runs that doctor for the task (**preflight**): a failing check
refuses the submission (exit 1, `preflight refused ...`, each check with its
`fix:`), queuing nothing; quote it as above. `--no-preflight` only when the
user asks. Warnings pass; a rehearsal is checked only for what its stand-ins
do not replace.
stderr prints `submission key: <key>`; stdout is the submission as JSON
(`id`, `runId`, `state`, `queueSequence`). After a timeout or lost reply, rerun
it with the same key: the same task returns the same submission; a different
task with that key is refused. Without `--key` every submit is a new run.
Task, profile, base commit and bundle are captured at submission; later edits
change nothing (a bundle or runtime config changed before the first start
blocks it).

**Hand over** to graphloom-watch, which watches hub submissions too. The run's
state directory is `~/.local/state/graphloom/hub/runs/<runId>`
(`$XDG_STATE_HOME` or the hub config's `directory` moves it).

### 2.1 Rehearse through the hub

To exercise the hub or a graph's journey with no model call, submit a
**rehearsal** (on a yes), queued and run like any submission on
`graphloom rehearse`'s stand-ins.

```sh
graphloom hub submit task.yaml --rehearsal --scenario operator --commands stub --offline
```

`--scenario`, `--commands`, `--offline` and `--stop-at <stage>` need
`--rehearsal`. Its key is scoped apart (`rehearsal:<key>`); it takes a slot.
`hub list` marks it `[rehearsal <scenario>: <verdict>]`; `hub list --json` has
the verdict and each B-check under `rehearsals`. Report it; for `not-ready`
quote the blocker. An approval stop blocks it as a real run (section 6).

`--offline` asks no GitHub: shipped scenarios replay recorded reads.
issue-fix's are for `--commands run` (checks read real test output) on a task
naming the issue they replay; the review graphs' stop at Publish with
`posting not enabled` (a rehearsal never posts).
`--stop-at <stage>` (id or name) stops once that stage is accepted, as
`graphloom rehearse --stop-at` does: the verdict is the stop's (`ready` when
it stopped there), the submission shows `blocked`, and a plain `hub resume` on
a yes continues it on the stand-ins.

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

`<submission>` is the submission or run id. Default panel `overview` (status,
graph, current stage and attempt, `Blocker`, `Next eligible`, slots);
`topology`: live path and declared graph; `stages`, `jobs`: progress; `usage`:
budgets, model calls, tokens, CPU/memory; `activity`: recent events; `job`,
`output`: one job (`--job`, an operation id from `jobs`). `--format text`
(default) is for you; in chat `--format markdown` (`--chat-renderer katex`
only when the user asked and their host renders it); `--format json` for
`jq`. A truncated panel names the `--cursor <cursor>` or `--page-size <n>`
that continues it. `hub list`'s line is usually enough; open panels on request.

`graphloom hub watch [<submission>]` is the user's live view and never exits:
suggest it. One snapshot: `graphloom hub watch <submission> --once --plain`.

## 4. Logs

```sh
graphloom hub logs <submission>
graphloom hub logs <submission> --stream stdout
```

The running (else latest) launch's stderr (default) or stdout, bounded;
`--launch <id>` names an earlier one. `--follow` never exits: suggest it for
the user's terminal, never as a tool call.

## 5. Stop: pause or cancel

| | `graphloom hub pause <submission>` | `graphloom hub cancel <submission>` |
|---|---|---|
| Running work | Stopped cooperatively at a safe point, drained | Stopped and drained |
| Afterwards | `paused`; no slot; no automatic resume | `canceled`, permanently |
| Continue | `graphloom hub resume <submission>` | Only with a new submission, which is a new run |
| Kept | Run state, worktree, budgets | Run state and worktree (no run continues them) |

Pause is what the user usually means by "stop". Both reply at once (stderr:
`command id: <id>`), show `stopping` until drained, and win over a scheduled
automatic retry. On a hub run `graphloom stop` is `hub pause`.

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

A plain resume lifts a pause or asks for another attempt, queued behind ready
work, never past the limit. A remedy means what it means for `graphloom
resume` (graphloom-triage), applied once by the run's owning GraphLoom under
the run lock:

- `--approve <id>` (with each declared `--input <name>=<value>`) and
  `--decline <id>` record the user's decision on a declared approval. Only the
  user decides; ask which, and for the input values. Never guess.
- `--reconciled` only after the user reconciled the worktree and external
  state; `--update-plugin`, `--update-executors`, `--upgrade`, `--supervisor`
  only for the cause triage found.
- `--update-plugin` takes the plugin the task's `plugins/<graph>` link names
  when the hub accepts it, as `graphloom resume --update-plugin` does. To move
  a blocked run to a newer plugin, on the user's yes: install the newer
  GraphLoom (`graphloom upgrade` restarts the hub on it, at once or when
  idle); repoint the link if it names the old `versions/<old>/...`; then
  `graphloom hub resume <submission> --update-plugin` (`--upgrade` moves the
  run's GraphLoom too). A gone or
  dangling link is refused, naming it; an update the controller refuses
  (changed stages) keeps the pinned plugin, which a plain resume never changes.
- A rehearsal (2.1) resumes only as a rehearsal, at its script's next
  decision; it refuses `--supervisor`.
- A remedy needs a drained submission with no pending command and a run that
  initialized; one blocked by `initialization-failed` takes only a plain
  `hub resume`. `succeeded` and `canceled` submissions cannot resume.

The reply is the accepted command, not the result; follow it with `hub list`
or graphloom-watch; `lastResume` says what became of it (`refused` with the
run's reason; a pause keeps an unapplied one).
`graphloom resume` on a hub run is routed to the hub and refuses `--on-stop`.

**Retry allowance.** Automatic resumes are bounded per submission (default 5
in 24 hours; three identical failures without progress block). One blocked
with `automatic retry stopped: <limit>; last cause: <cause>` stays so until
the user decides; renewing is a policy change, only once the cause is known
(graphloom-triage) and on the user's yes:

```sh
graphloom hub policy <submission> --renew
graphloom hub policy <submission> --automatic false
```

A blocker `memory limit reached (<limit>)`: the launch hit `launchMemoryMax`
(retried once); `--panel usage` shows peak vs limit; `hub status`'s `Recorded
launch peaks:` line the highest and how many came within 80%. Raising it in
`hub.json` is the operator's.

## 7. Concurrency limit

```sh
graphloom hub limit 3
```

Sets the hub-wide `maxConcurrentRuns` at once, durably. Lowering never kills
a run (`occupied 4/2 · new starts held` until runs finish); `0` admits nothing
new; raising starts queued runs at once. It affects every user: ask first.

## 8. Archive

```sh
graphloom hub archive <submission>
```

Only a `succeeded`, `failed` or `canceled` submission whose run has drained.
It leaves `hub list`'s queue; run state, worktree and branch stay; its key
stays reserved (the same task with it returns the archived result, never a new
run). The archive index keeps a compact entry (ids, key, graph, repository,
task path, request first line, times, final state, state directory, blocker)
that `hub list --archived` searches; the newest 5,000, older ones drop out of
search but stay on disk. Ask first.

## 9. Search past submissions

`graphloom hub list` with any filter searches, newest first; `--archived`
adds archived submissions (marked `(archived)`):

```sh
graphloom hub list --state blocked --state failed
graphloom hub list --repo widgets --since 3d
graphloom hub list --repo . --limit 10
graphloom hub list --graph issue-fix --grep "flaky test" --archived
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

Each line: `<acceptedAt>  <submission>  <state>  <runId>  <graph>  <request
first line>`, then any `blocker: ...`. `--json`: `submissions` (full records),
`summaries` (graph, request line), `archived` (index entries with `stateDir`),
`matched`. Use `jq` on it only for a field the flags miss (e.g.
`automaticResumes`, `launch.failure`):

```sh
graphloom hub list --state blocked --json | jq '.submissions[] | {id, automaticResumes, failureRepeats, launch}'
```

On a hub older than these flags (`--state is not valid for hub list`), use
`graphloom hub list --json | jq '.submissions[] | select(...)'` (queue only).

One run's history, also for a run missing from the index: `graphloom inspect
<runId>` and `graphloom stats <runId>`; a bare run id is found under the
hub's runs (`~/.local/state/graphloom/hub/runs`, an archived entry's
`stateDir`) when the repository's own state root does not hold it.
