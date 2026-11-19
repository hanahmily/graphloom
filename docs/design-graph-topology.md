# Graph topology: nodes, edges and supervisor-only nodes

Status: designed, 2026-11-19; §13 pull requests 1 to 3 implemented (the SDK
types, the traversal engine, supervisor-only nodes). Extends the
[TypeScript core design](design-typescript-core.md) §1, §4, §5, §6 and §8, and
keeps the [run convergence](design-run-convergence.md) rules (identity-anchored
receipts, `openAttempt`, correction escalation). The first graph to declare
edges is issue-fix 0.17.0, whose Fix⇄Review loop becomes two edges and which
gains a supervisor-only node,
[Arbitrate](design-issue-fix-graph.md#arbitrate-designed-for-0170).

GraphLoom was designed to traverse a graph. Today it walks an ordered list of
stages. This document replaces the list walk with one traversal engine: a graph
declares nodes and directed edges, a definition without edges is normalized to
a chain and runs on the same engine, and a node may be one only the supervisor
enters. Existing plugins keep their behaviour without a change.

## 1. Decisions

1. A graph declares **nodes** (the SDK's `StageDefinition`: id, name,
   requirements, validators, receipts, unchanged) and **directed edges** between
   them. Cycles are allowed. The node set and the edge set are fixed for a run,
   as the step list is today: the core rule "complete step set, identities,
   names, order, and required outcomes are fixed for a run" becomes "nodes,
   edges, identities, names and required outcomes are fixed for a run".
2. **One engine.** A definition without `edges` is normalized at intake to an
   implicit chain (§3.3) and runs on the same engine as a declared topology. The
   controller's list-specific code paths are removed.
3. The controller tracks the **live path**: the walk from the start node to the
   furthest node reached, with every closed cycle erased. Admission of a node
   requires accepted receipts on every node before it on the live path.
4. The run moves forward along declared edges by acting for a node ahead of the
   path; it moves back along a declared edge with `reenter`. Each reentry spends
   one `corrections`, so cycles stay finite. There is no `route` operation: a
   forward move happens on the first dispatch or validation that names the node.
5. A run completes when the live path ends at a terminal node and every node on
   it is accepted.
6. A node may be **supervisor-only**: no edge enters it, the graph can never
   reach it, only the supervisor enters it (`enter`) and only the supervisor
   leaves it, along one of its declared out-edges. The controller learns only
   "entry to this node is the supervisor's"; nothing about what the node does.
   Completion never requires it. Its receipts are evidence other nodes'
   validators read.

## 2. Today: an ordered stage list

| Behaviour | Where | Rule today |
|---|---|---|
| Definition | `packages/sdk/src/types.ts:47-56` | `GraphDefinition.stages` is an ordered array of `{ id, name, requirementIds }`; there are no edges |
| Definition check | `packages/sdk/src/validate.ts:225-249` | Checks each stage's shape; unknown top-level fields are ignored |
| Start | `packages/controller/src/loop.ts:3526-3538` | The run starts at `stages[0]` |
| Moving | `packages/controller/src/loop.ts:2700` | A dispatch sets `current` to the job's stage, whichever declared stage it names; `undeclaredStage` (`loop.ts:3276-3282`) refuses only an undeclared id |
| Admission | `packages/controller/src/admit.ts:270-281` | Validating a stage needs valid receipts for every stage earlier in the list |
| Re-validation | `packages/controller/src/admit.ts:216` (`earliestIncompleteStage`) | Validation of any stage other than the first incomplete one is refused before a validator runs (`not the next incomplete stage`), so a stage whose requirements all hold valid receipts is never validated again: no receipt is minted, and the caller still clears the stage's open attempt (`loop.ts:3269-3274`) |
| Reentry | `packages/controller/src/loop.ts:2344-2374` | Any declared stage; spends one `corrections`, sets `openAttempt`, opens the next attempt and bumps the generation. Invalidation is identity-aware (`admit.ts:451`), not positional. The "current or earlier" rule of core §6 is prose; the code does not check direction |
| Completion | `packages/controller/src/loop.ts:2462-2491` | `stop` with reason `complete` succeeds when every listed stage has valid receipts for all its requirements, and `deliveryDrift` (`admit.ts:133-142`) finds the last listed stage's receipts still describe the workspace |
| Receipt replacement | `packages/controller/src/admit.ts:385-391` | A new receipt for a stage requirement invalidates the earlier valid one |
| Resume | `packages/controller/src/controller.ts:1091-1129`, `1137` | Walks the list; the first stage whose accepted evidence drifted or no longer passes is invalidated with every later one (`invalidateStageAndAfter`, `admit.ts:420-437`) and becomes current |
| Repair activation | `packages/controller/src/repair-lifecycle.ts:709-712` | Invalidates from `stages[0]` onward and sets `current` to `stages[0]`, attempt 1 |
| Structural match | `controller.ts:1585-1600`, `repair-lifecycle.ts:886-905`, `repair.ts:245-280`, `repair-lifecycle.ts:862-880` | `describe()` and the candidate's `graphloom.stages.json` pin must have the same `stages` JSON |
| Operator views | `controller.ts:1483-1497`, `apps/graphloom/src/progress.ts:292-317`, `apps/graphloom/src/stats.ts:131`, `apps/graphloom/src/rehearsal.ts:718-735` | `complete` per stage, "k/n stages complete", per-stage stats; `rehearse --stop-at` takes the next stage as `stages[index + 1]` |
| Supervisor | `packages/supervisor/src/tools.ts:24-33`, `118-122` | Actions `dispatch`, `observe`, `validate`, `reenter`, `qualify_repair`, `activate_repair`, `return`, `stop` |

What the shipped plugins rely on, which the engine must keep:

| Reliance | Where |
|---|---|
| The graph reenters an earlier stage although the list declares no way back: hello Review → Write, release Review → Changelog, issue-fix Review → Fix (after a failed review and after failed final checks) | `examples/plugins/hello/src/graph.ts:325`, `release/src/graph.ts:212`, `issue-fix/src/graph.ts:732`, `810` |
| Stage selection is "the first listed stage that is incomplete or open", so after a reentry of an early stage the graph may next act for a stage several places ahead whose receipts are still valid | `issue-fix/src/graph.ts:332-338`, `pr-review/src/graph.ts:312`, `pr-design-review/src/graph.ts:307` |
| `view.current` is read: the review kit notes each stage's attempt from it, and issue-fix keys its private state on `current.attempt` | `review-kit/src/attempt.ts:39`, `issue-fix/src/graph.ts:1395-1403` |
| No shipped plugin reenters a stage ahead of the one it is in | the four `reenter` calls above |

## 3. The definition

### 3.1 Nodes and edges

```ts
export interface StageDefinition {
  id: StageId;
  name: string;
  requirementIds: RequirementId[];
  /** Who may enter this node: the graph along declared edges (default), or only the supervisor. */
  entry?: "graph" | "supervisor";
  /** Most visits of this node in a run. Required for a supervisor-only node; 1 to 64. */
  maxVisits?: number;
}

export interface EdgeDefinition {
  from: StageId;
  to: StageId;
}

export interface GraphDefinition {
  // … unchanged fields …
  stages: StageDefinition[];   // the node set
  /** Directed edges. Absent: the implicit chain of §3.3. */
  edges?: EdgeDefinition[];
  /** The node a run starts at. Default: the first graph-entered node in `stages`. */
  start?: StageId;
  /** Nodes a run may complete at. Default: every graph-entered node with no out-edge. */
  terminal?: StageId[];
}
```

The SDK keeps the name `StageDefinition` and every `stageId` field; a node is a
stage. Prose in this document says node.

issue-fix 0.17.0 declares:

```ts
stages: [
  { id: "fix", name: "Fix", requirementIds: fixRequirements },
  { id: "review", name: "Review", requirementIds: reviewRequirements },
  { id: "arbitrate", name: "Arbitrate", requirementIds: ["design-ruling"], entry: "supervisor", maxVisits: 6 },
],
edges: [
  { from: "fix", to: "review" },
  { from: "review", to: "fix" },
  { from: "arbitrate", to: "fix" },
  { from: "arbitrate", to: "review" },
],
start: "fix",
terminal: ["review"],
```

### 3.2 Definition rules

`assertGraphDefinition` refuses a definition, naming the first problem, when:

- `start`, `terminal`, an `entry` of `supervisor` or a `maxVisits` appears
  without `edges` (they need a declared topology);
- an edge names an undeclared node, repeats another edge, or is a self-loop (a
  retry of a node is a reentry of it, always allowed, §4.4);
- `start` is undeclared or supervisor-only; a `terminal` entry is undeclared or
  supervisor-only; `terminal` is empty after defaults;
- an edge enters a supervisor-only node;
- a supervisor-only node has no out-edge, has an out-edge to another
  supervisor-only node, has no requirements, or has no `maxVisits`;
  `maxVisits` is not an integer from 1 to 64;
- a graph-entered node is not reachable from `start` along edges between
  graph-entered nodes, or cannot reach a terminal node along them;
- there are more than 64 nodes or 256 edges.

Each requirement belongs to at most one node; a requirement named by two nodes
is refused once edges are declared (a receipt names one node).

### 3.3 Definitions without edges: the implicit chain

A definition without `edges` is normalized, at intake and on every `describe()`
check, by one pure SDK function (`normalizeTopology`) to:

- forward edges `stages[i] → stages[i+1]`;
- back edges `stages[i] → stages[j]` for every `j < i`;
- start `stages[0]`, terminal the last stage, every node graph-entered.

The back edges are what today's graphs use when they reenter an earlier stage
(§2); with them, the single reentry rule of §4.4 admits exactly the reentries
the shipped plugins make. The pinned definition stays the bytes `describe()`
returned; the normalized topology is a function of it, so the structural match
(§7.3) compares what the plugin declared.

On an implicit chain the engine gives today's results:

| Today | On the engine |
|---|---|
| Validation needs every earlier listed stage | The live path is always a prefix of the list (forward edges go one step), so "every node before N on the live path" is "every earlier stage" |
| Completion needs every listed stage | The path ends at the last stage only when it holds every stage; a `complete` stop first carries accepted later stages onto the path (§4.6) |
| Delivery drift reads the last listed stage | It reads the path's last node, the terminal |
| The graph reenters any earlier stage | Every earlier node has a back edge |
| `current` follows every dispatch | Unchanged (§4.1) |
| A dispatch for a stage ahead, after a reentry, when the stages between are accepted | A forward move across accepted nodes (§4.3) |

Two cases differ, and no shipped plugin reaches either:

- a reentry of a stage ahead of the live path's end, which today's code admits
  and its prose forbids, is refused (§4.4);
- on resume, a drifted receipt of a node off the live path is invalidated by
  identity as before but no longer moves `current` to that node (§7.1).

No plugin change ships with the engine. hello, release, pr-review,
pr-design-review and issue-fix 0.16 run unchanged.

## 4. Traversal

### 4.1 Visits, the live path and `current`

A **visit** is one entry of a node, recorded in `DurableRunState.visits` with a
sequence number, the node, its attempt (`StageAttempt.attempt`,
`nextStageAttempt`, `packages/controller/src/state.ts:741`), how it was entered
and how it ended (§7.4). Visits append and are never removed, so the run's
history stays acyclic even when its walk is not.

The **live path** (`DurableRunState.path`, shown as `RunView.topology.path`) is
a list of visits of graph-entered nodes, from a visit of `start`, in which no
node appears twice. Its last visit is the **tail**. A **side visit** is a visit
of a supervisor-only node; it is never on the live path and records the tail it
was entered from.

`current` keeps today's meaning: the node and attempt of the run's latest
dispatch, validation, reentry or `enter`. Plugins read it (§2). A dispatch or
validation for an earlier node on the live path is a supporting action for that
node: `current` follows it, as today, and the live path does not change. Every
routing rule below reads the tail, not `current`.

A node is **accepted** when each of its requirements has a valid receipt and
`openAttempt[node]` is not set. Validity is identity-anchored. Admission
evaluates it at the check: `admitValidation` runs its identity invalidation
first, as today. A forward move (§4.3) and the completion carry (§4.6) read the
receipts as recorded, which is what the graph saw in its view when it chose
the node. A receipt that is stale but not yet marked invalid then moves the run
where today's code would have admitted the action and rejected the validation,
instead of stopping the run with `undeclared edge`.

### 4.2 Actions for nodes on the path

A `dispatch` naming a node on the live path is admitted as today: supporting
work for that node. A `validate` naming a node on the live path is a
re-validation:

- a node that is not complete (some requirement lacks a valid receipt, after
  identity invalidation) is validated; a failed validation leaves it
  unaccepted, and nodes after it then cannot validate (§4.5) until the run
  reenters it or it validates;
- a node that is complete is refused before any validator runs (`stage X is
  already accepted`): no receipt is minted again, its receipts stand, and the
  validation still clears `openAttempt[X]`. This keeps today's rule, where the
  `earliestIncompleteStage` gate refused the validation of every stage but the
  first incomplete one (§2). A reentry that kept the candidate's identity
  therefore reopens the node and its next validation closes it again on the
  receipts it holds.

The open side visit's node is the one exception: each visit of a
supervisor-only node is judged afresh (§5.3).

### 4.3 Moving forward

There is no `route` operation. An action naming a node N (a `dispatch` job's
`stageId`, a `validate`; `observe` names no node and never moves the run) that
is not on the live path and is not the open side visit is a forward move. It is
admitted when:

- N is graph-entered and no side visit is open;
- a route of declared edges between graph-entered nodes leads from the tail to
  N, every node strictly between the tail and N on that route is accepted, and
  no node after the tail on the route is on the live path already (going back
  is a reentry, §4.4, and costs a correction). A direct edge `tail → N` is such
  a route. When several routes qualify, the
  controller takes a shortest one, choosing among nodes in `stages` order, so
  the result is deterministic.

The move appends the route's intermediate nodes to the live path as **carried**
visits (they keep their latest attempt; nothing runs for them, their receipts
are what carries them) and then a visit of N, which becomes the tail. The tail's
own acceptance is not a condition: as today, validation enforces it (§4.5). A
forward move spends no correction and does not bump the generation. It is
admitted in normal and recovery mode.

Carried visits are what let a graph that selects "the first incomplete stage"
act for a stage several places ahead after a reentry of an early one, when the
stages between still hold valid receipts (§2).

An action naming a node that is neither on the live path, nor the open side
visit, nor an admissible forward move is inadmissible with precondition
`undeclared edge` and a detail naming the tail, the node and the tail's
out-edges. In normal mode that stops the run
(`packages/controller/src/inadmissible.ts:42-49`); the stop is final, classified
in `stop-class.ts` beside `unsupported action in …` as a plugin defect. In
recovery it is an in-turn rejection.

### 4.4 Reentry over a graph

`reenter { stageId: X }` starts a new visit of a node on the live path. Who may
name which X:

| Mode | Where the run is | X admitted |
|---|---|---|
| normal (graph) | no side visit | the tail, or X on the live path with a declared edge `tail → X` |
| recovery (supervisor) | no side visit | any node on the live path |
| recovery (supervisor) | side visit of S | X with a declared edge `S → X`: a reentry when X is on the live path, a forward move (§4.3) when it is not (§5.2) |
| normal (graph) | side visit of S | none: only the supervisor leaves S |

The graph needs a declared back edge to close a cycle; on an implicit chain
every earlier node has one. The supervisor keeps today's power to reenter any
node the run has reached. A reentry of a node ahead of the path is refused with
`undeclared edge`; to go ahead, the run moves forward.

A reentry does what it does today (`loop.ts:2344-2374`): it requires one
`corrections` (else the run stops `corrections budget exhausted`), spends it,
runs identity-aware invalidation, sets `openAttempt[X]`, opens X's next attempt,
sets `current` and bumps the generation. It also truncates the live path after
X's earlier visit, replaces that visit with the new one, and closes an open side
visit. Visits removed from the live path stay in `visits` with the reentry that
removed them.

### 4.5 Admission

Validating node N mints receipts only when the receipts the path requires are
valid:

- N on the live path at position i: every node at positions 0 to i−1 is
  accepted.
- N reached by a forward move: the move first extends the path (§4.3), then the
  same rule applies.
- N the open side visit: nothing; a supervisor-only node's own validators judge
  its evidence (§5.3).

This replaces `admit.ts:270-281`. Everything else about validation is
unchanged: the requirement set must be covered, the evidence is the live
candidate's (`candidateEvidence`), history is the superseded candidates'
evidence, independence, contracts and identity anchoring apply as before, and a
new receipt for a node requirement replaces the earlier valid one
(`admit.ts:385-391`). A node that is already complete is refused as already
accepted (§4.2). A validation clears `openAttempt` for its node, accepted,
rejected or refused as already accepted, as today (`loop.ts:3269-3274`).

### 4.6 Completion

`stop` with reason `complete` first **carries the path forward**: when no side
visit is open and the tail is not terminal, the controller looks for a route
from the tail to a terminal node along the forward-move rule (§4.3) on which
every node after the tail, the terminal included, is accepted; when there is
one (the same deterministic choice), it appends those nodes as carried visits.
This is the case of a reentry that kept the candidate's identity: the reentered
node's validation is refused as already accepted and clears its open attempt
(§4.2), the later nodes still hold valid receipts but left the
live path with the reentry, and a graph that selects "the first incomplete
stage" (`pr-review/src/graph.ts:312-314`, `pr-design-review/src/graph.ts:307`)
finds none and stops `complete`, as it does today. Then the stop makes the run
`succeeded` when:

- no side visit is open and the tail is a terminal node;
- every node on the live path is accepted;
- `deliveryDrift` finds the tail's receipts still describe the workspace.

Nodes off the live path, supervisor-only nodes included, are never required. A
`complete` stop that fails these is a stop, as today, and a carry that does not
end in success leaves the live path as it was.

### 4.7 Receipts on a cycle

Moving back along a cycle does not invalidate receipts by position. Receipts
stay identity-anchored
([run convergence §4.1](design-run-convergence.md#41-candidate-anchored-freshness)):
a receipt is valid while its `acceptedIdentity` and `prerequisiteBindings` hold,
in any node, on the live path or not. What a cycle changes is which receipts
count:

- the reentered node is open until its next validation;
- the nodes the reentry removed from the live path count for nothing until the
  run reaches them again; reached again, they count on the receipts that are
  still valid, as in today's list (the same candidate under the same bindings
  has the same accepted outcome);
- a validation on the new lap replaces the earlier lap's receipt for the same
  requirement.

A Fix⇄Review lap that changes the candidate therefore validates Review again,
because Review's receipts are anchored to the candidate.

### 4.8 Budgets bound cycles

Every way back costs a correction (§4.4), and the `corrections` budget is finite
and never reset, so every cycle ends. Forward moves cost one decision, like
every action. A plugin's own caps (issue-fix's `review.maxReentries`) sit inside
that bound. Supervisor-only nodes add their own visit cap (§5.5).

## 5. Supervisor-only nodes

### 5.1 Declaration

`entry: "supervisor"` and `maxVisits` on a node, with its out-edges. That is all
the controller knows: it never reads what the node is for, what its requirements
mean or which out-edge fits a result. The
[controller boundary](design-typescript-core.md#1-decisions-and-scope) holds: no
plugin notion enters the controller, SDK or CLI.

### 5.2 Operations

| Step | Who | Operation | Effect |
|---|---|---|---|
| Hand over | graph (or the controller's own triggers) | `supervise` | Recovery opens, as today, from wherever the tail is |
| Enter | supervisor, in recovery | `enter { stageId: S, reason, evidenceRefs? }` | S is supervisor-only, has visits left, and no side visit is open. A side visit of S opens, entered from the tail (any graph-entered node), under S's next attempt; `current` becomes S; `openAttempt[S]` is set. No correction, no generation bump |
| Work | graph in normal mode after the supervisor's `return`, or the supervisor itself in recovery | `dispatch`, `observe`, `validate` for S | The node's jobs and validators run; a supervisor-authored dispatch follows the core's recovery rules (it names the current node, which is S) |
| Settle | controller | — | When a validation of S mints a receipt for every requirement of S, the controller records the settlement on the side visit (the receipts and each requirement's validation reason as the validator gave it) and opens a recovery episode with trigger `supervisor_node_settled`, a new episode also when the supervisor's own validation settled it. The trigger's message cites each receipt with its requirement, binding and reason, and names S's out-edges; its evidence refs are the records the receipts accepted (the newest 20) |
| Leave | supervisor, in recovery | `reenter { stageId: X }` | A declared edge `S → X` exists. When X is on the live path, a reentry (§4.4): one correction, X's new visit entered from the side visit. When X is not, a forward move from the tail (§4.3): the route rule applies, no correction, no generation bump, X under its next attempt. The side visit closes with outcome `routed to X` and `openAttempt[S]` is cleared |

Leaving to a node off the live path covers a side visit entered from a node
whose successor is the fitting exit: entered from Fix, the supervisor can leave
to Review along `S → review` when `fix → review` is a route from the tail.

The supervisor cannot supply a passing receipt, as everywhere: S's receipt is
the controller's, from S's validators over S's evidence. The supervisor may
leave S without a receipt (the node's work failed and it chooses another
remedy); the visit closes with outcome `left without receipt`.

While S is open:

- the graph may dispatch and validate for S, observe, `supervise`, and `stop`
  (a final stop that waits for an operator approval is how a node waits; §17 of
  the core design);
- the graph may not act for any other node, `reenter`, or stop `complete`:
  each is inadmissible (`supervisor-only node`), which in normal mode stops the
  run, a final stop classified as a plugin defect;
- the supervisor too dispatches and validates only for S, and `reenter` is
  only a leave along an out-edge of S; any other is an in-turn rejection
  (`supervisor-only node`, or `undeclared edge` for a leave without the
  edge);
- at each normal-mode step, before calling `advance`, the controller checks
  whether S's open visit is settled: its settlement's receipts, one per
  requirement, are all still valid. If it is, the controller opens the
  `supervisor_node_settled` episode instead. This also covers a resume after
  the settle, and a supervisor that `return`s without leaving: the episode
  opens again, so the trigger's safe default after three rejections is a stop.

`enter` is a supervisor action only. A graph decision with `enter` is
inadmissible (`enter is the supervisor's`), a final plugin-defect stop; a
supervisor's `enter` outside recovery is refused the same way. An `enter` of a
graph-entered node, of a node with no visits left, or while a side visit is
open is an in-turn rejection (`supervisor-only node`) naming the reason.

### 5.3 The node's work and its receipt

Validating S needs no predecessor receipts (§4.5). Each visit of S is judged
afresh: the "already accepted" refusal of §4.2 does not apply to the open side
visit's node, so a second visit's validation runs S's validators even when the
first visit's receipts are still valid, and its receipts replace them. The
settlement recorded on the visit names which receipts settled it. S's
requirements are ordinary requirements with validator bindings, contracts and
independence rules. The node's work is the plugin's: the graph builds S's jobs in `advance`
from evidence, so the jobs keep the plugin's own assignments, contracts and
confinement. A supervisor that dispatches for S in recovery writes its own
instruction, as for any recovery trial.

### 5.4 A supervisor-only node's receipt as evidence

S's evidence is run evidence like any other: a validator of another node sees
the jobs' records for the live candidate in `evidence` and those of earlier
candidates in `history`. What a validator also needs is to know which of those
records a receipt accepted, so it can honour a settled result and ignore an
unaccepted one. `ValidationInput` gains:

```ts
/** Every receipt of the run, valid and replaced, as `RunView.receipts` shows them. */
receipts?: Receipt[];
/** The currently admitted validator bindings, as `RunView.validatorBindings` shows them. */
validatorBindings?: ValidatorBinding[];
```

The controller passes both on every validator call of a run (run, resume, a
resume's receipt recheck, the supervisor's validation probes, and L2 replay
over the recorded state), from the run's state at the call, like `request`; a
validator that ignores them behaves as before. In a validation, `receipts` are
the run's receipts after identity invalidation and before the validation's own
new receipts. A receipt names its node and its
`evidenceRefs`, so "a receipt of S was minted on this record" is a plain lookup.
A replaced or identity-invalidated receipt still records that S's validators
accepted the record when it was minted; whether that still holds is the reading
node's rule, not the controller's.

A requirement that relies on S's results declares S's requirement in
`prerequisiteRequirementIds`. A qualified replacement of S's validator then
invalidates the reading node's receipts (run convergence §4.1), and the reading
validator honours an S receipt only when its `validatorBinding` (id and version)
equals the currently admitted binding of that requirement in
`ValidationInput.validatorBindings`. A receipt's own `prerequisiteBindings`
record the bindings at its acceptance, so they cannot answer that question.

### 5.5 Budgets

- `maxVisits`: `enter` beyond it is inadmissible (in-turn), naming the node and
  its visits.
- Each `enter` costs one decision. S's jobs spend `jobs` and `agentInvocations`
  like any node's, counted per node in `agentInvocationsByStage` and
  `budgetUsage`; the per-stage share guard (`STAGE_BUDGET_SHARE`,
  `loop.ts:3244`) applies to S as to any node.
- Leaving S costs one `corrections` when it is a reentry, none when it is a
  forward move.

## 6. Operations

The core's
[operations table](design-typescript-core.md#4-public-interface-and-process-protocol)
on the engine:

| Operation | Who requests it | Result over a graph |
|---|---|---|
| Dispatch | Graph or supervisor | A job for a live-path node, or a forward move (§4.3); a supervisor-only node only while its side visit is open. The supervisor dispatches only for the current node, as today; it moves forward by `validate` or by returning to the graph |
| Observe | Graph or supervisor | Unchanged; names no node |
| Validate | Graph, supervisor, or controller | Admission along the live path (§4.5) |
| Reenter | Graph along a declared edge from the tail; supervisor to any live-path node, or out of a supervisor-only node along its out-edge | New attempt, live path truncated, one correction (§4.4) |
| Enter | Supervisor | Opens a side visit of a supervisor-only node (§5.2) |
| Supervise | Graph; controller may also trigger recovery | Unchanged; adds the trigger `supervisor_node_settled` |
| QualifyRepair, ActivateRepair | Supervisor | Unchanged, with the topology in the structural match (§7.3) |
| Return | Supervisor | Unchanged; the graph's `advance` resumes, inside an open side visit included |
| Stop | Graph or supervisor | Completion as in §4.6 |

## 7. Resume, replay, repair and version transitions

### 7.1 Resume

Resume keeps the live path, the visits and an open side visit. It runs the
existing checks along the live path instead of the list:

- `reassessAcceptedWorkspace` and the receipt recheck walk the live path in
  order. The first node whose accepted evidence drifted or no longer passes is
  invalidated with every node after it on the live path and every
  graph-entered node off it (on a chain, exactly today's positional set); the
  path is truncated there and that node gets its next attempt and becomes
  `current`, as today, with no correction charged. The new visit is recorded
  `entered: "reenter"` with operation `resume`, and the visits it removed end
  `replaced by reentry of X`. Executor-repair activation invalidates the same
  set from the current node. A truncation that removes the visit a side visit
  was entered from closes the side visit (`closed by reentry of X`) and clears its open attempt. Receipts of nodes off the live path
  are invalidated by identity, as everywhere; they do not move the run (today's
  list walk would set `current` to such a stage; the plugins that read
  `current` key only attempt bookkeeping on it, §2).
- `deliveryDrift` reads the tail.
- A run resumed in recovery returns to normal mode as today. When a side visit
  is open and settled, the next step opens `supervisor_node_settled` again
  (§5.2); when it is open and not settled, the graph's `advance` continues the
  node's work.

### 7.2 Replay

L2 replay ([rehearsal §3.3](design-graph-rehearsal.md#33-l2-replay)) asks the
current `advance()` what it would do next. On the engine it also reports
whether that action is admissible from the recorded live path (an action for a
path node, a forward move, a reentry along an edge, an action for the open side
visit). Replay refuses a run whose pinned topology differs from the current
plugin's `describe()`, as it would differ structurally.

### 7.3 Repair qualification and activation

The structural match grows by the topology. `assertDefinitionUnchanged`
(`controller.ts:1585`), `assertCandidateDefinitionCompatible`
(`repair-lifecycle.ts:886`) and the `graphloom.stages.json` pin
(`repair-lifecycle.ts:862-880` writes it, `repair.ts:245-280` checks it) compare
the declared `edges`, `start` and `terminal` (absent in a chain, so a candidate
cannot add them) with the same JSON equality they use for `stages`; `entry` and
`maxVisits` are part of each stage, so the stages comparison covers them. A
candidate whose `describe()` adds, removes or reorders an edge, changes `start`
or `terminal`, or changes a node's entry or visit cap is rejected naming what
changed, even when its tests and independent review pass.

Activation restarts the live path at `start`, as it restarts at `stages[0]`
today (`repair-lifecycle.ts:709-712`): every graph-entered node's receipts
become invalid, on the live path or off it, as today's restart invalidates
every stage; the live path becomes a visit of `start`, `current` becomes
`start` with attempt 1 as today, and an open side visit closes with outcome
`closed by activation`. Visits are identified by sequence number, so the repeated attempt
number is unambiguous. Receipts of supervisor-only nodes are not invalidated by
activation; a reading node's `prerequisiteRequirementIds` decides whether a
replaced validator matters to it (§5.4).

`resume --update-plugin` and `resume --upgrade --update-plugin` run the same
match (`checkPluginUpdate`, `controller.ts:1452`), so an update cannot turn a
chain run into a declared topology or change a topology's edges. A plugin that
adopts edges needs a new run.

### 7.4 Evidence and history across generations

Generations keep their meaning
([run convergence §4.1](design-run-convergence.md#41-candidate-anchored-freshness)):
a reentry bumps the generation, a forward move and `enter` do not. Each evidence
record a job produces gains `producer.attempt`, the attempt of its node, beside
the existing `producer.stageId` (`packages/controller/src/admit.ts:577-588`), so
the evidence of every lap stays attributable after the live path forgets it.
`DurableRunState.visits` records each visit: sequence number, node, attempt, how
it was entered (`start`, `edge`, `carried`, `reenter`, `enter`, `migrated`), the
visit it came from, the generation, the operation (`intake`, `dispatch`,
`validate`, `stop`, `reenter`, `enter`, `resume`, `activate_repair`,
`migration`), and for a visit that left the live path or a side visit, how it
ended (`replaced by reentry of X`, `routed to X`, `left without receipt`,
`closed by activation`, `closed by reentry of X`). A side visit also records its settlement (§5.2): the
receipts that settled it and each requirement's reason; a settled visit is one
whose settlement still holds, not an ending. Nothing is deleted.

## 8. Operator surfaces

`graphloom inspect` (JSON) adds, for every run:

- `topology: { start, terminal, edges, implicit }` (`implicit` is true for a
  normalized chain) and, per stage, `entry`, `maxVisits`, `visits` (count) and
  `onPath`;
- `path`: the live path as `["fix#3", "review#3"]`;
- `visits`: every visit with how it was entered, where from and how it ended;
- `stages[].complete` keeps its meaning (every requirement has a valid receipt)
  and `stages[].accepted` adds "and on the live path and not open".

Existing fields keep their meaning.

`graphloom stats` keeps its per-node rows (they are per `stageId` already) and
adds each node's visit count; a supervisor-only node is marked. Totals are
unchanged.

`graphloom watch` and the progress summary (`apps/graphloom/src/progress.ts`):

- the summary line keeps `k/n stages complete` as computed today and, for a
  graph that declares edges, adds the path: `path fix#3 → review#3`;
- `stage_entered` carries how the node was entered; two moves are added,
  `node_entered_by_supervisor` (an `enter`) and `node_settled` (a supervisor-only
  node settled), both reported as moves.

## 9. Rehearsal and check

- **L0 static check** (`graphloom check`): `describe()` already passes through
  `assertGraphDefinition`, so the definition rules of §3.2 are checked there. A
  scenario's scripted supervisor decisions that `enter` or `reenter` are checked
  against the nodes and the (declared or implicit) edges, and a scenario that
  expects a supervisor-only node to settle must script an `enter` for it.
- **Scenarios** gain an optional `expect.path`, the live path's node ids when
  the run ends (`["fix", "review"]`), checked by the evaluator from durable
  state like `expect.receipts`.
- **`rehearse --stop-at <node>`** stops once the node is accepted on the live
  path; `ok` means the run stopped there with the node accepted and no later
  node on the live path accepted (today it reads `stages[index + 1]`,
  `apps/graphloom/src/rehearsal.ts:718-735`; on an implicit chain the two
  agree). A supervisor-only node is refused as a stop point.
- The rehearsal's scripted supervisor answers `supervisor_node_settled` from the
  scenario's `supervisor` decisions like any other trigger.

## 10. Supervisor

The supervisor package gains, and still depends only on `@graphloom/sdk`:

- the action `enter` in `GRAPHLOOM_SUPERVISOR_ACTIONS`, its Pi tool
  (`stageId`, `reason`, `evidenceRefs`), and the JSON reply form used by the
  Claude Code and Codex harnesses
  ([supervisor harnesses §4.2](design-supervisor-harnesses.md#42-decision-protocol-per-harness));
- in the episode prompt: the live path and, for a graph that declares edges,
  the nodes with their entry, the edges, the open side visit, and for each
  supervisor-only node its visits left and out-edges;
- `TRIGGER_GUIDANCE` (`packages/supervisor/src/host.ts:1046`) for
  `supervisor_node_settled`: the node's receipts are cited; read the node's
  evidence, then leave it with `reenter` along one of its out-edges; the
  plugin's own records say which fits. Its safe default after three rejections
  is a retryable stop naming the node;
- admission facts for the tools: `canEnter`, the supervisor-only nodes with
  visits left, and `exits`, the out-edges of an open side visit.

Recovery's core duty is unchanged. Entering a supervisor-only node is one more
remedy the supervisor chooses on its own judgment; the controller never enters
one by itself.

## 11. Compatibility and migration

### 11.1 Protocol and manifest

A chain needs no new protocol level: it declares nothing new and the engine
normalizes it. A declared topology does. Its fields are optional, but they
change what a definition means, and today's `assertGraphDefinition` ignores
unknown fields (`validate.ts:225-249`), so an older controller would silently
run a topology as a list. The bundle's manifest therefore states its level:

- `sdkProtocol: 2` declares that the bundle may describe a topology. A bundle at
  level 1 that describes `edges`, `start`, `terminal`, `entry` or `maxVisits` is
  refused at intake and on every `describe()` check.
- The controller accepts manifests at levels 1 and 2 (today it requires
  equality, `packages/controller/src/intake.ts:454`, `controller.ts:1457`,
  `controller.ts:1564`, `upgrade.ts:148`). A GraphLoom that predates this
  refuses a level-2 bundle with its existing equality check, which is the
  protection.
- The wire envelope's `protocolVersion` stays 1. Every wire change is an added
  optional field (`RunView.topology`, `ValidationInput.receipts`,
  `ValidationInput.validatorBindings`, `producer.attempt`) or a supervisor
  action, which never crosses the plugin wire as a graph decision the
  controller would admit.
- A run pins its bundle's level. `--update-plugin` keeps the run's level and its
  topology (§7.3).

### 11.2 Existing plugins

hello, release, pr-review, pr-design-review and issue-fix 0.16 declare no
edges, keep their `sdkProtocol: 1` manifests, and run on the engine as implicit
chains (§3.3). They need no source change, rebuild or manifest regeneration. A
plugin opts into a declared topology by declaring `edges` and writing
`sdkProtocol: 2` from its manifest generator; issue-fix 0.17.0 is the first.
Running runs keep their pinned definition; a run started on 0.16 cannot move to
0.17 with `--update-plugin`.

### 11.3 Durable state

`path`, `visits` and the side visit are new durable fields that every run now
carries, so the state format becomes 3. Its migrator from format 2
(`packages/controller/src/state-migrations/`, moved by `resume --upgrade`,
[release design §5.2](design-release.md#52-moving-a-run-forward-resume---upgrade))
derives them from the stored state alone:

- the live path is the prefix of the list through the furthest stage that has a
  recorded attempt (`stageAttempts`), any receipt, or is `current`; each of its
  visits is `migrated`, with the stage's latest attempt;
- no side visit is open (format 2 has no supervisor-only nodes).

The prefix is the furthest point the run reached, so the "first incomplete
stage" selection of the shipped plugins never needs more than a forward move
from it. The migrator changes no existing field, and the migration check
(protected view, release design) confirms every existing record reads the same.

## 12. Verification

Controller and SDK tests, each named for the PR that adds it (§13):

1. Definition rules: each refusal of §3.2; the issue-fix 0.17 topology accepted;
   `normalizeTopology` of a list gives the forward and back edges, start and
   terminal of §3.3.
2. The shipped plugins on the engine: every existing controller, plugin, matrix
   (`apps/graphloom/test/matrix/`), `release-e2e`, `issue-fix-e2e` and rehearsal
   suite passes unchanged. Named cases: hello's Review → Write reentry,
   release's Review → Changelog reentry and issue-fix's Review → Fix reentries
   are admitted along implicit back edges; after a supervisor reentry of the
   first stage of a five-stage chain whose later stages hold valid receipts, the
   graph's dispatch for the first incomplete stage is a forward move with carried
   visits; after a supervisor reentry of an early pr-review stage that keeps
   the candidate's identity, the stage's validation is refused as already
   accepted and clears its open attempt, and the graph's `stop complete`
   carries the accepted later stages onto the path and succeeds; `current` follows a supporting dispatch for an earlier stage; a
   reentry of a stage ahead is refused.
3. Forward moves: a direct edge; a route across accepted nodes with carried
   visits; refused across an unaccepted node, without a route, or while a side
   visit is open; refused through a node already on the live path (path
   `A → B`, edges `B → A` and `A → C`: a dispatch for C is not a forward move);
   the deterministic choice between two routes.
4. Reentry: the graph along a declared edge from the tail; refused without one;
   the supervisor to any live-path node; truncation and visit history; one
   correction each; `corrections budget exhausted` on the last.
5. Admission: a node validates when its live-path predecessors are accepted and
   not when one is open, while an off-path node's state is irrelevant.
6. Completion: succeeds when the path ends at a terminal node and is accepted;
   carries accepted nodes from a non-terminal tail to a terminal one; refused
   when no accepted route reaches a terminal node (the path left unchanged),
   with a side visit open, or with an open node on the path; delivery drift
   reads the tail.
7. Cycle receipts: Fix⇄Review laps with and without a candidate change; a
   changed candidate validates Review again; a node re-reached on unchanged
   identity counts on its valid receipts.
8. Supervisor-only nodes: `enter` refused in normal mode, for a graph-entered
   node, past `maxVisits`, with a side visit open; entered from the first and
   from the last node of a path; the graph refused acting for another node,
   reentering or completing while it is open; the settle opens
   `supervisor_node_settled`; leaving along an out-edge only, as a reentry to a
   path node and as a forward move to a node off the path; leaving without a
   receipt; never required for completion; a final stop inside it lifted by an
   approval.
9. `ValidationInput.receipts` and `validatorBindings` reach host and
   in-process validators on run, resume and recheck; a validator reading an S
   receipt minted under a since-replaced binding does not honour it.
10. Resume and repair: drift truncates the live path; off-path drift invalidates
    without moving the run; activation restarts at `start` and closes a side
    visit; a candidate changing an edge, `start`, `terminal`, `entry` or
    `maxVisits` is rejected by `describe()` and by the stages pin;
    `--update-plugin` from a chain to a declared topology is refused.
11. Protocol: a level-1 bundle with edges is refused at intake; a level-2 bundle
    without edges runs as an implicit chain; a level-2 manifest on an older
    controller is refused (fixture manifest, existing check).
12. State format 3: format-2 fixtures of hello, issue-fix and pr-review runs
    stopped mid-run (one after a reentry, one with `current` on an earlier stage
    than the furthest receipt) migrate to the expected path and resume to the
    same next action as before.

Supervisor tests: the `enter` tool and JSON reply parse and normalize; the
prompt renders the topology; the settle trigger's guidance and safe default;
admission facts. CLI tests: inspect, stats and watch output for a declared
topology and for a chain (existing fields unchanged); `rehearse --stop-at` over
a path; `expect.path`.

An end-to-end fixture in `@graphloom/testkit`, a three-node graph with a cycle
and a supervisor-only node driven by scripted agents and a scripted supervisor,
runs the whole flow through the real controller.

## 13. Implementation plan

Ordered pull requests. Each is reviewed and merged before the next starts.

1. **SDK: topology types and rules.** `StageDefinition.entry`, `maxVisits`,
   `EdgeDefinition`, `GraphDefinition.edges`, `start`, `terminal`;
   `assertGraphDefinition` rules (§3.2); `normalizeTopology` (§3.3) and
   reachability in a pure `topology.ts`; `RunView.topology`;
   `ValidationInput.receipts` and `validatorBindings`; the `enter` action and
   `EnterSpec`. Tests: `packages/sdk/src/topology.test.ts` (item 1), wire checks
   in `packages/sdk/src/index.test.ts`.
2. **Controller: one traversal engine.** Durable `path` and `visits`; forward
   moves with carried visits; reentry over edges; admission along the live path;
   completion and delivery drift at the tail; `undeclared edge` refusals and
   their stop class; `producer.attempt`; manifest levels 1 and 2; state format 3
   and its migrator. The list-specific paths go: the predecessor loop
   (`admit.ts:270-281`), `earliestIncompleteStage`, the last-stage
   `deliveryDrift`, the every-stage completion check (`loop.ts:2462-2466`),
   positional `invalidateStageAndAfter` callers. Tests:
   `packages/controller/src/topology.test.ts` (items 3 to 7),
   `topology-plugins.test.ts` (item 2), `state-migrations` cases (item 12),
   `intake` and `stop-class.test.ts` cases (item 11), and every existing suite
   unchanged.
3. **Controller: supervisor-only nodes.** `enter`, side visits, the settle
   trigger, leaving along out-edges, `maxVisits`, the graph's restrictions while
   a side visit is open, `ValidationInput.receipts` and `validatorBindings` on
   every validator path. Tests: `packages/controller/src/supervisor-node.test.ts`
   (items 8, 9).
4. **Controller: resume, replay, repair over the engine.** Live-path reassess
   and recheck, activation restart, the structural match and stages pin with
   edges, `--update-plugin` refusal, replay admissibility. Tests:
   `topology-resume.test.ts`, `topology-repair.test.ts`, and cases in
   `replay.test.ts` and `upgrade.test.ts` (item 10).
5. **Controller and SDK: `CheckoutSpec.write`.** The generic capability
   issue-fix already scopes under
   [executable confirmations](design-issue-fix-graph.md#executable-confirmations-second-phase):
   add agent-supplied files to a checkout before it is committed, with the path
   rules described there. Arbitrate's proof tests need it. Tests: cases in
   `packages/controller/src/checkout.test.ts`.
6. **Supervisor.** The `enter` tool and reply, the prompt's topology section,
   the trigger guidance and safe default, admission facts. Tests: cases in
   `packages/supervisor/src/tools.test.ts`, `decision.test.ts`, the harness
   conformance suites, and `packages/controller/src/supervisor-selection.test.ts`
   for the episode wiring.
7. **CLI and rehearsal.** inspect, stats, watch and progress; `rehearse
   --stop-at` over the live path; `expect.path`; the L0 checks of scripted
   `enter`/`reenter`. The testkit topology fixture and
   `apps/graphloom/test/topology-e2e.test.ts`. Docs: CONTEXT.md gains node,
   edge, live path, visit and supervisor-only node; the core design's list
   statements become graph statements; AGENTS.md's principle names nodes and
   edges.
8. **issue-fix 0.17.0.** Edges for Fix⇄Review, the Arbitrate node and its plan
   ([issue-fix: Arbitrate](design-issue-fix-graph.md#arbitrate-designed-for-0170)),
   `sdkProtocol: 2`.

## 14. Open questions

1. How [agent-host mode](design-agent-host.md), designed and not implemented,
   carries `enter` and the settle trigger to an attached host acting as
   supervisor. Its host protocol lists the supervisor's operations; this
   design adds one, and the host design has to say how a host proposes it.
