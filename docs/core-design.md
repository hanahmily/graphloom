# GraphLoom core: executable graph plugins

> Superseded by the [TypeScript design](design-typescript-core.md). The content below
> records the earlier native Go direction and is retained for historical context.

Status: revised design, 2026-09-22. The repository contains a partial Go
implementation of the earlier file-described model. Native plugin loading and the
public interface below are proposed, not implemented.

This revision replaces graph YAML and supervisor-authored normal execution with
user-authored Go graph plugins. Task configuration, isolated worktrees, durable
observations, and bounded correction remain part of the minimal release.

## 1. Three core modules

1. **Graph:** an executable harness supplied as a native Go `.so` plugin. It owns
   domain-specific agent tasks, validation, normal routes, and known corrections.
2. **Supervisor:** one logical agent session per run that owns exceptional recovery
   routing. Its decisions go directly to controller admission, without plugin veto.
3. **Controller:** the host that loads the graph, executes admitted operations,
   records evidence, and enforces lifecycle, permissions, and finite limits.

The graph advancer remains a pure internal helper for dependency readiness,
receipt freshness, stage ordering, and reentry invalidation. It is not the domain
harness: that behavior lives in the plugin.

The first release targets Linux on one host, one active job per run, and one
agent backend. Different roles use separate worker/reviewer sessions. The required
example is `write → review`, ending in a verified local file change. Automatic
publication, a portal, distributed scheduling, and parallel jobs are later work.

## 2. What changes in ownership

| Concern | Graph plugin | Supervisor | Controller |
|---|---|---|---|
| Happy path and required outcomes | Declares in Go | Reads | Pins and enforces order |
| Normal worker prompts and input/output contracts | Constructs | Can revise execution instructions during recovery while preserving required evidence contracts | Supplies inputs and launches |
| Deterministic validation | Implements predicates or requests checks | Diagnoses failures | Collects observations and executes commands |
| Semantic judgment | Requests an agent task and interprets its typed result | Handles escalated ambiguity | Records the actual result |
| Normal routes and known corrections | Chooses in code | Takes over when requested or when progress stalls | Applies transitions and detects repeated lack of progress |
| Reentry | Selects targets for known corrections during normal execution | Selects targets during recovery | Admits and atomically applies either route |
| Unfamiliar failure | Supplies domain context and optional suggestions | Investigates and directs repair within run authority | Starts recovery and executes admitted jobs without requiring a plugin handler |
| Acceptance | Evaluates domain evidence and requests acceptance | Cannot directly mark a stage accepted | Checks provenance/freshness and issues receipts |
| Worktrees, budgets, ownership, stop/resume | Requests operations within policy | Cannot override | Owns and enforces |

A plugin can deliberately ask an LLM to classify an issue and then route on its
structured observations, as Loopx does. Graph code supplies the harness around
that judgment. There is no requirement to encode every semantic question as a
Go conditional, and there is no domain-specific route table in the shared host.

No mandatory LLM plan-review job precedes every run. The graph author supplies
the validation policy as tested code. A graph may request independent semantic
review where its domain needs it; the hello graph includes Review as a required
stage. This supersedes the earlier supervisor-generated acceptance plan.

## 3. Task selection and plugin discovery

The operator still runs a task file:

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

These are proposed interfaces; the current partial implementation is not a native
plugin runner. Relative paths resolve from the task file. A simple graph ID
`hello` resolves to the operator-installed `plugins/hello.so` and its generated
build manifest in the task directory. Path traversal and arbitrary graph paths
are rejected. The MVP needs no remote registry or automatic download.

There is no `graphs/hello.yaml` to interpret. Stage definitions, prompts, result
schemas, checks, and routes are Go code or resources embedded in the plugin.
The happy path belongs to the plugin's definition; tasks select a graph instead
of implementing one. Additional graph-specific task options can wait until a real
second graph needs them.

Intake resolves the local repository and pins the task, graph definition, plugin
binary digest, build identity, and project limits. The plugin validates whether
the task fits its supported domain. An incompatible request stops with a reason;
the hello plugin must not silently solve some other task as a greeting exercise.

## 4. Public plugin interface

External plugin authors import a small public package:
`github.com/hanahmily/graphloom/loom`. They cannot depend on host `internal/`
packages. This public seam is now justified by independent plugin modules.

The proposed interface has two methods:

```go
type Graph interface {
    Describe() Definition
    Advance(View) (Decision, error)
}
```

