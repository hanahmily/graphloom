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
proposed in the [supervisor harnesses design](design-supervisor-harnesses.md).
The example is **Write → Review**, producing a local file change. It includes bounded recovery and one tested plugin-repair transition.
No RSI, cross-run memory, portal, distributed scheduler, or automatic publication
is part of this release. Multiple roles do not require parallel execution.

### Execution modes

The existing **standalone** mode uses the GraphLoom CLI as driver and Pi as the
supervisor backend (proposed: Pi, Claude Code, or Codex; see
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
graphloom run task.yaml
graphloom inspect <run-id>
graphloom stop <run-id>
graphloom resume <run-id>
graphloom delete <run-id> [--force]
```

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

Intake pins the task, repository HEAD, graph definition, plugin bundle, runtime
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

Superseded as the only backend by the proposed
[supervisor harnesses design](design-supervisor-harnesses.md): a harness-neutral
supervisor host drives Pi, Claude Code, or Codex behind the same `Supervisor`
port. The plugin declares its preferred harness in `GraphDefinition.supervisor`;
the operator's `supervisor.json` enables harnesses and may override or forbid
them; the run pins one harness, changed only by `resume --supervisor`. The Pi
details below remain the Pi harness specification.

Use the pinned `@earendil-works/pi-coding-agent@0.87.1` for the supervisor runtime.
The initial model is `minimax-cn/MiniMax-M3`, using a private command reference to
the existing OpenCode MiniMax CN credential. SDK connectivity and project type
checks have passed. Recovery and model switching are implemented with faux-provider
verification; live recovery/provider qualification remains outstanding. See the
[verified MiniMax setup](design-pi-supervisor.md#initial-minimax-configuration).

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
Arbitrary state migration is deferred.
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
(`stopMark`); a run that stopped before stop marks existed has none and is
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
