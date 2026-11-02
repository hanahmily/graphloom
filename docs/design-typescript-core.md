# GraphLoom: TypeScript graphs and repairable execution

Status: current design direction, revised 2026-09-27; implementation partial.
This document supersedes the native Go plugin design in [core-design.md](core-design.md)
and its [Go package plan](codebase.md). Active TypeScript packages implement parts
of this design, including durable execution, Pi recovery, executor extensions,
and qualified repair. Live-provider qualification and full local-release
verification remain pending.
[Agent-host mode](design-agent-host.md) is newly designed, not implemented.
Earlier Go source is retained under legacy/go.

## 1. Decisions and scope

GraphLoom is a graph-native harness for multiple agents. Users implement executable
graphs in TypeScript. The controller and public SDK are also TypeScript, running on
Node.js. Each graph supplies deterministic code around agent judgment. A task file
selects a graph and repository; it does not encode every route or recovery case.

The core has three modules:

| Module | Owns |
|---|---|
| Graph/plugin | Required stages and outcomes, normal task construction and routing, executor implementations, default validators, convenient corrections for known failures |
| Supervisor | One logical supervisor per run, a fresh model session per recovery episode; drive the graph to successful completion under failure—investigate, reenter, repair, and exhaust authorized remedies before stopping |
| Controller | Execution admission and lifecycle, state, artifacts, validation scheduling, accepted receipts, worktrees, budgets, and version transitions |

Plugins own execution logic; the controller owns its durable lifecycle. GraphLoom
provides built-in executors for common needs, including GitHub, and plugins can
supply additional executors using the same public interface. Domain integrations
do not belong in the controller state machine. See the
[executor design](design-executors.md) for extension, invocation, and recovery.

The plugin's declared steps (called stages in the SDK) are fixed for a run.
The supervisor may repair any failing implementation inside the plugin, but cannot
add, delete, rename, reorder, or bypass a step. Required outcomes remain unchanged.
The controller applies decisions from either source; the plugin cannot veto an
otherwise admitted supervisor recovery operation.

Diagnostic, build, test, review-of-repair, and retry jobs are supporting executions
attached to an existing step or its recovery episode. They do not become new plugin
steps. Reentry creates another attempt of an existing step, not a replacement step.
Every plugin step must be declared at intake; dynamically invented or optional
repair steps cannot evade this fixed-step contract.

The first complete release is a local Linux CLI, a Pi SDK supervisor backend with
multiple configured model providers, serial jobs, and an isolated Git worktree.
Claude Code and Codex supervisor harnesses, selected by the plugin as data, are
implemented by the [supervisor harnesses design](design-supervisor-harnesses.md).
The example is **Write → Review**, producing a local file change. It includes bounded recovery and one tested plugin-repair transition.
No RSI, cross-run memory, portal, distributed scheduler, or automatic publication
is part of this release. Multiple roles do not require parallel execution.

### Execution modes

The existing **standalone** mode uses the GraphLoom CLI as driver and Pi as the
supervisor backend (Pi, Claude Code, or Codex; see
[supervisor harnesses](design-supervisor-harnesses.md)). The proposed **agent-host** mode attaches an existing coding
session, which executes admitted implementation work and supplies supervisor
judgment during recovery. It requires no second Pi supervisor. Both use the same
graph, controller state, executor lifecycle, validation, and repair admission.

Mode is selected at invocation and pinned for a run; task YAML remains unchanged.
One primary host can fulfill worker and supervisor roles in normal and recovery
phases, but
cannot fulfill an independent reviewer requirement for its own work. Independent
review uses another session. See [agent-host mode](design-agent-host.md) for the
host protocol, evidence, leases, accounting profiles, and implementation milestones.
Its mode-specific session and accounting rules extend the standalone defaults below.

### Why TypeScript replaces native Go plugins

A third-party `.so` can hide the very gate that needs repair. TypeScript source
packages make inspection, patching, testing, and new-process activation practical.
One language also avoids a Go-to-JavaScript extension seam in this early project.

The language alone is insufficient. A `.d.ts` describes types, not implementation;
minified output, binary dependencies, and remote services can remain opaque.
Repairability is an explicit package and authority contract. See the
[TypeScript declaration-file documentation](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html).

## 2. Task and operator experience

Keep the minimal task file:

```yaml
graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
```

```sh
graphloom task new <graph> <args…> [--repo <dir>] [--profile <name|path>] [--out <dir>] [--dry-run] [--force]
graphloom run task.yaml
graphloom inspect <run-id>
graphloom stop <run-id>
graphloom resume <run-id>
graphloom delete <run-id> [--force]
graphloom session list <run-id>
graphloom session open <run-id> [--stage <stageId> [--from-original] | <session>]
```

