# Supervisor robustness: grounded, bounded recovery

Implemented (2026-10-15 to 2026-10-18; see §7 for the PR behind each item). Extends the
[Pi supervisor design](design-pi-supervisor.md), the
[core design](design-typescript-core.md) §6 (recovery) and
[run convergence](design-run-convergence.md) §4.3. It changes when the
supervisor is called, what it sees, what it may propose, how its proposals are
admitted, and how it remembers across a long run. The pinned invariants stay: one
logical supervisor owns exceptional recovery, the controller admits its
decisions, the step set is fixed, only the controller issues receipts, and
budgets are finite.

## 1. What the live run showed

Run `9bfa446d-4ea` (banyandb-fix against apache/skywalking#14092, 2026-10-11 to
2026-10-14) succeeded and shipped as apache/skywalking-banyandb#1413. It needed
136 generations, 30 repair candidates, five supervisor-session compactions and
repeated operator intervention. Most interventions were not graph or plugin
defects; they corrected the supervisor.

| Observed | Effect | Operator remedy |
|---|---|---|
| The supervisor said `validate` "produces no receipts" for the Fix stage | It stopped the run | Direct `admitValidation` call (`verify-admit.mjs`) showed acceptance; an injected `validate` minted all seven receipts |
| It proposed `activate_repair` for a candidate already active | `repair-lifecycle.ts:680` stopped the run: "activate_repair missing qualified artifact" | Resume with an injected `return` |
| After resumes it repeated beliefs the new code had made false ("the fix is not on disk", "the wrapper corrupts my arguments") | Wasted episodes, wrong repairs | Read the file on disk, inject `return` |
| The session grew to about 926k input tokens | Provider "context window exceeds limit"; the run stopped with "no GraphDecision JSON" | Manual compaction (five times) |
| Provider quota (429), overflow and thinking-only replies all surfaced as "no GraphDecision JSON" | The real cause was visible only in the session `.jsonl` | Read the session log; wait for quota; compact |
| False "stalled" triggers (a fixed dispatch cap, pacing against a stale budget) woke the supervisor during healthy progress | Each extra episode was a chance for a wrong action | Remove the cap, fix the budget |

The pattern: **the supervisor asserts something about run state that is false,
and the run acts on it**, or the run stops because one proposal was
inadmissible. Every operator remedy above was a check or an action the
supervisor could not perform itself.

## 2. Root causes

### 2.1 Claims are ungrounded

