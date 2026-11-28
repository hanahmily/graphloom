# GraphLoom loop (research and proposal)

Status: research draft. Implemented so far: the SDK's `validateLoopReply`,
the `packages/loop` skeleton (definition, pure engine, durable store), the
evaluator core, the runner-backed read host, the plugin-host `loopCandidates`
callback and `graphloom loop evaluate` (the last three are on the
`loop-read-host` branch); nothing else (no hub timer, janitor graph or
issue-fix hook). It extends the
[run hub](design-run-hub.md) and [`task new`](design-typescript-core.md#16-preparing-a-task-graphloom-task-new)
without changing graph topology, acceptance or supervisor authority. Companion
drafts: [hub janitor](design-hub-janitor.md) (the first loop) and the
[issue-fix "Looping" section](design-issue-fix-graph.md#looping-designed-not-implemented).
Prior-art notes are from memory, not re-verified. Open items are collected in
[section 15](#15-open-items).

## 1. Problem

An operator wants "keep running graph G on every work item that matches rule R":
for example issue-fix on the BanyanDB issues assigned to `hanahmily`. Today a
human runs `task new` then `hub submit` per item. A loop automates that, and the
hard part is not the timer. It is **triage**: decide, per candidate, whether a run
should start at all.

## 2. Terms

- **Candidate**: one work item a bundle lists for a loop, with a stable **subject
  key** the bundle chooses (`github:apache/skywalking-banyandb#1234`, or
  `day:2026-11-26` for housekeeping). The loop treats it as an opaque string.
- **Tick**: one pass of a loop: ask the bundle for candidates, apply the loop's
  own checks, submit the survivors.
- **Loop checks**: decisions made from runs and counts only (live run for this
  key, limits, preflight). Output `start | skip(reason)`.
- **Graph triage**: decisions that need the forge, made by the graph's own first
  step in a run (section 5).

## 3. Requirements

Who owns each is in section 5.

1. **Selection** by operator rule (assignee, labels, state, age): the graph's
   profile, listed by the bundle. Not the loop.
2. **No duplicate run**: no start while a non-terminal run exists for the key;
   a terminal run keeps the key reserved (sections 7 and 13).
3. **No start when the work is already delivered or in flight** (an issue with a
   PR, or closed): the graph's Triage step, not the loop.
4. **Capacity**: respect hub `maxConcurrentRuns`, plus a loop-level live cap and
   a per-tick start cap.
5. **Failure policy**: the loop never reruns a failed or blocked run; the graph
   owns its own retry. The key stays reserved until the operator acts.
6. **Explainable**: every loop skip records a one-line reason and evidence; a
   graph refusal is the run's own result. Operators read both with
   `loop status`.
7. **Crash-safe and idempotent**: a tick that dies halfway repeats without
   starting a second run.

The controller-plugin boundary applies: the hub, SDK, CLI and loop must not
learn what an "issue" or "assignee" is. Whatever knows GitHub vocabulary lives in
the bundle and its profile.

## 4. Where the loop lives: modes

| # | Mode | Description | Verdict |
|---|---|---|---|
| A | Hub component | Loop definitions are stored in the hub's `scheduler.json`; the daemon ticks them and submits internally | Gets durable state, one serialized writer, the existing idempotency keys and concurrency for free. Not usable without a daemon |
| B | Standalone executable | `graphloom loop run ./loop.yaml` polls, triages, and starts `graphloom run` directly, with its own state file | Works anywhere, but needs its own lock, state, capacity accounting and duplicate guard, and it bypasses the hub limit |
| C | Standalone core, hub as a sink | One loop engine library with a pluggable **sink**: `hub` (submit) or `direct` (spawn `graphloom run`). Run as `graphloom loop tick/run` externally, or hosted by the hub | Both of your ideas, one implementation |
| D | External scheduler drives one-shot ticks | systemd timer or cron runs `graphloom loop tick` and exits; no long-lived loop process | Simplest operationally; state lives in the loop's file, the timer lives in the OS |
| E | Event-driven (webhook) | GitHub webhook calls the loop on `issues.assigned`, so polling is unnecessary | Needs network exposure; the hub is a Unix socket only. Treat as a later *source* kind, not a loop mode |
| F | The loop is itself a graph | A "dispatcher" graph whose run lists candidates and submits child runs | Contradicts "no run starting another" in `AGENTS.md`, and a run is not a good long-lived daemon. Rejected |
| G | Plugin-owned loop | Each graph plugin declares its own source and triage as data | Right for the vocabulary (see 5), not for scheduling |

### Recommendation: C; first release is hub-hosted, the engine is a shared library

The hub already has the durable queue, concurrency limit, idempotent keys,
crash recovery, retention and archive search, so the hub-hosted loop is the
only first-release host; `direct` below is later work, kept as a seam. Ticks are level-triggered, like a
Kubernetes reconcile loop, not event-driven.

The engine is a pure function plus a small durable store:

```text
tick(loop, now, source, runs, store) -> decisions[]   // pure given inputs
apply(decisions, sink)                               // the only side effect
```

- **Core** (`packages/loop`, new): definition schema, tick, triage pipeline,
  store (`loops/<name>/state.json`, kernel lock, write-temp-fsync-rename as in
  the hub), decision log. No GitHub or graph vocabulary.
- **Sink `hub`**: `hub submit` with key `loop:<name>:<subjectKey>:<generation>`.
  The hub's existing idempotency makes a repeated tick harmless. Hub hosts the
  timer (mode A) so `hub serve` ticks enabled loops; `graphloom loop` talks to the
  hub socket for create/enable/disable/status.
- **Sink `direct`** (later, not in the first release): spawns `graphloom run` detached with the same key recorded
  in the loop store, for machines with no hub. It needs the loop's own duplicate
  guard (the run directory for that key exists, so refuse). This keeps B/D usable
  without drifting from the hub's semantics.
- **One-shot**: `graphloom loop tick ./loop.yaml [--dry-run]` runs a single tick
  and prints decisions. `--dry-run` is the first thing an operator uses to
  check a rule, and it is the main test seam.

Why not only A: a pure engine is easier to test and can be reused by a later
standalone host. Why not only B: it duplicates the hub's queue, limit and restart
guarantees.

## 5. Where triage lives

The loop owns only what it can decide from runs and counts. Everything that
needs the forge belongs to the graph and its profile.

| Question | Owner | Where |
|---|---|---|
| Is it mine (assignee, labels, repo)? | issue-fix | Its profile's `loop` section; the loop does not read it |
| Does it already have an open PR or pushed branch? | issue-fix | A step in the graph (see below); the loop does not check |
| Is it actionable, small, well specified? | issue-fix | A step in the graph |
| Is a run for this key already live, or blocked/failed/canceled? | loop | Run ledger, hub submission state |
| Capacity, per-tick starts, preflight | loop | `limits` |

**The open-PR check is a graph step, not a loop gate.** Consequence to accept
knowingly: an item the graph will refuse still costs a hub submission, a run
record and a slot while the step runs. The step needs no model, but the run is initialised first, which creates a
worktree and a branch in the task repository, so a refused issue leaves one
worktree behind until cleanup exists (the janitor defers worktree removal in
v1, see its open point 3). The key stays reserved, so it is one per issue, not
one per tick. The cost is otherwise small, and it means one implementation of "is
this delivered" that also protects a hand-started `graphloom run`. The loop
must then treat the refusal as a terminal, successful no-op: the key stays
reserved, so the next tick returns the same submission and does not start
another. The item becomes eligible again only when an explicit generation bump
says so (section 7), for example the PR was closed unmerged and the operator
unparks it.

### The plugin contract (keeps the boundary)

The loop needs a list of candidate keys from somewhere, and listing needs forge
vocabulary, so it is a bundle hook, a sibling of `prepareTask`:
`loopCandidates({ profile, now }) -> { candidates: [{ key, taskArgs }] }`; the
hook is pure, so `now` is an input (housekeeping needs it for its daily key).
It lists by the profile's `loop` section only (assignee, labels, state) and does
not judge delivery; that stays in the graph step. The hook reads nothing and has no network like `prepareTask`, so listing GitHub
issues needs a request and response protocol: the CLI performs the reads the
hook requests, with the runner config's read token, and hands the results back.
The protocol is section 14. The loop never sees the word
"issue". An optional `observedState` digest (issue `updatedAt`, comment count)
is reserved in the shape for later; v1 does not use it (section 7).

## 6. Definition file

There is no separate `selector`. A loop definition refers to a **graph
profile**, and the graph's profile schema, already validated by the bundle,
gains an optional `loop` section that holds the discovery fields.

```yaml
# loops/banyandb-issues.yaml        (generic; owned by packages/loop)
name: banyandb-issues
every: 15m                      # between 1m and 24d (the timer limit); shorter is refused
graph: issue-fix
profile: banyandb               # the issue-fix profile, as for `task new`
sink: hub                       # first release: hub only
limits:
  maxStartsPerTick: 1
  maxLiveRuns: 2
  maxStartsPerDay: 5
version: ">=0.17 <0.18"          # optional guard on the bundle (section 11)
```

The graph is found through `<loop dir>/plugins/issue-fix` (section 11).

```jsonc
// profiles/banyandb.json          (owned by issue-fix; documented in its design)
{
  "project": "apache/skywalking-banyandb",
  "issues": { "owner": "apache", "repo": "skywalking-banyandb", "context": [ ... ] },
  "loop": {                       // optional; absent means the profile cannot be looped
    "assignee": "hanahmily",
    "labels": { "none": ["wontfix", "needs-design"] }
  }
}
```

The issue repository is not repeated: it is the profile's existing `issues`
field, and `loopCandidates` reads it from there. The loop validates nothing
inside the profile; it asks the bundle (already done by `check`) and refuses
`loop add` with "profile `<p>` has no `loop` section" when the bundle says the
profile cannot be looped.

| Field | Owner |
|---|---|
| `name`, `every`, `graph`, `profile`, `sink`, `limits.*`; optional `repo` override | loop |
| `issues.*`, `loop.*` (assignee, labels, state), PR check | issue-fix profile and graph |

**A loop is not bound to a repository**, because a graph is not (the janitor
needs none; see its design, which has the bundle declare `repository:
"required" | "optional" | "none"`; `optional` also accepts a plain folder,
snapshotted at intake). For a graph that needs one, the local checkout is not in
the profile: a profile names the GitHub
`project`, which is shared and checked in; a local path differs per machine. The
loop resolves the task repository in order: the loop file's optional `repo`;
else the runner config's per-machine `repositories` map keyed by the profile's
`project` (new, generic: slug to path); else the loop file's directory, as
`task new --repo .` does. `loop add` refuses when none resolves.

`loop` commands: `loop add|list|status|enable|disable|tick [--dry-run]|unpark|rm`.
`loop status` prints, per key, its latest decision and reason.

## 7. Dedup and idempotency

Reuse the hub's semantics: the same key and task returns the same submission.

- **Subject key**: chosen by the bundle, stable (`github:owner/repo#N`).
- **Run key**: `loop:<name>:<subject>:<n>`, where `n` is a *generation* that
  increases only when an operator unparks the subject. Same generation means the
  same hub submission, so a crashed or doubled tick cannot create a second run.
- **Never auto-resubmit** a key whose last submission is `blocked` or `failed`:
  the hub already blocks after its retries, and resubmitting would loop on the
  same failure. It needs the operator (`loop unpark`, which bumps the
  generation). `canceled` and archived are respected, not resubmitted.
- **No automatic re-run on item change in v1.** An updated issue or new comment
  does not bump the generation: with decision 13.1 (an issue with a PR is
  skipped) and a failed key never rerun, an automatic bump could only restart
  refused or failed work at the cost of a slot and a worktree per change. The
  operator unparks. An `observedState`-driven bump may follow with its own
  rules.
- **Write-ahead order**: record `intent(subject, key)` in the loop store, fsync,
  submit with that key, record `started(runId)`. Recovery replays intents: the
  hub's key lookup answers whether the submit landed. This is the same
  reconcile-before-retry rule the controller follows.
- **Delivery is the graph's check** (section 5), not the loop's. The loop only
  guarantees the key: a graph refusal is a terminal no-op that keeps the key
  reserved, so it is not re-run each tick. Whether a closed-unmerged PR makes an
  issue eligible again is the operator's call: they unpark the key.

## 8. Safety

- **Preflight before submitting.** The hub runs in its own systemd environment
  (tools, logins and tokens come from `hub service --capture-env` and a 0600
  token file, not the shell). Each tick runs the `hub doctor --task` equivalent
  for the loop's task first; a failing preflight skips the tick with the doctor's
  reason. Otherwise a loop mass-produces blocked submissions.
- **The hub stays read-only.** No GitHub write token; runs stop at delivery for
  the owner's approval. The loop never changes that.
- **Respect the queue, do not burst.** Concurrency limit (currently 2) and
  per-launch memory limits (#365) stand; `maxStartsPerTick` defaults to 1.
  Polling shares the frozen token in `hub.env`, so cap GitHub requests per tick,
  honour rate-limit headers, and back off.
- **issue-fix tasks the loop writes carry `grants: sourceRepair: true`** (owner
  rule), supplied by the bundle's task plan.
- A new loop starts **disabled** and defaults to `--dry-run` until enabled.
- Hard caps: `maxStartsPerTick`, `maxLiveRuns`, `maxStartsPerDay`; also a global
  kill switch (`loop disable --all`).
- The loop never answers a run's approvals, resumes, or raises budgets. Stopped
  runs stay the supervisor's and operator's concern; the loop only counts them as
  live.
- The graph's own delivery rules apply (graphloom-deliver still needs an
  explicit yes to push).
- Discovery abuse: only items the profile's `loop` section matches are listed, so a
  stranger cannot trigger a run by filing an issue unless it is assigned to the
  operator. Issue text is untrusted input, as the graph already treats it.

## 9. Prior art (from memory)

- **Prow/Tide, GitHub Actions schedule and concurrency groups**: label-gated
  queues and per-key concurrency; informs caps and the one-live-run-per-subject rule.
- **Kubernetes controllers / Argo Events**: level-triggered reconcile with
  idempotent names. We copy level-triggered ticks and deterministic keys.
- **Dependabot/Renovate**: schedule plus "one open PR per dependency" dedup by
  branch name. Matches the Triage step.
- **GitHub Copilot coding agent, OpenHands resolver, Sweep**: assignment or label
  triggers a run. Our profile `loop` section is the same idea, but polling because the hub has
  no inbound network.
- **Probot/Actions `issues.assigned`**: event-driven; our mode E.
- **Merge queues/bots (bors, Mergify)**: serialize and gate; informs the caps.

## 10. Verification plan

- Pure tick tests: table of (candidate, runs, PRs) to decision; every skip reason.
- Crash points: kill between intent, submit and started; no duplicate, no loss.
- Same-key double tick against a fake hub.
- Two loops with overlapping subjects (same issue, two graphs) are independent by
  design (decision 13.2); the key includes the loop name.
- Rehearsal: loop-created submissions use `hub submit --rehearsal` first (every
  shipped scenario rehearses offline through the hub, #359/#363); no model calls
  before any real run.
- Preflight failure produces a recorded skip, not a submission.
- Upgrade: link repointed mid-run (old runs keep their pin, new ones get the new
  digest, one digest per tick); profile rejected by the new bundle (tick blocked,
  zero submissions); version range violated; restart between intent and submit.
- Skills: a `graphloom-loop` skill; every command named must be in `--help`
  (`skills-drift.test.ts`).

## 11. Versions and upgrades

A **loop refers to a graph the way a task does**: by the plugin link
`<loop dir>/plugins/<graph>`, a directory or symlink to a bundle version. It
never names a version by itself, and the loop does not pin a bundle. Pinning
stays where it is: at acceptance, the hub resolves the link and pins that
bundle's digest into the submission ([hub §4.2](design-run-hub.md#42-moving-a-run-to-a-newer-plugin)).
So a loop is a producer of ordinary submissions, each pinned on its own.

| Thing | Pinned to | Changes when |
|---|---|---|
| A started run | Bundle digest at its submission | Only by the operator's `hub resume --update-plugin`; the loop never does this |
| A tick's new submissions | The bundle the link resolves to, resolved **once per tick**, so one tick never mixes versions | The operator repoints the link or installs a newer bundle |
| The profile | An immutable copy captured per submission (hub captures task and config bytes) | Edits affect future submissions only |
| The loop store and definition | `schema: graphloom-loop-v1`; migrations run exclusively before ticks, unknown newer format refuses to start, as the hub's `scheduler.json` | A GraphLoom upgrade |

**Upgrade strategy**

1. *Upgrading the plugin or GraphLoom changes only future submissions.* In-flight
   and finished runs keep their pin. The key does not contain the plugin
   version, so an upgrade never re-runs an issue that already has a key.
2. *A stopped run is not moved by the loop.* A failed or blocked key stays
   reserved (decision 13.4). The operator moves it with
   `hub resume <s> --update-plugin`, or unparks the key for a fresh run on the
   new version.
3. *Compatibility check on every tick, before listing.* The loop loads the
   resolved bundle, then asks it to validate the loop's profile and confirm it
   has `loopCandidates` and the profile's `loop` section. A bundle or profile
   the new version rejects makes the tick **fail closed**: no submissions, loop
   state `blocked: <the bundle's reason>`, visible in `loop status`. It does not
   disable itself; fixing the profile or repointing the link clears it on the
   next tick.
4. *Optional guard against surprise upgrades.* A loop file may say
   `version: ">=0.17 <0.18"` (a range over the bundle's manifest version). A
   resolved bundle outside it blocks the tick the same way, so an unattended
   loop does not begin using an unreviewed major change when a link is
   repointed.
5. *Hook contract changes.* `loopCandidates` carries a protocol level like
   other plugin callbacks; the loop refuses a bundle whose level it does not
   support, the same fail-closed block.
6. *Service restart or GraphLoom upgrade.* The loop store is durable and the hub
   is the only writer. On start, unfinished intents (section 7) are reconciled by
   key against the hub before the first tick, so an upgrade restart cannot
   duplicate or lose a start.

**Not designed here:** automatically moving live runs to a newer plugin
(`--update-plugin`), and per-run canarying of a new bundle. Both stay operator
actions.

## 12. First loop: hub housekeeping (proposal)

Finding (checked in the code and `design-run-hub.md`): the hub has **no Docker
daemon of its own**. It uses the host's `docker` from the service `PATH`, only
for docker-confined jobs; `doctor` reports a missing CLI or daemon as a warn.
Around Docker the hub does per-launch work only: run-labelled container cleanup
when a launch drains, and `docker.maxMemory`. Nothing periodic checks the hub's
or Docker's health, and nothing removes what accumulates: stopped containers and
dangling images and volumes from graph jobs, worktrees and run artifacts of
finished runs, rotated logs beyond their caps, installed versions (`self prune`
is manual), terminal queue records (`hub archive` is manual). I found no prune
code in the sources.

So the first loop should be a **housekeeping loop**, which needs no GitHub, no
write token and no model:

- **Graph**: `hub-janitor` ([draft](design-hub-janitor.md)), no agent; the host
  effects run in a narrow built-in executor, since ordinary command jobs are
  confined to a run worktree and cannot reach host Docker. It has the
  same shape as any graph, so the loop needs no special case.
- **Candidates**: a time-bucket subject key, `day:<yyyy-mm-dd>`, so the run key
  is `loop:hub-housekeeping:day:<yyyy-mm-dd>:0`. `loopCandidates` returns one
  candidate per day, from `now`, instead of one per issue.
  This means a candidate need not be a forge item; the key is whatever the
  plugin says, so the loop stays generic.
- **Inspect node** (health): hub reachable (`hub status`), snapshot and disk headroom,
  Docker daemon reachable, `doctor` for the hub's captured environment. A
  failed probe is recorded as a finding in the report; it is not a graph failure.
- **Plan and Apply nodes**, report first, then removal only with `apply: true`:
  GraphLoom-**labelled** containers, volumes and images older than a threshold
  that belong to no non-terminal run, and archives terminal hub submissions past
  a per-state age so loops cannot fill the hub's queue (design-hub-janitor 7;
  archiving keeps the idempotency tombstone, so a loop key stays reserved).
  It then purges archived runs' files (state directory, worktree and branch)
  through the hub's `hub purge` after a longer age; old installed versions are
  reported as candidates only in v1. Defaults to report-only until
  the profile sets `apply: true`. Never touches unlabelled Docker objects, a
  run that is live, blocked or waiting, or a failed run's evidence.

Decided (operator): (1) a housekeeping run takes one of the hub's run slots like
any run, with no exemption; with limit 2 it queues behind a full hub, and the
daily key means a missed day is not caught up in bursts. (2) The first version is
report-only: `apply` defaults to false, and enabling it is a separate profile
change after the reports have been reviewed. Docker cleanup stays in a graph, not
the hub core, since that keeps the hub from growing a housekeeping duty.

## 13. Decisions (operator)

1. An issue that has any PR (open, merged, or closed) is skipped: the graph's
   delivery step refuses it, and the key stays reserved.
2. The same subject under two loops is not "the same": loop name is part of the
   key, and the loop does not coordinate across loops.
3. First release: the loop is hosted by the hub. The engine is a shared library
   (`packages/loop`) with the sink as a seam, so a standalone host (direct sink,
   one-shot `loop tick`) can follow later. Not in the first release.
4. The graph handles its own failure and retry (supervisor, hub automatic
   resume). The loop never reruns a failed or blocked run, and has no
   failure-count parking: a failed key stays reserved until the operator acts.
5. The first loop is hub housekeeping (section 12): a `hub-janitor` graph that
   uses a normal run slot and starts report-only.

## 14. The `loopCandidates` hook protocol

A bundle's `loopCandidates` hook answers "what could this loop start now?". It is
a pure callback in the bundle's isolated plugin-host child, as `prepareTask` and
`advance` are: no files, no processes, no network, no clock. Because listing
needs forge reads whose results steer the next read, the call is **stateless and
multi-round**: the hook may answer "I need these reads first", the loop's
evaluator performs them, and the hook is called again with the results.

### 14.1 Ownership

| Part | Owns |
|---|---|
| `@graphloom/sdk` | The types and `validateLoopReply`; no forge vocabulary |
| Bundle | The hook; which reads it may ask for (manifest); what a candidate is |
| Evaluator (`graphloom loop evaluate`, a CLI child) | Loads the bundle in the plugin host, runs the reads, enforces limits, records the transcript |
| `packages/loop` engine | Applies the loop checks to the candidates (section 7); never sees a read |
| Hub | Runs one evaluator child per tick under the launch containment rules; never loads plugin code |

### 14.2 Shapes

```ts
interface LoopCandidatesInput {
  protocol: 1;
  profile: unknown;           // the parsed profile JSON, unread by the loop
  now: string;                // one UTC instant per tick, the same in every round
  round: number;              // 0 first
  results: LoopReadResult[];  // the previous round's reads, same order; [] at round 0
}

type LoopCandidatesReply =
  | { refused: string }                              // profile or usage error, shown as is
  | { reads: LoopRead[] }                            // call me again with these results
  | { candidates: LoopCandidate[] };

interface LoopRead { id: string; executor: string; input: Record<string, unknown> }
interface LoopReadResult { id: string; ok: boolean; output?: unknown; error?: string }
interface LoopCandidate { key: string; taskArgs: string[]; observedState?: string }
```

- `key`: at most 200 characters from `[A-Za-z0-9:._#/@-]`, unique in the reply.
  The loop treats it as opaque; it is the `<subject>` of the run key.
- `taskArgs`: at most 16 strings of at most 512 characters, passed to
  `prepareTask` for the chosen item, as `task new <graph> <args>` would.
- `observedState`: reserved, ignored in v1 (section 7).
- **Order is priority.** The engine starts the first survivors up to
  `maxStartsPerTick`; the hook should return the oldest work first.
- At most 500 candidates per reply. Beyond that, the reply is refused as
  malformed, so a profile that matches too much fails visibly.

### 14.3 Reads

- `executor` must be listed in the manifest's `loop.reads` and be a
  **read-effect** executor (`effect: "read"` in its definition, such as
  `graphloom.github/list-issues`). The evaluator refuses a declared executor
  that is not read-only, so a hook can never write.
- `input` is checked by the executor's own `inputSchema`; a rejection becomes
  `ok: false` with its message, not a thrown error.
- `id` is unique in the tick. The evaluator returns results in request order and
  runs a round's reads sequentially, so the transcript is deterministic.
- The hook child is **confined** (section 14.9), so "the hook never receives
  credentials" is enforced, not promised.
- Credentials come from the runner config's `github.tokenEnv`, read by the
  evaluator from its own environment (the hub service's captured one). The hook
  never receives them, and a result never contains them.
- **The evaluator must not reuse `cli-runner.ts` unchanged.** There,
  `github.writeTokenEnv`, when set and present in the environment, *replaces*
  the read token and allows write executors for the whole runner. The evaluator
  builds its own GitHub-only runner from the config with `writeTokenEnv`
  ignored, so no write token is ever read and `allowWrites` is never set,
  whatever the runner config holds. The job it submits also carries
  `effect: "read"`, which the runner enforces against the executor's declared
  effect (`packages/sdk/src/executor.ts`), a second guard.

### 14.4 Limits (fail closed)

| Limit | Default | On exceed |
|---|---|---|
| Rounds | 5 | Tick blocked: "no candidates after 5 rounds" |
| Reads per round | 8 | Reply refused as malformed |
| Reads per tick | 20 | Tick blocked |
| One result's bytes | 256 KiB | That read's result becomes `ok: false, error: "result too large"`, for the hook to handle |
| All hook replies' and results' bytes | 1 MiB (counted once each, in bytes of their JSON form) | Tick blocked |
| One hook reply's bytes | 256 KiB | Tick blocked ("hook reply too large"); a legitimate reply is far smaller, and 500 candidates with long args can exceed it by design, so a profile that matches that much fails visibly |
| Wait a read may ask for (`retryAfterMs`) | capped at 24 h | The cap applies; see 14.5 |
| One hook call | 10 s | Tick blocked with the plugin host's timeout message |
| One read | the executor's own timeout (30 s) | `ok: false`, for the hook to handle |
| The whole evaluation | 5 min | Tick blocked |

"Tick blocked" means: no submissions this tick, loop state `blocked: <reason>`,
shown by `loop status`, cleared by the next tick that succeeds. A thrown error,
a malformed reply, or a failed `validateLoopReply` block this way and name the
bundle's message (the hook's own timeout reads "hook timed out after N ms at
round R"). A `refused` reply is a separate outcome, `refused`, with the
bundle's reason cut to 4096 characters; the loop shows it as `blocked: <reason>`
in `loop status`. Any other failure inside an evaluation, including a value
too deeply nested to copy, is a blocked tick `evaluation failed: <message>`.

### 14.5 Rate limits

There is no GitHub-specific class for the loop to match, and none is needed. A
rate-limited GitHub read already comes back as a failed `JobResult` with the
generic `retryAfterMs` ("a failed executor's requested wait before retrying it,
e.g. a rate limit", `packages/runner/src/types.ts`); the executor sets it from
GitHub's `retry-after` or `x-ratelimit-reset` headers
(`executors/github/src/client.ts`, `failure()` in `executors.ts`). The
evaluator therefore treats **any failed read that sets `retryAfterMs`** as a
deferral signal for any executor, not just GitHub's:

- The tick ends `deferred until now + min(retryAfterMs, 24 h)`, with no submissions. The
  hook is not called again that tick, and the next tick before that time does
  not read.
- Other failures reach the hook as `ok: false` with the summary, and the hook
  decides.

Pagination and a profile's `since` bound the reads per tick; each tick lists
the full matching set again, since the hook is stateless and the engine drops
keys it already has (section 7). Passing known keys to the hook to save reads is
a later optimisation.

### 14.6 Transcript and replay

The evaluator records, per tick, `rounds: [{ reads, results (bounded), reply }]`
in the loop's decision log with the bundle digest and `now`. It is what
`loop status` cites for a skip or a block.

- `loop evaluate --replay <transcript>` runs the hook on recorded results with no
  network and fails if its replies differ, which is how a plugin update's effect
  is checked.
- Tests use recorded transcripts as fixtures, as rehearsal replays recorded
  GitHub reads.
- The hook must be deterministic in its input; `now` is the only clock.

### 14.7 Bundle declaration and protocol level

```json
"loop": { "protocol": 1, "reads": ["graphloom.github/list-issues"] }
```

in the manifest, generated from `describe()` like other capabilities. No `loop`
key means the bundle cannot be looped. The engine supports protocol levels it
lists; a bundle at another level blocks the tick (section 11, item 5). Adding a
read to `loop.reads` changes the manifest digest, so a bundle update that widens
what a loop may read is visible to the operator.

### 14.8 Worked examples

- **hub-janitor:** round 0 replies `{ candidates: [{ key: "day:<date from now>",
  taskArgs: [] }] }`. No reads.
- **issue-fix:** round 0 replies `reads: [{ id: "p1", executor:
  "graphloom.github/list-issues", input: { owner, repo, state, labels,
  assignee, page: 1 } }]` from the profile's `issues` and `loop` sections.
  Round 1 receives page 1; if full, asks page 2, else replies candidates
  (pull requests dropped, issues older than `since` dropped, oldest first, key
  `github:<owner>/<repo>#<n>`, `taskArgs` the issue reference).
- **Refusal:** a profile with no `loop.assignee` replies `{ refused: "profile
  <p> has no loop.assignee" }`.

### 14.9 Where it runs

The evaluator is a CLI subcommand, so the hub runs it as it runs other CLI
children, with the same memory limit and containment, and receives one JSON
result. The hub core stays free of plugin code and GitHub vocabulary.

**A host for read executors outside a run exists** (checked in
`apps/graphloom/src/cli-runner.ts`, `apps/graphloom/test/github-runner.ts`):
`createBuiltinExecutorRunner` with `githubExecutorPackage` and `githubBinding`
gives a `Runner`, and `runner.runJob(job, ctx)` runs a read. The test helper
`runGitHub` submits it as a `command` job with `readOnly`, an
`executor: { id, version }`, the `input`, and a context of `runId`,
`operationId`, `generation`, `worktreePath` and `artifactDir`. For the evaluator:

- It builds a GitHub-only runner (section 14.3): the CLI runner as composed
  today needs a runner config with `allowUnrestricted: true` for its coding-agent
  harnesses, which a read does not need.
- The context fields are required but a read touches no workspace: the
  evaluator makes one empty scratch directory per tick for both paths and a
  synthetic `runId` (`loop-<name>-<tick>`); `operationId` counts reads.
- A `JobResult` maps to a `LoopReadResult`: `status: "ok"` gives `ok: true` and
  `output` the first evidence item's payload (the `github` object, as
  `githubEvidence` reads it); anything else gives `ok: false` with `summary`.
- The real GitHub package runs sandboxed (read-only closure, no writes), so
  reads keep that confinement. **Still to confirm at build time:** that the
  sandbox does not need the scratch directory mounted for a read-only job.

**The hook child runs confined.** A plain plugin-host child is not a scope: it
runs as the operator, so a hook could read `/proc/<parent>/environ` (the
evaluator's token), token files in the home directory, or open a socket
(verified by a hostile fixture). `graphloom loop evaluate`, and only it, spawns
the hook child under bubblewrap through an opt-in `launcher` on
`createChildPluginHost` (the controller and `task new` are unchanged):

- Own pid, net, ipc, uts and cgroup namespaces; a private `/proc` and `/dev`; an
  empty tmpfs `/tmp` as the working directory; the root remounted read-only;
  `--cap-drop ALL`, no new privileges, `--new-session`, `--die-with-parent`.
- Read-only binds of only: `/usr` and the library links, `/etc/ld.so.cache`, the
  node binary, the worker module with its package closure, and the bundle.
  Nothing else exists in the sandbox: not the home directory, `/etc`, the
  working directory, the bundle's siblings, or inherited file descriptors.
- Environment cleared to `PATH` (its value is visible; a P2 information leak).
- It is not `confineWorker`, which binds `/` read-only and so leaves every file
  readable; the repo's `confinementUnsupported` and `packageClosure` are reused.
- **Fail closed:** where bubblewrap is missing or cannot create the namespaces,
  `loop evaluate` exits 1 naming the cause. There is no flag to run unconfined.
  `--replay` is confined too, since the hook runs there. The probe proves a
  mount and pid namespace can be created, not `--unshare-net`; a bwrap that
  fails at spawn time still exits 1 and never runs unconfined.
- Not limited: memory and process count inside the sandbox (the host's timeout
  of 10 s and the pid namespace bound a fork or memory bomb), and nested user
  namespaces are allowed. Candidates for later hardening.
- The read host's GitHub executor keeps its own runner sandbox; this
  confinement is for the evaluator's hook child.

**Command surface.** `graphloom loop evaluate <graph> [--out] [--profile]
[--runner-config] [--now] [--replay <file>] [--json]`. Exit codes: 0 candidates
(or a replay that reproduced), 1 could not run (usage, bundle not loopable, no
runner config or token, confinement unsupported, replay differs), 2 refused,
3 blocked, 4 deferred. `--json` prints `{ outcome, transcript }`, a replay
verdict `{ replay: { ok, ... } }`, or `{ error }`; human text goes to stderr.
A bad `--now` is a usage error. `--replay` accepts a transcript or a `--json`
output, a regular file up to 16 MiB; profiles are size-checked before reading.
SIGTERM and SIGINT close both hosts and exit 143 or 130.

### 14.10 Verification

- `validateLoopReply`: every refusal (extra property, bad key, duplicate id,
  over a limit, non-listed or non-read executor).
- Evaluator with a scripted hook and fake executors: multi-round, pagination,
  result-too-large, rate-limit deferral, each limit, `refused`.
- Replay: a recorded transcript reproduces; a changed hook fails the replay.
- Credentials: a hook that echoes its environment or input sees no token.
- Issue-fix and janitor hooks against fake GitHub and no reads respectively.

## 15. Open items

1. **Hook protocol follow-ups**: generate the manifest `loop` key from
   `describe()` (today a bundle author writes it; only the CLI validates it, the
   controller and intake do not), and harden the hook sandbox with memory and
   process limits (section 14.9). A sandboxed read needs no mounted scratch
   directory (checked).
2. **Repository modes** (`required | optional | none`, folder snapshot) and the
   controller-owned private repository: janitor design, open point 1.
3. **Worktree release** for finished managed runs: resolved by archive followed
   by `hub purge` (#373); the janitor does both on age (janitor design, open
   point 3). Every Triage-refused issue still leaves a worktree until its run is
   purged.
4. **New `graphloom.github` reads**: `assignee` on `list-issues`, an issue
   timeline read (issue-fix "Looping").
5. **Runner config `repositories` map** (slug to local path) and the loop file
   `version` guard.
6. **Hub-hosted timer**: the hub schedules ticks and `graphloom loop` talks to the
   hub socket; the hub-side API is not specified yet.
