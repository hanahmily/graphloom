# GraphLoom: TypeScript graphs and repairable execution

Status: current design direction, revised 2026-09-24; implementation partial.
This document supersedes the native Go plugin design in [core-design.md](core-design.md)
and its [Go package plan](codebase.md). Active TypeScript packages implement parts
of this design; the Pi session adapter exists, while full recovery wiring,
executor extensions, and the full repair lifecycle remain pending.
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
| Supervisor | One logical session per run; drive the graph to successful completion under failure—investigate, reenter, repair, and exhaust authorized remedies before stopping |
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
The example is **Write → Review**, producing a local file change. It includes bounded recovery and one tested plugin-repair transition.
No RSI, cross-run memory, portal, distributed scheduler, or automatic publication
is part of this release. Multiple roles do not require parallel execution.

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
```

These are target interfaces. Relative paths resolve from the task file. `hello`
selects an operator-installed bundle at `plugins/hello/` beside that file. Reject
path traversal. Installation and dependency preparation are separate from run
startup; there is no automatic registry download on a run's execution path.

Intake pins the task, repository HEAD, graph definition, plugin bundle, runtime
profile, grants, and finite budgets. Additional graph-specific options wait for
a concrete need. The operator installation policy records whether local source
repair or validator substitution is authorized, avoiding repeated approval for
repairs already within that scope. Plugin metadata alone grants no authority.

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

Plugins, validators, builders, workers, and reviewers run outside the controller
process. A plugin crash or hang becomes an observed child failure; the controller
can terminate the process and ask the supervisor to investigate. Start a fresh
process for every replacement version. Node provides subprocesses and IPC through
[`node:child_process`](https://nodejs.org/api/child_process.html).

Process separation contains ordinary crashes; it is not a malicious-code sandbox.
The Linux runner must enforce filesystem, process, credential, and network scopes
for jobs. Plugin callbacks and validators get only immutable bundle files and
explicit evidence, not controller state or a writable target repository. When the
supervisor is admitted to repair source, its Pi session receives a **separate
writable candidate tree** (never the user worktree or live install). Node's `vm`
is not a security mechanism; do not use it as the isolation claim.
[Node VM documentation](https://nodejs.org/api/vm.html).

## 4. Public interface and process protocol

The SDK is a small public package. The following is an interface sketch; referenced
value types and wire schemas must be defined and tested during implementation:

```ts
export interface GraphPlugin {
  describe(): GraphDefinition;
  advance(view: RunView): GraphDecision;
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

The run has one logical supervisor session, created lazily, continued across
recovery episodes, and restored from durable context if its provider session is
lost. All supervisor diagnosis, **source repair coding**, repair coordination, and
activation requests for that run use this session. The supervisor writes qualified
plugin/validator patches **itself** through the Pi SDK against an admitted candidate
tree (see §7). Worker agents and the **independent patch reviewer** use separate
roles/sessions; the reviewer must not be the same agent that authored the patch.
No supervisor round trip is required on the happy path.

### Pi SDK session implementation

Use the pinned `@earendil-works/pi-coding-agent@0.87.1` for the supervisor runtime.
The initial model is `minimax-cn/MiniMax-M3`, using a private command reference to
the existing OpenCode MiniMax CN credential. SDK connectivity and project type
checks have passed; supervisor recovery and cross-provider switching remain to be
implemented. See the [verified MiniMax setup](design-pi-supervisor.md#initial-minimax-configuration).

Model changes among configured DeepSeek, MiniMax, OpenAI, and Anthropic providers preserve one
logical run-wide supervisor session. The controller owns model-switch admission,
actual-request accounting, recovery decisions, and the fixed plugin steps.

The [Pi integration design](design-pi-supervisor.md) defines explicit tools,
resource isolation, session restoration, model-switch journaling, and required
verification. Direct Pi Claude access uses API credentials; it must not promise
included Claude Code subscription allowance. A genuine Claude Code backend would
be a separate integration, not a Pi model setting. See the
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
through its Pi session against admitted candidate trees. Prefer another
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

The run supervisor's **Pi SDK session writes the repair** into an isolated candidate
copy; an **independent read-only reviewer** (separate session/role) evaluates it.
There is no second non-Pi “repair agent” that owns coding—the supervisor codes via
Pi. The original bundle and failure evidence remain immutable. Repair source lives
outside the target repository, so it cannot accidentally enter the user's
deliverable diff.

**Snapshot base for every qualification.** `QualifyRepair` always starts from an
immutable snapshot of a specific plugin version (normally the run's active pinned
bundle: source, lockfile, build inputs, and digests). The controller materializes
that snapshot into an isolated candidate tree **before** the supervisor's Pi session
is granted write tools scoped to that tree. Concurrent or overlapping repair
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
   candidate tree before editing. Admit Pi coding tools for the supervisor session
   **only** against that candidate cwd. A patch cannot change the repair policy that
   admits it. Only one activation may proceed at a time under the run lock; other
   in-flight candidates remain durable artifacts until activated, rejected, or
   superseded.
2. **Reproduce.** Add a focused regression case showing the defect in the original
   implementation. Include valid and invalid cases derived from the requirement.
   For an exact-byte gate, include missing newline, wrong content, and extra files.
3. **Patch (supervisor via Pi).** The same logical supervisor Pi session patches
   the isolated plugin candidate with Pi's full coding toolset, shell included,
   rooted at the candidate; it may build and test there, but step 4 is the
   controller's own check. Preserve the readable requirement,
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
   that wrote the patch**.
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
snapshots outputs after the child finishes. Workers can write only their assigned
worktree/output scope; reviewers and validators have read-only candidate access.
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

Reserve before effects. One repair candidate and its first trial use one correction
reservation; a revised patch or repeated failed trial requires another. Diagnostic
steps, independent review, and activation also consume applicable job/invocation/
decision limits, without counting the same correction twice. Reentry, activation,
mode changes, session replacement, and resume never reset counters. Exhaustion
preserves the run with attempted remedies, evidence, and an exact remaining blocker.
Until those limits or hard blockers apply, the supervisor treats unfinished required
stages as work still owed. Broad repair authority does not guarantee success for
every task or plugin.

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
| Missing newline or unrelated edit | Repair output; unchanged validation catches the defect |
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
user-authored plugin without changes to the controller. Scripted runners establish
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