The supervisor sees a JSON view (`buildRecoveryPrompt`,
`packages/supervisor/src/pi-supervisor.ts:347`) and replies in prose plus one
action. Nothing requires a claim ("validate would fail", "the patch is not
applied") to rest on evidence, and it has no tool to test a claim before acting:
it cannot ask what `admitValidation`, activation or checkout *would* do. The
operator could, with one function call.

### 2.2 One inadmissible proposal ends the run

Admission rejects an action whose preconditions fail by stopping the run
(`activate_repair` with no qualified artifact, `activate_repair outside
recovery`, and similar), and a decide error stops it too
(`loop.ts:366`, "supervisor decide failed"). A recoverable mistake in one turn is
treated like a hard blocker.

### 2.3 Memory is one ever-growing chat

A run-wide Pi session holds every episode's turns. It grows past the model's
window (§4.4 of this document replaces the compaction workaround), and it
carries conclusions from earlier code and earlier state forward as if they were
still true. The resume preamble ("do not treat an earlier rejection as still
true") is advice, not a mechanism.

### 2.4 The view is both too big and too thin

`evidenceRefs` lists every ref in the run (over a thousand here) on every turn,
while detail is given only for the current generation. The prompt is large and
still does not answer the question at hand.

### 2.5 Mechanical failures reach the model

Quota waits, context overflow, interrupted read-only jobs and transient executor
errors have known remedies, yet they either reach the supervisor as triggers or
stop the run as "supervisor decide failed". Each such episode costs a model
turn and risks a wrong action.

### 2.6 No measurement

There is no recorded set of supervisor episodes with known-good answers, so a
prompt or model change cannot be shown to help.

## 3. Goals and non-goals

Goals:

1. A false claim about run state is caught before it changes the run.
2. An inadmissible proposal never stops the run by itself; the supervisor gets
   the reason and another try.
3. The supervisor's working context stays bounded for a run of any length, and
   only verified facts survive an episode boundary or a resume.
4. Failures with a known remedy are handled without the model.
5. Stop reasons name the real cause.
6. Supervisor quality is measured against recorded episodes.

Non-goals: changing the step set or receipt rules; giving the supervisor
authority to accept requirements; teaching the controller plugin notions (the
plugin keeps declaring its contracts as data); replacing Pi.

## 4. Design

### 4.1 Admission feedback instead of stops

Split admission outcomes into **inadmissible** (a precondition fails: unknown or
non-qualified artifact, wrong mode, stage not current, malformed spec, repeated
no-progress proposal) and **blocking** (a real hard stop: budget exhausted,
operator stop, unrecoverable host failure).

- An inadmissible proposal is returned to the supervisor within the same
  `decide()` call as a tool error carrying the precondition that failed and the
  current value ("repair-f7a36302 is `activated`, not `qualified`; the active
  version is already banyandb-fix@repair-repair-f7a36302").
- After `MAX_INADMISSIBLE_PER_TURN` (3) rejections in one turn the episode ends
  with a recorded `supervisor_inadmissible` outcome and the controller applies
  the **safe default** for the trigger (normally `return` to normal mode when the
  graph can still dispatch; otherwise stop with the last rejection as the
  blocker).
- The JSON-fallback path (`decision.ts`) gets the same treatment: an
  unparseable reply is re-asked once with the parse error before it counts as a
  failed turn.

The admission tool list is also **narrowed by state**: a tool whose
preconditions cannot hold is not offered (no `activate_repair` without a
qualified candidate; no `qualify_repair` without repair authority). Narrowing is
a convenience; the admission check remains the authority.

### 4.2 Read and dry-run tools, and grounded claims

Add read-only tools the supervisor calls before deciding:

| Tool | Returns |
|---|---|
| `get_evidence(ref)` | One evidence record, payload bounded |
| `list_evidence(filter)` | Refs and one-line descriptions by stage, kind, generation, candidate digest |
| `list_receipts()` | Receipts with validity and binding |
| `read_candidate(path, range?)` / `diff_candidate()` | Worktree content and diff against the pinned head |
| `check_validate(stageId)` | What `admitValidation` would return now: accepted, evaluated, per-requirement reasons. No receipt is minted. |
| `check_activation(artifactId)` | Whether activation would be admitted, and why not |
| `check_checkout(spec)` | Whether a checkout spec applies to the current tree (for example a revert patch) |

Dry-runs run the real admission code against a copy of state and never persist.
They charge a small separate budget (`budgets.probes`), not `agentInvocations`.

**Grounding rule.** Every proposal carries `evidence: string[]`, refs or probe
ids. The controller rejects (as inadmissible, §4.1) a `stop`, a `qualify_repair`
against a controller or validator claim, or a `reenter` that cites no evidence
or probe produced in this episode. Prose reasons stay, but the action rests on
references the controller can check exist.

### 4.3 A deterministic recovery tier

Before invoking the model, the controller tries a fixed remedy table keyed by
trigger and failure class:

| Condition | Remedy | Model called? |
|---|---|---|
| Provider quota / rate limit with a reset time | Wait until reset (charged to `waitMs`), retry the turn | No |
| Provider context overflow | Compact (§4.4 makes this rare), retry once | No |
| Empty or thinking-only reply | Re-ask once with "call exactly one tool" | Once more |
| Interrupted read-only job | Retry (already implemented in `reconcile.ts`) | No |
| Executor transient failure (declared retryable by the executor) | Retry with backoff up to the executor's limit | No |
| `stalled` with new evidence since the last episode | Return to normal | No |

The supervisor host classifies provider errors (quota, overflow, auth, empty,
malformed) instead of collapsing them into "no GraphDecision JSON", and the stop
reason carries the class and the provider's message.

### 4.4 Episode sessions and a case file

Replace the single run-long chat with **one model session per recovery episode**,
seeded from a controller-owned **case file**:

```ts
interface CaseFile {
  facts: Array<{ id: string; text: string; evidence: string[]; since: number /* generation */ }>;
  refuted: Array<{ claim: string; by: string[] /* evidence or probe ids */ }>;
  attempts: Array<{ episodeId: string; trigger: string; action: string; outcome: string }>;
  open: string[]; // questions the last episode left
}
```

- The supervisor adds entries with a `record_finding` tool; the controller keeps
  a fact only if every cited ref exists, and marks a fact stale when the
  candidate digest or active plugin version it cites has changed.
- `attempts` is written by the controller from settlements, not by the model.
- A new episode's prompt is: the trigger, a short state summary, the live part
  of the case file, and the tool list. Detail is fetched with §4.2 tools.
- Resume needs no special preamble: stale facts are already marked, and the
  chat that held them is gone.
- The case file is bounded (`MAX_CASE_FACTS`, oldest stale facts dropped first)
  and stored in run state, so it is replayable.

Within an episode a session is short; compaction remains as a guard but should
not trigger in normal runs. Repair patch sessions (`patchCandidate`) stay
separate, as today.

### 4.5 Independent check of high-impact decisions

For `stop`, and for `qualify_repair` whose stated diagnosis is that the
controller, a validator or an executor is wrong, a **fresh reviewer session**
(same or stronger model, no shared chat) receives the proposal, its cited
evidence and the probe tools, and returns `confirm` or `refute` with evidence.
A refuted proposal is inadmissible (§4.1) with the reviewer's reason. This
mirrors the code-review verifier and the repair reviewer.

**Model ladder.** The configured model list gains roles: `routine` (episodes
resolved by `return`, `dispatch`, `validate`) and `escalated` (repairs, stops,
reviewer). The host picks by proposed action class, so a fast model handles the
common case.

### 4.6 Measurement: a supervisor replay set

Record each episode's input (trigger, state summary, case file, tool results it
requested) and its outcome. Build a replay set from run `9bfa446d-4ea` and later
runs, each episode labeled with an acceptable action set, for example:

| Episode | Acceptable |
|---|---|
| Fix complete per `admitValidation`, supervisor believes otherwise | `validate(fix)` |
| Candidate already active | `return` |
| Review confirmed findings | `reenter(fix)` or `dispatch(work)` with the findings |
| Revert patch no longer applies | ask for a fresh revert, not a controller repair |

The replay runner (built on [graph rehearsal](design-graph-rehearsal.md)) scores
a supervisor configuration: accuracy, inadmissible proposals per episode, probes
per episode, tokens per episode. CI runs it with a scripted or faux provider;
live scoring is opt-in.

## 5. Interfaces and seams

| Seam | Change |
|---|---|
| `@graphloom/sdk` | `GraphDecision.evidence?: string[]`; `CaseFile` type; probe result types; `SupervisorInput.caseFile` |
| `@graphloom/controller` | Inadmissible vs blocking admission outcome; safe default per trigger; probe API (`probeValidate`, `probeActivation`, `probeCheckout`) over a state copy; deterministic remedy table; case-file persistence and staleness |
| `@graphloom/supervisor` | Read and probe tools; state-narrowed admission tools; in-turn retry on inadmissible; provider error classification; per-episode sessions; reviewer session; model roles |
| Plugins | No change required. Plugin evidence is read through generic tools; the controller still knows no plugin schema names |

## 6. Verification

1. An `activate_repair` for an already-active candidate returns an in-turn error
   naming the current status, and the supervisor's next tool call is admitted;
   the run does not stop.
2. Three inadmissible proposals in one turn apply the trigger's safe default.
3. `check_validate` returns the same verdict as a real `validate` and persists
   nothing (state revision unchanged).
4. A `stop` with no evidence is rejected; with evidence that a reviewer refutes,
   it is rejected with the reviewer's reason.
5. A quota error waits until the reset time and retries without calling the
   model again; an overflow compacts and retries; neither stops the run.
6. Stop reasons for provider failures name the class and message.
7. A fact citing a candidate digest that has changed is marked stale and is not
   in the next episode's prompt.
8. A run with 50 recovery episodes keeps every episode prompt under a fixed
   token bound.
9. The replay set from run `9bfa446d-4ea` scores at least the current
   supervisor on accuracy, with zero stops from inadmissible proposals.

## 7. Delivery plan

Each item is one issue whose behavior can be verified and observed on its own
(tracking: hanahmily/graphloom#115).

| # | Issue | Design | Depends on | Delivered in |
|---|---|---|---|---|
| R1 | #117 A bad proposal never stops the run | §4.1 | — | #123 |
| R2 | #118 Provider failures are handled or named | §4.3 | — | #124 (+ #128 timeouts, #129 slips, #139 transient errors) |
| R3 | #119 Decisions grounded in evidence and dry-run probes | §4.2 | R1 | #134 (issue-fix dogfood run `4c70ff66-dd9`) |
| R4 | #120 Bounded memory, one session per episode, verified facts only | §4.4 | R3 | #126 |
| R5 | #121 Independent reviewer with model roles | §4.5 | R3 | #142 (issue-fix dogfood run `cbef664d-c46`) |
| R6 | #122 Episode recording and a scored replay set | §4.6 | — | #143 (issue-fix dogfood run `395ec998-6e4`) |

## 8. Open questions

1. Should probes share `agentInvocations`? Proposed: no, a separate small
   `probes` budget, since they make no model calls.
2. Safe default when the graph cannot dispatch: stop, or one more episode with
   an escalated model? Proposed: one escalated episode, then stop.
3. Should the case file be visible to the plugin? Proposed: no; it is controller
   and supervisor state.