- `Describe` returns the graph ID, graph version, protocol and private-state schema
  versions, ordered required stages, required check/review IDs, and requested
  capabilities. The controller freezes that definition at intake. Requested
  capabilities do not grant permission. This declaration does not define a
  supervisor repair allowlist; operator-authorized host capabilities govern recovery.
- `Advance` receives a detached view of current run facts and returns one typed
  decision plus the next private graph state. For identical inputs it must return
  an equivalent result. It does not spawn processes, call a model, mutate files,
  read clocks, or keep authoritative state in globals.

The controller passes task inputs, accepted stage receipts, observed job results,
artifact metadata or bounded requested content, outstanding jobs, recovery history
and active execution overrides, remaining limits, and a versioned private-state
blob in `View`. Canonical stage, attempt, receipts, and observations are authoritative;
the plugin must reconcile its private state with them after recovery. Private state
cannot veto a controller-admitted reentry or act as a second stage cursor.
The controller binds each call to a generation and expected state revision and
assigns stable decision/operation IDs. A repeated decision returns its prior
settlement; stale results cannot mutate newer state. Private state is bounded
serialized data; it cannot contain live clients,
goroutines, closures, or file descriptors.

`Decision` contains exactly one action, a concise reason, evidence references,
and the proposed next private state. The controller commits admitted graph state
and operation intent together. If admission fails, neither advances; a rejection
observation is fed back to the graph under the same limits.

| Action | Meaning |
|---|---|
| `Dispatch` | Run an agent task or bounded command with declared inputs and scope |
| `Observe` | Read specified files/artifacts or produce a workspace change manifest |
| `Accept` | Submit a domain verdict for the current stage with its required evidence |
| `Reenter` | Revisit a required stage and invalidate affected downstream receipts |
| `Supervise` | Yield to the run supervisor with evidence and optional repair suggestions |
| `Stop` | Preserve the run and explain what prevents further progress |

Completion is computed from valid required stage receipts, not a plugin-returned
terminal boolean. Supporting operations use the same small action vocabulary.
Supervisor recovery uses the shared execution actions under controller admission;
its protocol and return of control are defined in section 6. It does not return
plugin private state or call `Advance` to get permission for each repair.

### Export and load

Each plugin is a Go `main` package exporting exactly this entry function:

```go
// Package main in the user's plugin module.
func NewGraph() (loom.Graph, error) {
    return &HelloGraph{}, nil
}
```

The controller calls `plugin.Open` on the pinned artifact, looks up `NewGraph`,
checks its concrete function type, creates an instance, and validates `Describe`.
The Go SDK types must be identical in the host and plugin. A protocol version
field supplements those checks; it cannot make incompatible Go binaries load.

`NewGraph` and `Describe` must be side-effect-free by author contract. The same
applies to package initialization. These contracts are tested conventions for
trusted native extensions, not an OS sandbox around plugin code.

## 5. Concrete hello graph

The plugin declares required stages `write` and `review`, a content/scope check
for Write, and an independent reviewer verdict for Review. Its implementation
follows this sequence:

```text
Go: validate task compatibility
  → Go: construct a writer task
  → Agent: create GREETING.txt
  → Controller: collect file bytes and workspace change manifest
  → Go: check exact bytes and that only GREETING.txt changed
  → Controller: accept Write against current evidence
  → Go: construct an independent reviewer task
  → Agent: approve or request changes with evidence
  → Go: interpret the review for the exact same workspace revision
  → Controller: accept Review and finish
```

The central check is ordinary Go logic in the plugin, conceptually:

```go
contentOK := bytes.Equal(observedContent, []byte("Hello, GraphLoom!\n"))
scopeOK := len(changedPaths) == 1 && changedPaths[0] == "GREETING.txt"
```

The controller supplies the observed bytes and complete change manifest; the
worker's report is not used as a substitute for either. The predicate result is
bound to its check ID, pinned plugin digest, and observation references. A generic
controller records that qualified verdict without containing greeting-specific
code. A different plugin can run tests through a command job instead.

If the writer omits the newline, Go detects the defect and can dispatch one
corrected Write attempt with the failed check details. If the reviewer requests
changes, Go routes back to Write with the review report. The plugin escalates
unrecognized or repeated failures through `Supervise`. Both coded corrections and
supervisor-assisted corrections consume the same run allowance.

The reviewer is read-only on the worktree and writes its report into a separate
output directory. Write acceptance uses the deterministic check and does not
depend on the later Review stage. Both receipts are needed for final success.

