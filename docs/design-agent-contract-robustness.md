# Agent–harness contract robustness

Status: implemented, 2026-10-03, from the first live run of
[`examples/plugins/banyandb-fix`](../examples/plugins/banyandb-fix/) against
apache/skywalking#14092. The point fix in `apps/graphloom/src/cli-runner.ts`
that unblocked that run (§2.3) is superseded, not kept: its `REVIEW_SCHEMA`
and `reviewEvidence()` are deleted, and hello/banyandb-fix/release each
declare their own `resultContracts` instead. Two refinements the design
itself did not spell out, decided during implementation: (1) the schema a
dispatch hands a harness carries reference paths unnarrowed by `enum` for Pi
specifically, since Pi's own tool-parameter validation would otherwise refuse
a reconcilable miss before `submit_result`'s own §4.3 reconciliation ever saw
it — Claude and Codex, which have no such interception point, still narrow
with `enum`. (2) Claude and Codex have no in-turn retry in this harness: a
post-turn contract miss fails the job as `contract_violation` directly
instead of attempting a same-session follow-up prompt; only Pi's
`submit_result` retries in-turn, bounded by `MAX_RESULT_RETRIES`.
This specializes the [TypeScript core design](design-typescript-core.md) and
the [executor design](design-executors.md), and extends
[run convergence](design-run-convergence.md) with a class of failure that
design did not consider: the agent and the harness disagreeing about the
*shape* of what passed between them, while nothing fails.

## 1. What the live run showed

The run spent its whole `agentInvocations` budget (600) and stopped with zero
receipts: `stopReason: "agentInvocations budget exhausted"`,
`blocker: "supervisor decide"`, `recoveryTrigger: executor_failed ("model
request budget exhausted")`. Twenty evidence records: twelve environment and
issue reads, one plan (98 model calls), six plan-review passes (82–111 model
calls each; the sixth failed when the run budget hit zero mid-turn), one
executor failure.

Three structural mismatches, none of which produced a failure signal:

1. **Evidence kind.** Every review pass was recorded as `kind: "other"`. The
   plugin reads plan reviews through `reviews()`
   (`examples/plugins/banyandb-fix/src/evidence.ts:211-219`), which filters on
   `kind === "review"`. The only code that produces that kind for an agent job
   is `reviewEvidence()` in `apps/graphloom/src/cli-runner.ts:194-206`, gated by
   a string comparison that the plugin's own schema text did not satisfy. The
   graph saw "no review yet" six times and dispatched six reviews. The
   round cap meant to stop exactly this (`MAX_PLAN_REVIEW_ROUNDS`,
   `graph.ts:263,298`) counts through the same `reviews()` call, so it read 0
   for the whole run.
2. **Reference identity.** The reviewer was asked to name a repeated finding by
   its short id (`P1`) in `findings[].finding` and `prior[].finding`. The real
   Pi session wrote the finding's *description* in those fields. The ledger
   matches by id (`plan-findings.ts`, `planFindingById`), so no repeat was ever
   recognised; every pass's findings were new, and the dispute → verify →
   dismiss path never ran.
3. **Budget starvation.** Each model call decrements `agentInvocations` one for
   one (`packages/controller/src/children.ts:285-299`). Six review turns spent
   the run dry; the executor failure that finally fired recovery arrived with
   nothing left for `supervisor.decide()`, which refuses to start without one
   call of allowance. Recovery was triggered correctly and could do nothing.

None of this is specific to Pi, to banyandb-fix, or to plan review. The same
mismatches will happen wherever an agent's output is read by code that assumes
a shape the agent was never actually constrained to produce.

## 2. Where the harness meets an agent

Ten boundaries. Three already enforce their contract; seven do not.