`session open` starts the agent of a session the run recorded, on a fork of
it, in the user's terminal, and records the conversation when the agent exits
([§15](#15-opening-a-recorded-agent-session)).
`task new` asks the graph's plugin for a declarative plan, executes its
bounded generic steps (fetch a ref, resolve a commit, pin a ref, write the
task) in the task repository, and writes `task.yaml`
([§16](#16-preparing-a-task-graphloom-task-new)). Writing the file by hand
stays valid.

These are target interfaces. Relative paths resolve from the task file. `hello`
selects an operator-installed bundle at `plugins/hello/` beside that file. Reject
path traversal. Installation and dependency preparation are separate from run
startup; there is no automatic registry download on a run's execution path.

Delete removes a stopped or finished run's worktree, `graphloom/<run-id>` branch,
and state directory, in that order and with `state.json` last, so a delete that
fails partway can be repeated. It refuses a run that is running, owned by a live
controller, or has an active session in this process, and a state file whose
directory, worktree, or branch is not the run's own name. Creating the worktree
records the run's state directory in the repository's git config
(`branch.graphloom/<run-id>.graphloomStateDir`); delete touches a worktree or
branch only when that record names this run, so an edited state file cannot
point it at another run. Uncommitted worktree changes, ignored files included,
and branch commits beyond the pinned head are discarded only with `--force`, and
the branch is deleted only at the tip that was checked.
For agent-host runs, deletion also checks durable host quiescence and execution
reconciliation under the run lock. It refuses while native work may still be
active or effects remain unreconciled, even after the controller service exits.
`--force` does not bypass this check or permit removal of the reconciliation
journal; see the [host lifecycle contract](design-agent-host.md#leases-disconnection-stop-and-resume).

A task may also carry `base: <commit>` (a hash, tag or branch of the task repository). Intake
checks it with `git rev-parse --verify <base>^{commit}`, refuses anything that is not a commit,
and pins that commit instead of `HEAD`: the run's worktree starts at it, and the candidate
digest, `git diff <pinned>` and checkouts all measure the change from it. Absent means `HEAD`.
`inspect` shows the request and the pinned commit as `base`.

Intake pins the task, repository HEAD (or its `base`), graph definition, plugin bundle, runtime
profile, grants, and finite budgets. A task may also name a JSON `config:` file
relative to it; intake pins its bytes and digest, and the plugin host hands that
pinned value, unread by the controller, to `describe`, `advance` and every
validator, so one graph can serve many repositories. Resume uses the pinned
copy. See the [issue-fix design](design-issue-fix-graph.md#how-the-config-is-pinned-and-passed).
The operator installation policy records whether local source
repair or validator substitution is authorized, avoiding repeated approval for
repairs already within that scope. Plugin metadata alone grants no authority.

Intake applies budgets in layers, after the plugin first describes itself:
the controller's defaults, then the graph's declared `defaultBudgets`, then
the task's own `budgets` ([finite limits](#10-finite-limits)).

Inspect shows the required stages, current attempt, normal/recovery mode, active
job and phase, validation evidence, concise decision reasons, correction allowance,
plugin version history, and the evidence a stop cites. Show build/test/review/activation
phases during repair. Expose useful explanations and evidence references, not
private model reasoning.

## 3. Plugin package and trust

A source-repairable plugin ships:

```text
plugins/hello/
  package.json
  package-lock.json
  tsconfig.json
  graphloom.manifest.json       # generated bundle metadata
  src/graph.ts                  # definition and normal routing
  src/validators.ts             # default validation implementations
  src/executors.ts              # optional custom execution implementations
  test/                        # positive, negative, and regression cases
  dist/                        # built JavaScript and source maps
```

The manifest records graph/version, SDK protocol, source/build/dependency digests,
entry points, private-state schema, repair contract, and required runtime profile.
Readable acceptance requirements are exported with the graph definition and
included in the generated manifest. The controller loads metadata as data and
checks it against the loaded definition in a child process before activation.
They cannot disagree silently.

Pin the compiler and Node runtime profile, dependency lockfile, compiler options,
and exact tested build artifacts. Build from the shipped source in an isolated
builder; run the resulting artifact whose digest appears in qualification records.
A source archive unrelated to an opaque executable is not a repairable bundle.
Source maps and type declarations supplement source; they do not replace it.

| Contract | Permitted recovery |
|---|---|
| Source-repairable | Inspect and patch shipped source in a run-local copy, test and independently review, then activate an admitted replacement |
| Opaque | Retry or repair its environment; use an alternative validator only when requirements are independently readable and substitution is preauthorized; otherwise stop for supplier/operator action |

Source repair requires permission to modify the relevant code and usable source,
build dependencies, and tests. A plugin wrapping an unavailable service or binary
must disclose that dependency; calling the wrapper TypeScript does not make the
hidden behavior repairable. The MVP qualifies source-repairable plugins; any opaque
bundle it admits must visibly retain the limited contract above.

The manifest's `repairContract` is `source-repairable` or `opaque`; a bundle that
declares none is opaque, and a patch cannot change it. The run view shows the
contract with the operator's grants, so the supervisor sees the limit before
spending a correction. On an opaque bundle, QualifyRepair refuses a plugin patch.
A validator repair is a substitution only: it needs the `validatorSubstitution`
grant, a `requirementId` whose statement the manifest pins, and a candidate that
adds files without editing or deleting the bundle's own. Any other request stops
the run with reason `opaque gate`. The blocker says what is missing, and the stop
cites the evidence the escalation and the supervisor referenced. No snapshot is
taken and no correction is spent.

Jobs the supervisor originates (every dispatch made in recovery) are confined to
the run's scope: the runner mounts the filesystem read-only except the job's
worktree, its linked-worktree administrative directory, the run's scratch directory
(`<stateDir>/scratch`), and a private `/tmp`, using bubblewrap, and points `TMPDIR`,
`GOCACHE`, `GOTMPDIR`, `GOENV`, `npm_config_cache` and (for executors that keep no
state of their own) `XDG_*` into the scratch directory. When Go is installed, the job
also gets a run-scoped `GOMODCACHE` in scratch that reads through the operator's cache
without writing it: the runner reads the operator's effective `go env GOMODCACHE GOPROXY
GOFLAGS` once, host-side, then sets `GOPROXY` to `file://<operator cache>/cache/download`
followed by the operator's proxy list, and adds `-modcacherw` to `GOFLAGS`. The
operator's checksum-database cache (`cache/download/sumdb`, small) is copied into the run
cache (never linked, links in it skipped) so checksum verification works offline. An operator
with `GOPRIVATE` or `GONOPROXY` set keeps the pre-existing behavior instead (their cache
read-only and unredirected, so cached private modules resolve and uncached downloads are
not available), because Go would bypass every proxy for those paths. The private
`/tmp` is used only when nothing the job reads lives under `/tmp`; the runner passes that
launch scope to admission, which accepts a write under `/tmp` only when it is private.
A runner that cannot confine
a job (no bubblewrap, or a non-Linux host) refuses it, in-turn and again at run time,
rather than running it unconfined. This holds whatever `allowUnrestricted` says for
the graph's own jobs. An agent executor's own login and history directories stay
writable. A proposal that visibly changes the host (a `go env -w`, an `rm` of a path
outside the scope) is refused in-turn with "host change needs the operator: report it
as a blocker". The operator's `hostRepair` task grant (off by default) lifts the
confinement; each such job is then recorded in `state.hostChanges`, in `inspect`, and
as `hostChange` evidence. Environment faults outside the run are the operator's: the
supervisor reports them as a blocker with evidence.

### A job's own confinement

A job may also ask for confinement beyond the run's scope with `JobSpec.confinement`, as data
the SDK validates when the job is pinned. The runner enforces it, and refuses the job, in-turn and
again at run time, where the machine cannot (no bubblewrap, no Docker, an executor it does not
apply to), never running it unconfined.

- `{ kind: "bwrap", network, mask, binds }` for an agent or command job: the root is read-only,
  the home directory is an empty tmpfs with holes only for the executor's own state (`ownState`)
  and what it needs to start, `mask` paths (absolute or `~/`) are hidden, `binds`
  (`{ path, readOnly }`) are added, and `network: false` removes the network
  (`--unshare-net`). The workspace stays writable unless the job is `readOnly`. It builds on
  the run-scope confinement above, so the controller gives such a job the run's scope. In a
  rehearsal, where `GRAPHLOOM_REHEARSAL_SCENARIO` names the scenario file, the runner also
  leaves that file's directory writable, since the stand-in model records beside it.
- **Read-only jobs and the shell.** A read-only job under a `bwrap` confinement runs with the
  workspace (and the run's other writable paths) mounted read-only: only its artifacts, its agent
  session, the executor's own state (an agent's login) and the run's scratch directory (the redirected temp and cache directories) stay
  writable. The sandbox, not a permission policy, then keeps the job from changing the workspace,
  so an agent executor may give such a job a shell. The runner says so with one signal: it sets
  `GRAPHLOOM_READONLY_SANDBOX=1` (`READONLY_SANDBOX_ENV` in the SDK) in the environment of the
  executor process it launched, only for a `readOnly` job it actually started under its own
  `bwrap` confinement that declares no read-write bind (one could reopen the workspace), and it removes any inherited value from every other launch. The signal
  is never read from job input, and an agent harness's own child processes do not inherit it. The
  coding-agent executor reads it into `CodingSessionOptions.readOnlySandboxed`; the Claude Code
  permission policy then admits `Bash` for a read-only job. Without the signal (no confinement,
  a docker or writing job, a harness started outside the runner) `Bash` stays denied for a
  read-only job, and `Write`, `Edit`, `NotebookEdit` and write tools stay denied either way. The
  shell can still read what the sandbox shows and use the network the confinement allows; it can
  write the run's scratch directory and the job's artifacts. A Codex job has its own shell
  inside Codex's read-only sandbox and is unaffected. The coding-agent executor's digest changes
  with this behavior, so an existing run needs `--update-executors` to use it.
- `{ kind: "docker", image, cpus, memory, pids, tmp, wallClockMs, writable, readOnly, env }`
  for a command job that runs untrusted code: each command runs as one `docker run` built from
  the data in `packages/runner/src/sandbox-docker.ts`: `--network none`, the memory and pids limits,
  `--read-only` with a `tmp` tmpfs, the operator's uid, `--cap-drop ALL`, `no-new-privileges`
  and `--pull never`. The image must be pinned by `@sha256:` digest. Only the `writable` and
  `readOnly` paths are mounted (each at its own path; `.` is the job's workspace, a relative path
  is under it, `@scratch/<dir>` is under the run's scratch directory), and only `env` is passed:
  no host environment reaches the container. A stop or the container's wall clock ends in
  `docker kill` by name; a resume removes the containers labelled `graphloom.run=<run>`
  (`Runner.releaseRun`). An `env` value may name a scratch directory (`@scratch/<dir>`), which the container sees
  at its host path (a toolchain's build cache, say); and the command's own report file
  (`GRAPHLOOM_REPORT_FILE`) is mounted into the container, the one host file besides the mounts it may write, so
  a report larger than the output tail comes back as the command's report.
  A job's tool calls are the controller's own admitted child operations of executors the graph bound,
  not processes of the confined job; the confinement binds the job's process, and each tool executor
  keeps its own isolation and credentials (a GitHub read needs its token and the network).
  Images are never pulled by a job. `graphloom sandbox pull <image@sha256:...> [--check]` puts one
  in the local store before the run (a graph's environment check calls it), and `graphloom doctor`
  reports the Docker CLI, the daemon, and whether it is rootless (the `docker` group is
  root-equivalent on the host; rootless is recommended).

Plugins, validators, builders, workers, and reviewers run outside the controller
process. A plugin crash or hang becomes an observed child failure; the controller
can terminate the process and ask the supervisor to investigate. Start a fresh
process for every replacement version. Node provides subprocesses and IPC through
[`node:child_process`](https://nodejs.org/api/child_process.html).

Process separation contains ordinary crashes; it is not a malicious-code sandbox.
Execution profiles must distinguish enforced restrictions from cooperative policy
and post-execution checks. The current coding harnesses permit unrestricted native
tools and detect some worktree violations afterward; they do not provide OS
confinement or general network enforcement. A profile requiring those guarantees
must reject unsupported execution. Agent-host mode records these capabilities at
attachment, as defined in its [authority contract](design-agent-host.md#authority-accounting-and-honest-limits).
Plugin callbacks and validators should get only immutable bundle files and explicit
evidence, not controller state or a writable target repository. Builders and repair
authors get a separate candidate tree; a working directory alone does not confine
them. Node's `vm`
is not a security mechanism; do not use it as the isolation claim.
[Node VM documentation](https://nodejs.org/api/vm.html).

## 4. Public interface and process protocol

The SDK is a small public package. The following is an interface sketch; referenced
value types and wire schemas must be defined and tested during implementation:

```ts
export interface GraphPlugin {
  describe(config?: unknown): GraphDefinition; // config: the task's pinned config
  advance(view: RunView): GraphDecision;       // view.config: the same value
  prepareTask?(input: PrepareTaskInput): TaskPlan | TaskPlanRefusal; // optional; `graphloom task new` (§16)
}

export interface Validator {
  evaluate(input: ValidationInput): ValidationResult;
}
```

`describe` declares stable stage IDs, ordered requirements, readable requirement
statements, evidence schemas, default validator bindings, independence constraints,
and private-state schema. Required outcomes must be understandable without reading
the predicate that checks them. The controller freezes this requirement definition
and the complete ordered step list, including stable IDs and names. Every dispatched
job references an existing step or a recovery episode associated with one. There
is no operation for inserting or removing steps during a run.

`advance` is deterministic over a detached view. It constructs job descriptions
and chooses normal routes; it does not directly call models, launch processes,
mutate files, or own authoritative state. `evaluate` is likewise pure over supplied
observations. A test command or semantic review is a separately executed job;
the validator interprets its observed result. These restrictions apply to graph
decision callbacks, not the whole plugin: plugin-owned executors perform actual
I/O in scoped execution processes. Built-in executors follow the same lifecycle
protocol. The controller records and admits execution without implementing its
domain behavior; see [executor invocation](design-executors.md#invocation-and-lifecycle).

`prepareTask` is optional and runs before any run exists. It is pure over its
input, like `advance`: it returns a plan as data, which the CLI validates and
executes ([§16](#16-preparing-a-task-graphloom-task-new)).

Values crossing processes use a versioned, bounded JSON protocol, with runtime
schema checks. TypeScript types do not validate external data. Requests and replies
bind run ID, operation ID, generation, expected state revision, active version,
and the recovery episode when applicable. Unknown, oversized, stale, or malformed
messages become observations, never state writes. Logs use a separate channel.

The view contains task inputs, canonical stage/attempt, receipts, evidence,
outstanding operations, recovery history, remaining budgets, current validator
bindings, execution overrides, and bounded serialized private plugin state.
Private state is advisory bookkeeping; the plugin must reconcile it with canonical
facts after recovery. It cannot be a second authoritative stage cursor.

| Operation | Who requests it | Result |
|---|---|---|
| Dispatch | Graph or supervisor | Built-in or plugin executor job (including agent/command jobs) with explicit inputs, schema, and scope |
| Observe | Graph or supervisor | Immutable controller-observed file/command/workspace evidence |
| Validate | Graph, supervisor, or controller when a candidate is ready | Run currently admitted checks for a named stage and candidate |
| Reenter | Graph for known correction; supervisor during recovery | Invalidate affected receipts and revisit a current/earlier required stage |
| Supervise | Graph; controller may also trigger recovery | Transfer decision ownership to the run supervisor |
| QualifyRepair | Supervisor | Build/test/review a candidate plugin or validator version |
| ActivateRepair | Supervisor requests; controller admits | Recorded, compatible version transition after qualification |
| Return | Supervisor | Resume normal graph routing from canonical facts |
| Stop | Graph or supervisor; operator stop has priority | Preserve state and explain the blocker |

There is **no agent-controlled Accept operation**. The controller issues a receipt
when all required evidence for the current stage passes its admission rules. A
plugin schedules ordinary work and validation but has no final completion veto.
A supervisor can ask for the same validation during recovery; it cannot supply a
passing receipt itself. Completion is derived from valid required-stage receipts.

## 5. Requirements, validators, and acceptance gates

A gate is the admission rule for an outcome. Separate three records:

1. **Requirement:** what must be true, rooted in the pinned user task and graph
   definition, with a stable ID and readable statement.
2. **Validator binding:** the implementation/version selected to verify that
   requirement, plus evidence schema and independence constraints.
3. **Receipt:** the controller's record of the requirement, binding, candidate
   revision, observed evidence, and accepted result.

A gate implementation can be wrong. Replacing it is different from changing what
the task requires. Plugin repair may change routing, prompts, or validators, but
cannot change the step set, IDs, names, or order, nor requirement statements,
evidence meaning, review independence, or granted authority. A new requirement needs explicit user
clarification and a new task/run in the MVP.

Validators return `passed`, `failed`, or `inconclusive`, with evidence references.
A timeout, crash, or malformed response is inconclusive, not evidence that the
product is defective or that it passed. The supervisor diagnoses the distinction.
Checks must pass against the current candidate and admitted validator bindings;
missing or stale evidence does not count.

The controller checks provenance, candidate/workspace fingerprint, predecessor
receipts, required check coverage, validator version, and independent reviewer
identity before accepting. It cannot prove arbitrary predicates or prose correct.
Separate tests and review provide evidence against weakening the criterion; they
are not a mathematical guarantee. User ambiguity remains a possible blocker.

Requirement manifests and accepted history live outside plugin writable scope.
Record a disputed gate as such. Freeze acceptance that depends on it until the
defect is resolved, rather than asking a worker to satisfy a known-wrong predicate.

### Where validation is defined

Validation is declared by the graph plugin, not inferred from an executor's exit
status. The plugin may use its own validator code or explicitly bind a compatible,
versioned built-in validator. These remain distinct responsibilities:

| Record or implementation | Owner/location | Example |
|---|---|---|
| Required outcome and evidence contract | Graph stage definition, pinned at intake | Relevant tests pass for the submitted candidate |
| Validator implementation and default binding | Plugin source or imported reusable validator package | Interpret a completed test result against the required suite |
| Evidence production | Scoped executors and controller observation | Test report, observed workspace fingerprint, independent review report |
| Accepted receipt | Controller durable state | The named requirement passed for this candidate and binding |

Illustrative target syntax, not the current SDK:

```ts
const testsPassed = defineValidator({
  evaluate(input) {
    const test = input.evidence.testRun;
    if (!test || !test.completed || !test.reportAvailable) {
      return { status: "inconclusive" };
    }
    if (!coversRequiredTests(test, input.requirement)) {
      return { status: "inconclusive" };
    }
    return {
      status: test.exitCode === 0 && test.failed === 0 ? "passed" : "failed",
      evidence: [test.artifactRef],
    };
  },
});

const implement = defineStep({
  id: "implement",
  requirements: [{
    id: "tests-pass",
    statement: "The relevant tests pass for the submitted candidate.",
    evidenceSchema: testEvidenceSchema,
    validator: testsPassed,
  }],
});
```

Here, `coversRequiredTests` checks the relevant test selection established from
the pinned task and admitted test plan; an empty test run or an unrelated command
exiting zero cannot satisfy the requirement. Planning and collection of that
evidence are executor jobs, not side effects hidden in `evaluate`. A candidate
fingerprint covers the actual working tree, not only Git HEAD when edits are
uncommitted. The controller rejects evidence from a different candidate, attempt,
or inadmissible producer before issuing a receipt.

For semantic requirements, an independent reviewer executor examines the task and
candidate and emits a structured report. A validator interprets that report; the
controller enforces reviewer identity and evidence provenance. The implementation
agent's own approval cannot satisfy an independent review requirement. Checks
belong to their declared stage: for Select → Implement → Review, Implement may
require tests and Review may require issue-resolution/scope approval. Do not make
Implement acceptance depend on the later Review receipt.

Missing, malformed, or interrupted checks are inconclusive. A completed relevant
test that fails is negative evidence. Both can trigger recovery, but the supervisor
must distinguish product defects from broken validation infrastructure. Repairing
validator code uses the existing qualification procedure; it cannot weaken the
pinned requirement or synthesize a passing receipt.

The [executor example](design-executors.md#example-graph-executor-and-coding-agent)
connects these declarations to graph decisions, coding agents, and test/reviewer
executions.

## 6. Supervisor authority and routing

The graph handles normal execution and optional known corrections. The supervisor
owns exceptional recovery. Its **core job is to make the graph advance
successfully**: keep working the run toward accepted required stages, prefer
investigation and repair over early Stop, and spend remaining budgets on the next
plausible remedy within pinned outcomes and granted authority. Stopping is for
exhausted limits, missing indispensable authority, contradictory requirements,
opaque unrepairable gates, or operator cancellation—not for inconvenience or a
single failed trial.

The controller records exactly one active decision
source through durable `normal` and `recovery` modes. Both use the same admission
and execution interface. Workers and reviewers report typed results or conflicts;
they do not route the run or modify receipts.

The run has one logical supervisor identity, continued across recovery episodes
and restored from durable context if its host/provider session is lost. All
supervisor diagnosis, **source repair coding**, repair coordination, and activation
requests use that identity. In standalone mode this is a Pi session created lazily;
workers and the independent patch reviewer use separate sessions. In agent-host
mode the attached primary session performs normal assigned coding and fulfills the
supervisor role during recovery. An explicit host rebind preserves logical identity,
records the new conversation, and resets no budgets. The supervisor writes repairs
itself against admitted candidate trees (see §7); an independent reviewer must use
a different session. No supervisor decision round trip is required on the happy
path. A host acting as a worker does not simultaneously own recovery decisions.

### Standalone Pi SDK session implementation

Superseded as the only backend by the
[supervisor harnesses design](design-supervisor-harnesses.md) (implemented through S6): a harness-neutral
supervisor host drives Pi, Claude Code, or Codex behind the same `Supervisor`
port. The plugin declares its preferred harness in `GraphDefinition.supervisor`;
the operator's `supervisor.json` enables harnesses and may override or forbid
them; the run pins one harness, changed only by `resume --supervisor`. The Pi
details below remain the Pi harness specification.

Use the pinned `@earendil-works/pi-coding-agent@0.87.1` for the supervisor runtime.
The supervisor model is any `<provider>/<modelId>` in Pi's registry, a provider
Pi ships or a custom one in its `models.json`, with that provider's own Pi
credential ([choosing a supervisor model](design-pi-supervisor.md#choosing-a-supervisor-model)).
The first operator setup used `minimax-cn/MiniMax-M3`, through a private command
reference to the existing OpenCode MiniMax CN credential. SDK connectivity and project type
checks have passed. Recovery and model switching are implemented with faux-provider
verification; live recovery/provider qualification remains outstanding. See the
[verified MiniMax setup](design-pi-supervisor.md#the-minimax-operator-setup-history).

Model changes among configured DeepSeek, MiniMax, OpenAI, and Anthropic providers preserve one
logical run-wide supervisor; each recovery episode opens its own Pi session on the
current model. The controller owns model-switch admission,
actual-request accounting, recovery decisions, and the fixed plugin steps.

The [Pi integration design](design-pi-supervisor.md) defines explicit tools,
resource isolation, session restoration, model-switch journaling, and required
verification. Direct Pi Claude access uses API credentials; it must not promise
included Claude Code subscription allowance. Coding agents can instead run the
user's own Claude Code through the coding-agent executor's Claude Code harness,
a separate integration rather than a Pi model setting. See the
[authentication findings](research/pi-claude-auth.md).

### Trigger and repair

The controller starts recovery on an explicit yield, launch failure, timeout,
malformed result, plugin-process failure, invalid decision, or unexplained failure
stop. Negative domain results may first use a known correction in graph code.
After two failed correction trials at the same unresolved stage, transfer to the
supervisor before a further trial. Corrections identify their source attempt and
unmet contract, so counting does not require parsing domain error strings.

Two repeated no-progress decisions also trigger recovery. New operation IDs alone
do not establish progress. Keep repetition counters across mode changes until
relevant fresh evidence or stage acceptance resolves the condition. All decisions,
including repeated observations and Return cycles, consume global limits.

The supervisor's repair scope covers every failing plugin implementation surface:
prompts, available model settings, task construction, validation logic, artifact
handling, error handling, and routing between existing steps. It may investigate,
run repair jobs, reenter existing stages, and **write** qualified source patches
through its selected supervisor session against admitted candidate trees. Prefer another
authorized remedy while budget and authority remain; Stop only when further progress
is blocked as above. No plugin-specific repair allowlist is required. This is a
duty to attempt repairs aggressively within bounds—not a guarantee of success when
source, capabilities, or budget are unavailable.
Routing repairs preserve the fixed step set and required order; retry and reentry
cannot be used to skip an outcome or introduce a new step. When the supervisor
retries or reenters a stage, it **generates the job instruction (prompt) itself**
for that recovery trial—it must not be forced to reuse the plugin's original
happy-path prompt. The override still preserves the original user task, evidence
contracts, write scope, and reviewer independence. Persist scoped overrides with
target job/stage, supervisor-authored instruction, reason, source evidence, and
expiry after the named trial; they cannot silently affect unrelated stages.

A denied optional action returns a rejection so the supervisor can choose an
authorized alternative. Missing indispensable authority, contradictory requirements,
unavailable source/dependencies, or exhausted limits can still stop the run. Operator
cancellation always takes precedence. Recovery cannot manufacture permission.

### Reentry and return

Reentry targets a declared current or earlier required stage. Before admission,
quiesce active children and reconcile ambiguous effects. Under the run lock,
reserve a correction attempt, move the stage cursor, invalidate the target and
downstream receipts and dependent checks, cancel dependent pending jobs, and record
reason/evidence. Retain history and artifacts. Do not reset the worktree or discard
operator edits. Retries append attempts, so the execution history remains acyclic.

The active decision source then dispatches the recovery trial using that reservation.
**In recovery, the supervisor authors the `Dispatch` instruction** (agent prompt or
command description) for that trial. The plugin's prior instruction is diagnostic
context only—it is not binding for the recovery attempt. Graph-authored known
corrections in normal mode may still supply their own coded instructions; that does
not constrain supervisor recovery. Reentry and its first trial consume one
correction attempt, not two. Duplicate operation IDs return recorded settlements
without additional invalidation or reservation.

`Return` requires no active or ambiguous operation. It records recovery results
and atomically restores normal mode. It does not declare success. The plugin sees
current stage, attempts, validation receipts, and admitted repair results; it must
consume valid repaired results before dispatching duplicate work. The controller
can validate and accept a repaired candidate while still in recovery, so an
incorrect normal route cannot withhold acceptance. Routing that remains broken can
itself be patched through the version procedure below.

## 7. Repairing plugin code or a defective validator

The run supervisor **writes the repair** into an isolated candidate copy using
its Pi session in standalone mode, or the attached primary session in agent-host
mode. An **independent read-only reviewer** (separate session/role) evaluates it.
The supervisor remains the patch author; repair is not automatically delegated to
a second coding agent. The original bundle and failure evidence remain immutable.
Repair source lives
outside the target repository, so it cannot accidentally enter the user's
deliverable diff.

**Snapshot base for every qualification.** `QualifyRepair` always starts from an
immutable snapshot of a specific plugin version (normally the run's active pinned
bundle: source, lockfile, build inputs, and digests). The controller materializes
that snapshot into an isolated candidate tree **before** the supervisor session
receives the candidate-edit assignment and its write scope. Concurrent or overlapping
repair
attempts each get their own snapshot and tree; they never share a writable working
copy, and they never mutate the live installed bundle or another candidate. A
revised patch forks again from the recorded base snapshot (or from an explicit
prior candidate digest), not from a half-edited tree. Qualification receipts bind
the base snapshot digest and the candidate digest together so activation cannot
admit a patch whose parent is no longer the intended version.

| Defect | Response |
|---|---|
| Product output is wrong | Repair output and rerun existing validation |
| Validator invocation/environment is wrong | Repair execution and rerun existing validation |
| Readable plugin/validator source is wrong | Qualify a source patch against the unchanged requirement |
| Opaque validator is wrong | Qualify an authorized replacement only if an independent readable requirement exists; otherwise stop |
| Requirement itself is contradictory | Present evidence and request clarification; do not redefine success |

A source repair or validator substitution follows the same bounded procedure:

1. **Diagnose and reserve.** Identify the disputed requirement or route, faulty
   version, candidate revision, failure evidence, repair authority, and one shared
   correction reservation. Snapshot the faulty plugin version into an isolated
   candidate tree before editing. Admit candidate coding for the supervisor session
   **only** against that candidate cwd, under the declared execution profile. A patch
   cannot change the repair policy that
   admits it. Only one activation may proceed at a time under the run lock; other
   in-flight candidates remain durable artifacts until activated, rejected, or
   superseded.
2. **Reproduce.** Add a focused regression case showing the defect in the original
   implementation. Include valid and invalid cases derived from the requirement.
   For an exact-byte gate, include missing newline, wrong content, and extra files.
3. **Patch (supervisor session).** The same logical supervisor patches the isolated
   plugin candidate using Pi coding tools in standalone mode or native host tools
   in agent-host mode. Tools operate under the declared profile, rooted at the
   candidate; exploratory builds/tests do not replace step 4's controller check.
   Agent-host repair uses a durable edit offer and settlement rather than blocking
   a controller callback on the very host that issued it. Preserve the readable
   requirement,
   complete ordered step list, original test corpus, and original failing result.
   A changed old test needs an explicit defect explanation and independent review;
   deleting negative coverage or loosening expected outcomes is not a repair shortcut.
4. **Build and test.** The host builds from pinned source/dependencies and runs
   regression, positive, negative, and affected integration checks. Reproduce the
   defect on the old version and demonstrate corrected behavior on the candidate.
   For crashes, reproduce the failure without requiring the broken validator to
   validate its own replacement. Build/test infrastructure failure is inconclusive.
5. **Independent review.** Give a separate read-only reviewer the original task,
   requirement, patch, old/new observations, and test evidence. It must evaluate
   equivalence to the required outcome and remaining gaps. Its receipt binds the
   exact source/build digests and **cannot be authored by the supervisor session
   that wrote the patch**, regardless of driver mode.
6. **Activate.** The controller admits the exact qualified artifact and records a
   version transition as described below. A rejected or revised patch needs fresh
   qualification; previously failed candidates remain visible.
7. **Revalidate.** Rerun affected checks and downstream review against the real run
   candidate. A patch's test pass is not the product's acceptance receipt. Continue
   the original happy path from the earliest affected stage.

A replacement needs a readable, independently pinned acceptance requirement and
operator-authorized substitution policy. A plugin declaring itself replaceable is
not sufficient authorization. If the only definition of correctness is inside
an opaque binary or remote service, the supervisor cannot establish equivalence;
it must request supplier/operator intervention.

Dependencies and optional network access belong to the builder's granted scope.
The MVP does not auto-upgrade shared dependencies or publish a repaired package.
A patch is local to this run. Reusable upstream fixes are a separate authorized act.

## 8. Version transitions and crash recovery

Normally resume loads the active pinned version. A qualified repair permits an
explicit version change inside the same run; installing a newer plugin elsewhere
never upgrades a run implicitly. Every transition records old/new digests, source
patch, qualification and review receipts, affected stages, state compatibility,
correction reservation, and activation generation.

The MVP accepts only the same SDK protocol, private-state schema, requirement
manifest, complete step set/IDs/names/order, and evidence schemas. During
qualification, before independent review, the controller checks the candidate's
manifest and declared dependencies, rejects any `node_modules` or `.git` entry its
digest cannot cover, then loads it in a throwaway host. Its
`describe()` must match the pinned version, private-state schema, stages,
requirement statements, evidence schemas and default validator bindings. A run
started with an in-process plugin or caller-supplied host and no `recreateHost`
hook has no way to load the candidate, so only a definition returned by the
operator's preflight is compared. A mismatch rejects the candidate with a reason
naming what changed; the run stays in recovery on its old version. Activation
repeats the `describe()` check on the host it switches to. An independent review
cannot authorize a structural difference.
Runtime admission also rejects jobs and routes that name undeclared steps.
Arbitrary state migration is deferred. Moving a run's durable state to a newer
GraphLoom release, across ordered state-format migrators that change only how
state is stored, is `resume --upgrade`
([release design §5.2](design-release.md#52-moving-a-run-forward-resume---upgrade)).
Private state is disposable bookkeeping: a compatible patched plugin must reconcile
it against the canonical run view. If it cannot, stop with a compatibility reason;
do not erase authoritative state or start a new run silently.

Activation has these durable phases:

```text
qualified candidate → activation intent → fresh child preflight
                    → atomic version/binding switch and invalidation
                    → affected validation → normal continuation
```

Quiesce jobs first and persist intent before starting a candidate process. Preflight
checks protocol, metadata, unchanged requirement definitions, qualified validator
binding changes, and bounded callback behavior.
Under the cross-process lock, compare generation/state revision, verify the
candidate still descends from the recorded base snapshot (reject if the active
version moved under a concurrent activation), commit active version and validator
bindings together with receipt invalidation, and fence old messages. Resume
reconciles that journal: before the switch, the old version stays active; after it,
the new version stays active. Never execute both as decision owners. Never merge
two candidate trees; activate exactly one qualified artifact or keep the previous
pin. Candidate preflight cannot perform target-repository effects.

A routing-only change preserves already-qualified outcomes if their validator
bindings and evidence remain unchanged. A validator change invalidates its affected
stage and downstream receipts even when the worktree bytes are unchanged. In that
same atomic transition, move the active stage cursor to the earliest invalidated
required stage and cancel its dependent pending jobs/checks. This prevents a run
at Review from remaining there with its accepted Write prerequisite invalidated.
The MVP may conservatively invalidate from the earliest affected stage when
dependencies are uncertain. Reentry and activation share the existing repair
reservation.

A failed candidate does not mutate the original bundle. Before switching, it can
be rejected with the old version still pinned and the run in recovery. After a
switch, rollback is another recorded compatible transition under admission and
remaining limits; it never resurrects invalidated receipts or treats a known-bad
gate as valid. Stop/resume preserves both failed and successful transitions.

### Moving a run onto upgraded executors

A run pins its executor catalog at intake (id, source, isolation, built-in
status, input shape and a digest of the code). Resume checks the pins against what
the runner serves, so an installed executor whose bytes changed stops the run with
`executor pin mismatch`. The blocker adds the way forward: `resume with
--update-executors to pin the installed executor`.

`graphloom resume <run> --update-executors` is the operator's explicit transition,
the executor counterpart of `--update-plugin` (the two combine). For each pinned
executor whose installed digest or source location changed, the controller
replaces the catalog entry with the installed descriptor, taken as data (digest,
input shape, source, entry module), and records the transition: old digest to new
digest (and source, when it moved) and the generation it took effect, in durable state
(`executorTransitions`, shown by `inspect`), as an `executorUpdate` evidence
record, and as a version-history entry. A dispatch admitted before the stop and
not yet started carries the new digest. The run then continues; later resumes
need no flag.

The flag refuses, as an `executor pin mismatch` naming the executor, when the
executor is no longer installed, its `isolation` or `builtin` status changed (the
operator reconfigured how it runs; re-pinning would hide it), or its entry is an
active run-local repair whose base the installed bytes have moved past: the
qualified copy stays pinned and only a repair replaces it. The pinned descriptor
carries no declared effect today, so there is no effect check; one that did would
need to refuse on change.

Accepted receipts and evidence are not rewritten. A receipt's identity binds the
workspace change and artifact digests it was accepted on, and evidence records
the job that produced it, never an executor digest, so evidence produced
before the transition stays valid evidence of what ran then. Only dispatches
after the transition run the new bytes.

### Resume retries what failed

An operator resumes because something changed (code, config, environment,
grants, budgets), so a failure recorded before the resume is not by itself a
reason to stop again. That is one rule for the whole run, not a decision each
part makes on its own: the controller classifies every stop as *retryable* or
*final*, tells the graph about the resume, and plugins count only failures from
after it.

Every stop is classified when the run stops. The controller classifies its own
stop reasons by a fixed table (`stop-class.ts`); a graph or supervisor stop
carries its own class as data, `StopSpec.retryable` (default `true`), so the
controller never learns a plugin's reason strings. On resume:

- after a **retryable** stop, the run runs again: the graph's `advance()` decides
  from current evidence and retries what failed;
- after a **final** stop, the resume surfaces the same stop reason, blocker and
  cited evidence without asking the graph, unless something the stop depends on
  changed: the operator updated the plugin (`--update-plugin`), the active version
  or bundle changed, the workspace change differs from the one the run stopped on,
  or a budget was raised. The held resume is recorded as a remedy; it does not
  start a generation. A resume after a change records what lifted the stop.

| Class | Stop | Who classifies | On resume |
|---|---|---|---|
| retryable | job/executor failure (`job failed: …`, `stale job result identity`, a recovery trigger with no supervisor) | controller | graph retries |
| retryable | delivery failure (`delivery failed`) | plugin (`retryable: true`) | graph retries; a failure since the resume stops again |
| retryable | provider failure (`supervisor provider …`, `supervisor decide failed`, `reviewer_unavailable`, `supervisor_inadmissible`) | controller | graph retries; recovery starts afresh if the failure recurs |
| retryable | plugin host failure (`plugin host: …`, `plugin host restart failed`) | controller | graph retries |
| retryable | no-progress loop (`no-progress loop`: 16 consecutive controller steps charged no finite budget; the blocker names the last action) | controller | graph retries |
| retryable | step limit (retired: a run saved with it by an earlier controller) | controller | the recovery episode continues |
| retryable | environment (`environment check failed`, `environment preparation failed`, `environment changed`) | controller | checked again before the graph runs |
| retryable | rechecked on resume (`worktree mismatch`, `pin mismatch`, `executor pin mismatch` (`--update-executors` re-pins changed executors), `reconcile required`, `repair rehydration required`, `delivery changed after acceptance`) | controller | resume checks it again first |
| retryable | any other stop, and a graph or supervisor stop that does not say | controller / default | graph retries |
| final | needs maintainer decision, cannot reproduce, incompatible task | plugin (`retryable: false`) | same blocker until a change |
| final | budget exhausted (`budgets exhausted`, `<budget> budget exhausted`) | controller, or plugin (`retryable: false`) | same blocker until a budget is raised (or another change) |
| final | `unsupported action in …` (a plugin defect) | controller | same blocker until the plugin changes |
| final | operator stop | controller | the resume is the operator's answer: the run runs again |

A stop's class is visible as `stopRetryable` in `run`/`resume` reports and
`inspect`. What a final stop depends on is recorded when the run stops
(`stopMark`): the plugin and executors, the active version, the workspace
change, the budgets, and the GraphLoom build that ran it (product version and
commit, `hostBuild`, passed by the CLI on `run` and `resume`). A fix to
GraphLoom itself, such as its runner's confinement, is therefore a change: a
resume on a different build runs the run again and records "GraphLoom changed
from X to Y" as the remedy. A mark from before builds were recorded counts as an
unrecorded build. A run that stopped before stop marks existed has none and is
retried, as before. A class and mark belong to the stop reason they were recorded
for: a resume sets them aside, so a new stop it records (a preflight `pin
mismatch`) is classified on its own, and restores them only when it holds the
original final stop.

On every resume that runs, the controller fills `RunView.resume`:
`{ generation, at, pluginUpdated, previousStopReason, previousStopRetryable }`,
kept in durable state as `lastResume` (absent until the first resume; older
states load without it). `generation` is the generation the resume started, so
evidence from an earlier generation predates the resume.

A run resumed while in recovery first returns to normal mode, so the graph's own
`advance()` retries what failed. The trigger recorded before the stop is not
current evidence. If the failure recurs, recovery starts again with a fresh
trigger and post-resume evidence. This applies to every retryable stop, including
the supervisor's own retryable stop and a run with no supervisor. The one
exception is a run saved with the retired step-limit pause, which continues the episode.
Resume first reconciles the pending dispatch, repair, and model-switch journals.
It keeps budgets, correction trials, handoffs, repeated-proposal tracking, repair
candidates, and the case file. The return is recorded as a remedy and as a
settlement fact for the next episode. A re-opened stage runs as its next attempt
(`nextStageAttempt`), so a plugin can tell a reentry from a resume.

### Writing plugins: resume

A decision that ends the run because something failed only uses failures from
after the operator's latest resume. A failure recorded before it is stale: retry
what failed instead of stopping on it. A failure that recurs after the resume
still ends the run, so a failing step cannot loop.

- `isStaleFailure(record, view)`: whether `record` predates `view.resume`
  (always `false` in a run never resumed).
- `failuresSinceResume(evidence, view, isFailure?)`: the failures recorded since
  the latest resume. By default the job failures the controller records
  (`executorFailureOf`); pass `isFailure` for a failure the plugin reads from its
  own evidence, such as a command that ran but exited non-zero.
- Mark a stop no retry can clear `retryable: false` (a maintainer must decide, the
  task is incompatible, the plugin's own budget check). Leave failure stops
  retryable (the default), or say `retryable: true`.

For example, issue-fix's delivery:

```ts
const delivered = commandRuns(current, COMMAND.deliver)
  .filter((r) => succeeded(r.command) || !isStaleFailure(r.record, view))
  .at(-1);
if (delivered === undefined) return dispatch(deliverJob, "put the change on its branch");
if (!succeeded(delivered.command)) return stop({ reason: "delivery failed", blocker, retryable: true }, "…");
```

Keep the definition, requirements and private-state schema unchanged when
applying this to an existing plugin, so a running run can adopt it with
`resume --update-plugin`. The conformance cells in
`apps/graphloom/test/matrix/` (hello, issue-fix) and the resume tests in
`apps/graphloom/test/release-e2e.test.ts` and `issue-fix-e2e.test.ts` inject
each retryable stop a plugin can produce, resume once, and assert it retries;
a final stop resumes to the same blocker.

## 9. Worktree, communication, and durable state

The controller creates `graphloom/<run-id>` from pinned source HEAD in an isolated
Git worktree. It preserves source working files, index, and current branch;
uncommitted source changes are not copied. Branch/worktree registration uses
shared Git metadata under a per-repository lock. Retain the run worktree on
success, stop, and failure. Missing/mismatched worktrees stop resume; never silently
recreate or reset them. External edits require assessment and invalidate evidence.

Jobs exchange explicit immutable artifacts and the admitted workspace revision
through the controller. Agents return a typed result envelope containing run/job
identity, revision, status, summary, outputs, and evidence references. The host
rejects stale identities, escaping paths, symlinks, and oversized results, then
snapshots outputs after the child finishes. Worker assignments permit only their
worktree/output scope; reviewers and validators require read-only candidate access.
Enforcement depends on the admitted profile. Unrestricted tools receive these as
policy and are checked afterward; do not claim this prevents arbitrary writes.
Shared Git metadata, plugin repair trees, and controller state are separate scopes.

One private durable state contains pinned inputs, active versions/bindings, stages,
attempts, receipts, operation intents, mode/episode, overrides, reservations, and
supervisor continuity. Use a cross-process lock and synced atomic state replacement;
a JavaScript mutex alone cannot serialize CLI processes. Immutable artifacts are
addressed by digest. Journaling must reconcile process outcomes rather than blindly
replay a dispatched effect after a crash.

### Evidence storage

A large run's evidence is mostly content: file reads, search output, every version
of an artifact written through command argv, agent outputs, metrics. Carried inline,
it was rewritten to `state.json` on every save and cloned into every plugin view and
validation (a 1,713-record review carried 16.1 MB). The controller therefore keeps
the **externalized form** canonical, in memory, in `state.json` and on the wire.

- **At record time.** When the controller makes an evidence record (job results,
  observations, the environment preflight, child tool calls, and every other
  record, through a sweep before each state save), every payload part, an object,
  array or string subtree, whose JSON serialization is over the threshold (8 KiB)
  moves into `<stateDir>/evidence/sha256/<hex>.json`: content-addressed, immutable,
  deduplicated, written once and fsynced **before** any state save that references
  it. The part becomes `null` in the payload and is listed on the record as
  `externalized: [{ path, sha256, bytes }]`. A part is moved at the deepest level
  that leaves its enclosing object within the threshold, so small identifying
  fields (`command.id`, `exitCode`, `path`) stay inline; the payload root and
  `producer` are never moved; many tiny members move with their container, not one
  blob each. Largest first, deterministic: the same payload always gives the same
  record. A crash between a blob write and the save leaves an orphan blob, never a
  dangling reference. Blobs live under the state directory, so deleting the run
  deletes them.
- **In the plugin worker.** Before calling `advance` or a validator's `evaluate`,
  the worker (GraphLoom's code, not the bundle's) installs an enumerable lazy getter
  at each recorded path of `view.evidence` and of the validation input's `evidence`
  and `history`. The first read loads the blob from `GRAPHLOOM_EVIDENCE_STORE` (the
  run's `evidence/`, set by the controller), verifies its digest, parses it, caches it
  for the call and replaces the getter. Plugin code is unchanged:
  `record.payload.command.argv` reads as it did. A missing or corrupt blob is the
  host observation `evidence_unavailable`, distinct from `internal`: the run goes to
  recovery with that cause, not as a plugin defect. The in-process host (scripted
  and test graphs) hydrates eagerly through a reader the controller gives it; a host
  that does not hydrate itself is handed hydrated records by the controller.
- **Readers in the controller.** Anything that shows or compares content hydrates
  first: the supervisor's `get_evidence` (bounded by the tool), settlement lines,
  the reviewer's cited evidence, replay and `record-scenario`, and an artifact's
  accepted identity (which is a digest of content however it is stored). A synchronous
  validator in the controller's process gets hydrated records; a host validator
  gets them externalized and its worker hydrates.
- **Fingerprints and keys** that hash a record's payload hash its externalized form
  (the digests stand in for the content). An inline record hashes as before; a
  record that has parts moved hashes differently from its inline form, so
  `candidateFingerprint` and the supervisor's no-progress evidence keys of a run
  change once, across the upgrade below.
- **Safety valve.** If a view's inline evidence still passes 8 MB, the view is built
  with a halved threshold (down to 256 bytes), a deterministic function of the
  state; the extra blobs are ordinary blobs and the stored state is unchanged. The
  64 MB wire bound stays as a runaway guard.
- **Format 2.** The state format is 2. The 1 to 2 migrator moves the large parts of
  an existing run's evidence into `evidence/` and sets the references; its protected
  view hydrates both sides, so the migration machinery checks that every record still
  says exactly what it said. `graphloom resume --upgrade` moves a run, writing the
  blobs durably before `state.json`.

Stop records an atomic request, fences the generation, cancels/reaps the process
group, and preserves a resumable stopped state. Late messages cannot advance it.
Inspect and stop read/control state without importing plugin code. Run status is
`active`, `stopped`, or `succeeded`; normal/recovery and repair phases are separate
progress fields. No automatic commit, push, merge, or external publication occurs.

## 10. Finite limits

| Limit | Initial default |
|---|---:|
| Agent invocations, including supervisor and repair reviewers | 64 per run |
| Executed jobs and observations, including validation/build/test jobs | 128 per run |
| Admitted/rejected decisions and mode/version transitions | 512 per run |
| Corrective attempts across coded correction, supervisor repair, and plugin patches | 8 per run |
| Individual job or agent invocation | 20 minutes |
| Plugin protocol callback | 10 seconds |
| Active run execution time | 4 hours |

These are the controller's own defaults, the bottom layer of three: a graph
may declare `defaultBudgets` in its definition (issue-fix takes them from its
repository profile), and the task's `budgets` override both, key by key. Each
value stays a finite positive integer, and `recoveryReserve` stays below
`agentInvocations`. `defaultBudgets` is not compared on resume or repair: a
run keeps the budgets it was intaken with. What a run used is kept apart from
what it has left (`budgetUsage`), so the run's budget is always used plus
left, including any budget an operator raised by hand; `graphloom stats`
reports it per stage. See [budgets](budgets.md) for the measured runs the
profile defaults come from.

These are standalone defaults. Agent-host mode preserves correction, job, decision,
and active-run limits while using separate coding/proposal deadlines, adding a
distinct host-slice allowance, and declaring explicit usage coverage; see [host accounting](design-agent-host.md#authority-accounting-and-honest-limits).
An external host without provider interception cannot promise this exact model-call
ceiling. Even the current standalone Claude harness has documented request-count
limitations; inspect must disclose the accounting profile rather than imply a
hard ceiling it cannot enforce.

Reserve before effects. One repair candidate and its first trial use one correction
reservation; a revised patch or repeated failed trial requires another. Diagnostic
steps, independent review, and activation also consume applicable job/invocation/
decision limits, without counting the same correction twice. The graph's
environment checks and preparation count as a job, reserved before they run; a
checkout job that repeats them counts as two. A prepare command may declare
`inputs` and `outputs` globs; a checkout then restores its saved output instead of
running it when the digest of the input files' contents and the command's argv
match an earlier success in the same run
([prepare cache](#14-prepare-cache)). Reentry, activation,
mode changes, session replacement, and resume never reset counters. Exhaustion
preserves the run with attempted remedies, evidence, and an exact remaining blocker.
Until those limits or hard blockers apply, the supervisor treats unfinished required
stages as work still owed. Broad repair authority does not guarantee success for
every task or plugin.

### Job wall clock and timeout continuation

A job may ask for its own wall clock with `JobSpec.timeoutMs` (a positive
integer of at most one day, `MAX_JOB_TIMEOUT_MS`), as data: a graph sizes long
work, such as issue-fix's `agent.timeoutMs` profile setting. The request stays
finite twice over. The runner clamps it to the operator's ceiling for the
executor (`ExecutorBinding.maxTimeoutMs`; the coding agent's defaults to four
hours, `maxTimeoutMs` in the runner config) and tells the executor the result
(`ExecutorContext.timeoutMs`), so a harness fits its stall watchdogs inside it.
The controller aborts any job once the run's active-time budget runs out, so no
request outlives the run's `activeMs`. A job without a request keeps the
operator's default.

A timed-out job settles as `failureKind: "timeout"`, never as a success: a
result the executor reports as `ok` after its wall clock ran out keeps its
session but not its evidence. The session does not depend on the executor
answering in time. Each coding-agent harness saves its session into the
controller's session directory while the turn runs, as soon as the harness
reveals it (Claude Code's transcript and Codex's rollout as they grow, Pi's
session file from its first assistant message, the scripted harness's
transcript as the turn begins), and reports it at once
(`ExecutorContext.keepSession`). A timed-out job keeps the newest session it
reported even when the executor is killed after the runner's stop grace
without answering; the grace is only the executor's chance at a later save
and a last report. Each harness resumes a session cut off mid-tool. An agent
job may declare `timeoutContinuations` (0 to 3,
`MAX_TIMEOUT_CONTINUATIONS`): when it times out after changing the worktree
(the controller's own before/after fingerprints, not the executor's claim) and
its session was kept, the controller queues the same job with `continueFrom`
the timed-out operation instead of opening a recovery episode, and the
executor tells the agent why (`ExecutorSession.note`): its last turn ran out of
time and the worktree keeps its changes. At most the declared count of
continuations runs per attempt. An attempt is a dispatch the graph or the
supervisor made; every continuation, declared-retryable retry, or quota resume
the controller queues for it carries the attempt's operation id
(`timeoutChain` on the queued retry and its pending dispatch) and shares its
allowance, counted in run state under that id (`timeoutContinuations`). A later
attempt of the same stage, such as a reentry after review in the same
generation, gets its own allowance. The count and the chain are durable: a
stop and resume, which bumps the generation, neither resets the count nor
drops the chain of a queued continuation. A continuation that was running when
the controller stopped is reconciled like any interrupted dispatch, and the
graph's next dispatch after that is a new attempt. Each continuation is
admitted like a queued retry: it spends a decision, a job and its agent
invocations through the usual budget checks, and continues, rather than
repeats, a correction the timed-out try already counted. A timeout that
changed nothing, kept no session, or exceeds the attempt's count goes to
recovery as `executor_failed`, with the reason it was not continued. The
plugin never sees the failure first: executor failures reach recovery from the
controller, so the continuation is a generic contract declared on the job, not
plugin code.

The Codex harness keeps and resumes sessions (`codex exec resume`), but it
serves read-only jobs only, so a Codex job never changes the worktree and is
never continued after a timeout: the worktree change is the controller's
proof that the timed-out try made progress worth continuing, and a read-only
job offers none. Its kept session stays available to an explicit
`continueFrom` from the supervisor or the graph.

## 11. Minimal example and verification

Hello's required stages are Write and Review:

```text
Graph dispatches writer → agent writes GREETING.txt
  → host observes exact bytes and complete workspace change manifest
  → validator checks requirement → controller accepts Write
  → graph dispatches independent read-only reviewer
  → reviewer approves current revision → controller accepts Review → success
```

Only `GREETING.txt` may change, with exact UTF-8 bytes `Hello, GraphLoom!\n`.
The change manifest includes tracked, untracked, and ignored files, excluding Git
metadata. Review reports and run artifacts live outside the target worktree.
Write acceptance does not depend on the later Review stage; final success needs both.

The release must demonstrate these cases through the real controller interface:

| Scenario | Required result |
|---|---|
| Custom executor and built-in GitHub executor | Same lifecycle interface; install a new custom executor without rebuilding the controller; record bounded results and actual implementation identity |
| Crash after external write but before result | Reconcile remote outcome; do not blindly repeat the write |
| Executor exceeds scope, hangs, or returns stale output | Enforce scope, stop independently, reject stale results, and retain evidence for recovery |
| Correct file | Both stages accepted from observed evidence |
| Missing newline or unrelated edit | Repair output; unchanged validation catches the defect, and a job that edits outside its write scope fails |
| Review requests changes | Known graph reentry or supervisor recovery; fresh downstream review |
| Unknown launch failure with no plugin handler | Supervisor repairs invocation and returns without duplicate Write |
| Plugin process crashes or hangs | Controller remains responsive; bounded recovery or concrete stopped state |
| Faulty validator rejects correct bytes | Reproduce, patch, test invalid cases, independently review, activate, rerun gates, complete same run |
| Permissive replacement always passes | Negative tests/review reject activation; no acceptance bypass |
| Opaque gate with no readable requirement or repair authority | Stop with evidence; no invented replacement criterion |
| Replace Write validator while Review is active | Activation moves cursor back to Write, cancels dependent work, and requires fresh Write and Review receipts |
| Restart during activation | Exactly one active version and no duplicate reservation/effect |
| Stale evidence, altered candidate, or old-version reply | Reject; affected receipts cannot establish completion |
| Patch adds, deletes, renames, or reorders a step | Reject activation even if tests and patch review pass; preserve the pinned step list |
| Job or route names an undeclared step | Reject admission; supporting repair jobs cannot become hidden graph steps |
| Retry/reentry and plugin repair within existing steps | Allow under qualification and budget rules; step identities and order remain identical |
| Changed requirement or incompatible schema in patch | Reject compatibility; preserve old run |
| Repeated failures | Stop at shared limits, including across resume |

Also test scoped permissions, source-checkout preservation, independent reviewer
identity, missing worktrees, and missing immutable artifacts. Qualify a second
user-authored plugin without changes to the controller; the
[release example](../examples/plugins/release/README.md) is that plugin. Scripted runners establish
repeatable behavior; one real-backend hello run verifies actual agent integration.
These are release requirements, not claims of tests already run.

## 12. Implementation plan

1. **M1 — TypeScript SDK and isolated plugin host.** Establish public value/wire
   contracts, runtime validation, package/build identity, process lifecycle,
   deterministic graph callbacks, and hello source bundle. Test real child load,
   malformed protocols, crash/timeout containment, and a second external plugin.
2. **M2 — Durable hello execution.** Implement task intake, isolated worktree,
   artifact channels, required validation, controller-owned receipts, and complete
   Write → Review with scripted agents. Test restart, freshness, stop/resume, and
   source preservation through the same public controller interface.
3. **M3 — Pi supervisor recovery.** Implement the selected Pi session adapter,
   configured-provider switching, actual model-request accounting, automatic
   fallback, direct recovery admission, scoped overrides, reentry, and Return.
   Recover an unfamiliar failure without a plugin handler; preserve session,
   active model, modes, and reservations across restart. Qualify DeepSeek, MiniMax,
   and OpenAI switching as specified in the [Pi design](design-pi-supervisor.md).
   After `QualifyRepair` admission, enable Pi coding tools scoped to the candidate
   tree so the supervisor writes source repairs in-session.
4. **M4 — Qualified plugin repair and local release.** Add isolated snapshot /
   build/test/independent review/activation, same-run version transitions,
   validator substitution policy, and affected-evidence invalidation—with the
   supervisor Pi session as the patch author. Pass the defective-gate scenario,
   activation crash scenarios, opaque-plugin stop case, and a real-backend hello run.

The executor extension design is an additional implementation slice alongside the
existing milestones: establish the common executor lifecycle and a user-authored
executor, provide independently packaged GitHub support, then qualify supervisor
recovery and replacement through that same interface. These are design commitments,
not implemented capabilities or additional graph steps. See the
[delivery and checks](design-executors.md#delivery-and-checks).

Agent-host delivery is a separate H1–H4 sequence in the
[host plan](design-agent-host.md#delivery-and-acceptance). It reuses these modules
and does not replace outstanding standalone qualification.

Proposed package seams are npm workspaces under `packages/`: `sdk` (value/wire
contracts), `controller` (durable state and admission), `plugin-host` (process
adapter), `supervisor` (session and recovery protocol), and `runner` (jobs and
enforced scopes). `apps/graphloom` is the CLI composition root; graph authors
depend on `@graphloom/sdk`, not controller internals. Keep validation scheduling
and receipt admission independent of normal graph routing.

Earlier Go sources are frozen under `legacy/go` for selective porting. Do not
extend that tree for new MVP features. Switch the CLI to full run/inspect/stop/
resume only after parity for supported behavior is demonstrated. No native
plugin implementation or arbitrary Go-run state migration is required by this plan.

## 13. Relationship to Loopx

Loopx provides evidence for typed recovery outcomes, agent-driven control-plane
source repair, and regression checks that retain legitimate blocking. It does not
establish arbitrary automatic validator replacement in a running graph. GraphLoom's
source bundle contract, independent repair qualification, and same-run activation
are design decisions here. See the [source findings](research/loopx-gate-defect-handling.md)
and [issue-fix study](research/loopx-issue-fix-example.md).

## 14. Prepare cache

A prepare command (never a check) may declare `inputs` and `outputs`, together,
as repository-relative globs (`**`, `*`, `?`; a leading `!` excludes). Preparation
commands are processed strictly in declaration order. For each cacheable one the
controller reads the declared input files in the checkout as they stand at that
point (earlier commands have run or been restored) and keys the command by the
digest of their paths and contents, its argv and its declared globs. On a hit the outputs are copied into the
checkout, the command does not run, and the evidence carries `restored from
cache <key>`. On a miss the command runs; after the whole preparation succeeds,
its outputs are saved under that key. A failed preparation caches nothing (and entries saved by a
preparation that then left tracked files changed are dropped). A command without
both declarations always runs. So does one whose inputs match no file or include
a symbolic link, because a link's target content cannot be hashed without
crossing the no-follow boundary; the evidence records that bypass and why.

The cache is `prepare-cache/` in the run's state directory, so it is removed with
the run and is never writable by a job. Saving and restoring use lstat and
`O_NOFOLLOW`, never enter a symbolic link, accept only regular files and
relative symbolic links that stay inside the checkout, verify each stored file's
SHA-256 before restoring, and copy rather than link. An entry that fails
verification is a miss. Each command keeps its four newest entries. The plugin
owns correctness of the declaration: an input it omits can leave stale output
restored, so it lists everything the command reads.

Every environment check and preparation command sees `$GRAPHLOOM_PLUGIN_ROOT`
(`PLUGIN_ROOT_ENV` in the SDK): the absolute path of the graph bundle's root,
the directory that holds `graphloom.manifest.json`. This holds in the worktree
preflight, in every checkout, and under `graphloom check`. The controller passes
it in the command executor's `env` input and reads nothing about the bundle to
do so. Commands run in the worktree, so this is how a check finds what the
bundle ships, such as a tool from the bundle's own dependencies. The variable
is not part of a prepare command's cache key.

## 15. Opening a recorded agent session

Status: `session list`, `session open`, conversation capture, the launcher
and its probe are implemented (pr-review P1 wave 3c); `JobSpec.forkFrom` and
the fork by a job are not (P4). Differences from the text are under
[Implementation notes](#implementation-notes-wave-3c-session). Revised
2026-10-29: the conversation is recorded, a repeated open continues it, and a
graph job may fork it.

An operator sometimes wants to talk to the agent that did a job, for
example to ask the answerer why it settled a question that way, and wants
what was said there to count: a later job of the run may start from it.
`graphloom session open` finds the recorded session, restores and forks it,
starts the real agent CLI on the fork in the operator's terminal, and, when
the agent exits, records the fork's transcript in the run as an **operator
conversation**. The recorded session itself never changes. The command is
plugin-neutral: it reads only the run's generic session records (stage id,
operation id, executor, session ref, origin, parent) and never knows a
plugin's role names.

```text
graphloom session list <run-id> [--json]
graphloom session open <run-id> [--stage <stageId> [--from-original] | <session>]
```

**List.** One row per `agentSessions` record
([timeout continuation](#job-wall-clock-and-timeout-continuation)): stage id
and attempt, operation id, dispatch key, executor and harness, session ref,
status, when its last turn settled, the operation it continued, and whether
it can be opened (`ok`, `running`, `pi: no interactive restore`, `wiped`,
`transcript omitted`). Operator conversations are rows too, with origin
`operator`, their stage, their parent's session ref (the job session or the
earlier conversation they forked), and when they started and ended, so a
chain reads conversation → conversation → job session. `<session>` names a
row by its session ref (`claude-<uuid>`, `codex-<uuid>`), its operation id,
or a conversation's record id.

**Open.** It selects the session to fork:

- With `--stage`, the stage's latest operator conversation by `endedAt`, so
  a second open continues the first conversation (a chained fork). With no
  conversation yet, or with `--from-original`, the stage's **job session**:
  the stage's latest attempt that recorded a session, the dispatch key that
  attempt dispatched first, and that key's latest session by `settledAt`. In
  a stage where an author's job is followed by a checker's, that is the
  author, corrections included. `--from-original` starts a new chain beside
  the old one, which stays recorded.
- With `<session>`, that row: any job session (a checker's, for example) or
  any conversation.
- With neither, the run's latest session.

Every open makes a new fork; nothing is resumed in place. Two opens at once
fork the same parent and are recorded as siblings; the later `endedAt` is
the stage's latest. Then:

1. **Refusals.** It refuses, naming the reason, when:
   - the session's harness is Pi (`pi-…`): Pi has no interactive restore, so
     the message points at the transcript in the run's state instead;
   - the executor is not the coding agent (a scripted harness, a custom
     executor);
   - the job that owns the session is still running: its operation, or any
     outstanding operation whose `continueFrom` or `forkFrom` lineage
     includes it, has not settled;
   - the run has succeeded or failed: the saved copies were removed then
     (`wipeAgentSessions`), so the row lists as `wiped`;
   - the saved copy is missing or corrupt, as a resume refuses it
     (`openClaudeSession`, `openCodexThread`);
   - the conversation's transcript was not stored because it exceeded the
     bound (below); the message names `--from-original`.
2. **Harness.** The session's own harness opens it, never another: a
   `claude-` ref only in Claude Code, a `codex-` ref only in Codex. There is
   no harness option. The ref's prefix, the record's harness and the saved
   metadata's shape must agree, or it refuses. opencode is not involved.
3. **Restore and fork.** The saved copy in the run's session directory is
   GraphLoom's evidence and is only read. The transcript is restored into the
   agent's own store (the same config dir or Codex home the executor used,
   so the operator's own login), then forked, so the operator's turns land in
   a new session and the recorded one never changes:
   - **Claude Code:** write the transcript and its side files into
     `<configDir>/projects/<project>/` as `openClaudeSession` does, then run
     `claude --resume <uuid> --fork-session --session-id <new uuid>`
     interactively. GraphLoom picks the fork's id before launch.
   - **Codex:** copy the rollout to `sessions/<today>/rollout-<time>-<new
     thread>.jsonl` under the Codex home, with the thread id in its
     `session_meta` record replaced by a fresh one, then run
     `codex resume <new thread>` interactively. The recorded thread's own
     rollout is never written.

   Either command may be prefixed by the operator's session launcher
   (below).
4. **Hand over the terminal.** The agent inherits stdin, stdout, stderr and
   the controlling TTY. GraphLoom prints the fork's id and waits. Without a
   TTY on stdin it refuses.
5. **Capture.** When the agent exits, whatever its exit code, GraphLoom
   reads the fork's transcript from the agent's store by the id it chose
   before launch (Claude Code's `<new uuid>.jsonl` and side directory under
   the project directory, Codex's copied rollout), never from the agent's
   or a launcher's output. If no transcript exists under that id, for
   example because a launcher dropped `--session-id` or pointed the agent at
   another store, nothing is recorded and the message says why; GraphLoom
   never guesses at another session. A fork with no operator turn is
   discarded and nothing is recorded. Otherwise it
   takes the run lock, only now and only for the write, and:
   - copies the transcript into the run's session directory
     (`agent-sessions/operator/<fork ref>`). Like a job's saved copy, it is
     self-contained: it holds the parent's turns, so a later fork needs only
     it;
   - adds an `AgentSessionRecord` with `origin: "operator"`, the stage, the
     harness and confinement of the session it forked, and `parent`;
   - records `operator-conversation` evidence: stage, base session ref (the
     parent), root job session ref, fork session ref, harness, `startedAt`,
     `endedAt`, the transcript's SHA-256 and size, its context estimate
     (below), and the **turn extract**.

   The parent's saved copy is left byte-identical. If the run finished while
   the agent ran, the capture records nothing and says so; the fork stays in
   the agent's own store. GraphLoom then exits with the agent's exit code.

**Session launcher.** Some operators start Claude Code or Codex through a
local wrapper of their own (for example `hapi claude …`, `hapi codex …`).
That is operator configuration, never code. The runner config gains, per
harness:

| Key | Meaning |
|---|---|
| `claude.sessionLauncher`, `codex.sessionLauncher` | An argv prefix, such as `["hapi", "claude"]`, that replaces the agent command for `session open` only. GraphLoom appends its own arguments: `hapi claude --resume <uuid> --fork-session --session-id <new uuid> --append-system-prompt "<note>"` |
| `claude.sessionLauncherStateDirs`, `codex.sessionLauncherStateDirs` | Directories the launcher keeps its own state in (for example `~/.hapi`), made writable inside the session's confinement as `ownState` is |

`GRAPHLOOM_CLAUDE_SESSION_LAUNCHER` and `GRAPHLOOM_CODEX_SESSION_LAUNCHER`
override the launcher for one invocation, split into words as a shell would
split them (quotes honored, no expansion); the state directories still come
from the config. The keys are per harness because a launcher wraps one CLI,
and its state is that launcher's. The existing runner-config parser, which
refuses unknown keys, gains them: a launcher must be a non-empty array of
non-empty strings, and a state directory an absolute or `~/` path. Headless
graph jobs never use a launcher: they keep `claude.command` and
`codex.command`, since their stream-json over pipes must not pass through a
wrapper.

Inside the confinement, the launcher's first word is resolved on `PATH` to
an absolute real path; that file and its directory are bound read-only, and
its state directories writable. The agent's config dir or Codex home, and
`passEnv`, are those of the harness, so the agent the launcher starts uses
the store GraphLoom restored into. Network is already on for an opened
session, so a launcher may talk to a local hub.

**Launcher probe.** A wrapper may not pass GraphLoom's arguments through.
Checked against the operator's `hapi`: `hapi claude --help` prints Claude
Code's own help, so it passes options through; `hapi codex --help` fails
with "Unsupported shared Codex launch flag: --help", so it may not accept
`resume <thread>` either. Before launching, `session open` probes the
configured launcher, with no model call and no session: for Claude Code,
`<launcher> --help` must succeed and list `--resume`, `--fork-session`,
`--session-id` and `--append-system-prompt`; for Codex, `<launcher> resume
--help` must succeed and describe `resume`. A failed probe refuses the open,
naming the launcher, the probe and its output, and suggests removing the
launcher setting (plain `claude` or `codex`) or using the launcher's own
resume outside GraphLoom. It never falls back to a fresh session or to
another one. `graphloom doctor` runs the same probes and warns with the same
message.

**Turn extract.** A harness-neutral list of the conversation's own turns,
built deterministically from the transcript: each operator message verbatim,
and the agent's final text answer of each turn (Claude Code: the last
assistant text before the next user message; Codex: the turn's last agent
message). Tool calls and results are left out. It is at most 256 KiB:
operator messages are kept whole up to 128 KiB in total, each agent answer
is cut to 4 KiB, and past the limit the oldest agent answers go first, then
the oldest operator messages, each cut marked. Plugins read the extract as
run evidence, as they read `operator-approval`; it holds no ref or path.

**Bound.** A conversation's stored transcript is at most 32 MiB
(`maxConversationBytes` in the runner config). Beyond it, the transcript is
not copied: the evidence records `transcript: omitted (<size>)`, and keeps
its digest and the turn extract. Such a conversation cannot be forked, by a
later open or by a job; a plugin that wanted it falls back to its own
seeding from the extract.

**Context estimate.** Each session record carries `contextTokens`: the
input context of the transcript's last model call, from its own usage
records (Claude Code: `input_tokens` plus cache reads and cache writes of
the last assistant message; Codex: the last `token_count` event), or its
byte size divided by four when there is none. It is generic data, listed in
`RunView.agentSessions`; a plugin compares it with its own bound.

**Forking by a job.** `JobSpec.forkFrom: <session id>` is the fork form of
`continueFrom`
([continuing an agent session](design-executors.md#continuing-an-agent-session)).
The id is an operation id (a job session) or an operator conversation's
record id. The controller admits it only for a coding-agent job whose
harness equals the session's, for a settled session with a stored
transcript, and never together with `continueFrom`. Unlike `continueFrom`,
it may cross stages and dispatch keys, and one session may be forked any
number of times. Anything else is `continuation rejected`, with the reason
(a `claude-` session cannot start a Codex job). The executor restores the
saved copy into the new job's own session directory under a fresh id
(`claude -p --resume <uuid> --fork-session`; for Codex, the rollout copied
under a new thread id, then `codex exec resume`), so the parent stays
byte-identical, and the job's session is recorded with `forkedFrom`. The
assignment starts with the continuation notice, and scopes, tools,
credentials, confinement and budget come only from the new dispatch.

**Opening note.** One line of status, built from generic run data, for
example: "This is a fork of the answers session; since it ended: the
answer checker's job settled ok (32 supported, 2 partial), run status
stopped (report ready)." The "since it ended" part is the one-line result
summary of each operation the stage settled after the session's own, and
the run's status and stop reason. Claude Code gets it as
`--append-system-prompt`, which adds no turn; Codex, which has no such flag
for an interactive resume, gets it as the first user turn
(`codex resume <thread> <note>`), which the turn extract skips. No skill is
involved: a skill inside one harness cannot hand the terminal to another
harness's session.

**Confinement.** The session runs in the run's worktree under the same
confinement kind its job used, taken from the record: each
`AgentSessionRecord` gains `harness` and the job's `confinement`, copied at
admission, and a conversation inherits its parent's. The worktree is always
mounted read-only, also for a writer job's session: the chat is not a graph
job, and an edit there would be an external edit that invalidates evidence
([§9](#9-worktree-communication-and-durable-state)). The run's state
directory is not mounted; the GraphLoom process captures the transcript
after the agent has exited, never the agent. The agent's own login state
stays writable, since the fork is written there. A confinement that cannot
be built (no bubblewrap, a non-Linux host) refuses the open; nothing runs
unconfined. bwrap runs without `--new-session` so the agent keeps the
terminal; on a kernel that still allows `TIOCSTI`
(`dev.tty.legacy_tiocsti` = 1) the open refuses, because a confined process
could otherwise push keystrokes into the operator's shell.

**Untrusted content.** A session whose job read untrusted content (its
confinement masks the workspace's agent configuration) still holds that
content in its transcript, and the operator's chat continues from it. A
prompt injection in that content can steer the opened agent as it could the
job. While the chat runs, the confinement is the defence: the agent holds
no credential beyond its own login and cannot write the worktree or the run
state. Once recorded, the operator's messages are trusted operator input,
but the agent's answers in the same transcript are not, since they may have
been steered. A job that forks a conversation gets it as a continued
transcript, context and not authority, and the plugin keeps its own
independent checks.

**Lock and budgets.** `session open` holds no run lock while the agent
runs, so the run may advance meanwhile; a job dispatched before the capture
does not see the conversation. Chat turns run on the operator's own login
and are not charged to the run's budgets. A job that forks a conversation
is charged like any job, its inherited context included. The fork also
stays in the agent's own store, where `claude --resume` or `codex resume`
reopens it outside GraphLoom; turns added there are not recorded. When the
run finishes, `wipeAgentSessions` removes the conversations' transcripts
with the jobs'; their evidence, extract included, stays in run state.

**Verification.** Opening and capturing leave the parent's saved transcript
(and Claude Code's side files, and Codex's rollout) byte-identical, and so
does a job's `forkFrom`. A second `--stage` open forks the first
conversation (its parent is that conversation, and the agent sees the first
chat's turns); `--from-original` forks the job session; `session list`
shows each conversation with its parent. A fork with no operator turn
records nothing; one over the bound records `transcript: omitted` and is
refused as a fork source; a capture after the run finished records nothing.
The turn extract of fixture transcripts (Claude Code and Codex) keeps the
operator messages verbatim and drops tool output, and its cut order holds
at the limit. `forkFrom` is refused across harnesses, together with
`continueFrom`, and for an omitted or wiped transcript, and admitted across
stages and dispatch keys. Pi sessions, non-agent executors, a ref whose
prefix disagrees with its record, a finished run, and a session whose job
(or a continuation or fork of it) still runs are refused. `--stage` picks
the stage's first-dispatched key, not a later checker. The opened session's
confinement matches its job's kind with the worktree read-only (a write
fails with `EROFS`), a masked file absent and no token in its environment.
A stub launcher prefix is applied to `session open` only, and a headless
job with the same config runs `claude.command` unchanged; the environment
override replaces the configured launcher; the launcher's state directories
are writable inside the confinement and the rest of the home is not; a
launcher whose probe fails (a stub that rejects `resume`, like `hapi
codex`) is refused before anything launches, and `doctor` warns; capture
through a stub launcher finds the fork by the id GraphLoom chose, and a
stub that drops `--session-id` records nothing. Fake `claude` and `codex`
binaries record their argv, environment and TTY and write scripted turns; a real-CLI check of `--fork-session`,
`--append-system-prompt` with `--resume`, `codex resume <thread> <prompt>`
on a copied rollout, and the non-interactive forks a job uses runs opt-in,
as the
[harness assumptions](design-supervisor-harnesses.md#11-unverified-cli-assumptions)
are checked.

### Implementation notes (wave 3c, session)

- **The opening note reaches Claude Code twice.** Checked against Claude Code
  2.1.300 (live, [harness assumptions](design-supervisor-harnesses.md#11-unverified-cli-assumptions)
  5, 7 and 8): `--resume <id> --fork-session --session-id <new>` works as
  specified, interactive and with `-p`, and `--append-system-prompt` is
  accepted on a resume but does **not** reach the model (asked for its note's
  marker word, the fork answered NONE). `session open` therefore passes the
  note as `--append-system-prompt` (it applies if a later Claude Code honors
  it) and also as the positional first prompt, so it becomes the first turn,
  as for Codex. Either way the note starts with `[GraphLoom opening note]`,
  which the turn extract and the "did the operator say anything" test skip.
- **Records.** `AgentSessionRecord` gains `harness` (from the session ref's
  prefix), `confinement` (the job's, copied at admission), `summary` (one line
  of the job's result, for the note), and for a conversation `origin:
  "operator"`, `parent` (the parent record's `operationId`), `startedAt`,
  `endedAt`, `transcript` (`sha256`, `bytes`, `omitted`) and `contextTokens`. A
  conversation's `operationId` is its record id (`conv-<hex>`) and its
  `dispatchKey` is `operator`, so a plugin's lookup of a job's session by
  dispatch key never meets one. `RunView.agentSessions` carries `harness`,
  `origin`, `parent` and `contextTokens`.
- **Capture only into a stopped run.** The capture takes the run lock and
  writes `state.json`; a controller that is running holds its own copy and
  would overwrite the write, so a run that is running (or owned by a live
  controller) records nothing and says so; the fork stays in the agent's own
  store. A run that finished records nothing either. A run stopped at `report
  ready` is the intended case.
- **Confinement.** The opened session runs through the runner's own
  `confineWorker` (bubblewrap, no `--new-session`): root read-only, the home
  an empty tmpfs with only the checkout, the agent, the launcher and its
  directory read-only, the agent's config dir or Codex home and the launcher's
  state directories writable, network on, the job's masks and read-only
  binds (binds that no longer exist are skipped), and the environment the
  harness's executor gives plus `passEnv`, with the runner config's GitHub
  token variable and the usual token names removed. A job that had no
  confinement of its own opens under the run's read-only scope without
  hiding the home; a docker confinement refuses. `~/.claude.json` lives in the
  hidden home, as for a job.
- **Codex.** `codex resume` gets `--sandbox danger-full-access` when its
  `resume --help` lists `--sandbox` (bubblewrap is the confinement). Not
  checked against a real Codex in this wave (assumptions 6 and 7 for Codex
  remain unverified); the stand-in tests cover the copied rollout.
- **Turn extract and context.** As designed; the extract is
  `[{ operator, answer?, operatorCut?, answerCut? }]`. `contextTokens` is
  computed for conversations (stored on the record); a job session's is not
  stored in this wave.
- **`session` is not dispatched** to the installed version that owns a run
  (the way `resume` is); it reads the run's state directly.
- **Not built:** `JobSpec.forkFrom` and the executor's fork (P4).

## 16. Preparing a task: `graphloom task new`

Status: implemented (pr-review P1 wave 3c); differences from the text are
under [Implementation notes](#implementation-notes-wave-3c-task-new).

Some graphs need a task that is tedious and error-prone to write by hand: a
ref fetched from a forge, a commit pinned by hash, a merge base, a request
that names them. `graphloom task new` prepares it. The plugin decides what
its arguments mean and returns a **task plan**: a short list of generic
steps, as data. The CLI validates the plan, executes it in the task
repository, and writes `task.yaml`. The CLI, the SDK and the controller never
learn what the arguments name (a pull request, an issue, a release); that
stays in the plugin, following the controller-plugin boundary.

```text
graphloom task new <graph> <args…> [--repo <dir>] [--profile <name|path>]
                   [--out <dir>] [--dry-run] [--force]
```

| Option | Meaning |
|---|---|
| `<graph>` | The graph id. The bundle is `plugins/<graph>/` in `--out`, the resolution `run` applies beside a task file ([§2](#2-task-and-operator-experience)), with the same path-traversal refusal |
| `<args…>` | Passed to the plugin verbatim. Words after `--` are never read as CLI flags. The CLI does not interpret them |
| `--repo <dir>` | The task repository (default `.`). Its top level is used, as intake does |
| `--profile <name\|path>` | The task's config. A value containing `/` or ending in `.json` is a path from the current directory; otherwise a name, looked up as `profiles/<name>.json` in `--out`, then in the bundle. Required when the manifest declares `taskConfig: "required"` |
| `--out <dir>` | The operator's workspace (default `.`): where the bundle is found and under which the task is written |
| `--dry-run` | Print the validated plan and the task it would write, with `${name}` references unresolved. No step runs and nothing is written; the CLI only reads the remotes and `HEAD` for the hook's input |
| `--force` | Replace an existing task file at the plan's path. Without it, an existing file is refused before any step runs |

**The hook.** The CLI loads the bundle in the plugin host, an isolated child
process as for every other callback, and calls `prepareTask`. A bundle
without it is refused: "graph `<id>` does not prepare tasks; write task.yaml
by hand". The input is data the CLI read, bounded like every protocol value:

```ts
interface PrepareTaskInput {
  args: string[];          // the words after <graph>, verbatim
  repo: {
    remotes: Array<{ name: string; url: string }>; // fetch URLs, as `git remote -v`
    head: string;          // HEAD's commit
  };
  profile?: unknown;       // the parsed JSON of --profile, unread by the CLI
  options: { dryRun: boolean };
}

type TaskPlanRefusal = { refused: string };     // usage or input error, printed as is

interface TaskPlan {
  summary: string;         // one line for the operator, at most 200 characters
  steps: TaskPlanStep[];   // at most 16, executed in order
}

type TaskPlanStep =
  | { kind: "fetch"; remote: string; refspec: string; intoRef: string }
  | { kind: "resolve"; name: string; revParse: string }
  | { kind: "resolve"; name: string; mergeBase: [string, string] }
  | { kind: "updateRef"; from: string; to: string }
  | { kind: "writeTask"; path: string; fields: Record<string, string> };
```

The hook reads no file, runs no process and has no network, as `advance`.
A thrown error, a timeout or a malformed reply is reported with the plugin's
message, and nothing runs.

**Validation.** `validateTaskPlan(plan, graphId)` in `@graphloom/sdk` checks
the reply's shape at run time and refuses the whole plan, naming the step
and the rule, before any step runs. No step kind runs a command; an unknown
`kind` or an extra property is refused.

- **Names.** A `resolve` binds `name` (`[A-Za-z][A-Za-z0-9]{0,31}`, unique in
  the plan). `${name}` may appear in `from`, `to`, `revParse`, the
  `mergeBase` operands and field values, only after the step that binds it.
  An unbound or malformed reference is refused; there is no other expansion.
  A bound value is always a full object id.
- **Refs.** `intoRef` and `to` must lie under `refs/graphloom/<graph>/`, the
  graph's own namespace, and pass `git check-ref-format`, after
  substitution. `refspec` is one source ref starting with `refs/` that passes
  `check-ref-format`, with no `:`, `+`, `*`, `^`, `~`, `@{` or `..`, so the
  plan cannot write outside its namespace or name a pattern. `revParse`, the
  two `mergeBase` operands and `from` are each a ref under the graph's
  namespace or a `${name}`.
- **Remotes.** `remote` is a remote configured in the repository whose fetch
  URL is `https://`, or an `https://` URL without user information. Other
  transports (`file`, `ssh`, `ext`, a local path) are refused.
- **Task.** Exactly one `writeTask`, the last step. `path` is relative, ends
  in `task.yaml`, and resolves under `--out` with no `..` segment; a
  directory on the way may not be a symlink that leaves `--out`. Field keys
  are task fields other than `graph`, `repo` and `config`, which the CLI
  writes itself. Values are strings of at most 4 KiB with no NUL. The
  composed task must parse with intake's own task parser (`parseTaskYaml`),
  so a field intake does not know is refused here, not at `run`.
- **Bounds.** At most 16 steps, 8 names and 64 KiB of plan JSON.

**Execution.** The CLI executes the steps in order with fixed argv, never a
shell, and prints one line per step with its result. Every git command runs
with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_TERMINAL_PROMPT=0` and `-c core.hooksPath=/dev/null`, so no hook
(`reference-transaction` included), user filter or credential helper runs,
and no repository code runs at all.

| Step | Command |
|---|---|
| `fetch` | `git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always -c gc.auto=0 -c maintenance.auto=false fetch --no-tags --no-recurse-submodules --no-write-fetch-head -- <remote> +<refspec>:<intoRef>`. The ref is created or moved; nothing is checked out, and no branch, index or working tree changes |
| `resolve` | `git rev-parse --verify --end-of-options <ref>^{commit}`, or `git merge-base --all -- <a> <b>`, which must print exactly one commit. The full object id is bound to `name` |
| `updateRef` | `git update-ref --no-deref <to> <oid of from> <zero oid>`: create only. An existing `to` at the same commit is left as is; at another commit the step fails ("pinned ref moved") |
| `writeTask` | Writes `graph`, `repo` (relative from the task's directory), `config` (relative, when a profile is given), then the fields with `${name}` substituted, to a temporary sibling renamed into place. When the task's directory is not `--out`, a relative symlink `plugins/<graph>` beside it points at the bundle the CLI loaded, so `run` pins the same bundle; an existing one at another real path is refused without `--force` |

A failed step stops the plan: the line names the step and git's message, no
task is written, and refs already written stay in the graph's namespace,
where a repeated `task new` updates them. On success the CLI prints the
summary, the task's path, and the next command (`graphloom check <path>`).
Exit codes: 0 written (or printed, with `--dry-run`), 1 a step failed, 2 a
usage error, a refusal or an invalid plan.

**Adoption.** A graph implements the hook when its task needs such
preparation. The [PR-review graph](design-pr-review-graph.md#31-task) is the
first. issue-fix may adopt it later (for example `graphloom task new
issue-fix owner/repo#N`); that is not part of this design. The
[`graphloom-run` skill](design-agent-skills.md#1-skills) uses `task new` for
a graph whose bundle implements it. That skill change lands with the
command, since the drift test requires every command and flag a skill names
to be in `graphloom --help`.

**Verification.**

- `validateTaskPlan` unit tests: a step of unknown kind (`{ kind: "run",
  argv }`) and an extra property are refused; `intoRef` and `to` outside
  `refs/graphloom/<graph>/` (another graph's namespace, `refs/heads/main`,
  a `..` segment, also after substitution) are refused; so are a refspec
  with `:`, `+` or `*`, an unbound or forward `${name}`, a duplicate name, a
  second or non-final `writeTask`, an absolute or escaping `path`, a
  `graph` or `repo` field, and a `file://`, `ssh://` or credentialed URL;
  each bound holds.
- Real-Git CLI tests in a temporary repository fetching from a local
  smart-HTTP fixture: a `fetch` runs no hook (a `reference-transaction` and a
  `post-checkout` hook in the repository that would write a marker file
  leave none) and ignores the global config (`HOME` pointing at a config
  with a hook path); the working tree, index and `HEAD` are unchanged after
  the plan; `resolve` binds the right ids and refuses a criss-cross history
  with two merge bases; `updateRef` creates, accepts the same value, and
  fails on a moved ref.
- `--dry-run` runs only the read-only input commands (a stub `git` on
  `PATH` records the argv), creates no ref and writes no file. An existing
  `task.yaml` is refused without `--force` before any step runs, and
  replaced with it. A failing step writes no task. The written task passes
  `graphloom check`, and `run` pins the bundle through the `plugins/<graph>`
  link.
- A bundle without `prepareTask`, a hook that throws, times out or returns
  a malformed plan, and a `{ refused }` reply each exit 2 with the message
  and run nothing.

### Implementation notes (wave 3c, task new)

- **Paths the task names from outside its directory are links.** Intake
  refuses `..` in `repo` and `config`, so a task written under `--out` that
  names a clone or a profile elsewhere cannot hold `repo: ../../clone`. The
  CLI instead puts a relative symbolic link beside the task (`repo`,
  `profile.json`, and `plugins/<graph>` as designed) and writes `repo: repo`
  and `config: profile.json`; a path already inside the task's directory is
  written as it is. A link already in place for the same target is left, any
  other file there is replaced only with `--force`, and every conflict is
  refused before a step runs.
- **Fields.** A plan may set only `request` and `base`; the composed task is
  parsed back by `parseTaskYaml` and must read as written (a request holding a
  quote, a backslash or a newline is written as a block scalar).
- **Remote check.** A `remote` that is a name must be configured in the
  repository with an `https://` fetch URL without user information; a URL
  must be the same. Every Git command also runs with `credential.helper=`,
  `core.sshCommand=/bin/false`, `core.fsmonitor=false` and the ambient
  `GIT_*` variables removed. The CLI asks Git itself (`check-ref-format`)
  after substitution as well.
- **`--dry-run`** reads the remotes and `HEAD` and prints the plan and the
  task with references unresolved; it writes no ref, link or file.
- Plugin arguments are every token that is not one of the CLI's five flags
  (`--repo`, `--profile`, `--out`, `--dry-run`, `--force`, each also as
  `--flag=value`), or follows `--`; so `--base main` and `--review` reach
  pr-review untouched.