The retained file-described examples document the prior design only. The new
[plugin example](../examples/plugins/hello/README.md) specifies the implementation
contract for this sequence.

## 6. Supervisor recovery authority

**Plugins own normal routing; supervisors own exceptional recovery routing;
controllers enforce and apply both.** A plugin defines required outcomes and their
evidence contracts. It need not anticipate every failure or implement a handler
for every repair. Plugin repair suggestions are context, not a capability allowlist.

There is one logical supervisor session per run, created lazily and continued for
later recovery episodes. It receives pinned task requirements, stage/check
contracts, observed errors, job specifications, artifacts, prior corrections,
remaining budgets, and the host's available authorized capabilities. Happy-path
worker calls do not require a supervisor round trip.

### Entering recovery

The controller starts recovery when the plugin returns `Supervise`, when a normal
operation has an unhandled failure, or when normal execution cannot progress. The
host supplies the fallback even for a plugin with no recovery branches:

- Launch failures, timeouts, and missing/malformed agent results enter recovery
  after the controller has reconciled the child outcome.
- A well-formed negative domain result can use a known plugin correction. After
  two consecutive failed correction trials for the same unresolved stage, the
  controller transfers control to the supervisor before dispatching another.
  Correction decisions identify the source trial and unmet check/result contract;
  the host counts these generic reservations and outcomes without interpreting
  domain-specific error strings. Successful acceptance of the repaired evidence
  resets this failed-trial streak.
- An `Advance` error, invalid decision, or plugin-requested failure stop enters
  recovery. Repeated decisions that neither schedule new work nor advance current
  evidence also trigger recovery after two occurrences. Operation IDs alone do
  not count as progress. Successful current evidence or stage acceptance resets
  this local repetition count; global budgets never reset.

Operator cancellation and exhausted global limits produce a resumable stopped
run. A denied optional action returns a rejection so the supervisor can choose
an authorized alternative. A required effect with no authorized alternative stops
with a reason; recovery cannot grant itself permission.
An unsupported task or contradictory required outcome can be explained by the
supervisor, but changing the pinned request requires operator input and a new run
in the MVP. Failure to load a valid plugin definition stops intake. Native crashes
and hangs have the separate limitation described below.

### Executing recovery

The controller durably records an execution mode (`normal` or `recovery`), episode
ID, initiating evidence, and decision revision. Exactly one decision source is
active: the plugin in normal mode, the supervisor in recovery mode. The controller
quiesces or reconciles any outstanding child before admitting replacement work;
late results and stale decisions cannot advance either mode.

Supervisor decisions go directly to controller admission. They can:

- `Observe` files, artifacts, logs, and workspace state.
- `Dispatch` diagnostic or work jobs within admitted scopes.
- Write qualified plugin/validator repairs **via the supervisor's Pi session**
  against an isolated candidate tree (`QualifyRepair` → patch → review →
  `ActivateRepair`).
- Retry a failed job with corrected instructions or available launch/model settings.
- `Reenter` a declared current or earlier stage with a repair explanation.
- `Return` control to normal graph execution, or `Stop` with an unresolved blocker.

Retry is a `Dispatch` referencing its source job and correction reservation. It
preserves the required result schema, input provenance, and authorized write scope.
A repair that revisits an already accepted stage must first reenter that stage;
subsequent validation and review require fresh evidence. Independent reviewers
retain their read-only role and cannot become the writers they review.
Execution overrides contain the changed prompt or launch settings, target
stage/job, reason, and evidence. The controller validates and persists them before
use. They apply to the named repair trial and are consumed or explicitly cleared;
they cannot silently change later stages. Installed models under the configured
backend and permitted commands are available without a plugin-specific handler.
Unavailable capabilities yield observations; they do not grant new permissions.

Diagnostics and repair results return to the same supervisor session. Admission
rejections do too, with a reason and remaining limits. A supervisor decision
cannot issue `Accept`, weaken pinned checks, remove required stages, rewrite a
result schema to manufacture success, mutate plugin private state, or expand user
authorization. The controller enforces structural and authority rules; it cannot
prove every prompt semantically preserves intent. Original requirements remain in
repair inputs, and unchanged checks and independent review still gate acceptance.

### Returning to the happy path

`Return` is a supervisor-only control action, admitted when no child or ambiguous
operation remains outstanding. It records the repair summary, new observations,
execution overrides, and current stage/attempt, then atomically changes mode to
normal. It does not accept a stage or advance the required-stage cursor. Both modes
and all episode/correction reservations survive stop/resume.