| # | Boundary | Where | Enforced today |
|---|---|---|---|
| B1 | Dispatch → executor input | `executors/coding-agent/src/run.ts:30-40` (`isInput`), `:107-110` | Shape of `assignment` only; `resultSchema` is "a string" |
| B2 | Executor → model: output constraint | `assignment.ts:21-31` (`inlineObjectSchema`); `pi-harness.ts:275-291`, `claude-harness.ts:338-348`, `codex-harness.ts:232-240` | Only when `resultSchema` is inline JSON; a schema *name* yields no constraint at all |
| B3 | Model → executor: result extraction | `pi-harness.ts:152-157`, `claude-harness.ts:588-596`, `codex-harness.ts:232-240` | Presence of a submission; never its validity |
| B4 | Executor → controller: evidence recording | `packages/controller/src/loop.ts:1741-1792` | Kind copied verbatim (executor hardcodes `"other"`, `run.ts:117`); `resultSchema` stamped as metadata (`:1759`), never used to classify or validate |
| B5 | Controller → plugin: evidence consumption | `agentRuns`/`reviews` (19 call sites in banyandb-fix); parsers `parseDecisionRecord`, `parseCodeReview`, `parseVerification`, `reviewVerdict` | Per-parser, inconsistent: three return `{problem}`, `reviewVerdict` silently defaults (`verdict: ""`, `findings: []`, `prior: []`) |
| B6 | Agent → ledger: id references | `findings[].finding`, `prior[].finding` | None; an unknown id silently matches nothing |
| B7 | Supervisor → controller: proposals | `packages/supervisor/src/tools.ts` (`reject()`), `decision.ts`, `pi-supervisor.ts` (`sanitizeProposal`) | **Yes**: validated in-turn, rejected with a reason the model can act on, repaired or thrown otherwise |
| B8 | Agent → controller: tool calls | `packages/controller/src/children.ts:259-272` | **Yes**: id, admission, effect vs. write scope, bounded JSON; refusal returned to the agent in-turn |
| B9 | Plugin → controller: decisions | `packages/plugin-host/src/worker.ts:87,112`, `loop.ts:407,985-998` | **Yes**: wire-validated; malformed → `plugin_malformed` recovery |
| B10 | Controller ↔ agent: budget and progress | `children.ts:285-299`; `escalation.ts` (`progressMark`, `noteGraphDecision`); plugin round caps | Counted, not paced; progress is judged by evidence-content hashes, which a non-deterministic model always changes |

The pattern in B7–B9 is the one to generalise: **the contract is declared once,
checked at the boundary when the value arrives, and a violation is either
corrected in-turn by its producer or escalated with a reason — never recorded as
a success and never silently defaulted.** B1–B6 and B10 each lack one or more of
those three properties.

### 2.1 The overloaded `resultSchema`

`JobSpec.resultSchema` (`packages/sdk/src/types.ts:253`) is a schema *name*
the controller stamps onto evidence (`types.ts:133-134`, `loop.ts:1759`).
`input.resultSchema`, which the executor hands to the model, is either that
same name or inline JSON Schema text — `inlineObjectSchema` tells them apart by
trying `JSON.parse`. A name gives the model no constraint: Pi falls back to an
open object, Claude to `additionalProperties: true`, Codex to "whatever parses
as JSON". The CLI runner's review wrap keyed on the inline-vs-name ambiguity.
Two fields with one name and different meanings is the root of mismatch 1.

### 2.2 Why nothing fired

Recovery triggers are failure-shaped: `executor_failed`, `stalled`,
`plugin_*`, `correction_limit`, `environment_changed`. A mis-shaped success is
not a failure. `progressMark` hashes evidence content, and a fresh model
response is always new content, so the stall detector sees progress. The
plugin's own caps count through the plugin's own (broken) lookup. There is no
controller-owned counter of "agent dispatches for this stage since its last
receipt", so the controller had no independent way to notice six reviews and no
acceptance.

### 2.3 The point fix, and what it does not fix

`cli-runner.ts` now detects a review job from the job-level `resultSchema` tag
as well as the inline placeholder, preserves a plugin's own schema instead of
overwriting it, and forwards `prior`. That makes banyandb-fix's reviews land as
`kind: "review"`. It does not fix mismatches 2 or 3, does not help the next
plugin that declares a new schema, and — the deeper problem — it keeps a
plugin's schema name (`"review-verdict-v1"`) and a plugin's schema text
(`REVIEW_SCHEMA`) hardcoded in the composition root. The controller, SDK and
CLI own no plugin vocabulary: a plugin's steps, schema names and result shapes
are the plugin's. Moving that string into the controller would be the same
violation one layer down. It is a patch on B4 for one schema name, in a layer
that should not know the name at all.

## 3. Goals and non-goals

Goals:

- A result that does not match its declared contract is never recorded as a
  success. It is recorded, flagged, and either corrected by the agent in the same
  session or escalated with a precise reason.
- Evidence kind and schema validity are decided by the controller from one
  declaration, not by executors or CLI glue matching strings.
- Ids an agent is asked to reference are constrained to the set it was shown,
  and an unknown reference is a violation, not a silent miss.
