# GraphLoom run hub

Status: implemented in this worktree, with deployment qualification outstanding.
The local CLI, durable scheduler, managed controller/runner contract, reusable
panels and terminal watch are connected. This extends the
[core design](design-typescript-core.md) without changing graph topology,
acceptance, supervisor authority or run budgets.

The [throwaway panel prototype](../apps/graphloom/prototype-monitor-panels/README.md)
remains a fictional visual-review artifact. Production rendering now lives in
`packages/monitor`: text, ANSI, JSON and bounded Markdown/KaTeX, ELK topology with
complete adjacency fallback, and quantitative cell charts. Tests use fake
process drivers, real gated child processes with cgroup filesystem fixtures,
scripted controller runs and renderer fixtures. Real delegated
systemd/cgroup/container stop/restart qualification and deployed HAPI assistant
color qualification remain operational checks; no service was deployed as part
of implementation. Unknown chat hosts use plain output.

## 1. Outcome and scope

An operator starts one daemon and sets `maxConcurrentRuns`. Users submit tasks;
the hub queues them, starts GraphLoom CLI child processes when slots are available,
reports progress and resource use, and schedules eligible resumptions. A submission
keeps the same run ID across every resume. The queue survives daemon and machine
restarts.

The first version serves trusted users acting through one Linux account, on one
machine, through a Unix socket. Separate Unix accounts can run separate hubs with
separate credentials and limits. Network access, tenant isolation, multiple
machines, graph dependencies, and a web interface are later work. Existing direct
`graphloom run` remains available and outside the hub's limit; the limit is global
to one hub, not a machine-wide limit on arbitrary processes.

Monitoring means run status, stage progress, and resource usage: recorded model
calls, tokens and cost when available, budget consumption, elapsed/active time,
and process CPU/memory with explicit measurement coverage.
Usage rates supplement those totals. Provider cooldowns remain visible as waiting
states used by automatic continuation; enforcing provider rate limits is outside
the requested scope. The concurrency limit controls how many runs execute at once.

## 2. Ownership and package seam

```mermaid
flowchart TD
    U[CLI clients] --> H[Hub: durable queue and run slots]
    H --> A[GraphLoom CLI child: run A]
    H --> B[GraphLoom CLI child: run B]
    H --> Q[Queued and waiting submissions]
    A --> CA[Controller, plugin host, runner, supervisor]
    B --> CB[Controller, plugin host, runner, supervisor]
    CA --> SA[Run A state and evidence]
    CB --> SB[Run B state and evidence]
    SA -. observations .-> H
    SB -. observations .-> H
```

| Module | Owns |
| --- | --- |
| New `packages/hub` | Submissions, slot admission, launch journal, retry timing, process lifetime, hub observations |
| `apps/graphloom` | `hub` commands, socket transport, installed-version dispatch, managed child bootstrap |
| `packages/controller` | Run initialization, lock and ownership, evidence, receipts, budgets, reconciliation, structured continuation eligibility |
| `packages/runner` | Jobs, sandboxing, executor children and external execution cleanup |
| `packages/supervisor` | Investigation and recovery within a run |

The hub is a deep module: callers submit, inspect, and control submissions without
coordinating processes, persistence, or timers. Its private scheduler and process
adapter are tested through that interface. Graph plugins never import the hub;
they do not know whether their controller was started by a terminal or a daemon.

The hub never writes `state.json`, synthesizes receipts, edits a stopped run's
budgets, or diagnoses graph failures with another agent. It requests operations
from the CLI version that owns the run. Existing pinning and upgrade rules apply.

## 3. Operator interface

The CLI provides:

```sh
graphloom hub serve --config ~/.config/graphloom/hub.json
graphloom hub service --capture-env --token-env-file ~/.config/graphloom/hub-tokens.env --write
graphloom hub service --refresh
graphloom hub status
graphloom hub doctor --task ./tasks/fix/task.yaml
graphloom hub submit ./tasks/fix/task.yaml --key fix-14169
graphloom hub submit ./tasks/fix/task.yaml --rehearsal --scenario operator
graphloom hub list
graphloom hub list --state blocked --state failed --since 3d
graphloom hub list --archived --repo widgets --grep "crash" --limit 20
graphloom hub watch
graphloom hub watch <submission> --plain
graphloom hub inspect <submission>
graphloom hub inspect <submission> --panel topology --format text
graphloom hub inspect <submission> --panel topology --format ansi
graphloom hub inspect <submission> --panel overview --format markdown --chat-renderer katex
graphloom hub inspect <submission> --panel topology --stage review
graphloom hub inspect <submission> --panel job --follow-current
graphloom hub watch <submission> --panel usage
graphloom hub logs <submission> --follow
graphloom hub limit 3
graphloom hub pause <submission>
graphloom hub resume <submission>
graphloom hub cancel <submission>
graphloom hub archive <submission>
graphloom hub purge <submission>
graphloom hub purge --archived --before 30d --dry-run
```