The next `Advance` receives these canonical facts and reconciles its private state.
It must evaluate relevant fresh repair results before dispatching another normal
job; a repaired result that satisfies the original job contract must not be
ignored merely because the supervisor dispatched it. Required validation still
runs, and only ordinary evidence-backed acceptance resumes the happy path. If the
plugin again cannot progress, the controller returns the resulting observation to
the same supervisor session under the remaining shared limits. A no-op `Return`
cycle spends decision/invocation limits and is not successful recovery.

For example, an incompatible writer launch enters recovery automatically. The
supervisor chooses a supported configuration and retries Write through the host.
After a valid result, it returns control; the plugin checks exact bytes and scope
and continues to Review. No provider-error branch or repair handler is needed in
the hello plugin.

### What recovery cannot guarantee

The supervisor can repair execution around a functioning plugin; it cannot replace
native code or redefine success. A broken native predicate, irreconcilable private
state, or contradictory pinned requirement may still prevent acceptance. A plugin
defect needing changed code requires a rebuilt bundle and a new run in the MVP;
live replacement and state migration remain outside scope.

Native `.so` code runs in the controller process. A panic or hang may prevent the
supervisor from running at all. Reliable automatic recovery from native crashes
requires process isolation, which is outside the minimal release. Broad recovery
authority improves failure handling but is not a promise that every graph can
always finish.

## 7. Controller, evidence, and communication

The controller serially asks the active decision source (plugin or supervisor)
for the next action, admits it, records intent, executes the operation, and feeds
back a durable observation. It owns the only canonical run state. No agent or
plugin callback receives a mutable store handle or a runner handle through the
public interface.

This narrows accidental coupling; native plugin code is still trusted code in the
host process. It can technically import OS libraries and bypass its interface.
The controller's permission enforcement protects agent jobs and correct plugin
use; it is not a containment guarantee against a malicious installed `.so`.

### Agent and data channels

The plugin or recovery supervisor constructs an agent task with a versioned result
schema; recovery preserves required evidence contracts. The controller
injects run ID, node ID, generation, actual workspace revision, resolved input
artifact references, output path, and execution limits. Agent prompts cannot
override this identity or scope.

Agents return one `result.json` in their private output directory. Logs use
stdout/stderr separately. The shared envelope contains identity, input revision,
`status` (`completed`, `blocked`, or `failed`), summary, declared outputs, and
evidence references. A graph-specific payload carries fields such as the review
verdict. The plugin validates that payload and interprets its meaning.

The controller rejects missing/malformed envelopes, stale identities, unknown
input references, escaping output paths, symlinks, and oversized artifacts. After
the child stops, it snapshots outputs and hashes them. Agents exchange those
explicit artifacts and the admitted worktree revision through the controller;
direct agent-to-agent chat is not required.

### Check and receipt rules

Command exits, bounded file reads, and workspace manifests are controller-owned
observations. Native predicates are trusted plugin judgments over those
observations; reviewer verdicts are agent judgments. Their provenance is recorded
separately. A passing native predicate is only as correct as the installed plugin;
the controller cannot prove arbitrary domain logic semantically sound.

For `Accept`, the controller checks the current stage, predecessor receipts,
declared required check IDs, observation provenance, scope, plugin identity, and
freshness. It rechecks applicable workspace fingerprints before accepting or
finishing. Content changes invalidate dependent checks and reviews. Reports stored
outside the worktree do not change its fingerprint.

Required checks are pinned in the plugin definition. A plugin cannot omit a
declared check through its typed decision, and a worker cannot mint a receipt.
There is no universal requirement that every stage has both a command check and
an agent review: the hello plugin requires its content/scope predicate for Write
and its independent verdict for Review. The generic host enforces that declaration.

### Execution graph and reentry

Required stages remain ordered. Executed jobs and observations form an append-only
attempt graph with dependencies on prior observations and required receipts.
Dependencies on observations may refer to failed jobs, enabling diagnostics.
Successful stage prerequisites are separate receipt references.

**The plugin selects known reentry routes in normal mode; the supervisor selects
recovery routes. The controller owns application of both.**
Workers and reviewers report results or conflicts through their typed artifacts.
They cannot change the current stage, issue receipts, or directly trigger reentry.

There are two paths to the same `Reenter` decision:

1. **Known condition:** `Advance` interprets an observed result and selects the
   target in Go. For example, Review returning `request_changes` selects Write
   with the review report. No supervisor call is required.
2. **Ambiguous failure:** the plugin yields or the controller starts recovery.
   The supervisor selects a target and remedy and submits `Reenter` directly to
   controller admission. The plugin need not recognize or approve this repair.

An illustrative supervisor decision payload is:

```json
{
  "action": "reenter",
  "stage": "write",
  "reason": "The implementation contradicts the pinned request.",
  "evidence_refs": ["artifact:review-2"]
}
```

The controller binds this payload to the active recovery episode, owner,
generation, and expected state revision. It becomes a transition only after
admission. A rejection returns to the supervisor, without plugin veto or partially
applied state. Normal-mode plugin decisions use the same admission rules.

For an emitted `Reenter`, the controller checks:

- The decision belongs to the current owner, generation, and expected state
  revision; cited evidence exists and is applicable to the current attempt.
- The target is a declared required stage at or before the current stage.
  Reentry cannot skip required stages or rewrite their checks.
- No child remains active or has an unresolved outcome. Cancellation and reaping
  must finish before reentry can be admitted.
- A corrective attempt is available under the run's persistent limits.

Under the run lock, one durable transition reserves that corrective attempt,
commits the decision source's state (plugin private state only for a plugin
decision, episode state for a supervisor decision), moves the active stage to the
target, invalidates its receipt and all downstream receipts, and cancels dependent
pending work. It also invalidates checks and reviews that depend on the superseded
attempt. The transition records the reason, evidence, and stable operation ID.
An admission failure leaves these changes unapplied and feeds a rejection back to
the active decision source; applicable rejection counters still advance.

The active decision source dispatches the repair using the reserved attempt.
Reentry and that repair's first trial count as one corrective attempt; another failed trial
requires another reservation. A duplicate decision returns its recorded outcome
without a second reservation or invalidation. Stop/resume preserves the reservation
and counters.

Retries append new nodes; they never reset or replay historical jobs. Reentry
preserves prior artifacts and history, while requiring fresh acceptance for the
target and downstream stages. It does not reset the worktree or discard operator
changes. The graph stays acyclic because new nodes only depend on existing nodes.

## 8. Worktree, durability, and limits

Intake pins the supplied local repository's `HEAD`, creates branch
`graphloom/<run-id>`, and creates an isolated worktree at that commit. Dirty source
files, its index, and its current branch remain unchanged; uncommitted changes
are not copied. Git registrations and the new branch are shared metadata managed
only by the controller under a per-repository lock.

Writer jobs can write the run worktree and their own outputs. Reviewers, native
observation requests, and check jobs receive read-only source access and separate
scratch/output directories. The host runner must enforce those scopes and exclude
controller state and shared Git metadata. The MVP grants no external publication
effects to jobs. The result remains a local worktree diff without automatic
commit, push, or merge.

One private `state.json` records pinned inputs, plugin identity/private state,
graph nodes, receipts, operation intents, reservations, decision-source mode,
recovery episodes, execution overrides, and supervisor continuity.
Transitions use a cross-process run lock and synced atomic replacement. Artifact
files are immutable and referenced by digest. Missing referenced data stops
progress; unreferenced crash remnants do not become evidence.

Persist worktree creation and dispatch intent before effects. On recovery,
reconcile existing Git registrations and child-process outcomes instead of
blindly replaying. Resume uses the same retained worktree and exact plugin bundle.
Missing or mismatched inputs stop the run; they are never silently recreated.
Unexpected external edits stop dispatch for assessment and invalidate affected
evidence; a coded repair must not silently discard operator changes.

Stop uses an atomic request inbox. The controller fences the old generation,
cancels/reaps the active child, and records a resumable stopped state. Late results
cannot advance it. Run status is `active`, `stopped`, or `succeeded`; stopping an
active operation is visible during cancellation. Worktrees are retained.

| Limit | Initial default |
|---|---:|
| Agent invocations, including supervisor | 64 per run |
| Executed jobs and observation requests | 128 per run |
| Admitted or rejected decisions from either source, including mode changes | 512 per run |
| Corrective attempts, coded or supervised | 8 per run |
| Individual job/agent invocation duration | 20 minutes |
| Active run execution time | 4 hours |