- The controller notices "many dispatches, no acceptance" without depending on
  the plugin's own evidence lookups, and recovery always has budget to act.
- Every one of B1–B6 and B10 gets the B7–B9 treatment.
- The controller, SDK and CLI contain no plugin notion: no schema name, no
  step name, no result shape. Everything they enforce is read from what the
  plugin declared for this run.

Non-goals:

- Making agents infallible. The harness tolerates bad output; it does not
  prevent it.
- Changing what plugins may ask for. Plugins keep declaring schemas and reading
  evidence; only the plumbing between declaration and consumption changes.
- New graph steps. Correction happens inside the existing job (in-turn) or in
  recovery, per [run convergence](design-run-convergence.md).

## 4. Design

### 4.1 Plugin-declared result contracts (B1, B2, B4, B5)

`@graphloom/sdk` gains a *type*, not a registry. The plugin declares its
contracts in its `GraphDefinition`, next to the requirements that consume them:

```ts
interface ResultContract {
  name: string;                      // the plugin's own name for the shape
  schema: Record<string, unknown>;   // JSON Schema the model is constrained to
  evidenceKind: EvidenceRecord["kind"]; // SDK kind a valid result is recorded as
  /** Fields whose values must be ids from a set the plugin supplies at dispatch. */
  references?: string[];
}
interface GraphDefinition { /* … */ resultContracts?: ResultContract[]; }
```

The SDK ships no names and no schemas. hello declares its review contract
(today's `REVIEW_SCHEMA` moves out of the CLI into hello); banyandb-fix declares
its four (`DECISION_RECORD_SCHEMA`, `PLAN_REVIEW_SCHEMA`, `CODE_REVIEW_SCHEMA`,
`VERIFICATION_SCHEMA`), each already written and already next to the validator
that reads it. `evidenceKind` is the one thing a contract says in the
controller's vocabulary — the SDK's `kind` union is controller-owned, and it is
how the controller's own generic checks (`assertSeparateReviewer`'s
`kind === "review"`) stay generic. The run pins the declarations it was admitted
with, like executors are pinned.

Consequences:

- `JobSpec.resultSchema` is only ever a *name the plugin declared*.
  `input.resultSchema` goes away; the executor receives the schema text from the
  run's declarations (`run.ts:107-110` looks it up instead of forwarding a
  string). `inlineObjectSchema`'s name-vs-JSON guess is deleted. A job naming a
  contract its own plugin did not declare is refused at admission.
- Every harness always constrains output (B2). Pi's `submit_result` always has
  real `parameters`; Claude's `--json-schema` and Codex's prompt always carry the
  registered schema. "A name yields no constraint" cannot recur.
- `recordJobEvidence` (B4) validates `codingAgent.output` against the declared
  contract and sets `kind` from its `evidenceKind` when valid — mechanically,
  for whatever the plugin declared; the controller compares strings it was
  handed, never strings it knows. The CLI runner's `REVIEW_SCHEMA` and
  `reviewEvidence()` are deleted outright, not moved. `selfReportedKind` keeps
  its one job of downgrading an agent's *claims* about kinds it may not produce.
- Each record carries the outcome:

  ```ts
  contract?: { name: string; status: "valid" | "invalid" | "repaired"; problems: string[]; repairs?: string[] }
  ```

  An invalid result is still recorded (as `kind: "other"`, with the raw output)
  so nothing is lost, but it can never satisfy a requirement, and `inspect`
  shows it.
- Plugin parsers (B5) become thin: they read already-validated output. The four
  parsers converge on one behaviour — a contract-invalid record is `{problem}`,
  never a defaulted value. `reviewVerdict`'s `String(payload.verdict ?? "")` goes.

### 4.2 In-turn correction of structured results (B3)

Admission tools already do this for the supervisor: `reject(message)` returns
the problem to the model without ending the turn, and the model calls again.
The same shape applies to a job's structured result.

- Pi: `submit_result`'s `execute` validates against the contract (including
  reference sets, §4.3) and returns a non-terminating rejection listing the
  problems: `Rejected: findings[1].finding must be one of P1, P2 or ""; you gave a
  description. Call submit_result again.` It terminates only on a valid result.
- Claude and Codex: structured output is constrained by the schema at the CLI
  (B2 now guarantees that), so type-level problems are rare; reference problems
  are checked after the turn and, when found, one follow-up prompt carries the
  rejection and asks for a corrected result in the same session.