`graphloom --help` lists every hub command; `graphloom hub --help` lists them
alone, and `graphloom hub <command> --help` prints one command's usage and a
short description. `inspect` and `watch` take `--stage <stage>` (narrow the
topology and job panels to one stage's neighbourhood) and `--follow-current`
(select the current stage's running job instead of naming one with `--job`).

`submit` returns immediately after durable acceptance with `submissionId`, the
reserved `runId`, queue position, and a reference usable by `hub inspect`.
`--key` is an optional idempotency key: the same key and request return the same
submission; different input with that key is a conflict. Without a key, submitting
the same task twice deliberately creates two runs. The CLI always generates and
prints a key **before its first request** unless `--key` supplies one, and reuses
it after an uncertain response. A new invocation gets a new key. Raw API clients
may omit a key, but cannot safely retry an uncertain unkeyed submission.
`--rehearsal` makes a rehearsal submission, whose run runs on stand-ins with no
model calls ([§12](#12-rehearsal-submissions)). Before it queues anything, the
hub runs the submission's preflight ([§3.3](#33-submit-preflight));
`--no-preflight` skips it.

`pause` records a hold and requests a cooperative stop if active. It returns the
new desired state immediately; `inspect` shows `stopping` until cleanup finishes.
`resume` removes a hold or requests another attempt and joins the queue. It never
bypasses capacity. `cancel` permanently withdraws the submission and drains any
active execution; it retains run state and worktree. Continuing a canceled task
requires a new submission. `archive` moves a terminal, drained submission out of
the queue into the archive index ([§4.1](#41-archive-index)) and keeps its run
files; `purge` removes an archived submission's run files
([§4.3](#43-purging-an-archived-submissions-run-files)). `limit 0` stops new admissions and lets current runs
finish. Lowering a limit never kills an existing run.

`hub resume` also accepts explicit operator remedies already supported by ordinary
resume: approval inputs, reconciliation acknowledgement, and plugin, executor or
product upgrades. They are stored as a typed, single-use command and applied by
the owning CLI under the run lock. `--update-plugin` follows the operator's task's
plugin link to the bundle it names at acceptance ([§4.2](#42-moving-a-run-to-a-newer-plugin)). Automatic resume supplies none of these.
Replies distinguish an accepted command from a completed run transition; what
became of the latest resume is in the submission's `lastResume`
([§3.2](#32-what-became-of-a-resume)).

Example configuration:

```json
{
  "maxConcurrentRuns": 2,
  "retry": {
    "automatic": true,
    "maxAutomaticResumes": 5,
    "maxElapsedMs": 86400000,
    "baseDelayMs": 30000,
    "maxDelayMs": 1800000
  },
  "pollIntervalMs": 5000,
  "shutdownGraceMs": 60000
}
```

The elapsed retry window starts at the first automatic-resume-eligible failure.
Limits and defaults are copied into each submission at acceptance. Changing the
hub default affects future submissions; an explicit policy update is required for
existing ones. `hub limit` persists the global limit immediately. The config seeds
it on first creation; subsequent starts use the durable value and report it.

### 3.1 Status and history search

`graphloom hub status [--json]` reads `GET /v1/health`: hub ID, socket, the running
hub's GraphLoom version, the limit, occupied slots, per-state submission counts
(and, apart, the rehearsal submissions' per-state counts, [§12](#12-rehearsal-submissions)),
the archive index's size, and any fault, retention, monitoring or archive-index
error. It is the reachability check for scripts and agent skills: exit 0 when the
hub answers without a fault, 1 when nothing answers on the socket, 3 when it
answers with a persistence fault or is shutting down. A retention, monitoring or
archive-index error is printed but keeps exit 0; admission still works. `--json`
prints the health object with `reachable` and `healthy` booleans and the
submission count in place of the records; unreachable prints
`{"reachable": false, "healthy": false, "socket", "error"}`.

Status also reports the hub process's **environment**, which its runs inherit
(§9): the first five `PATH` entries and how many follow, where `claude`,
`codex`, `git`, `gh`, `docker` and `bwrap` resolve on that `PATH` (the
runner config's `claude.command`/`codex.command` or `GRAPHLOOM_CLAUDE_BIN`/
`GRAPHLOOM_CODEX_BIN` when set; an enabled supervisor harness's own
`claude.command`/`codex.command` is looked up separately), and whether the
runner config's `github.tokenEnv` and `github.writeTokenEnv` variables and `CLAUDE_CONFIG_DIR`
and `CODEX_HOME` are set: names and `set`/`unset` only, never a value but
`PATH`. A `Warning:` line names each CLI a configured harness needs (the runner
config's or the supervisor config's enabled harnesses; `git` for every run)
that the hub cannot find; it does not change the exit code. `--json` carries
the same summary as `environment`.

`graphloom hub doctor [--task <task.yaml>] [--json]` runs `graphloom doctor`'s
checks (platform, git and flock, the harness CLIs and their logins, docker,
confinement, the runner and supervisor configs and the token variables they
name, and with `--task` the plugin's environment checks, supervisor selection
and agent roles) **inside the hub**: `POST /v1/doctor` makes the hub run its
own installation's `graphloom doctor --json` as a child with the hub's
environment and the hub config's runner/supervisor paths, exactly what a run
it launches would find, not what the caller's shell has. The CLI resolves the
task path; the hub accepts only an absolute one and runs one doctor at a time.
Exit codes are doctor's: 0 when no check failed, 1 when one did, and 1 when no
hub answers. `graphloom doctor` in a shell and `graphloom hub doctor` can
disagree; the second is what hub runs see.

`graphloom hub list` without flags lists the retained queue in queue order. Any
search flag turns it into a history search over the same records, newest
acceptance first:

| Flag | Matches |
| --- | --- |
| `--state <s>` | Repeatable; any of the scheduling states (an archived entry's final state) |
| `--graph <id>` | The task's graph, read from the captured task |
| `--repo <path-or-substring>` | An argument starting with `/`, `.` or `~` is resolved (and real-pathed) by the CLI and matches the repository exactly; anything else is a substring of its path |
| `--key <substring>` | A substring of the idempotency key |
| `--since`, `--until` | Inclusive bounds on acceptance time: an ISO time, or a duration before now (`90s`, `10m`, `2h`, `3d`, `1w`) resolved by the CLI |
| `--grep <text>` | Case-insensitive text in the request or the blocker; a live submission's whole request, an archived entry's first line |
| `--limit <n>` | At most `n` rows (1 to 10,000) after sorting; `matched` reports the count before it |
| `--archived` | Also search the archive index (§4.1) |

The filters combine with AND. The search runs in the hub
(`GET /v1/submissions?state=…&graph=…&archived=true`); the reply keeps the list
shape, with live matches in `submissions`, a `summaries` map of each match's
graph, request digest and request first line, archive matches in `archived`, and
`matched`. The plain reply without parameters is unchanged. The hub reads each
captured task once (they are immutable) to know its graph and request; an
unreadable task matches no graph and no request text.

### 3.2 What became of a resume

An accepted resume is never dropped silently. The submission's `lastResume`
records the latest one by command ID with its status:

| Status | Meaning |
| --- | --- |
| `pending` | Accepted, waiting for a slot, or held by a pause; the next launch carries it |
| `launched` | The current launch carries it |
| `applied` | The run took it: the launch returned a run report, or the controller recorded the command applied under the run lock |
| `refused` | The run refused it before changing anything (`reason`, [§6.1](#61-a-launchs-report-of-its-end)) |
| `withdrawn` | It ended unapplied (`reason`): a cancel, a crash, a service interruption, a failed plugin reconciliation |

A pause keeps an accepted resume. A pause that lands before the launch carrying
a resume applied it (the launch's grant is withdrawn) puts the command back as
the submission's pending command; so does a launch that never started its run,
or a plain resume accepted while the launch drained. The next resume releases
the hold and its launch applies the held command: a plain `hub resume` does not
replace a held remedy, while a new remedy replaces it. A withdrawn command is
not kept, since the next launch may be an automatic continuation, which carries
no remedy.

A retried command ID with a different request is a conflict. A retry of the
same request is answered from the record, except for a resume the run never
applied: one held by a pause, or withdrawn. Its retry applies it (the hub
queues it again; `--update-plugin` resolves the plugin link again), so a
retry never reports success for a command that did nothing. A refused resume
is answered from the record with its reason: the same request is refused the
same way, and a corrected remedy needs a new command ID. The controller's own
per-command record keeps a reapplied command from applying twice.

### 3.3 Submit preflight

A task whose environment check fails in the hub's environment (a toolchain or
token the service lacks) would otherwise be accepted and block at its first
launch. `hub submit` therefore asks the hub to run the doctor for the task
first: `POST /v1/submissions` with `"preflight": true` runs the same doctor as
`hub doctor --task` (§3.1), in the hub's environment, before the task is
captured. Any `fail` among the checks the submission needs refuses it with
`422` and nothing is queued; the CLI prints each failing check with its fix
(at most six, then a count), how to see every check (`graphloom hub doctor
--task <file>`) and that `--no-preflight` submits anyway, and exits 1.
Warnings never refuse; a passing preflight prints one line on stderr naming
the warnings, and stdout stays the submission.

| Submission | Checks that refuse it |
| --- | --- |
| Real | Every check the doctor fails: host, agents, configuration, setups and the task's (plugin, environment checks, supervisor selection, agent roles) |
| Rehearsal, `--commands stub` (default) | The host checks and the task's plugin; the stand-ins replace the agents, supervisor, runner config and commands |
| Rehearsal, `--commands run` | Those, and the task's environment checks, since its commands run for real |

A failing check a rehearsal does not need is named in the passing line (`not
needed by a rehearsal: ...`). A submit whose `--key` the hub already holds
(a retry after a lost reply, or an archived key) skips the preflight: the hub
answers it with the existing submission or a conflict, as before. Doctor runs
are serialized in the hub, the endpoint's and the preflights', so concurrent
submits wait in turn rather than fail. A passing verdict is kept in memory for
5 minutes, keyed by the task file's bytes and path, the mode (real, rehearsal
with stubbed or real commands) and a fingerprint of the hub's environment and
its runner and supervisor config files; the same task submitted again in that
time is not checked twice (the line says `cached`). A failure is never kept:
after a fix, the next submit checks again. A hub older than the preflight
refuses the unknown field; the CLI then runs the preflight itself against
`POST /v1/doctor` with the same rules, and submits without the field.
`--no-preflight` is for an operator who knows better (a check that fails for
a reason the run does not meet); it prints `preflight: skipped`.

## 4. Submission inputs and durable state

Submission captures task bytes, config bytes, canonical repository and bundle
paths, the resolved base commit, bundle identity/digests, and the chosen runtime
configuration reference and non-secret digest. The hub materializes a private task
with valid relative paths or links, using the same intake rules as `task new`.
Queueing must not silently change the requested base when repository HEAD moves.
The task/config copies are immutable; a bundle or runtime configuration that has
changed before initial admission blocks the submission for explicit replacement.
Intake rechecks identities before any graph job starts. Credentials remain in the
operator's existing stores; the queue does not copy secret values.

Read-only input preparation can run before slot admission. Plugin callbacks,
rehearsals, worktree creation and all execution belong inside the reservation.
The hub does not prepare a graph-specific task from a forge reference: the user
can use the existing `graphloom task new` before submitting it.

Use a local filesystem and one versioned `scheduler.json` containing configuration,
submissions, idempotency keys, queue sequence, command records and launch intents.
The hub holds a kernel lock for its whole lifetime; every mutation goes through
one serialized writer. Write a complete temporary snapshot, fsync it, rename it,
and fsync its parent before acknowledging a command or allowing a child to work.
Do not inherit the lock descriptor into children. This follows the project's
existing file-based persistence without introducing a database for one writer.

Immutable submission inputs are written and synced before the snapshot references
them. Orphan input directories can be reported after a crash; they are never
treated as accepted submissions. Mutable telemetry and rotated process logs live
separately. Snapshot schema migrations run exclusively before scheduling; a newer
unknown format refuses startup. Invalid state is a reported fault, not an empty
queue. Bound the snapshot to 16 MiB and 10,000 retained submissions; reserve 2 MiB
for global lifecycle metadata. Admission accounts for each submission's maximum
bounded operational record size, not its current size, so every accepted entry
has space for a launch, a pending operator command, and its cleanup/result state.
All strings, command inputs and history summaries have schema bounds. Completed
launch/command history is checkpointed into per-submission journals, with only
bounded summaries and a committed cursor in the snapshot. Journal bytes are
synced before the snapshot advances its cursor; unreferenced suffixes after a
crash do not count as accepted commands. Old command IDs remain deduplicated from
the committed journal. Refuse new submissions before consuming lifecycle reserves,
and never discard unsettled intent to compact history. Pause, cancel, drainage
and settlement remain writable at the admission cap. Actual disk exhaustion stops
new work and reports the persistence failure; it cannot be solved by a logical
capacity reservation. An explicit archive operation removes
terminal queue records while retaining run artifacts (until an explicit purge,
§4.3, removes them), compact idempotency
tombstones in the snapshot, and a history entry in the archive index (§4.1). A tombstone records the key, request digest and original
submission/run IDs: a matching request returns an archived result, never a new run.
The same 16 MiB cap applies; refuse new keys if it is reached. Keys remain reserved
for the lifetime of this hub store. No automatic retention policy makes an old
submission eligible to run again.

The scheduling record has two independent axes:

| Field | Values and meaning |
| --- | --- |
| Desired action | `execute`, `hold`, `cancel`; only an operator command changes a hold/cancel |
| Scheduling state | `queued`, `starting`, `running`, `stopping`, `waiting`, `paused`, `blocked`, `succeeded`, `failed`, `canceled` |
| Run observation | Controller status, revision, stage, attempts, stop/continuation information; read-only and timestamped |
| Launch | Generation, reservation, process identity, cgroup, command identity, launch/exit/cleanup observations |

`blocked` means a human decision, changed input, reconciliation, or renewed retry
allowance is needed. `failed` is a terminal controller failure or unrecoverable
initialization failure. Waiting and blocked submissions can have no live process.
A scheduling label alone never releases a reservation.

### 4.1 Archive index

Archiving a submission first adds one entry to `archive-index.json` beside
`scheduler.json`, then commits the snapshot without the queue record. The entry
holds the submission and run IDs, idempotency key, graph, repository path,
original task path, the submission's request digest, the request's own SHA-256
and first nonblank line (at most 200 characters), acceptance, settlement (the
terminal record's last update) and archive times, the final state, the run's
state directory (`<hub directory>/runs/<runId>`) and the last blocker (at most
512 characters; none for a succeeded submission, whatever its completion stop
recorded). Graph, request and state directory come from the captured task
and the hub runtime; when they cannot be read the entry omits them and the
archive still proceeds. An entry that still exceeds 16 KiB keeps only its
identity, times, state and clipped paths.

The index is history, not authority. Tombstones alone reserve keys and answer
repeated submissions; evicting an index entry never makes a request runnable
again. Retention is bounded: the newest 5,000 entries and at most 8 MiB, the
oldest evicted first when either bound is exceeded. Each archive rewrites the
file through the same temporary-file, fsync and rename sequence as the snapshot.
A crash between the index write and the snapshot commit leaves an entry for a
still-live submission; searches skip entries whose submission is still in the
queue, and the retried archive replaces the entry. A missing index (every hub
store created before the index existed) starts empty: submissions archived
earlier are not listed, and their runs remain findable only by run ID under
`<hub directory>/runs/`. An unreadable or foreign index is renamed aside to
`archive-index.json.damaged-<time>`, the hub starts with an empty index and
reports `archiveIndexError` in health, and admission continues.

`hub purge` (§4.3) marks an entry `purgedAt` in place: the entry keeps its
position and every other field, so a purged submission stays findable with its
ids, key, final state, rehearsal verdict, times, recorded memory and blocker.
`hub list --archived` shows it as `<state> (archived, purged)`; `--json`
carries `purgedAt`.

### 4.2 Moving a run to a newer plugin

Submission records the plugin twice: the bundle the run is pinned to (resolved,
`bundlePath`/`bundleDigest`) and the operator's task's plugin link, unresolved
(`pluginLink`, `<task dir>/plugins/<graph>`; submissions made before it existed
derive it from the task path). The run reads its plugin through the hub's
private link `submissions/<s>/plugins/<graph>`, which the controller pins as the
bundle path and which names the recorded bundle.

`hub resume <s> --update-plugin` does what `graphloom resume --update-plugin`
does from the task directory: it takes the plugin the operator's task names
now. At acceptance the hub resolves the operator's link and refuses, with the
reason, a link that is gone, points nowhere, or names no bundle of the run's
graph; the reply names the link to repoint. The resolved bundle and its digest
travel with the single-use command (a client cannot supply them; a retried command
ID is answered from the record without resolving again), and the hub
pins that bundle's installed version before acknowledging. Before the launch
starts its child, the hub checks the bundle has not changed since acceptance and
points the private link at it; the owning CLI then applies `--update-plugin`
under the run lock with the core's rules unchanged (same graph, unchanged
stages and topology, protocol level; see the core design's plugin update).
With `--upgrade` the same resolution applies: install the newer GraphLoom,
repoint the task's link at its plugin if the link names a version directory,
restart the hub service, then `hub resume <s> --update-plugin --upgrade`.

When the launch drains, the hub compares the run's plugin pin (manifest and entry
digests) with the bundle at the private
link. If the controller accepted the update, the hub records the new bundle as
the submission's plugin, and retention releases the old version's pin unless
something else (for example the captured runtime) still references it. If it
refused, the hub points the private link back at the recorded bundle, so the
run stays on its pinned plugin and the stop reason says why. The refusal
replaces the run's recorded stop with the pin mismatch, while the stop the
resume answered (an approval the run waits on, say) is still in force, so the
blocker shows both: `plugin update refused: <mismatch>; the run still stops on:
<earlier blocker>`, and the resume's `lastResume` is `refused` with the mismatch.
The earlier blocker is the one recorded when the launch was reserved
(`launch.priorBlocker`): polling replaces the submission's observation with the
run's own pin mismatch before the launch drains. Any other resume,
including a plain `hub resume`, keeps the recorded bundle exactly; it also
repairs a private link an interrupted update left behind. A failure of this
reconciliation blocks the submission with `plugin reconciliation failed: …`
(unless the run succeeded), dropping a resume accepted while the launch drained.

### 4.3 Purging an archived submission's run files

Archiving keeps the run's files: its state directory `<hub directory>/runs/<runId>`
(state, evidence, scratch, agent sessions), its worktree `<repo>/graphloom/<runId>`
and its branch. They stay until the operator purges them; nothing removes them
automatically. Plain `graphloom delete` refuses a managed run, archived or not, and
names `hub purge`.

```sh
graphloom hub purge <submission>...                       # named archived submissions
graphloom hub purge --archived --before 30d --dry-run     # what would go, and its size
graphloom hub purge --archived --key widgets --rehearsal  # hub list filters select in bulk
```

`hub purge` accepts submission or run ids, or `--archived` with `hub list`'s
filters (`--state`, `--graph`, `--repo`, `--key`, `--since`, `--until`, `--grep`;
§3.1) plus `--before <iso|duration>` (archived before) and `--rehearsal`
(rehearsal submissions only). A bulk purge reads the archive index, so a
submission the index no longer lists is purged only by its id. Entries already
purged are skipped. Each submission is one request
(`POST /v1/submissions/:id/purge`, body `{"dryRun"?, "force"?}`), so one refusal
never stops the rest; the command exits 1 when any was refused.

For each submission the hub:

1. Refuses a live one (any submission still in the queue: `409`, naming what to do
   first, archive it or cancel it), an unknown one (`404`), and a second purge of
   the same submission while one runs (`409`). Only this hub's tombstones are
   purgeable, and only their run directory under this hub's `runs/`.
2. Deletes the run through the controller's run deletion, the code `graphloom
   delete` uses: under the run's lock, it refuses a run a live controller owns, a
   worktree with uncommitted changes and a branch with commits beyond the pinned
   head unless `--force` discards them, and a run whose binding names another hub
   or submission, even with `--force`. It removes the worktree (`git worktree
   remove`, then `git worktree prune`), the branch at the tip it checked, the
   repository's record of the branch's state directory, then the state directory
   with `state.json` last. Read-only directories, such as a Go module cache in
   scratch or the worktree, are made writable and removed. The hub drained the
   run before archiving it, so a `running` status a killed controller left is not
   a refusal here.
3. Removes the run's ownership record (`<install home>/runs/<runId>.json`, in the
   home the run's state names and in the hub's own home) when it names this state
   directory.
4. Marks the archive index entry `purgedAt` (§4.1) and refreshes retention.

A purge is idempotent and finishes one that failed partway: the controller removes
`state.json` only after the worktree and branch, so a state directory without it
is removed as is; a run that never saved state but whose worktree or branch the
repository records for its state directory needs `--force`. A missing state
directory reports `alreadyPurged` and still removes a leftover ownership record and
marks the entry. When the index no longer lists the submission the files are
removed anyway and the reply carries `indexError`. `--dry-run` removes nothing and
reports, per submission, the state directory, worktree, branch and their disk use;
`--json` prints the replies.

After a purge, `hub inspect` (and `GET /v1/submissions/:id`) answers `410` with
the time the run files were purged; for an archived submission that was not
purged it names the run's state directory. `graphloom inspect <runId>` no longer
finds the run.

What a purge releases. An archived submission holds no hub retention marker
(§9.1): its captured runtime, plugin and executors were released when it left the
queue. What still kept its versions installed was the run's ownership record,
which `self prune` and `self list` honour while the record's state directory
exists, for the owning version and for the version the run's plugin link (the
hub's private `submissions/<s>/plugins/<graph>`) resolves into
([release design §4.3](design-release.md#43-shim-commands-graphloom-upgrade-graphloom-self)). Purging removes
the state directory and the record, so both versions become prunable unless
something else keeps them. The submission's own `submissions/<s>/` directory
(captured task, launch logs, command journal) stays; it pins nothing.

## 5. Concurrency contract

One run slot covers a whole run execution, including its plugin process, agents,
commands, supervisor, startup and cleanup. Resuming an existing run needs the same
kind of slot as starting a new one. Jobs within a run do not consume extra slots.

The scheduler may reserve a launch only when:

```text
occupiedSlots < maxConcurrentRuns
and desiredAction == execute
and eligibleAt <= now
and no unsettled launch exists for this submission
```

Reservation and launch intent are one durable mutation, before spawn. Starting,
running and draining launches occupy slots. An uncertain launch also occupies a
slot until reconciled. Child exit, stale heartbeat, a stopped state file, or loss
of a monitoring connection alone is insufficient to release it.

After decreasing the limit below occupancy, show both values, for example
`running/draining 4, limit 2, new starts held`. Existing occupancy may temporarily
exceed the new limit; no new reservation is admitted until occupancy drops below
it. Increasing the limit wakes scheduling immediately. Concurrent submit/resume/
limit requests serialize through the same writer, so none races the capacity check.

Choose the oldest eligible entry by a monotonically increasing queue sequence.
Future-dated entries do not block ready work. A retry or manual resume gets a new
sequence when it becomes ready, behind work already waiting. Runs are
non-preemptive; fairness requires running jobs eventually release slots. The
existing per-run finite budgets bound execution, while operator controls handle
long-running work. A paused or safely yielded submission consumes no slot.

For example, with limit 2 and A/B/C queued, A and B start. A safely yields until
14:00, drains, and C starts in its slot. At 14:00 A becomes ready; if B and C are
still active, A waits. Its reset time makes it eligible, not entitled to bypass
the limit.

At most one unsettled launch exists per submission and per managed run ID. Duplicate
resume commands coalesce rather than creating another execution. Different runs
against one repository may use their existing isolated worktrees; repository
locks still serialize shared Git mutations. If two tasks intentionally write the
same external resource, that remains a task-level coordination concern; global
run capacity does not make those writes safe to overlap.

## 6. Launch, containment and restart

Use direct child processes with fixed executable and argv, no shell expansion,
noninteractive stdin, and separate bounded logs and machine control descriptors.
A launch inherits the hub process's environment, which under systemd is the
unit's, not the operator's shell profile ([§9.1](#91-the-services-environment));
`hub status` summarizes it and `hub doctor` checks it.
Pin the executable for initial launch. Resume resolves the owning installed
version, retaining its existing dispatch rules. A missing version or an unsupported
managed-launch protocol blocks the submission; it never silently upgrades a run.

Add a versioned managed-launch protocol to the CLI (`run` with a preassigned run
ID, and `resume` with a launch identity and control descriptor). A trusted bootstrap
waits for a start grant before loading graph code or creating the worktree. The
hub puts it in the launch's cgroup, persists its Linux boot ID/PID/start time and
launch generation, then grants execution. EOF before the grant exits without work.
The child reports run creation, observation revisions, scheduling yields and exit;
logs are never parsed as acknowledgements. Lost messages are recovered from the
launch journal and run state. Version dispatch must preserve the managed protocol
and control descriptor to the actual controller; the hub's immediate child PID
need not be the controller PID. Worker, plugin and executor processes do not
inherit the control descriptor. After a grant, control-channel loss requests a
cooperative scheduling stop at the next safe point; the reservation remains held
while any work drains.

If preparation fails after spawning a bootstrap, persist the failure on the launch
record. Live process observations, cleanup messages and daemon restart cannot
clear that failure. Keep the reservation until drainage is verified, then block
the submission; an unsuccessful preparation is never silently requeued.

The controller must reserve initialization exclusively by run ID and persist an
intake journal before worktree side effects. Repeating the same initial request
with the same submission binding reconciles partial intake or reports the existing
run; it cannot overwrite state or create a second worktree. A different binding
for that run ID is refused. A new launch generation cannot work while an earlier
launch remains live or unaccounted for.

New controller bindings declare `initializationProtocol: 1`. After the first state
save, and before reporting creation or admitting supervisor/graph execution, the
controller syncs `managed-execution-started.json`; resume also establishes this
marker before admitting work. Missing state is eligible for initial replay only
with verified pre-execution provenance: an untouched pre-intake directory, or a
matching protocol-bound intake without the execution marker or unexpected
artifacts. Legacy bindings and missing state after the marker require recovery.
The automatic `initialization-failed` observation schedules the same initial
intake under the normal retry allowance and backoff, preserving the run ID,
captured inputs and owned worktree. Every attempt needs a fresh slot and grant
after complete drainage. A plain manual retry is allowed; resume remedies require
initialized run state and are rejected before initialization.

For the supported Linux daemon deployment, require a delegated cgroup v2 subtree
and create one cgroup per launch. Put the hub itself in a separate leaf. Ordinary
descendants inherit membership even when they change process group. Use the
cgroup's populated state to verify drainage, and its kill facility when graceful
termination expires. Probe these capabilities before accepting runnable work;
PID polling alone is not a supported substitute. These facilities are documented
in the [kernel cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [systemd delegation](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#Delegate=).

Docker processes can live outside this subtree. Extend the runner's existing
run-labelled container cleanup to return a verifiable success/failure result.
Custom executors that launch external work must provide equivalent termination
and inspection, or be refused in managed mode. A reservation releases only after
the launch cgroup is empty, no live controller owner remains, and runner-managed
external execution is confirmed stopped. Cleanup failure holds the slot and
reports the resource; it never gets a replacement run on an assumed-free slot.
Uncertainty about a completed external effect can block resume even after all
execution has drained and its slot has been released.

On daemon start, acquire the hub lock, then reconcile **all** unsettled launches
before admitting anything. For each launch:

| Observation | Action |
| --- | --- |
| Reserved, no child ever granted, no execution/artifacts | Return to ready queue |
| Child alive with matching identity | Keep its slot; observe it, or stop/drain it before replacement |
| Controller gone, descendants/container still active | Drain and verify; retain slot |
| State exists, execution drained | Read terminal result or evaluate continuation of the same run |
| Partial intake with matching protocol-bound journal and no execution marker | Retry initial intake with bounded backoff through the owning CLI inside a new slot |
| Failed launch preparation, now drained | Preserve its recorded failure and block until an explicit retry |
| Conflicting identity, unreadable state, unknown external work | Block admission for that reservation and report the uncertainty |

The same rules apply after reboot; old PIDs are not identities. A missing startup
acknowledgement never justifies spawning another independent run. Control-channel
reconnection does not itself create a launch generation. Old-generation messages
cannot release a slot, overwrite a result, or authorize a retry.

Persist a managed-run binding at intake. Ordinary `graphloom resume` for such a
run routes through its hub, and direct controller entry requires a current hub
grant. Ordinary `stop` records a hub hold before requesting the stop, avoiding an
automatic-resume race. Read-only commands remain available without the hub.
Explicit offline detachment requires the hub to be stopped, all execution drained,
and the binding reconciled under both locks; deletion does not bypass ownership.
Older runtimes without this protocol cannot manage bound runs. This is lifecycle
coordination for trusted users, not a security boundary against the owning account.

### 6.1 A launch's report of its end

A managed launch that gets its grant writes how it ended to
`<hub>/submissions/<s>/launches/<launchId>.json` before it exits
(`HubLaunchReport`): `completed` when its command returned a run report,
`refused` when it refused its request before changing the run, `error` for any
other failure (its message, for display only), and, for a launch that carried an
operator command, whether the run applied it. It is a report, never authority:
drainage is still verified as above, the hub reads it only once the controller
owner is gone, and one that names another launch or generation is ignored. A
killed launch writes none.

A refusal has a structured cause, the error's type, never its text:
`RequestRefusedError` with `invalid-remedy` (an approval or decline the run
refuses: an undeclared approval ID, an input that does not fit, a finished run)
or `invalid-scenario` (a rehearsal scenario the bundle does not declare),
`IntakeError` (`invalid-task`: the task, its config or the bundle manifest) and
`UpgradeRefusedError` (`upgrade-refused`). Retrying the same request is refused
the same way, so the hub does not retry it: the submission blocks at once with
`launch refused: <reason>` (an initial launch) or `resume refused: <reason>;
the run still stops on: <earlier blocker>` (a resume, whose run is unchanged),
and the resume's `lastResume` is `refused`. The submission stays recoverable: a
corrected remedy under a new command ID applies, and a plain `hub resume`
retries an initial launch (captured input is immutable, so a refused task or
scenario needs a new submission). Any other failure follows the continuation
rules of §7.

### 6.2 Memory containment

The host the hub shares is finite, and one run's agents, builds and tests can
take all of it: a global out-of-memory kill then picks a victim anywhere, the
user's systemd manager included, which takes the hub and its socket down with
it. So every launch runs under memory limits, and an OOM kill is a recognised
outcome, not a crash.

**Launch limits.** `hub.json`'s `launchMemoryHigh` and `launchMemoryMax`
(bytes, or a systemd-style size: `512M`, `4G`, `1.5G`; `max` for none) are
written to each launch cgroup's `memory.high` and `memory.max` before its
bootstrap starts, with `memory.oom.group=1`: an OOM inside a launch (at its
own limit, or a global one that chose one of its processes) kills the launch's
whole group, controller included, never one random process of it, so the run
resumes from its last accepted state instead of continuing with a job's
process missing. The defaults are 6 GiB for the max and two thirds of the max
(4 GiB) for the high, where the kernel throttles and reclaims before it kills.
A launch holds its controller and plugin worker (a few hundred MiB), the agent
CLIs of its parallel jobs (each several hundred MiB), and command jobs' builds
and tests run on the host (a Go or Node test suite takes a few GiB); 6 GiB
holds that with room, and two default slots (12 GiB) leave most of a 32 GiB
host to everything else on it. A limit needs the delegated memory controller:
with a limit configured, the probe refuses to start the hub (naming the
cgroup and its controllers) when `memory` is not delegated, and a launch whose
limits cannot be written fails before anything of it runs. With both set to
`max` the hub writes no limit and needs no memory controller.

**An OOM-killed launch.** When a launch drains, the hub reads its cgroup's
`memory.events` and `memory.peak` and records them durably
(`<hub>/submissions/<s>/launches/<launchId>.memory.json`) before removing it,
so a hub that stops before the launch settles reads the record on restart. A granted launch that
wrote no report of its end (§6.1) and whose cgroup records an OOM kill
(`oom_kill` or `oom_group_kill`) ended on memory:

| Record | Cause | Hub behaviour |
| --- | --- | --- |
| `oom` > 0: the cgroup reached its own `memory.max` | `memory limit reached (<limit>): the kernel killed the launch at its cgroup's memory.max (launchMemoryMax); peak <peak>` | One automatic retry; reached again with no accepted progress between, it blocks with that cause and what to change |
| `oom` = 0 | `killed by the out-of-memory killer outside the launch's own limit (the hub service's MemoryMax, or the host out of memory)` | An ordinary crash retry, under the normal allowance (§7) |

One retry, not none: the run resumes from its last accepted state, and a peak
made of concurrent jobs that happened to overlap need not recur. Not more: a
second kill at the same limit with no progress between says the run's working
set does not fit, and another attempt would only spend time (and, with agent
jobs, tokens) to reach it again. Accepted progress between kills resets that
count, as for any repeated failure fingerprint; every retry still spends the
submission's allowance. The blocker reads `memory limit reached (6 GiB): ...;
reached again on its automatic retry with no accepted progress, so the hub
does not retry it: raise launchMemoryMax in hub.json and restart the hub (or
lower the run's parallel jobs), then graphloom hub resume <submission>`. A run
that recorded an operator stop keeps that stop, with the memory cause before
it. The launch's log gets the cause as its closing line (§8). `hub inspect
--panel usage` shows the launch's peak against its limit, its high, and any
OOM-killed processes, read from the launch cgroup while it runs; a launch that
reported its own end is settled by its report, whatever its cgroup recorded.

**The recorded peak.** The hub also keeps the record (peak, `memory.high`,
`memory.max`, `oom`, OOM-killed processes, the launch id and when it settled)
with the submission as `lastLaunchMemory`, replaced each time a launch drains;
a hub that finds a submission without one (settled before it was kept) reads
the newest `<launchId>.memory.json` on start. So the peak to retune
`launchMemoryMax` by outlives the cgroup: with no launch running, `--panel
usage` (text, Markdown, JSON) shows that launch's recorded peak, limits and OOM
kills, labelled with the launch id and time and named in the panel's coverage
line as recorded at the launch's end; while a launch runs, the live cgroup view
stays and the previous launch's recorded peak is shown beside it. `hub list
--json` and `GET /v1/submissions/<id>` carry `lastLaunchMemory`, and an archive
entry keeps it. Text `hub list` stays one short line per submission and adds
`OOM-killed: peak <peak> of <max> (launch <id>)` only when that launch had an
OOM-killed process, the one memory fact that calls for action. `hub status`
gives the distribution (§9.1).

**Docker-confined jobs.** A docker-confined command job's containers run in
Docker's cgroups, outside the launch's and the service's, so neither limit
covers them. Each container gets its confinement's `memory` as `--memory` and
an equal `--memory-swap` (no swap beyond it); the runner config's
`docker.maxMemory` (a docker size such as `6g`) caps every container: a job
declaring more runs with the ceiling, and its command evidence records both
(`sandbox.memory`, `sandbox.declaredMemory`). Containers run without `--rm`,
so that once one exits on its own the wrapper reads Docker's `OOMKilled`; a
container that exited 137 with `OOMKilled` is reported as `<command>: the
container was killed at its memory limit (--memory <size>; exit 137,
OOMKilled)` in the job's summary and as `sandbox.oomKilled` in its evidence,
then removed (as before, the runner removes the job's containers afterwards,
and resume cleanup removes any the run left).

## 7. Automatic continuation

The controller currently exposes stop retryability, quota/retry timing, and
reconciliation state. Retryability answers whether an operator's resume can try
again. Its fallback for an unrecognized stop is retryable, so the hub must not
use that boolean as automatic-resume authorization.

Add a controller-owned, versioned observation for continuation:

```ts
type Continuation =
  | { kind: "complete" }
  | { kind: "automatic"; cause: string; notBefore?: string;
      fingerprint: string; stateRevision: number }
  | { kind: "operator"; cause: string; evidenceRefs: string[] }
  | { kind: "terminal"; cause: string };
```

`cause` is a closed set of controller classifications, not free-form log matching.
The implementation must enumerate it and validate it on the wire. Unknown values
require operator action. The fingerprint binds the failed operation, cause and
relevant input/version identities; advancing timestamps or inventing another
operation ID alone cannot reset the repetition counter. The owning controller
rechecks eligibility under the run lock when a queued resume actually starts.

| Condition | Default hub behavior |
| --- | --- |
| Owning controller reports succeeded/complete after final acceptance and delivery checks | Mark succeeded after execution drains |
| Safe provider cooldown with structured reset time | Wait until reset plus margin and jitter, then queue the same run |
| Known transient launch/provider failure with no ambiguous effects | Bounded exponential backoff |
| Verified incomplete initialization | Retry the same initial intake under the automatic allowance; never resume absent state |
| Controller crash | Drain; request controller reconciliation, then continue only if safe |
| Hub service shutdown interrupted execution | Reconcile and requeue only when the recorded desired action is still execute |
| Explicit reconciliation debt or ambiguous external effect | Block for operator; never add `--reconciled` automatically |
| Approval, missing authority, exhausted run budgets, pin drift, product decision, unknown stop | Block for operator |
| User pause/cancel | Hold/cancel wins over any eligible retry |
| Terminal controller failure | Mark failed; retain artifacts |

For a crash whose safety cannot be determined read-only, launch a reconciliation
pass inside a slot. The owning CLI runs the existing reconciliation procedure and
emits either eligibility or an operator blocker before dispatching any new work.
A reconciliation pass cannot approve effects on the operator's behalf.

Every failure-driven automatic resume spends one of the submission's five default attempts,
durably before launch. The default backoff is 30 seconds, doubling to 30 minutes,
with nonnegative jitter up to 20%. A provider `notBefore` is a lower bound and is
never shortened by the backoff cap. Three repetitions of one failure fingerprint
without accepted progress block further automatic resumes. The blocker names the
limit reached and the last cause, for example `automatic retry stopped: retry
allowance used (5/5 automatic resumes); last cause: initialization-failed: <the
launch's error>`, or `the same failure repeated 3 times without accepted
progress`, or the elapsed retry window; the cause is the continuation's, with
the launch's reported error, the run's blocker, or `the launch ended without
reporting its end (killed or crashed)`. A launch's refusal (§6.1) is never
retried. Neither progress nor
a daemon restart resets the total attempt count or 24-hour retry window. A manual
resume does not replenish these limits; renewal is an explicit policy change.
No hub policy increases the controller's remaining budgets.
If a required `notBefore` lies beyond the retry deadline, block with that reason
instead of scheduling a launch outside the window. Recheck the deadline on launch,
not just when creating a timer. Persist wall-clock deadlines for restarts and use
elapsed monotonic time for in-process delays; a backward clock jump cannot trigger
an early provider retry.

Current controllers can sleep through a quota/retry wait while still owning the
run. Such a process continues to occupy its slot. To free capacity, add a managed
scheduling yield: only at a durable wait point with no executing operation, the
controller saves the continuation and queued retry, settles accounting, returns
`stopped`, and exits. Cleanup must finish before the hub records `waiting` and
releases the slot. This is distinct from an operator stop. The wait's `notBefore`
and remaining wait charge survive resume; yielded time follows existing wait
budget rules and consumes no active execution time. If the wait budget cannot
cover it, emit a budget blocker. Ordinary standalone execution keeps its current
wait behavior. The hub never frees a slot by simply observing a sleeping process.
For a planned service shutdown, persist a `service-interruption` command before
signalling children. Unlike a wait yield, it may request cancellation of an active
operation: the controller stops admission, cancels/drains execution and preserves
any pending dispatch for its normal reconciliation path. The durable controller
reason and hub command ID distinguish it from a user hold; explicit user hold or
cancel always takes precedence. Restart first reconciles the interrupted operation
inside its reservation. Continuing a matched planned interruption does not spend
a failure-resume attempt or reset failure counters/deadlines. An unplanned crash
does spend an attempt; a failure during planned-interruption recovery follows the
ordinary bounded failure policy. If a crash leaves an ordinary operator stop
without a matching interruption identity, the hub requires operator action.

No automatic global provider throttling is inferred from one run's quota error:
different harnesses may use different accounts. A later extension can define
operator-named credential pools and admission cooldowns. A strict requests/tokens
per minute limit would also require runner/harness cooperation inside active runs.

## 8. Monitoring

Expose one versioned `MonitorSnapshot` per submission and aggregate it for the hub.
Each snapshot carries run/submission identity, observation time, controller
revision, hub observation identity, an event cursor, and freshness/availability
for each source. Controller, hub and process observations have their own source
timestamps; the snapshot does not claim they were captured in one atomic read.

| Scope | Fields |
| --- | --- |
| Hub | Configured limit, occupied slots, ready/waiting/blocked counts, daemon health, last reconciliation |
| Submission | Desired action, queue position, eligible time, run ID, launch generation, resume count, latest blocker |
| Run | Controller status/revision, topology identity, live path/tail, current stage/attempt, side visit, receipt validity and acceptance, normal/recovery mode, last meaningful progress |
| Usage | Granted/used/remaining budgets with existing exactness labels, recorded model calls, tokens when reported, usage deltas per minute; process CPU/memory with coverage and sample time |
| Lifetime | Queue time, active time, cooldown time, restart count, bounded log references |

Reuse `progress.ts` and `stats.ts` semantics through an owning-version observation
interface; extract their pure projections to a shared controller monitoring module
instead of duplicating them in the hub. Poll changed durable state every five
seconds with bounded parallelism; process/control events wake an earlier read.
Watch output remains useful for people but does not drive scheduling. Do not
spawn one permanent `graphloom watch` process per submission.

The topology implementation's live path and side visits determine what work is
currently owed. All-node completion counts are inventory, not a run-completion
denominator: an unvisited branch or supervisor-only node need not complete.
Completion always comes from the owning controller. Legacy ordered runs retain
their stage counts, with no estimated duration percentage. Reentry can invalidate
receipts. Rates use actual sample
elapsed time and nonnegative deltas, include a sample timestamp and window, and
become unavailable after counter resets or insufficient data. A missing token or
cost measurement is unknown, not zero. Cost is shown only when a harness supplies
it or an explicit pricing source is configured; no billing accuracy is implied.
Recorded calls may arrive only when jobs settle, so reported rates can lag work.

A launch's state wins over a controller record that predates it. Before an
initial launch's first state save the owning runtime has no `state.json`; the
overview says `Status: starting` with the controller source `starting: run
state not written yet`, not `unknown` and the read error. While a launch is
starting or running and the controller's last record says otherwise (a
resumed run reads `stopped` until its first save), the overview shows the
hub's state, the controller source notes `last recorded <status>`, and the
earlier blocker is not repeated. With no launch active nothing runs, so the
overview's status is the hub's (`waiting`, `paused`, `blocked`, `queued`,
`succeeded`...), never a killed controller's last `running`; the controller
source notes `last recorded <status>; no launch is active`, and the blocker is
the hub's, else the run's (an approval it waits on). Before the run's state
exists, the overview's graph is the captured task's. A succeeded submission has
no blocker in any view: plugins often record `none` on their completion stop.
The jobs panel lists every job the run recorded, as `stats` counts them (the
usage panel's jobs): agent sessions, and command and other jobs by the producer
of their evidence (`settled`, with their evidence), leaving out environment
checks and an agent's own tool calls.

Each managed launch starts its stderr log (`hub logs`) with `graphloom: run <id>
starting|resuming|resuming automatically|reconciling (launch <launchId>,
generation <n>)[: <remedy flags>]` and ends it with `graphloom: run <id>
<status>[: <stop reason>][; blocker: <blocker>][ (retryable|final)]`; a launch
that refused or failed ends it with `graphloom: run <id> refused: <reason>
(final)` or `graphloom: run <id> error: <message>`. When a launch ends without
reporting its end (§6.1: killed, or crashed), the hub appends the closing line
as it settles it: `graphloom: run <id> <hub state>: the launch ended without
reporting its end; the hub settled it[; blocker: …|; next attempt at …]`.
`hub logs` without `--launch` reads the active launch's log while one runs,
else the latest written.

Read failures retain the last observation with a stale marker. Silence reports
possible lack of progress; it never proves death or authorizes a replacement.
Cap log retention per launch and event-reader buffers; a slow viewer cannot block a
controller or grow the daemon without bound. Logs and run artifacts remain visible
only to users authorized for the daemon's Unix account.

### Terminal and agent-chat output

Both are required outputs. The daemon produces versioned snapshots and bounded
events. One semantic panel projection selects typed facts from a `MonitorSnapshot`;
terminal and chat renderers consume that projection. The
[panel design](design-monitor-panels.md) maps the reference
screenshot to topology, overview, stages, jobs, activity, job details, usage and
output. A full dashboard is optional composition, not the required interface.
Presentation code never owns execution or decides whether a run can resume.
Closing a viewer or losing the chat connection leaves the daemon and runs running.

```text
controller state + owner identity + hub queue
                 |
          monitoring projection
                 |
   MonitorSnapshot + cursor events
                 |
       semantic panel projection
        /          |           \
      JSON      cell frame    chat layout
                 /    \        /     \
               ANSI  plain  Markdown KaTeX
```

Proposed `graphloom hub inspect <submission> --panel <kind> --format
text|markdown|json|ansi` returns a standalone panel. Text is uncolored character
output, ANSI is an explicit terminal color format, and JSON retains typed panel
facts. Markdown accepts `--chat-renderer auto|plain|katex`; `auto` uses only a
verified host capability profile and otherwise chooses plain Markdown. The
[panel interface](design-monitor-panels.md#5-terminal-and-chat-delivery) owns the
full command and capability contract. Repeated `--panel` selects several panels
from the same observation frame. Proposed `graphloom hub watch
[<submission>] [--panel <kind>]` follows those panels. With no selection, the
hub-wide view shows a run/queue list and capacity; a selected run shows its
overview and topology. Details and recent output are separate panels, accessible
directly or through interactive selection. Explicit commands request pause/resume
through the hub interface. Ctrl-C detaches the viewer and restores the terminal;
it does not stop runs. Resize, narrow windows, `NO_COLOR` and Unicode display
width must work. Child logs never write directly over the viewer.

Without a TTY, or with `--plain`, print append-only human-readable reports by
default. Explicit ANSI inspection is useful for an ANSI-aware consumer; it is
never the automatic chat or redirected-output format. `--json` watch emits bounded
NDJSON events without terminal controls or animation. Keep initial snapshot and
reconnect behavior explicit in every mode.
The daemon's own stdout/stderr remain structured service logs; it never takes
over a terminal. Current GraphLoom has text/JSON monitoring but no TUI framework
dependency. See the [library research](research/run-hub-monitoring-ui.md).

The recommendation is **one semantic panel projection with separate terminal and
chat renderers**. A small character-cell renderer follows Troupe's approach for
ANSI/plain panels and bounded area plots; ELK.js is the proposed complex-graph
layout engine. Input and live redraw belong to the CLI adapter. Ink is an optional
shell, not a required rendering dependency. Troupe's bespoke tree layout is not
suitable as the general graph router. Chat KaTeX consumes semantic panel data,
not ANSI strings or a promise of exact terminal cell geometry. See the
[panel design](design-monitor-panels.md#3-complex-topology-and-execution-overlays)
and [source research](research/troupe-monitoring-reference.md). These are design
recommendations, not installed dependencies or verified release integrations.

An illustrative topology panel, not output from an implemented hub:

```text
fix-14169 · issue-fix · running · observed 12:21:05 UTC
Declared: Fix -> Review; Review -> Fix
Supervisor-only: Arbitrate -> Fix, Review
Live path: Fix #3 -> Review #3
Current work: Review #3 · side visit: none · hub occupied: 2/3
```

The example uses the issue-fix topology described in the graph topology design.
Production consumes the pinned definition and the SDK's normalized topology,
including directed cycles, live path and supervisor-only nodes. The reference
contracts are in the [topology design](design-graph-topology.md) and
[panel design](design-monitor-panels.md). An absent newer
runtime observation is unknown, not an invented visit. Keep declared edges,
observed traversal and active jobs distinct. Rendering must retain multiple
incoming edges and return directions. A labelled legacy stage view is only a
compatibility fallback. The monitor never infers routing by reading plugin source
or asking a model, and never decides completion from animation or process exit.
If the viewport, chat renderer or message budget cannot show a graph legibly, use
a bounded, paginated adjacency view with explicit hidden-node/edge counts and
continuation references. Every edge remains retrievable; a decorative compact
diagram must not silently drop relationships. A usage panel retains numeric
values, units, time window and sample gaps even when its plot is unavailable.

HAPI's inspected Markdown implementation already registers `remark-math` and
`rehype-katex`. That permits an optional **static colored KaTeX snapshot** using
an allowlisted subset such as `\textcolor`, `\texttt`, `array` and `\boxed`,
inside a Markdown math block. No HAPI source change, screenshot or MCP connection
is needed for that path. It does not make HAPI an ANSI terminal, preserve arbitrary
cell alignment, supply interactions, or update an earlier message automatically.
Use a checked palette and escape all data as text; labels, status words and
values carry meaning without color. Never pass graph/output strings through as
KaTeX commands. Keep long output as bounded plain text and unsupported glyphs or
oversized topology in the plain/adjacency fallback.

Choose a rendering profile from a verified host capability or explicit user
choice and record its version. A host name, MCP connection, or an accepted tool
response alone does not establish that a particular message surface renders
math. Unknown hosts use plain Markdown. If a selected KaTeX profile cannot encode
a panel safely, fall back to plain Markdown with the same observation identity
and a short reason; JSON stays available. Host compatibility checks cover the
actual Markdown delivery surface, light/dark themes, narrow widths and error
fallback, rather than treating one successful colored example as full support.
KaTeX is an optional enhancement and cannot gate v1 hub launch or basic monitoring.

Chat panels are requested on demand. The user or invoking agent runs `hub inspect`
and includes its canonical text or Markdown in the reply. The hub stores no chat
destinations and does not send or retry session messages. A tool result can show
the generated source; native colors require a supported assistant Markdown
surface. The existing standalone `graphloom watch` notification workflow remains
separate from hub monitoring.

Chat reports use plain Markdown/text or the explicitly supported static KaTeX
profile. Ordinary chat messages never receive raw ANSI escape sequences.
Screenshots and image attachments are exports only when requested; they are not
the normal panel delivery path. A future MCP Apps adapter may offer rich HTML
panels for hosts that support the extension, but neither MCP Apps nor a HAPI/MCP
client modification is a v1 prerequisite. A regular MCP tool can return structured
panel data and a canonical text/Markdown representation; it does not add host
rendering capability by itself. Hub watch/events expose queue admission, graph
progress, waiting/requeue, final success and failure. Distinguish an automatically
handled cooldown from an operator blocker:
the former reports the next eligible time without asking the user to resume.
Hub retries remain controlled solely by the recorded submission policy. The
existing standalone watch skill keeps its current watch-only rules.

For example: `fix-14169 accepted Plan and entered Build #2. Calls 12/40; last
accepted progress 2m ago. Hub occupancy 2/3.` Reports carry enough context for the
agent to relay them without loading the entire run or polling a model every tick.
Execution polling caches the owning runtime's small continuation observation while
`state.json` retains the same file identity. Owner and cgroup liveness are checked
every poll, and cleanup reuses that observation. A changed state invalidates the
cache. Full topology, jobs and usage projections are requested only for panel
reads, including terminal watch refreshes, with a short refresh interval; cgroup
counter sampling continues independently. Older owning runtimes without the
execution-only capability still use their versioned observer, with the same cache.

The canonical report can be printed even when no language model is available;
agent prose is optional presentation, never scheduling evidence. Rendering and
sampling run as ordinary code; metric samples do not invoke an LLM. On-demand
chat rendering uses a surface whose support is known; a tool result does not
inherit the assistant-message renderer merely because both appear in one session.

Keep three views distinct: an inspection or chat message is a timestamped
snapshot; retained events and prior attempts are bounded history; a connected
terminal watch is a live view with explicit stale/disconnected status. A new
snapshot reply does not rewrite old chat history. Message replacement or
continuous rich-UI refresh requires a separate verified host capability and is
outside the baseline. Color, panel size and rendering success are never evidence
that a graph advanced or succeeded.

Expose a snapshot with an event cursor, then a bounded resumable event stream.
Each event has a hub-local monotonic sequence, submission/run identity, observation
time and controller revision when present. Clients retain their event cursors.
Reconnect replays retained events; an expired cursor returns an explicit gap and
a fresh snapshot. Clients deduplicate replayed events by sequence. Bound event
buffers and retention, and surface stale data or disconnected viewers. Event
production reflects recorded facts and observed changes; it is not a complete
trace of every intermediate controller transition between samples.

## 9. Transport and deployment

Use HTTP/JSON over an owner-only Unix socket in `$XDG_RUNTIME_DIR/graphloom/`.
The CLI is its first client. Keep private scheduler state under
`$XDG_STATE_HOME/graphloom/hub/` (default `~/.local/state/graphloom/hub/`).
Resolve submission paths on the local host, validate bounded inputs and enum
values, and accept typed operations rather than arbitrary commands/environment.
The daemon socket remains local and owner-only regardless of renderer. A browser
or phone opening `localhost` cannot directly reach that Unix socket, and rendering
requirements do not authorize a public HTTP listener or a socket proxy. A future
MCP bridge would run as an authorized local client; its host transports only the
bounded panel/tool data through the host's supported channel. Remote access and
its authentication remain a separately designed feature.

| Request | Meaning |
| --- | --- |
| `POST /v1/submissions` | Durable task submission; `Idempotency-Key` supported |
| `GET /v1/submissions` and `GET /v1/submissions/:id` | Bounded list and detail; search parameters `state` (repeatable), `graph`, `repo`, `key`, `since`, `until`, `grep`, `limit`, `archived` (§3.1) |
| `POST /v1/submissions/:id/commands` | Typed pause, resume, cancel, policy-update or archive command |
| `POST /v1/submissions/:id/purge` | Remove an archived submission's run files, or report them with `dryRun`; body `{"dryRun"?, "force"?}` (§4.3) |
| `PATCH /v1/settings` | Change global concurrency limit |
| `GET /v1/health` | Health and aggregate scheduling state: version, socket, counts, faults, archive index size, the hub's environment summary (§3.1) |
| `POST /v1/doctor` | Doctor's checks run by the hub in its own environment; body `{"taskPath"?}` (absolute); one at a time (§3.1) |
| `GET /v1/events?since=<cursor>` | Bounded NDJSON observation stream; reconnect cursor and explicit retention gaps |
| `GET /v1/submissions/:id/logs` | Bounded log read/follow with offset |

All mutations support command idempotency. Resume remedies use a command ID
persisted both by the hub and the controller under the run lock, so a crash after
applying an approval/upgrade cannot apply it twice. `202 Accepted` means queued
or being drained, never that a controller already completed the requested action.

Run the daemon in the foreground under a user systemd service, with explicit
runner/supervisor config paths and installed runtime. No self-daemonization,
terminal setup prompts, or automatic installation occurs in the serving process.
`graphloom hub service` prints the unit; its `ExecStart` is the install home's
version-independent launcher ([§9.2](#92-upgrades-the-launcher-and-restarts)):

```ini
[Unit]
Description=GraphLoom run hub

[Service]
Type=exec
ExecStart=/home/me/.local/share/graphloom/current/bin/graphloom hub serve --config /home/me/.config/graphloom/hub.json
Restart=on-failure
RestartSec=5
# 75: the hub restarts itself when idle after an upgrade; 78: its state is newer than the installed GraphLoom reads.
SuccessExitStatus=75
RestartForceExitStatus=75
RestartPreventExitStatus=78
Delegate=yes
KillMode=mixed
TimeoutStopSec=90
UMask=0077

[Install]
WantedBy=default.target
```

On SIGTERM the hub stops admissions, persists its shutdown intent, asks active
controllers to yield/stop, and drains them within its 60-second grace period.
Service shutdown preserves `execute` intent for restart; user pause remains held.
Systemd's mixed kill mode first signals the main process and ultimately kills
remaining unit processes, giving the hub a chance to coordinate shutdown. See
[systemd's termination rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
External execution still requires runner reconciliation after restart. A host
reboot follows the same durable queue recovery. Enabling lingering for startup
without a login is an operator deployment choice.

### 9.1 The service's environment

A systemd user service reads no shell profile. Its runs inherit the unit's
environment, so a toolchain the profile puts on `PATH` (a Go or nvm Node, say),
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` (without which an agent job gets a `401`
from its provider), and the runner config's token variables are missing unless
the unit provides them, while `graphloom doctor` in the operator's shell still
passes. `graphloom hub service` writes that environment explicitly, as two
drop-ins beside the unit `graphloom-hub.service` (a third, `--limits`, holds
its memory limits; below), under
`$XDG_CONFIG_HOME/systemd/user/graphloom-hub.service.d/` (default
`~/.config/systemd/user/...`):

- `--capture-env` starts a clean login shell of `$SHELL` (`-l -i -c` with only
  `HOME`, `USER`, `LOGNAME`, `SHELL` and `TERM=dumb`, stdin closed, 20 s) and
  keeps an allowlist: `PATH`, Go's variables (`GO` followed by capitals or
  digits only, so never `GOOGLE_API_KEY`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `LANG`, `LC_ALL`, the proxy variables (`HTTP_PROXY` ... `NO_PROXY`, either
  case), and GraphLoom's own non-secret settings, named one by one, never by
  prefix (`CAPTURED_GRAPHLOOM_VARIABLES`): `GRAPHLOOM_DISABLE_AUTOUPDATE` and
  `GRAPHLOOM_RELEASE_REPO`, `GRAPHLOOM_HOME`, `GRAPHLOOM_RUNNER_CONFIG` and
  `GRAPHLOOM_SUPERVISOR_CONFIG`, `GRAPHLOOM_MAX_WIRE_BYTES`, the harness CLIs,
  logins, models and timeouts (`GRAPHLOOM_CLAUDE_*`, `GRAPHLOOM_CODEX_*`,
  `GRAPHLOOM_PI_*`, but not the `*_PASS_ENV` lists), the coding agents' retry
  policy (`GRAPHLOOM_CODING_RETRY_*`) and `GRAPHLOOM_OCR_BIN`; so a profile that
  turns auto-update off keeps it off for the hub's runs. A variable a runner
  config names as a token (the hub config's `runnerConfig`, else the one the
  profile names, and the caller's) is never captured, whatever its name; when
  one cannot be read, no `GRAPHLOOM_*` setting is captured. A value holding a URL with user information (a proxy's or `GOPROXY`'s
  credentials, a user name alone included) and a value spanning lines are
  left out and named. They become `Environment=` lines of `environment.conf`.
- `--token-env-file <file>` writes `tokens.conf`, `EnvironmentFile=-<file>`,
  and fills `<file>` owner-only (mode 0600, written through a renamed temporary
  file) with the runner config's `github.tokenEnv` (the hub config's
  `runnerConfig`, else the default runner config): from that variable in the
  caller's environment, else `gh auth token`. The write token is opt-in:
  `--write-token` adds `github.writeTokenEnv` the same way. A secret is never
  captured anywhere but this file, and never printed.
- Without `--write` the drop-ins are printed and nothing is written; with it,
  the token file and the drop-ins are written (mode 0600). Either way only
  variable names go to stderr. Plain `graphloom hub service` still prints the
  unit and installs nothing.

```sh
graphloom hub service --capture-env --token-env-file ~/.config/graphloom/hub-tokens.env --write
systemctl --user daemon-reload && systemctl --user restart graphloom-hub.service
graphloom hub status     # the environment summary
graphloom hub doctor --task ./tasks/fix/task.yaml
```

Re-run it after changing the shell profile or a toolchain, and after `gh auth
login` or a token rotation (the token file is a copy), then reload and restart
the service; a restart stops active runs cooperatively and continues them. The
drop-ins are independent: refreshing the tokens leaves the captured
environment and the limits alone, and the reverse.

**Memory limits.** `--limits` adds a third drop-in, `10-limits.conf`, with
the service's own `MemoryAccounting=yes`, `MemoryHigh=` and `MemoryMax=`
(§6.2): `hub.json`'s `serviceMemoryHigh`/`serviceMemoryMax` when given, else
each launch limit times `maxConcurrentRuns` (at least one) plus 1 GiB for the
hub itself and its observe and doctor children (9G/13G with the defaults and
two slots); a launch limit of `max` derives `infinity`, and a derived
MemoryHigh above an explicit `serviceMemoryMax` becomes three quarters of it. Printed without
`--write`, written (0600) with it, like the other two. Values set with
`systemctl --user set-property graphloom-hub.service MemoryHigh=... MemoryMax=...`
live in `~/.config/systemd/user.control/graphloom-hub.service.d/50-Memory*.conf`
and take precedence: systemd applies drop-ins of every directory in file-name
order, and `10-limits.conf` sorts first, so a set-property value wins until its
file is removed (`--limits` says so). A `MemoryMax` change applies on
`systemctl --user daemon-reload`; a launch limit change in `hub.json` applies
to launches started after the hub restarts.

`hub status` shows the service's MemoryHigh, MemoryMax, current and peak use
(read from the delegated cgroup), the launch limits and concurrency, and each
live launch's current and peak use against its limit, and a `Recorded launch
peaks:` line over each live and archived submission's latest finished launch
(§6.2): the highest recorded peak (its submission, launch and time), how many
came within 80% of the current `launchMemoryMax`, and how many had an
OOM-killed process; `hub status --json` carries them as `memory` (the
distribution as `memory.recorded`). Both `hub status` and `hub doctor` (a `hub memory`
check among its host checks) warn when the service has no MemoryMax (or a
MemoryMax but no MemoryHigh), when `launchMemoryMax` is `max`, when it
exceeds the service's MemoryMax, and when `launchMemoryMax` times the
concurrency limit exceeds the service's MemoryMax: launches together can then
reach the service's limit, where the kernel kills one that is under its own
(the warning names the `hub limit` that would fit). Docker containers are in
none of these (§6.2).

```sh
graphloom hub service --limits --write
systemctl --user daemon-reload
graphloom hub status     # Memory: and Launch limits: lines, and any warning
```

The hub must not use the daily-update shim as the running daemon executable.
Runtime upgrades take effect at a service restart, which `graphloom upgrade`
arranges ([§9.2](#92-upgrades-the-launcher-and-restarts)); existing runs retain
their owning version. Installation must preserve versions referenced by queued tasks
as well as active runs. An unhealthy scheduler store or failed reconciliation
prevents new admissions and appears in health output.

Installed hubs register durable per-version markers at
`hub-retention/<version>/<hub-directory-hash>.json` under the installer's short-lived lock
before accepting references to installed runtimes or bundles. Pruning protects
only those versions, including with `self prune --force`. The version lives in
the marker's path, so missing hub state or corrupt marker contents cannot expose
its inputs or retain unrelated future installations. Legacy global records are
migrated under the same lock to a finite snapshot of currently installed versions.

Acceptance and retention refresh are serialized: add and sync new pins before
acknowledging a submission, then release references only from an authoritative
queue/owner snapshot. A launch retains its inputs until drainage, even when its
scheduling label is terminal. Queued, waiting, paused, blocked and failed runs
remain resumable and retain their captured inputs, current owning runtime, plugin
and executor pins across daemon shutdown. A pending or launched `--update-plugin`
also retains the bundle it moves to; once the hub records it (§4.2), the
replaced bundle is no longer a captured input. Drained succeeded/canceled submissions
and archived submissions release their hub pins; normal run ownership records
continue to protect retained run artifacts until `hub purge` removes the run's
files and its record (§4.3). Shutdown releases the daemon's own
runtime reference when no remaining submission needs it. Missing or unreadable
run state prevents release and reports a retention error; it never pins versions
installed later. A private list of known install homes lets a restarted hub
remove stale markers after its last submission in a home is archived.

### 9.2 Upgrades: the launcher and restarts

Before the launcher, `hub service` pinned `ExecStart` to one version's Node and
CLI (`versions/<v>/node/bin/node versions/<v>/apps/graphloom/dist/main.js`), so
after every upgrade the operator regenerated the unit, reloaded systemd and
restarted the hub when idle, and a forgotten step left the hub on the old
version. Three pieces remove those steps.

**The launcher.** For an installed GraphLoom, `ExecStart` is
`<home>/current/bin/graphloom hub serve --config <file>`: the release's own
launcher reached through the `current` link, which systemd resolves when it
starts the hub; the launcher then runs the version's bundled Node on the real
path of that version's CLI ([release design §4.1](design-release.md#41-layout)),
so the hub loads every module from `versions/<v>/` and a later switch of
`current` never changes a running hub. A hub start after an install therefore
runs the new version with no new unit. It is not the user shim: the hub never
starts the daily update check. A clone has no install home; its unit stays
pinned to the clone's Node and CLI. What runs a submission does not change: a
submission's runtime is the hub's own at acceptance (§4), retained by the
per-version markers below, and a resume dispatches to the run's owning version
(§6), so a running or queued submission keeps its runtime across a hub
restart onto a newer version.

**The refresh.** `graphloom hub service --refresh` brings an installed unit and
the hub it runs onto the version that runs the command, and `install.sh` runs
it, with the newly switched version's CLI, after `graphloom upgrade` or an
install that switches `current` (not with `--no-switch`), when
`$XDG_CONFIG_HOME/systemd/user/graphloom-hub.service` exists. It releases
`install.lock` first, since a starting hub takes it (retention below).

1. A unit whose `ExecStart` is pinned to one of this home's
   `versions/<v>/` (that version's Node and CLI, or its `bin/graphloom`) gets
   the launcher's `ExecStart` with the same arguments, once; a unit without
   the restart exit statuses gets them. Every other line, and every drop-in,
   stays. A unit that starts anything else (a clone, another home) is the
   operator's own: left alone and not restarted.
2. The environment is not captured again: `environment.conf`, `tokens.conf`
   and the token file (§9.1) are the operator's deliberate choice, and an
   upgrade that silently re-read the login shell could change what runs see.
   Instead the refresh reports the new version's `hub doctor` in the hub's
   environment once the hub runs it: `ok`, or each failing check with its fix.
3. `systemctl --user show` decides reachability. When systemd's user manager
   does not answer (no user bus, a container, `ssh` without lingering), the
   refresh restarts nothing and prints the commands: `systemctl --user
   daemon-reload && systemctl --user restart graphloom-hub.service` when the
   hub is idle. Otherwise it always runs `systemctl --user daemon-reload` (so
   a retry also applies an edit an interrupted refresh made), reads whether
   the loaded unit restarts on exit 75, and asks the hub (`GET /v1/health`,
   on the unit's `--socket`, else its `--config`'s socket) which version it
   runs and how many launches hold slots:

| The hub | The refresh |
| --- | --- |
| Not active | Restarts nothing; the next start runs the new version |
| Already on this version | Reports its doctor |
| Idle (no occupied slot) | `POST /v1/restart {"when": "idle"}`: the hub holds admissions and, still idle, restarts at once, so nothing it admitted after the health reply is interrupted; the refresh waits up to 90 s for it to answer on the new version and reports its doctor |
| Idle, and the hub (older than this) or the loaded unit cannot take the request | `systemctl --user restart graphloom-hub.service` at once (a launch admitted in between is stopped cooperatively and continued), then as above |
| Busy | `POST /v1/restart {"when": "idle"}`: the hub restarts once its running launches finish |
| Busy, and the hub or the loaded unit cannot take the request | Prints the restart command for when it is idle |
| Active but not answering on its socket | Prints the restart command |

**Restart when idle.** A hub asked to restart when idle stops starting new
launches (submissions are still accepted and queued, waiting ones still become
ready), lets the running launches drain and settle as usual, and when no slot
is occupied it closes like a service stop and exits 75; the unit's
`RestartForceExitStatus=75` makes systemd start it again, through the launcher,
on the installed version (`SuccessExitStatus=75` keeps it from being logged as a
failure). The request lives only in the hub process: a crash or any other
restart starts the new version anyway and clears it. `hub status` shows
`Restart pending since <time> (<reason>): no new launch starts; ...` and the
health object carries `restart` and `launchesHeld`. The hub accepts the
request only under its unit (systemd's `INVOCATION_ID` is set); elsewhere it
answers `409`, and the refresh checks that the loaded unit restarts on 75
before asking. Holding new launches is the simplest safe choice: it bounds the
wait by the launches already running, where waiting for a natural idle moment
could wait forever on a busy queue, and it interrupts nothing; queued work
loses only the time the running launches take, and starts on the new version.
An operator who wants the new version at once runs `systemctl --user restart
graphloom-hub.service`, which stops active runs cooperatively and continues
them afterwards (§9).

**Automatic updates.** The daily update check ([release design
§5.4](design-release.md#54-automatic-updates)) installs and switches `current`
but leaves the running hub alone: `install.sh --auto` prints `hub: keeps its
version until restarted` to `update/log`, and the update notice says the hub
keeps its version until `graphloom hub service --refresh`. No surprise
restarts come from the daily trigger. An operator who wants them sets
`GRAPHLOOM_HUB_RESTART_ON_AUTO_UPDATE=1` in the shell the shim runs from;
`install.sh --auto` then runs the refresh as `graphloom upgrade` does (an
idle hub restarts, a busy one restarts when idle). `GRAPHLOOM_DISABLE_AUTOUPDATE=1`
starts no check at all, so it installs and restarts nothing. Because `current`
moved, any later restart of the hub (a reboot, a crash) runs the new version.

**State format.** `scheduler.json`'s `schemaVersion` is the hub state format
(1 today). Before it writes anything (the state directory, retention markers,
the store), a starting hub reads that field: a newer format than it reads
means a newer GraphLoom wrote the state, for example after `graphloom self
rollback` or `self use` with a hub that the newer version ran, and the hub
refuses to start, naming the directory and both formats, and exits 78; the
unit's `RestartPreventExitStatus=78` keeps systemd from looping on it. Nothing
is changed: the operator starts the newer version again (`graphloom self use
<v>`, then `systemctl --user restart graphloom-hub.service`). An older format
is read by a newer hub, which migrates it forward when it next saves; none
exists yet. A state the hub cannot parse at all stays a corrupt-store refusal
(§10), never an empty queue.

**First upgrade.** `graphloom upgrade` runs the installer of the version being
left. Upgrading from a version before the refresh therefore runs no refresh;
run `graphloom hub service --refresh` once after it. `hub status` names the
gap meanwhile: `Installed: GraphLoom <current> is current, the hub runs
<version>: graphloom hub service --refresh restarts it`. A switch to a version
without the refresh (an older one) prints that the hub restarts by hand.
`graphloom self use` and `self rollback` switch `current` without a refresh;
the hub moves at its next restart (`systemctl --user restart
graphloom-hub.service` when it is idle).

## 10. Implementation and verification

The implementation follows these layers; production-host qualification remains separate:

1. **Managed execution contract.** Exclusive/idempotent intake journal, run binding,
   launch protocol, controller continuation observation, runner drainage result,
   version compatibility. Test independently of the daemon transport.
2. **Queue and concurrency.** Durable submissions and commands, serialized slot
   reservation, fair readiness order, manual pause/resume/cancel, crash recovery.
3. **Automatic continuation and observations.** Bounded retry policy, safe wait
   yields, versioned snapshots and reused progress/usage projections, independent
   panels with JSON/plain/Markdown and ANSI terminal rendering, an optional
   terminal composition, and on-demand chat snapshots. Qualify the optional
   static KaTeX profile on supported HAPI message surfaces separately; it does
   not block the baseline. MCP Apps remains later
   work for compatible hosts.
4. **Deployment.** Unix transport, delegated cgroups, user service packaging,
   release retention and clean-install/restart verification.

Use scripted graphs, stub CLI children, temporary repositories/homes and an
injectable clock. No live provider or real login is needed for core verification.
Test observable admission and process behavior, not just queue implementation.

| Scenario | Required result |
| --- | --- |
| Submit 20 runs with limit 3 | At most 3 reserved/executing runs; remaining tasks eventually start |
| Parallel submit/resume/limit commands | Durable ordering; no duplicate execution or admission race |
| Limit 3 → 1 → 0 → 4 | Drain without killing on decrease, no new launch at 0, fill capacity on increase |
| Retrying run alongside new work | Retry joins behind already-ready submissions; same run ID and budgets |
| Kill hub before/after every reservation, spawn, grant, intake and ack write | One submission maps to at most one run/worktree; uncertain launch keeps its slot |
| Kill controller with surviving grandchild or Docker container | Slot retained until verified cleanup; no replacement overlaps |
| Restart with expired owner lease but original process alive | Original execution stays fenced; no duplicate controller |
| Reused PID, old boot ID or delayed control message | No unrelated process signaled; stale messages cannot settle launches |
| Quota yield versus live sleeping controller | Yield releases only after drain; sleeping process remains occupied |
| Stop during cooldown or simultaneous retry admission | Hold/cancel wins once recorded; already-reserved child is revoked or drained |
| Crash, reconciliation debt, exhausted budget or unknown stop | No unsafe automatic replay, budget increase or implicit acknowledgement |
| Repeated transient failure across daemon restarts | Durable backoff, repetition and total limits eventually block |
| Same idempotency key with same/different payload | Same submission/conflict respectively, including lost response |
| Crash after operator remedy applies but before hub acknowledgement | Command result reconciles without applying remedy twice |
| Pause lands right after a remedy resume is accepted | The remedy is held and applies on the next resume, or a retry of its command ID applies it; never reported applied when it was not |
| A remedy or launch input the run refuses (wrong approval ID, unknown scenario) | Blocked at once with the refusal and the earlier stop, not retried; a corrected command still applies |
| Automatic retries run out | The blocker names the limit reached and the last cause |
| Task/config/base/bundle changes while queued | Captured inputs used or explicit drift blocker; no silent substitution |
| Slow log reader, disk full, corrupt/newer snapshot | Bounded memory; no unpersisted launch; explicit health failure |
| Admission capacity filled with existing runs active | Pause, cancel, drainage and settlement still persist within reserved capacity |
| Planned restart versus repeated unplanned daemon crashes | Planned continuation preserves retry allowance; unplanned recovery exhausts its bounded allowance |
| Managed direct resume or second hub instance | Cannot bypass the slot scheduler or the hub lock |
| Missing runtime version, cgroup delegation or cleanup capability | Refuse managed launch with an actionable explanation |
| Service environment lacks a tool or variable the operator's shell has | `hub status` warns for an enabled harness's missing CLI; `hub doctor` fails the check runs would fail; `hub service --capture-env` prints only allowlisted names, tokens only into the 0600 file |
| Submit a task whose check fails in the hub's environment | Refused before capture with each failing check and its fix; warnings pass; a rehearsal needs only the host checks, the plugin and, with `--commands run`, its environment checks; `--no-preflight` skips |
| Upgrade with a pinned unit, an idle hub, a busy hub, or no reachable systemd | Unit migrated once to the launcher, drop-ins untouched; idle restarted at once; busy restarts when idle with new launches held; unreachable restarts nothing and prints the commands |
| Hub state written in a newer format | Refused at start with exit 78, nothing written |
| Same run in terminal and chat | Same snapshot facts and controller revision; no client-owned scheduling |
| Single panel or several panels requested | Independent rendering or shared observation frame; same facts and stable job selection |
| TTY resize, narrow view, Unicode labels, redirected output | Readable panels or append-only plain/JSON; no stray control sequences |
| Known KaTeX host, unknown host, or changed host version | Explicit profile selection; auto is plain when capability is unverified; no inference from MCP connectivity |
| KaTeX syntax characters, unsupported glyphs, large graph or renderer failure | Escaped data and bounded plain fallback; no arbitrary commands; every graph edge remains retrievable through paginated adjacency |
| HAPI assistant message versus tool result | Qualify the actual rendering surface; success in one surface does not claim support in all |
| Static inspection, retained history and connected watch | Timestamps, history scope and live/stale state remain distinct; old snapshots do not appear live |
| ANSI, Markdown/KaTeX and JSON for the same panel | Same identities, values, units, unknown/gap markers and status words; color/layout adds no acceptance claim |
| Viewer exits or watch connection disconnects | Runs continue; reconnect resumes or reports an explicit event gap |
| High-frequency metric updates | Bounded code-driven sampling; no per-sample model calls or unsolicited chat output |
| Browser/phone preview or future MCP client | No public hub listener or implicit bypass of the local socket boundary |
| UI marks a stage or run complete | Completion comes from controller evidence/status, never animation or job exit alone |
| Real systemd stop/restart/reboot-equivalent test | Queue restored, descendants accounted for, user holds preserved |

Document checks cover relative links and consistency with the core design.
Implementation checks must include affected workspace tests, typecheck and build;
cgroup/systemd/container qualification runs in a Linux integration environment
where those capabilities are required, not silently skipped.

## 11. Existing code to build on

| Existing code | Reuse or required extension |
| --- | --- |
| [CLI entry](../apps/graphloom/src/main.ts) | Run/resume composition; add managed bootstrap and hub commands |
| [Controller lifecycle](../packages/controller/src/controller.ts) | Optional caller-chosen run ID, creation callback, stop/resume; add exclusive intake journal and managed binding |
| [Run ownership](../packages/controller/src/owner.ts) | Linux process identity and conservative live-owner detection |
| [Stop classification](../packages/controller/src/stop-class.ts) | Operator resume semantics; add separate unattended-continuation classification |
| [Execution loop](../packages/controller/src/loop.ts) | Quota/retry waits, final acceptance and delivery checks; add safe scheduling yields |
| [Reconciliation](../packages/controller/src/reconcile.ts) | Interrupted dispatch handling; controller retains all decisions about effects |
| [Version ownership](../apps/graphloom/src/ownership.ts) | Dispatch to the installed version that owns the run |
| [Progress](../apps/graphloom/src/progress.ts) and [statistics](../apps/graphloom/src/stats.ts) | Existing stage, budget, waiting and usage projections |
| [Docker confinement](../packages/runner/src/sandbox-docker.ts) | Run-labelled external process cleanup; require a verifiable drainage result |

## 12. Rehearsal submissions

A **rehearsal submission** exercises the hub, and a graph's journey through
it, without a model call: the hub queues, reserves, launches, contains,
observes, continues, stops, remedies and retains it exactly as it does a real
submission, but its managed launch runs the run on the stand-ins
[`graphloom rehearse`](design-graph-rehearsal.md) uses: scripted agents for
Pi, Claude Code and Codex, the scenario's scripted supervisor, quick mode's
command stub (or the real commands with `--commands run`), and with
`--offline` the GitHub stand-in replaying the scenario's recorded reads.
Nothing in the scheduler, the controller or the plugin host changes for it;
the hub never learns a plugin notion, and a plugin cannot tell a hub rehearsal
from a `graphloom rehearse` run (both carry the `rehearsal-` run-ID prefix
that keeps a plugin's refs under `rehearsal/<runId>/`).

```sh
graphloom hub submit task.yaml --rehearsal [--scenario <name>] [--commands stub|run] [--offline] [--stop-at <stage>] [--key <id>]
```

### 12.1 Captured input and identity

The settings are part of the captured input (`HubInput.rehearsal`:
`scenario`, `commands`, `offline`, `stopAt`; only what was given), so of the
request digest and the snapshot: they are durable, immutable and checked on the
wire (a scenario name of at most 128 safe characters, `commands` `stub` or
`run`, `offline` true, `stopAt` a node id or name of at most 128 characters,
letters, digits, spaces, `.`, `_` or `-`; anything else is refused). A rehearsal submission's
idempotency key is scoped apart: the hub stores `rehearsal:<key>`, and a
real submission's key may not start with that prefix, so a rehearsal and a
real submission of the same task and `--key` are always two submissions,
never a conflict. Its run ID is `rehearsal-hub-<uuid>`. Intake captures the
runner config when there is one (B2 probes the operator's real agent CLIs
named there) but does not require it, and pins no supervisor config: the
scenario's script is the supervisor. `--scenario`, `--commands`,
`--offline` and `--stop-at` without `--rehearsal` are refused by the CLI
before any request.

### 12.2 Launch, scope of the stand-ins, continuation

The managed bootstrap reads the mode from the stored submission, never from a
client: an initial launch runs `rehearse <launch task> --state-root <hub>/runs
<settings>`, a resume `resume <stateDir> --rehearsal <remedies>`, and a
reconciliation pass `__hub-reconcile <stateDir> --rehearsal`; a real
submission gets `run`, `resume` and `__hub-reconcile` without it. Each entry
re-reads the stored submission and refuses a command of the other mode, so a
real submission never runs on stand-ins and a rehearsal never on the
operator's harnesses. `graphloom resume <run> --rehearsal` on a hub run routes
to the hub only when the run is a rehearsal submission's, and a rehearsal
submission's run refuses a plain `graphloom resume`.

The stand-ins are scoped to the rehearsal launch's own process. The launch
writes its scratch (scenario, options, stand-in home, launchers, reply
cursors, call log, verdict) to `<hub>/rehearsals/<runId>/`, builds the
stand-in runner config in memory, and sets the stand-in variables
(`GRAPHLOOM_REHEARSAL_SCENARIO`, `_HOME`, `_SYNTHESIZED`, `_ADVERSARIAL`) in
that process only while the run executes. The hub service's environment is
never modified. Every managed launch first drops any stand-in variable it
inherited from the service (a real launch also drops
`GRAPHLOOM_REHEARSAL_GITHUB_TOKEN`, which a rehearsal's online reads may use),
so a stray variable in the service's environment cannot make a real run
answer from a scenario. The rehearsal's task (`rehearsal-task.yaml`, the
captured request with the rehearsal's small budgets) sits beside the
materialized launch task and is kept, so a retried initial launch intakes the
same bytes under the same binding. Cleanup after a launch drains the runner
the run used: the pinned runner config when there is one, else the built-in
executors' own cleanup contract.

`hub resume` continues a rehearsal as a rehearsal: the scripted supervisor
starts at the scenario's next unused decision, counted from the run's
recorded supervisor episodes, as `resume --rehearsal` does
([rehearsal design](design-graph-rehearsal.md), decided 2026-11-19).
`--approve`, `--decline`, `--reconciled`, `--update-plugin`,
`--update-executors` and `--upgrade` behave as for a real run;
`--supervisor` is refused, since the supervisor is the script. Automatic
continuation, pause, cancel, service interruption, retention and archive are
unchanged.

With `stopAt` the initial launch runs `rehearse --stop-at <stage>`'s run: it
stops as an operator stop once that node (id or name) is accepted on the live
path, before the graph is asked for its next step, and the submission shows
`blocked`. A plain `hub resume` continues it on the stand-ins to the run's end,
as `resume --rehearsal` continues a direct `rehearse --stop-at`. The stop point
holds for the initial launch only: a launch interrupted before the node was
accepted leaves the verdict pending, and its continuation runs on to the end.

Every shipped graph's scenarios run offline (`--offline`) with no GitHub at
all: each scenario records the reads its run makes, and the offline GitHub
stand-in declares the write executors too, so the binding withholds a write
exactly as online. A review graph's Publish therefore stops with `posting not
enabled` where online it would post, and a clean design review succeeds
without a write. The issue-fix scenarios are meant for `--commands run`, on a
task naming the issue they replay (`rehearsalRequest` of the plugin's
rehearsal entry); quick mode cannot stand in for the command jobs whose output
that graph reads back ([rehearsal design](design-graph-rehearsal.md#46-hermeticity-and-time)).
`hub-rehearsal-shipped.<tier>.test.ts` submits them to a temporary hub and
checks each recorded verdict equals the direct `rehearse` verdict.

### 12.3 Verdict

The launch evaluates the rehearsal as `rehearse` does (the controller's
boundary checks with the CLI's B2 capability probe and B3 call-log check
merged in) and records it once, after the first launch whose run stopped for
its own reasons: succeeded, failed, a stop that needs the operator, such as
a graph's declared approval, or the submission's own stop point. A launch the
hub or the operator interrupted (a pause, a scheduling yield, a crash) leaves
it pending, and a later launch takes it. Under `stopAt` the verdict is the
stop's, as `rehearse --stop-at` judges it: `ready` exactly when the run
stopped once the node was accepted with no node after it on the live path
accepted, else `not-ready` with the blocker `stop-at`; it carries no B-checks,
names the node (`stoppedAt`), and `report.json` holds the stop report
`rehearse --stop-at` prints. A continuation of a recorded rehearsal keeps the recorded verdict:
for a scenario that expects an approval stop, the verdict is the stop's, and
the approved continuation's success does not re-grade it, unless the scenario
rehearses the answer the resume carried
([rehearsal §4.4](design-graph-rehearsal.md#44-scenarios)): the scenario then
continues with the answer's own expectation, and the answer supersedes the
recorded verdict: it is pending again, and the launch whose run stops on its
own records the continuation's.
`<hub>/rehearsals/<runId>/verdict.json` holds the compact verdict (`verdict`,
each B-check's status, the blocker, convergence, the run's status and stop
reason, the launch and time), `report.json` the full report beside it.

The hub service reads the verdict file; it is never part of the scheduler's
snapshot or a controller observation. `hub list --json` carries
`rehearsals.<submission>` for each listed rehearsal with a verdict, `GET
/v1/submissions/<id>` adds `rehearsalVerdict`, the overview panel of `hub
inspect` adds a `Rehearsal:` line (scenario, commands, offline, the stop
point, verdict and the checks that did not pass), `hub list` marks a row `[rehearsal <scenario>:
<verdict>]`, `hub status` counts rehearsal submissions by state
(`rehearsalCounts`), and an archive index entry keeps the settings and the
verdict. A rehearsal takes a slot like any submission: the limit covers
rehearsals and real runs together.

| Scenario | Required result |
| --- | --- |
| Rehearsal of `hello`'s happy scenario through a hub | Succeeds through the real managed bootstrap; verdict `ready` recorded and shown |
| Topology fixture's `operator` scenario | Blocks waiting on the approval with verdict `ready`; `hub resume --approve` continues with the script's next decision to `succeeded` |
| Rehearsal and real submission of one task and key | Two submissions, two run IDs, distinct digests; each key idempotent in its own scope |
| Rehearsal settings without `--rehearsal`; `--supervisor` on a rehearsal | Refused |
| Stand-in variables planted in the service's environment | Absent from a real launch's environment; a rehearsal sets its own |
| Every scenario of every shipped graph, offline, through a hub | The recorded verdict equals the direct `rehearse` verdict, and every one is `ready` |
| issue-fix's `arbitrate-operator`, answered with each answer its blocker names (`review-stands`, `implementation-stands`, a decline), directly and through a hub | Each continues as the scenario's answer scripts it to `succeeded`, with a `ready` verdict |
| `--stop-at` on `hello`'s happy scenario, by id and by name | Blocks at the node with the stop's verdict, equal to `rehearse --stop-at`'s; `hub resume` continues to `succeeded` and keeps the verdict |