Reserve before dispatch. Invalid outputs and rejected decisions spend applicable
allowance. Correction begins with retry/reentry after unmet evidence; one repair
and its trial form an attempt. Repeating failed trials spends further attempts.
Global decision/job/time limits also prevent inspection or replanning loops.
Resume, mode changes, and session replacement preserve all counters. The eight
corrective attempts are shared by plugin and supervisor; entering recovery does
not create a fresh allowance. Exhaustion stops the run with evidence, attempted
remedies, and the remaining blocker.

`Advance` is a short, terminating pure callback by plugin contract. An in-process
Go plugin cannot be forcibly cancelled safely if it hangs, and a native crash can
terminate the host. Panic handling can record some failures but is not crash
containment. An operator can terminate a stuck host; restart must reconcile its
journal and bounded child jobs. Automatic retries of crashing plugins are excluded.

## 9. Native Go build and loading contract

A native Go plugin is built with `go build -buildmode=plugin`; loading executes
new package initializers, and loaded plugins cannot be unloaded. The host and
plugin need matching toolchain versions, relevant build flags/tags, and identical
sources for shared dependencies. Platform support is limited; GraphLoom initially
targets Linux. Go also documents limitations in plugin race detection.
[Official Go plugin documentation](https://pkg.go.dev/plugin).

Accordingly, GraphLoom must ship a reproducible host build profile. Plugin authors
build against that exact SDK source and profile, not merely a compatible-looking
semantic version. The profile records the Go toolchain, OS/architecture, relevant
environment/build settings, and dependency identities. CI builds the host and
sample plugin together and performs an actual load test.

A generated sidecar records graph ID/version, SDK/state schema, build profile ID,
and binary digest. The loader verifies compatibility metadata and the digest
before loading, then validates the exported function and definition. The sidecar
is diagnostic compatibility metadata, not authentication or a replacement for
the Go loader's own compatibility checks.

Copy verified plugin bytes and their manifest into the private run directory;
verify the copied bytes again and load that immutable copy so a changing source
path cannot substitute another binary between verification and execution. Resume pins both plugin and compatible host build identity. Installing
a new plugin version affects new runs only. One controller process owns a run;
inspect/stop read state without loading native extensions.

Illustrative build sequence once the SDK and sample implementation exist:

```sh
# Use the release's exact build profile for both commands.
go build -o bin/graphloom ./cmd/graphloom
go build -buildmode=plugin -o examples/plugins/hello.so ./examples/plugins/hello
```

A future packaging command can generate the sidecar from actual build information.
Its schema and compatibility checks must exist before the runnable milestone;
users should not hand-write claims that a mismatched binary is compatible.

## 10. Implementation sequence and release gate

1. **Public seam and loader:** add `loom` types, native export/load validation,
   pinned build manifests, and a separately compiled hello plugin. Test the real
   `.so` load path plus a malformed plugin in disposable host processes.
2. **Deterministic graph execution:** call `Advance` from the controller; execute
   writer, observed content/scope check, and independent review. Keep generic
   readiness and receipt rules in `internal/graph`.
3. **Supervisor recovery:** retain the run-wide session and add durable normal /
   recovery modes, controller-triggered fallback, direct supervisor admission,
   scoped overrides, and canonical-state reconciliation on Return. Verify an
   unfamiliar launch failure recovers with no plugin repair handler, known
   correction loops transfer to the supervisor, and both routes share limits.
   Test reentry, rejected future targets, forbidden acceptance/check weakening,
   stale/duplicate decisions, receipt invalidation, and mode/override/reservation
   preservation across stop/resume. A repaired job must resume normal checks and
   Review without a duplicate Write or plugin-specific approval.
4. **Runnable local CLI:** complete isolated worktree setup, artifact handoffs,
   stop/resume, build-compatible replay, and a real-backend hello run.

The release gate is `graphloom run task.yaml` loading `hello.so`, completing Write
and Review with actual evidence, and preserving the original checkout. A missing
newline, unrelated edit, review rejection, and unexpected agent failure must take
the intended coded or supervised correction path without weakening the check.

Also test plugin identity/type/build mismatches, private-state restart, stale
receipts, duplicate dispatch recovery, plugin panic, budget exhaustion, output
path escape, and missing worktrees. Domain logic tests import the implementation
as ordinary Go code and test the public interface; subprocess integration tests
exercise native loading. A second independently built plugin must work without
editing the controller, demonstrating that the extension seam is real.

See [codebase design](codebase.md) for package ownership and migration from the
current partial implementation. The prior research remains historical context;
it does not override this native plugin design.