- Bounded: `MAX_RESULT_RETRIES` (2) per job. Past that the job fails with the
  last problems as its summary — a real `executor_failed`, not a silent
  `"other"`.

This gives the agent what the supervisor already has: the reason, in the turn,
with a chance to fix it.

### 4.3 Reference integrity (B6)

Fields listed in `ResultContract.references` are not free strings. At dispatch,
the plugin supplies the valid id set (it already computes it:
`knownPlanFindings(ledger)`, `knownFindings(ledger)`). The harness:

1. Puts the set into the per-dispatch schema as `enum: ["", "P1", "P2"]`, so a
   constrained model cannot write anything else (B2).
2. Validates membership at ingestion regardless (B4).
3. On a miss, attempts one deterministic reconciliation: an exact or
   whitespace-normalised match of the written value against the shown
   descriptions. A hit is recorded as `contract.status: "repaired"` with the
   substitution in `repairs`; a miss is a violation handled by §4.2.

Mismatch 2 becomes impossible under a constrained model and visible under an
unconstrained one.

### 4.4 Dispatch-time contract admission (B1)

When a dispatch is admitted, the controller checks that the job can produce
what its stage needs, using only declared data: `job.resultSchema` must name a
contract the plugin declared, and if a requirement of `job.stageId` names that
same contract as its `evidenceSchema`, the job's purpose and read-only flag must
be ones the controller may record that `evidenceKind` for (the existing
`selfReportedKind` rule, now applied before the job runs instead of after).
A refusal reads: `job names review-verdict-v1, which the plugin did not declare`
or `stage fix's requirement plan-reviewed consumes review-verdict-v1 (kind
"review"), which a non-read-only job may not produce`. The controller never
sees a schema name it was not given by the plugin. This is static and free,
and it would have refused banyandb-fix's first review dispatch before any
model call.

### 4.5 A contract-violation recovery trigger (B4, B10)

New `RecoveryTrigger.code`: `contract_violation`. Fired when:

- a job fails after exhausting §4.2's retries, or
- `K` (2) consecutive results for the same `(stageId, purpose)` are
  contract-invalid.

Its message names the contract, the field, and the last problems. A
`TRIGGER_GUIDANCE` entry tells the supervisor the remedies that apply: re-dispatch
with a corrected instruction, switch harness, or `qualify_repair` the plugin if
the plugin's own declaration is wrong.

### 4.6 Controller-owned acceptance accounting (B10)

Independent of any plugin lookup, the controller keeps per stage:

```ts
dispatchesSinceReceipt: Record<StageId, { agent: number; total: number; since: string }>
```

reset when a receipt for that stage is minted. It is observability only: it feeds
the budget-exhaustion message (§4.7) and recovery views, and does not trigger
recovery. An earlier fixed cap (4 agent dispatches without a receipt entered
`stalled`) was removed: a multi-pass stage such as a review sweep with
verifiers legitimately exceeds any fixed count while making progress, so the
cap misfired and invited needless supervisor turns. Runaway stages are caught
by `noteGraphDecision`'s repeat detector, the contract-violation streak, §4.7
budget pacing, plugin round caps and the finite budgets.

### 4.7 Budget pacing and a recovery floor (B10)

- `budgets.agentInvocations` gets a reserved floor, `recoveryReserve`
  (default `max(8, 5%)`). `reserveModelCall` (`children.ts:285-299`) denies
  normal-mode calls once remaining ≤ reserve and allows recovery-mode calls
  down to zero. `supervisor.decide()` can always run at least once.
- Pacing: when one stage has consumed more than `STAGE_BUDGET_SHARE` (50%) of
  the run's agent budget without a receipt, enter recovery (`stalled`, same
  message family as §4.6) while budget remains to act on it.
- A `stalled` episode whose run has produced new evidence (its progress mark
  moved) since the last recovery episode decided anything returns to normal
  on its first turn without a model call, and the remedy is recorded in the
  run's `remedies`. The return becomes the new baseline, so a stall with
  nothing new since then reaches the supervisor.
- The budget-exhaustion stop names the consumer: `agentInvocations exhausted:
  stage fix spent 502 of 600 across 6 review dispatches, 0 receipts`.

### 4.8 Observability

`inspect` adds `contracts: { valid, invalid, repaired, byName }` and
`dispatchesSinceReceipt`. Evidence records show `contract`. The design's own
test (§6.6) replays this run's evidence and must report 6 invalid-for-kind
review results and 2 reference misses.

