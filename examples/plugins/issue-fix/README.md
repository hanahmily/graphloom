# issue-fix graph plugin

Source-repairable Fix → Review bundle that fixes one bug issue in any
repository, written only against the public `@graphloom/sdk`. Everything
repository-specific comes from a *profile*: a JSON file the task names with
`config:`. The graph has a plan, implementation, RED/GREEN proof, scope check, optional changelog check,
open-code-review sweep with independent verification, and local `fix/<issue>`
delivery. The reviewer may raise new findings in the first three review
rounds only; after that it verifies the known findings, and new comments
become follow-ups in the pull request. It replaced the BanyanDB-only
banyandb-fix graph, which has been removed; its banyandb profile carries that
graph's requirements, checks, prompts and commands. Since 0.4.0 the run tracks its
critical and high findings as issues in `.graphloom/issues.json` in the run's
worktree, with a readable `.graphloom/issues.md`: the verifier opens or
dismisses them, the fixer marks them fixed, and the reviewer verifies each one
done or reopens it. The graph owns the file and rejects any other edit, Git
ignores it, and the pull request lists the table. The
[design](../../../docs/design-issue-fix-graph.md) gives the profile schema,
how the config reaches the plugin, the
[discovery rounds](../../../docs/design-issue-fix-graph.md#review-discovery-rounds)
and the [issues file](../../../docs/design-issue-fix-graph.md#the-issues-file).

## Profiles

| Profile | Repository | Regression runner | Build checks | Changelog |
|---|---|---|---|---|
| [`profiles/banyandb.json`](profiles/banyandb.json) | apache/skywalking-banyandb, issues in apache/skywalking | `go-test` | `make test-ci` for the changed packages, lint (cheap tier); build, check (full tier; `make check` includes license-check) | `CHANGES.md` |
| [`profiles/graphloom.json`](profiles/graphloom.json) | hanahmily/graphloom (this repository) | `vitest` | `npm run typecheck`, `npm run build`, `npm test` | none |
| [`profiles/canopy.json`](profiles/canopy.json) | apache/skywalking-banyandb, issues in apache/skywalking; Node/TypeScript changes under `canopy/` | `vitest` | the changed workspaces' tests, typecheck, lint (cheap tier); build, `npm test`, `make license-dep` (full tier) | `CHANGES.md` |
| [`profiles/banyandb-ql.json`](profiles/banyandb-ql.json) | apache/skywalking-banyandb; the Measure QL tickets R01 to R06, tracked in the private hanahmily/banyandb-ql-design | `go-test` | banyandb's, plus the `bench-gates` final step | `CHANGES.md` |

Since 0.5.0 the code review covers every changed file (ocr's exclusions put
back, `.graphloom/` left out) and then checks the change as a whole across
files.

The banyandb profile declares BanyanDB's contributor checklist, and the
controller runs it before any job, on every resume, and after a repair
activation:

| Command | Checks |
|---|---|
| `go` | `go env GOVERSION` equals the `go` line of `go.mod` |
| `git` | Git 2.41 or later (open-code-review needs it; BanyanDB needs 2.30) |
| `ocr` | [`scripts/ocr-path.sh`](scripts/ocr-path.sh) finds an open-code-review with delegation mode, the [bundled](#bundled-open-code-review-0140) one first, and prints the absolute path the code reviewer is told to run |
| `codex` | `codex --version` and `codex login status`: Codex is installed and logged in, with the command and home the runner configures for the harness (`GRAPHLOOM_CODEX_BIN`, `GRAPHLOOM_CODEX_HOME`, then `CODEX_HOME`) |
| `claude` | `claude --version` and `claude auth status`: Claude Code is installed and logged in, with the command and config directory the runner configures for the harness (`GRAPHLOOM_CLAUDE_BIN`, `GRAPHLOOM_CLAUDE_CONFIG_DIR`, then `CLAUDE_CONFIG_DIR`) |
| `make` | GNU make |
| `check-req` | `make -C scripts/ci/check test`: BanyanDB's Go version and architecture test |
| `node` | Node.js >= 24.6.0: `make generate` and `make build` need it for every task |
| `generate-*` (prepare) | `make generate`, split into separately cached steps, leaves no tracked or unignored file changed |

It also pins the SHA-256 of `CONTRIBUTING.md`. A missing tool stops the run and
names it. A changed guide blocks normal jobs until a qualified repair updates
the declaration; without a supervisor, the run stops.

Since 0.8.0 the banyandb profile differs in two more ways. It no longer runs
`license-check` as a command of its own, because `make check` already runs it
and `check-format`. And it checks in two tiers: a command's `tier` is `cheap`
or `full` (default `full`). When a profile declares any `cheap` command, one
checkout job runs GREEN and the cheap commands (banyandb: `make test-ci`,
`make lint`); the full commands (`make build`, `make check`) run in a second
job only when the cheap tier passed on the same candidate digest and no other
requirement already fails. A cheap failure goes back to the implementer with
its evidence and skips RED and the full tier. A command that did not run never
counts as passed, and Fix is accepted only when both tiers passed on the same
digest. A profile with no `cheap` command runs every check in one job, as
before. The profile's `implementation.selfCheck` lists the commands the
implementer runs before returning `ready` (banyandb: `go vet` and
`golangci-lint run` on the changed packages) and lists in the record's
`selfChecks`; the graph does not trust that report.

## Run it

From `examples`:

```yaml
graph: issue-fix
repo: skywalking-banyandb
config: plugins/issue-fix/profiles/banyandb.json
request: "Fix apache/skywalking#14092."
```

The run's budgets come from the profile's `budgets`, which the graph declares
as its default budgets (since 0.6.0): about twice what the measured runs
used, per [docs/budgets.md](../../../docs/budgets.md). A `budgets:` block in
the task overrides them key by key; `graphloom stats <run>` shows what a run
used against them.

[`../../issue-fix-banyandb-task.yaml`](../../issue-fix-banyandb-task.yaml) and
[`../../issue-fix-graphloom-task.yaml`](../../issue-fix-graphloom-task.yaml)
are ready to use; the GraphLoom one runs on the checkout it lives in
(`repo: .`). Intake pins the profile's bytes and digest; editing the file
later does not change a running or resumed run.

A resume retries what failed (since 0.6.1): candidate checks that failed, and a
RED that could not build or run, before the operator's latest resume run again
once, instead of sending the implementer a correction for a fault that may
have been the environment. Checks that passed stay valid, and a failure
recorded after the resume is corrected as before.

The commit message and the pull request summary come from the decision
record's `change` (since 0.7.0, contract `decision-record-v2`): what the change
does against the base, kept current every round. The round's `summary` is the
implementer's report to the graph and is never delivered. Sentences naming
review issue ids, `.graphloom/` or the implementer in the first person are
dropped, the Test plan names only the pinned checks the evidence shows passed,
and follow-ups about the environment or a pinned check are left out. A record
without `change` falls back to the plan's text.

The runner config enables Claude Code, Codex and Pi, the GitHub reads, and
command jobs long enough for the profile's checks:

```json
{
  "harness": "claude-code",
  "harnesses": ["claude-code", "pi", "codex"],
  "allowUnrestricted": true,
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "agentDir": "~/.pi/agent" },
  "codex": { "reasoningEffort": "high" },
  "github": { "tokenEnv": "GRAPHLOOM_GITHUB_LIVE_TOKEN" },
  "command": { "timeoutMs": 10800000 }
}
```

Claude Code and Codex must be installed and logged in (`claude auth status`,
`codex login status`); the environment checks stop the run before any job
otherwise, naming the tool. For the graphloom profile the full suite takes
about ten minutes; its commands allow 45.

```sh
GRAPHLOOM_GITHUB_LIVE_TOKEN="$(gh auth token)" node ../apps/graphloom/dist/main.js run issue-fix-graphloom-task.yaml
```

## Bundled open-code-review (0.14.0)

You don't need to install open-code-review. The plugin depends on
`@alibaba-group/open-code-review` at exactly 1.13.3. `npm ci` at the
repository root installs it, and the release tree ships it. npm installs the
native binary from the platform package, `@alibaba-group/ocr-linux-x64` and
so on, so no install step needs the network. `npm ci --ignore-scripts` gives
the same result. Every profile's `ocr` check runs
[`scripts/ocr-path.sh`](scripts/ocr-path.sh). The script prints the absolute
path of the first open-code-review that has delegation mode, in this order:

1. A path passed as the script's argument.
2. `$GRAPHLOOM_OCR_BIN`.
3. The bundled binary.
4. `ocr` on `PATH`.

The controller tells the check where the plugin is through
`$GRAPHLOOM_PLUGIN_ROOT`. The code reviewer runs the native binary directly,
so it needs no `node` on `PATH`. If no open-code-review is found, the check
stops the run and says that both the bundled copy and `ocr` on `PATH` are
missing. The
[design](../../../docs/design-issue-fix-graph.md#bundled-open-code-review)
gives the details. To pin another open-code-review, change the dependency and
both lockfiles, the repository root's and this plugin's.

## The Measure QL tickets: the banyandb-ql profile (0.12.0)

[`profiles/banyandb-ql.json`](profiles/banyandb-ql.json) runs the graph on the
Measure QL relational tickets R01 to R06 ([#197](https://github.com/hanahmily/graphloom/issues/197)).
They are tracked in the private `hanahmily/banyandb-ql-design` and implemented
in apache/skywalking-banyandb. The profile is banyandb's (same project,
regression runner, build checks, budgets and harnesses; its environment adds a
`docker` check) with three additions, each described below: the issue tracker
and its three design documents as context, delivery text that keeps the private
repository out, and a `bench-gates` final step.

- **Issues and context.** `issues` is `hanahmily/banyandb-ql-design`, and
  `issues.context` lists `docs/relational-design.md`,
  `docs/relational-tickets.md` and `docs/catalog-b-context.md` of that
  repository. The run reads them once (the GitHub token needs read access to the
  private repository) and gives them to the planner, the implementer and the
  reviewers, so a ticket that defers to them is planned against the real
  contract.
- **Delivery.** `pullRequest.reference` is `{ "style": "implements", "subject":
  "the Measure QL" }`. The commit's last line and the pull request's heading say
  "Implements the Measure QL <issue title>"; there is no `Fixes
  hanahmily/banyandb-ql-design#N`, the footer has no `{issue}`, and any mention
  of the private repository the agents wrote (a reference, a link, a context
  document's name) is dropped from the commit message and the body. The planner
  and implementer are also told to write public text that stands alone.
- **The `bench-gates` final step.** One `final` tier command, requirement
  `bench-gates`, runs once after code review converged. It
  - picks the Go image from `go.mod`'s `go` line (`golang:<version>`; override
    with `GRAPHLOOM_BENCH_IMAGE`);
  - mounts the checkout read-write at `/src` and the host's Go module cache
    read-only at `/go/pkg/mod`: `GRAPHLOOM_BENCH_GOMODCACHE`, else the
    operator's cache named by the `file://` proxy a confined job is given (a
    confined job's own `GOMODCACHE` is a run-scoped copy), else `go env
    GOMODCACHE`, which on this machine is `/mnt/d/gomodcache`; module downloads
    are off (`GOPROXY=off`, `GOTOOLCHAIN=local`);
  - runs `make bench-ql-report` in `docker run --rm --cpus=4 --memory=8g
    --memory-swap=8g`, as the invoking user, with every user-level directory
    (`HOME`, `GOCACHE`) inside the container's own `/tmp`, so the step needs
    nothing outside the checkout, the module cache and the run's report file.
    It also runs under the bubblewrap confinement of supervisor-originated jobs
    (whole filesystem read-only but the checkout and the run's scratch directory,
    a private `/tmp`, a redirected module cache), reaching the docker daemon
    through its socket; when it cannot reach the daemon or find a module cache
    it fails saying which;
  - expects `build/bench/ql-report.json` afterwards and wraps it in
    `{ "harness": { image, imageGo, cpus, memory, memorySwap }, "report": ... }`
    as the command's report file, refusing one over 60,000 bytes (a run keeps
    at most 64 KiB of a report).

  The make target is the ticket's own: its implementation adds it, together with the
  runner behind it. A checkout without the target fails the step with a message
  naming it, what it must write and how the step runs it, and the change goes
  back to the implementer. The planner's and implementer's guidance (the profile's
  `planning.notes`, which are `BENCH_GUIDANCE` in `src/bench.ts`) states the
  target, the report schema and the benchmark rules, citing
  `docs/relational-tickets.md`, "Benchmark rules for every ticket".

### The report: `ql-bench-report/v1`

```json
{
  "schema": "ql-bench-report/v1",
  "ticket": "R01",
  "environment": { "goVersion": "go1.26.10", "commit": "<sha>", "baseCommit": "<sha>", "seed": 20261024, "cpus": 4, "memoryBytes": 8589934592, "swapBytes": 0 },
  "budgets": { "queryBytes": 268435456 },
  "preflight": [
    { "facts": 1024, "dimensions": 64, "fits": true, "peakAccountedBytes": 1000000, "budgetBytes": 268435456 },
    { "facts": 16384, "dimensions": 1024, "fits": true, "peakAccountedBytes": 2000000, "budgetBytes": 268435456 }
  ],
  "gates": {
    "exactResults": { "checked": 52224, "mismatches": 0 },
    "failedTimedCalls": { "count": 0 },
    "accountedMemory": { "peakBytes": 2000000, "budgetBytes": 268435456 },
    "outstandingResources": { "count": 0 }
  },
  "cases": [
    {
      "name": "join-unique",
      "size": { "facts": 1024, "dimensions": 64 },
      "samples": [
        { "pair": 1, "order": "AB", "variant": "operator", "nsPerOp": 803, "allocBytesPerOp": 4096, "allocsPerOp": 12, "retainedBytes": 65536, "rpcP50Ns": 900000, "rpcP95Ns": 1400000, "rpcCpuNs": 700000 }
      ],
      "effects": [{ "metric": "nsPerOp", "comparison": "operator-vs-reference", "estimate": -0.97, "ciLow": -0.98, "ciHigh": -0.96, "confidence": 0.95 }]
    }
  ]
}
```

(`samples` lists every raw sample: five paired repetitions with alternated
`order`, for each variant; the example shows one.) The `bench-gates` validator
passes only when the command exited 0, changed no file, and the report is
complete and every **hard gate** holds, read from the counts and bytes, never
from a boolean the report carries:

| Hard gate | Holds when |
|---|---|
| exact results | `checked` > 0 and `mismatches` = 0 |
| zero failed timed calls | `failedTimedCalls.count` = 0 |
| bounded accounted memory | `accountedMemory.peakBytes` <= `budgetBytes` |
| zero outstanding owned resources | `outstandingResources.count` = 0 |
| preflight fits both sizes | an entry for 1,024/64 and for 16,384/1,024, each with `peakAccountedBytes` <= `budgetBytes` |

Complete means: the schema, the frozen environment (toolchain, commit, base
commit, seed, CPUs, memory), the effective budgets, a case at each of the two
sizes, exactly five alternated pairs per case (each holding every variant once, one `order` per pair, alternating) with `nsPerOp`,
`allocBytesPerOp` and `retainedBytes`, and an interval (`ciLow` <= `ciHigh`) on
each paired effect. **No latency is ever judged**: the timings (medians of the
samples, the effect estimates with their intervals, RPC p50/p95/CPU) go in the
pull request's `Benchmark` section, labelled reported only, and a result that
passes every gate passes whatever its timings.

### Running R01 to R06

1. Check out the base the ticket builds on. R01 builds on
   apache/skywalking-banyandb#1438's head (which contains #1432): `git fetch
   origin pull/1438/head:pr-1438`, then a worktree or clone at that branch is
   the task's `repo`. A later ticket stacks on the branch the earlier run
   produced: point `repo` at a checkout of that branch (the run's `fix/<issue>`
   branch, pushed or not), so its change is part of the base the ticket sees.
2. Copy [`examples/issue-fix-banyandb-ql-task.yaml`](../../issue-fix-banyandb-ql-task.yaml),
   set `repo` and name the ticket (`request: "Implement hanahmily/banyandb-ql-design#N."`).
3. Check it, with a token that can read the private repository:
   `GRAPHLOOM_GITHUB_LIVE_TOKEN="$(gh auth token)" graphloom check task.yaml`.
   The environment checks need docker, a module cache, the Go toolchain `go.mod`
   names, Node.js 24.6 and the other banyandb tools.
4. Run it as any issue-fix task (`graphloom run task.yaml`). The pull request
   body is the delivery command's report, with the Benchmark section.
5. To refresh the timings on an idle machine, run the same target outside a run, in the
   same container, from a clean checkout of the delivered branch:
   `docker run --rm --cpus=4 --memory=8g --memory-swap=8g --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOMODCACHE=/go/pkg/mod -e GOFLAGS=-buildvcs=false -e GOPROXY=off -e GOTOOLCHAIN=local -v "$PWD:/src" -v "$(go env GOMODCACHE):/go/pkg/mod:ro" -w /src golang:<go.mod's version> make bench-ql-report`,
   then read `build/bench/ql-report.json`. Gates are re-checked by the report; do
   not move a threshold after seeing results.

The rehearsal scenarios for this profile (`happy`, `bench-gate-fails` in
`src/rehearsal.ts`) are self-contained, so `graphloom rehearse task.yaml
--scenario happy --commands run` works in a real checkout of the base (set
`GRAPHLOOM_REHEARSAL_GITHUB_TOKEN` to a token that reads the private
repository). The stand-in's change adds a marker file and a test to
`pkg/timestamp`, and a `GNUmakefile` that includes the `Makefile` and adds a stub
`bench-ql-report` target writing a report (GNU make reads `GNUmakefile` first;
the rehearsal's checkout is thrown away). In `happy` the report passes and the
run reaches delivery with the Benchmark section. In `bench-gate-fails` the first
candidate's report fails a hard gate, the graph reenters Fix, and the corrected
candidate's report passes. The plugin's tests walk both reports through the
real validator.

## The final command tier (0.12.0)

A command may declare `tier: "final"` with `requirement: "final-checks"` (the
two go together). Final commands are for checks too slow to repeat every
round, such as a benchmark. They run once per candidate digest, in a checkout
of the candidate, after code review has converged on it and before delivery,
and Review's `final-checks` requirement is met only when every one passed and
changed no file. A failure is a real defect: the graph reenters Fix with the
failing output, under the same cap and corrections budget as a review
reentry (`review.maxReentries`; a candidate that the last pass left unchanged
goes to the supervisor instead), and the next candidate runs the cheap tier,
RED, the full tier, code review and the final tier again. A final failure from
before the operator's latest resume is run once more, as for any check. A
final command's optional `section` names a pull request section that shows
the `summary` its JSON report carries (a line or a list of lines), labelled as
reported. Profiles without final commands behave as before
([#196](https://github.com/hanahmily/graphloom/issues/196); see
[the design](../../../docs/design-issue-fix-graph.md#the-final-command-tier)).

## Context documents (0.12.0)

A profile may declare `issues.context`, a list of `{ repo?, path, ref? }`:
documents the issue defers to, such as a design kept in another repository.
The graph reads each once, in the Fix step that reads the issue, records it as
evidence (path, blob sha, bytes) and gives it to the planner, the implementer
and the code reviewers under a heading naming its source. A document with
`repo` comes from the read-only `graphloom.github/get-file` executor; one
without is a file of the target repository at the base commit. Later edits do
not change a running or resumed run. Documents longer than 12,000 characters
together are written as read-only files below `.graphloom/context/` (which Git
ignores, so the delivered commit omits them) and listed in the prompts, because
an executor's assignment is limited (the coding agent's is 64,000 characters);
every agent job's input is checked against its executor's declared input shape.
A missing document, or more than 200,000 bytes of them, stops the run before any agent
([#195](https://github.com/hanahmily/graphloom/issues/195); see
[the design](../../../docs/design-issue-fix-graph.md#context-documents)).

## Agent wall clock and timeout continuation (0.13.0)

A profile's optional `agent` settings size the coding agents' jobs:

- `timeoutMs` is the wall clock every coding-agent job (plan, implement, code
  review, verification) asks for instead of the operator's default of one hour.
  The runner clamps it to the operator's `maxTimeoutMs` (default four hours),
  and the run's `activeMs` budget still bounds every job. `banyandb-ql` asks for
  three hours, because its feature tickets outgrow one; the other profiles keep
  the operator's default.
- `timeoutContinuations` (default 1, at most 3, 0 turns it off) is how many
  times per implement attempt the controller continues the implementer's own
  session when its job runs out of time after changing the worktree, telling
  the agent to check what is done and finish the rest. Each implement dispatch
  the graph makes (a first attempt, or a reentry after review feedback) gets
  its own allowance, which the continuations chained from it share. A timeout
  that changed nothing, kept no session, or comes after the attempt's last
  continuation still opens a supervisor episode. Each continuation is a
  dispatch charged to the run's budgets, and continues, rather than repeats,
  the correction it belongs to. The allowance became per attempt (it was per
  Fix generation) in the controller, with no change to this plugin; the
  harnesses now also keep the implementer's session when it is killed before
  it can save it while stopping.

## Rehearsal findings (0.12.1)

- `bin/buf` is an output of the BanyanDB profiles' `generate-proto` step. `make lint` and
  `make format` (under `make check`) run it from `api/` without installing it, so a prepare-cache
  hit must restore it. The other tools in `bin/` install themselves where they are used.
- Candidate checkouts commit their changes with the new objects in their own store (the
  controller packs them), because an object the shared source repository already holds is
  otherwise left there, and BanyanDB's `license-eye` (go-git) cannot read it through alternates
  ("object not found"). The banyandb-ql rehearsal no longer needs a per-run nonce.
- A rehearsal's run (id `rehearsal-<id>`) delivers to `rehearsal/<run id>/fix-<issue>`, which the CLI
  removes when it discards a `ready` rehearsal; a real run still delivers to `fix/<issue>`
  ([#199](https://github.com/hanahmily/graphloom/issues/199)).

## Review failures reenter Fix (0.11.0)

When code review fails only because findings are confirmed, the graph
reenters Fix itself instead of starting a supervisor episode: on the first
failing round, or when this round has fewer confirmed findings than before the last correction,
and while fewer than `review.maxReentries` (default 4) review reentries have
happened and the run has at least two corrections left. A disputed finding, a
round that is not converging, the cap, a low corrections budget, or any other
failure (incomplete passes, missing statuses, issues-file or contract
problems) still goes to the supervisor
([#193](https://github.com/hanahmily/graphloom/issues/193); see
[the design](../../../docs/design-issue-fix-graph.md#review-failures-the-graph-reenters-fix-or-the-supervisor-decides)).
The rehearsal scenario `review-reenters` (go-test profiles) covers it.

## Work runs without a decision record (0.10.3)

Review and delivery use the latest *valid* decision record from any work run. A
work job that carries no decision-record contract, such as one a supervisor
dispatches, is not the implementer's answer; when no work run recorded a valid
record the graph asks the supervisor for one instead of failing
([#191](https://github.com/hanahmily/graphloom/issues/191)).

## Generated files, duplicate findings and acceptance coverage (0.10.0)

- A profile command may declare `writes`: the files it regenerates, such as
  canopy's `canopy/LICENSE` and `canopy/licenses/**` for `make license-dep`.
  The implementer's write scope covers them even when `protectedPaths` lists
  them, so a correction for a failed license check is not refused for scope.
  A `writes` path below a protected directory is a `+path` exception in the
  scope (the rest of the directory stays excluded).
- A problem the code reviewer raises twice (per file and in the whole-change
  check or a sweep pass) is one finding when the lines overlap on the same
  path in the same round; a comment marked `distinct` stays separate. Only
  passes whose result carries `contract: "dedupe-1"` merge, so evidence from
  before 0.10.0 replays with its original finding ids.
- The planner lists the issue's acceptance items (`acceptance`) and the
  implementer maps each to files and tests (`coverage`); the graph checks the
  map before code review and sends the change back for anything uncovered. A
  plan without `acceptance` runs as before. The contract is
  `decision-record-v2` with these two optional fields.

### Refreshing the pinned CONTRIBUTING.md

The banyandb profile pins `CONTRIBUTING.md` by sha256 (`environment.pinnedFiles`),
and a different file in the repository stops a run with `environment_changed`.
When BanyanDB changes it, refresh the pin and the fixture the tests use:
`git -C <skywalking-banyandb> show origin/main:CONTRIBUTING.md | sha256sum` gives
the digest; put it in `profiles/banyandb.json`, copy the file to
`examples/skywalking-banyandb/CONTRIBUTING.md`, rebuild, and regenerate the
manifest (`npm run manifest`). The pin was refreshed in 0.10.0.

## The canopy profile

[`profiles/canopy.json`](profiles/canopy.json) (since 0.9.0) checks changes
under `canopy/` in apache/skywalking-banyandb, an npm workspace (`web`,
`server`, `shared`) tested with Vitest. Select it with
`config: plugins/issue-fix/profiles/canopy.json` and a request such as
`Fix apache/skywalking#14001.`; [`../../issue-fix-canopy-task.yaml`](../../issue-fix-canopy-task.yaml)
is a ready task. The banyandb profile cannot check such a change: its
`make test-ci` command fails when the change touches no Go package.

- **Environment.** `node` must equal `canopy/package.json`'s `engines.node` (an
  exact pin, as the repository's `make check-node-version` requires), plus
  `git`, `license-tools` (`make`, and `go` or `bin/license-eye`, for
  `make license-dep`), `ocr`, `codex` and `claude`. Prepare runs
  `npm ci --include=dev` in `canopy/` (dev dependencies matter: an agent shell
  often has `NODE_ENV=production`), cached on the lock file and the
  workspaces' `package.json` files, with the `node_modules` directories as its
  outputs.
- **Cheap tier**, run beside GREEN: `test-changed` runs `npm run -w <ws> test`
  for each workspace the change touches (`shared/` and canopy's root files run
  both; a change touching no workspace fails), then `npm run typecheck` and
  `npm run lint`, each in `canopy/`.
- **Full tier**, only once the cheap tier and GREEN passed: `npm run build`,
  `npm test` for all workspaces, and `make license-dep` with
  `make check-license-outputs` from the repository root. `license-dep`
  reinstalls the canopy dependencies it prunes, and runs last. The Playwright
  tests (`canopy/e2e`, `npm run e2e`) are not run; the planner marks a change
  that needs them `needsE2E`.
- **Self check.** The implementer runs `npm run -w <ws> typecheck` and `lint`
  for the workspaces it changed (all three when `shared/` changed).
- **Regression test.** A Vitest test, named by its path from the repository
  root (`canopy/server/test/config.test.ts`,
  `canopy/web/src/components/Pager.test.tsx`) and its full name. The `vitest`
  runner runs it from the nearest `package.json` (the workspace) with the
  hoisted `canopy/node_modules/.bin/vitest`, so nothing in the profile selects
  a directory. Two changes to the runner came with the profile and apply to
  every `vitest` profile. It forces `NODE_ENV=test`: under `production`, React
  loads its production build and every component test fails in setup (the
  profile's test commands set it too). And its reporter and name pattern work
  with vitest 5, which canopy uses: vitest 5 no longer calls `onFinished`, and
  joins a test's titles with ` > ` where vitest 3 uses a space.
- **Budgets** are banyandb's scaled down for a single-workspace UI change
  (3,000 agent invocations, 150 jobs, 250 decisions, 50 corrections, 10 hours of
  active time). They are unmeasured: no live run has used this profile yet.
  Measure one with `graphloom stats` and revise them ([budgets](../../../docs/budgets.md)).
- Not run: `license-check` (the license-header scan, slow on the whole
  repository). A new source file still needs the Apache header.

## Another repository

Copy a profile beside your task, adjust it, and name it with `config:`. A
profile selects one of the built-in regression runners (`go-test`, `vitest`);
another test framework needs a new runner in `src/runners/`.

## Build and repair

```sh
npm run build -w @graphloom/plugin-issue-fix
npm test -w @graphloom/plugin-issue-fix
npm run manifest -w @graphloom/plugin-issue-fix   # after build
node <installed>/scripts/qualify.mjs <candidateRoot>  # repair preflight
```

The manifest declares `taskConfig: "required"` and pins the source,
profile, test and lock digests, but no requirements: they depend on the
profile, and each run pins the ones `describe(config)` returns.
`src/qualification.ts` holds positive and negative cases for every validator
under both shipped profiles.