## 5. Interfaces and seams

| Interface | Change | Owner |
|---|---|---|
| `ResultContract`, `GraphDefinition.resultContracts` | new type and field; plugin-declared, no built-in names | sdk |
| `JobSpec.resultSchema` | a declared name only; `input.resultSchema` removed | sdk, executors, plugins |
| `EvidenceRecord.contract` | new optional field | sdk, controller |
| `RecoveryTrigger.code` | `+ "contract_violation"` | supervisor, controller |
| `DurableRunState.dispatchesSinceReceipt` | new durable field, default `{}` | controller |
| `RunBudgets.recoveryReserve` | new, default derived | controller, intake |
| `recordJobEvidence` | validate + classify from the run's declared contracts | controller `loop.ts` |
| Dispatch admission | contract-vs-requirement check | controller `loop.ts` (`prepareDispatch`) |
| `reserveModelCall` | floor-aware | controller `children.ts` |
| `submit_result` / post-turn check | validate, reject in-turn, bounded retries | executors/coding-agent |
| `REVIEW_SCHEMA`, `reviewEvidence()` | deleted, not relocated | cli |
| `resultContracts` declaration | new, one per schema the plugin uses | hello, banyandb-fix |
| `reviewVerdict`, parsers | no silent defaults | banyandb-fix |
| `TRIGGER_GUIDANCE.contract_violation` | new | supervisor |

## 6. Verification

Controller:

1. A valid `review-verdict-v1` result from any harness records as
   `kind: "review"` with `contract.status: "valid"` — through
   `createCliRunner`, with each plugin's *real* `JobSpec`, not a scripted
   `evidence: [{kind: "review"}]`. (Closes the gap that hid mismatch 1: no test
   sent banyandb-fix's `planReviewJob` through the real runner.)
2. An output missing a required field records as `kind: "other"`,
   `contract.status: "invalid"`, and never satisfies the stage's requirement.
3. A dispatch whose contract cannot yield the stage's `evidenceSchema` is
   refused at admission with the §4.4 message.
4. Four agent dispatches for one stage with no receipt enter `stalled`
   recovery; a receipt resets the counter.
5. Normal-mode `reserveModelCall` is denied at the floor; a recovery-mode call
   is granted; `supervisor.decide()` runs after a budget-exhaustion failure.

Executors:

6. Pi: an invalid `submit_result` gets a rejection and the next valid call
   terminates; the third invalid call fails the job with the problems.
7. A reference field outside the supplied id set is rejected in-turn; a
   description matching a shown finding is repaired and recorded as such.
8. Every harness receives the registered schema text when the job names a
   contract; `inlineObjectSchema` is gone.

Plugin:

9. `reviewVerdict` on a contract-invalid record returns `{problem}`; the plan
   ledger treats it as a failed pass, not an empty approved one.

Replay:

10. This run's 20 evidence records as a fixture: the new accounting reports 6
    review dispatches since the last receipt (recovery would have fired at 4),
    6 kind-invalid results under the old rules, 2 reference misses.

## 7. Migration

- Each plugin declares the contracts it already has: banyandb-fix's four
  schemas (`ocr.ts`, `review-common.ts`, `decision-record.ts`,
  `plan-findings.ts`) become `resultContracts` entries; hello declares its
  review contract, taking the schema that today lives in `cli-runner.ts:24-42`
  with it. Nothing plugin-shaped remains in `apps/` or `packages/`.
- Plugins already set job-level names; they drop `input.resultSchema`.
- `input.resultSchema` is accepted for one release with a deprecation warning,
  resolved to a name when it is one and registered under the job-level name
  when it is inline JSON.
- Durable state: `dispatchesSinceReceipt` and `contract` default to absent; a
  resumed run starts counting from its resume.

## 8. Open questions

- Two plugins may declare different contracts under the same name; the
  controller only ever sees one plugin's declarations per run, so this is
  harmless — but a *repair* that changes a contract mid-run must invalidate
  receipts that rested on the old shape, like a validator change does today.
- `recoveryReserve` as a percentage interacts with very small budgets (hello's
  default 64); a fixed minimum of 8 may be too large there.
- Reconciliation in §4.3 is deliberately exact-match only. Fuzzy matching would
  recover more but can mis-attribute a genuinely new finding to an old id, which
  is worse than a rejection.
