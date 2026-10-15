# Graph rehearsal: verifying a graph can run before it runs

Status: rollout step 1 implemented, 2026-10-03 (§7); all three example
plugins' `happy` scenarios genuinely recorded from real successful live runs,
2026-10-04 (§4.5, below). All four provider-free/bounded rungs run for real:

- `check` (L0) and `rehearse` (L1) against hello and release end to end —
  real controller, real plugin host, real Pi harness code, a scripted
  stand-in model, zero provider calls, both reaching `ready`.
- `replay` (L2) against the recorded `879ee04f-e57` run this design was built
  from: reclassifies its evidence under the current contracts (6 of 7 agent
  results valid, the one recorded mid-budget-exhaustion correctly invalid),
  re-evaluates `plan-reviewed` with the current validator (now correctly
  `failed`, naming the still-open findings, instead of the six-pass loop that
  originally burned the run's whole budget for no receipt), and reports what
  the current `advance()` would do next (stop, naming the same findings).
- `probe` (L3) dispatches one real job to the real configured harness (bounded
  to `MAX_PROBE_MODEL_CALLS`, 10) with the exact assignment a free rehearsal
  rendered for the named contract, and reports the controller's own contract
  check against the real result. Run for real against banyandb-fix's
  `code-review-v2` on a real, logged-in Codex CLI (not a stand-in): correctly
  routed to Codex rather than the runner's default harness (a real bug, found
  and fixed — see below), spent 5 of its 10 budgeted calls on open-code-
  review's own multi-step tool workflow, and returned a contract-valid result
  (`{comments: [], prior: [], summary: {total_files: 0, ...}}`, correct for a
  fixture with no uncommitted change to review).

Claude Code and Codex now have stand-ins too (§4.1): not a `CodingHarness`
factory substitution like Pi's (both run as separate spawned processes, not
in-process model calls), but small executables (`executors/coding-agent/src/
rehearsal/{codex,claude}-standin.ts`) bound as `codex.command`/`claude.command`
in a rehearsal's `RunnerConfig`, spoken to by the real, unmodified
`codex-harness.ts`/`claude-harness.ts` exactly as a real `codex`/`claude`
binary would be — NDJSON progress plus an `--output-last-message` file for
Codex, the stream-json control protocol for Claude Code. Verified directly
against the real harness adapters (18 tests: the seam guard, a scripted
happy path, assignment-fidelity refusal, `harnessSupplied`, effects written
to the worktree, schema synthesis when a contract has no scripted reply, all
three `fail` kinds, and a signal-driven abort), and wired unconditionally
into `performRehearsal()`'s `RunnerConfig` alongside Pi.

banyandb-fix — the plugin that actually dispatches to all three harnesses —
now has a `rehearsal.ts` happy scenario and reaches `ready` live through the
real controller, its real environment checks, and all three stand-ins (the
plan, its review, the implementation, and the code review, each a real
dispatch with a real contract-checked reply). This is the first rehearsal to
exercise a real plugin's GitHub reads too: `RunnerConfig.github` gained a
`baseUrl` (threaded into `githubBinding()`, which already supported it) so a
rehearsal can point the GitHub executor at a fixture server, and
`performRehearsal()` now enables it unconditionally, same as the three coding
harnesses. `probe` has now been exercised against a real model too (above).

2026-10-04: all three example plugins' `happy` scenarios are now genuinely
recorded with `graphloom rehearse --record-from` (§4.5) from real, successful,
isolated live runs — hello and release cleanly, banyandb-fix after real
convergence work, not a hand-authored guess at what a model would say,
matching §4.5's own stated goal for the first time end to end. Four real bugs
surfaced and were fixed along the way:

- `--record-from` silently dropped a valid/repaired review-kind result that
  flattens to its own payload with no `codingAgent` wrapper (the same shape
  `classifyAgentResult`, `packages/controller/src/loop.ts`, already leaves
  behind) — found recording hello's own review stage.
- `--record-from` never attached a work dispatch's own file-kind evidence (the
  actual bytes a job wrote) as `effects` on its reply — found the same run: a
  replayed scenario answered the right JSON shape but never wrote the file a
  requirement validates.
- `--record-from` attributed file-kind evidence to whichever reply was most
  recently pushed, with no check that it was from the same generation — found
  recording banyandb-fix's run: a supervisor's own diagnostic `observe` during
  a later recovery episode read files a work dispatch had already written,
  generations after that dispatch's own (unrelated, stale) reply, and the file
  evidence landed on that stale reply instead of nowhere. Now gated on
  `record.generation` matching the reply's own generation, since a dispatch's
  real effects never cross a generation boundary but a later, unrelated
  observe can still share the "most recently pushed reply" heuristic.
- `readWorktreeFile` (`packages/controller/src/worktree.ts`) crashed the whole
  run with an uncaught `EISDIR` when a real model's plan legitimately quoted a
  directory path (a Go package path, `./pkg/timestamp`) in a field the
  controller later `observe()`d — generic, plugin-agnostic, surfaced as
  `stopReason: "observe rejected"`. Fixed with a directory check that reports
  the path missing instead, the same convention `observeWorkspace` already
  uses for a path that does not exist.

One gap `--record-from` cannot close by itself, not a bug: Fix's RED/GREEN
requirements validate by running real commands against a real checkout, never
by the graph `observe()`-ing the implementer's own written files, so the
controller's evidence never captures `pkg/timestamp/scheduler.go`'s or
`scheduler_test.go`'s bytes as a replayable effect. banyandb-fix's own
`rehearsal.ts` supplements those two files' bytes by hand, copied verbatim
from the live run's own worktree the moment it succeeded, same as the
original hand-written scenario did — the only hand-authored part of an
otherwise fully recorded scenario, and transparently commented as such.

banyandb-fix's own Review stage also exposed two genuine bugs beyond
recording fidelity, both now fixed with regression tests:

- The supervisor's `executor_failed` guidance (`TRIGGER_GUIDANCE`,
  `packages/supervisor/src/pi-supervisor.ts`) said "retry the dispatch,"
  readable as "use the `dispatch` tool," for a stage pinned to a non-default
  executor whose `input` shape (e.g. `input.assignment`, a harness choice) is
  plugin-specific and invisible to the supervisor — every guessed dispatch
  failed the executor's own input-schema validation. Guidance now tells the
  supervisor to check the stage's own `agentSessions[].executorId` first and
  prefer `return` (letting the graph's own `advance()` reissue the dispatch it
  already knows how to shape) unless the default built-in agent executor is
  pinned, where a plain instruction-only dispatch is safe.
- `review()` (`examples/plugins/banyandb-fix/src/graph.ts`) treated any
  unusable review pass (incomplete coverage, a crash, a non-read-only run) as
  a final verdict to re-evaluate forever, with no retry at all — found live,
  when open-code-review's own default path filter excluded the new test file
  from delegation review on the first pass. An unusable pass now retries a
  fresh pass the same way a sweep continuation does, bounded by the same
  `MAX_SWEEP_PASSES` cap, instead of handing a transient failure to the
  supervisor on the very first attempt.

Separately, not a bug: open-code-review excludes `*_test.go` from delegation
review by its own documented default path filter
(`internal/agent/selection.go`'s `default_path` gate, upstream). A project or
user `rule.json`'s `include` glob overrides it (`.opencodereview/rule.json`
or `~/.opencodereview/rule.json`); the live run that produced banyandb-fix's
recorded scenario used the global layer, since the fixture's own repo is not
part of this one. A real plugin reviewing real test files needs this
configured in its own environment — out of scope for the graph itself to fix.

Quick mode's command stubbing (§3.2) is built and is now the default for
`rehearse`/`probe`: a fourth stand-in, `executors/command/src/rehearsal/
command-standin.ts`, answers each command job from the scenario's own
`commands` map (a plain success when the scenario names nothing for that id)
instead of running it, bound in place of the real command executor module the
same way the three coding harnesses are. Environment checks run for real in
both modes, as designed — including the part found live, not written down
up front: a checkout's own re-preparation of the environment's checks
(`runInCheckout`) dispatches the identical id set under the *checkout job's
own* instruction ("RED check", "Candidate checks"), not a recognizable
environment-check one, so the CLI runner's router (which sees the full job,
unlike an executor) tells the two kinds of command dispatch apart by the
command-id set itself — exactly the environment's own declared checks and
prepare commands, together and alone — not by instruction text, which only
caught the once-per-run preflight and missed every checkout's own. A known,
real limitation, not a bug: a validator whose requirement needs the *same*
command id to behave differently per checkout (RED failing on the base
commit, GREEN passing on the candidate, as banyandb-fix's own does) cannot be
represented by `RehearsalCommandResult`'s one declared outcome per id, so
banyandb-fix's own Fix stage still rehearses with `--commands run`; its
`rehearsal.ts` scenario declares no `commands` at all, since the only
plugin that could use them yet does not.

B2's capability probe is built too (`apps/graphloom/src/capability-probe.ts`):
each enabled spawned-CLI harness (Claude Code, Codex; Pi is in-process, with
no `--help` to ask) runs its own `--help` (Codex's own `exec --help`, since
its flags are the `exec` subcommand's own, not the top-level binary's) and
checks that every flag its own adapter actually passes it is named there —
`CLAUDE_CODE_ADAPTER_FLAGS`/`CODEX_ADAPTER_FLAGS`, exported from
`claude-harness.ts`/`codex-harness.ts` themselves (next to the `cli.push(...)`
calls they must stay in sync with, not re-derived from them, since the
control flow that builds the real array is not easily walked without running
a session). Run for real against this machine's installed, logged-in
`claude`/`codex`: `passed`, no flag missing. Wired into both `check` (L0) and
`rehearse`'s own B2 boundary (the real operator config, not a rehearsal's own
stand-in one — the question is the same one the gate in `run` will ask: would
a live run find what its adapters need).

Everything proposed in §3-§4 is now built and verified: `--record-from`
(§4.5), `--offline` (§4.6), `--synthesized` (§4.4), `--adversarial` (§4.4), and
B3's per-job call-log provenance check (§4.1, §4.7), scoped down to the
identity tuple that is actually tractable to thread end to end (below). The
gate in `run` (§3.5) was also built, then reverted the same day: it hard-blocks
every real run against a plugin's real target, not only a broken one (§3.5,
§8).

B3's provenance check is narrower than the text's own "job identity" framing
of (`operationId`, contract, stage, purpose): it cross-checks `operationId`
and contract name only. `stageId`/`purpose` are threaded the same way (job
input → `CodingRunRequest.identity` → `JOB_IDENTITY_ENV` for the spawned
harnesses → each stand-in's own call-log entry) and are available to extend
the cross-check later, but the check itself does not yet compare them: a
`stageId`/`purpose` mismatch at a *fixed* `operationId` is not a reachable
failure mode in the current controller (both are stamped once per dispatch
from the same `JobSpec` the operationId itself was minted for), unlike an
`operationId` reused across two different dispatches, which is exactly the
"continued session mixing turns" class the text describes.

`--adversarial` covers three of its text's four mutations generically
(dropped required property, shown-description-in-reference, effect outside
write scope — each exercised by every plugin's own `--adversarial` rehearsal
to whatever extent that plugin's own contracts/replies offer); the fourth
("a job whose purpose may not produce its kind") is a deliberate scope cut,
recorded under Decisions (§8): it needs a job-dispatch-level mutation, not a
reply-level one, and the existing B1 admission check already covers it
independent of this mode. It also, by design, demonstrates at most one
mutation per rehearsal run for most plugins: a happy scenario scripts no
supervisor decisions, so the first adversarially-induced failure that needs
recovery (every mutation except the reference-description repair, which
resolves transparently, and Pi's own in-turn retry, which resolves within
one dispatch) halts the run before any later dispatch is ever reached. This
is accepted, not worked around — see Decisions.

Deliberate implementation choices beyond the text, each found by running the
real mechanism rather than by inspection: (1) a rehearsal's reply cursor is a
small file beside the scenario, not in-memory state, because every agent job
is a fresh child process (§4.1) — found when `release`'s second write job
silently produced an empty `CHANGELOG.md`. (2) Replay's reclassification must
reattach a flattened record's producer metadata (`stageId`/`purpose`), which
a plugin's own stage-scoped evidence lookup (e.g. `reviews()`) needs — found
when the real banyandb-fix replay's `plan-reviewed` re-evaluation reported
"the plan has not been reviewed" despite six reclassified `review` records
being present, because they had lost the producer that lookup filters on.
(3) Codex and Claude Code's wire protocols hand a spawned process the result
contract's *schema* (an `--output-schema` file; an inline `--json-schema`
argument) but never its *name*, which a stand-in needs to pick the right
scripted reply; rather than widen the scenario format to match by schema
content (fragile once reference narrowing is in play) or fork the production
harnesses' calling convention, both harnesses now also set a `GRAPHLOOM_JOB_
CONTRACT` environment variable on the child's own environment — invisible to
a real `codex`/`claude` binary, read only by a stand-in replacing one. (4) The
three stand-ins were written fresh rather than moved from `test/fake-claude.mjs`/
`test/fake-codex.mjs`, departing from this doc's literal "move from test/ into
a shipped entry": those fixtures are feature-rich but test-specific (subagent,
background and resume-script formats with no `RehearsalReply` analog), and the
real shared surface — one reply per contract, effects, assignment fidelity,
the three `fail` kinds — was small enough to implement directly against the
same `scenario.ts` client Pi's stand-in already used. (5) Both stand-ins'
`#!/usr/bin/env node` shebang is rewritten at build time
(`executors/coding-agent/scripts/patch-standin-shebang.mjs`) to the absolute
path of the Node that built them: `createCodexHarness`/`createClaudeCodeHarness`
spawn a stand-in as the whole command (the CLI args are fixed, so there is no
`node <script>` wrapper to control), so it depends on its own shebang to find
an interpreter, and `env node` resolves via `PATH` — which a rehearsed
plugin's own environment declaration can rebind. Found live: banyandb-fix's
environment check (and its rehearsal fixture, matching its existing e2e
test) installs a fake `node` satisfying only `node --version`, and once it
shadowed the real one on `PATH`, the Claude Code stand-in "ran" (exit 0, no
stderr) without ever executing a line of its own code — an unmistakable-once-
found, nearly undiagnosable-until-then failure, since every other signal
(the resolved `command` path, the spawn succeeding, the exit code) looked
correct. (6) A second, real, pre-rehearsal bug surfaced the same way:
banyandb-fix's own `evidence.ts#agentRuns()` read a coding-agent result only
from its `codingAgent` wrapper, never the flattened shape a *valid* "review"-
kind result takes once the controller's own `classifyAgentResult` (§4.3)
strips that wrapper — meaning a real, convergent code review could never mint
a receipt, in a real run as much as a rehearsed one. banyandb-fix's own e2e
test never caught this because its fake runner always wraps in `codingAgent`
directly, bypassing the controller's real contract-flattening path entirely;
this rehearsal is the first thing to exercise that path for this plugin at
all. Fixed in `agentRuns()` itself (fall back to the bare, producer-stripped
payload for a `"review"`-kind record with no wrapper), not in the rehearsal
plumbing, since a live run needed the same fix independent of this design.
(7) `probe`'s own job construction named no `executor`/`input.harness` at
all, so `createCliRunner` always routed it through `pinJobExecutor`'s legacy
default — silently the runner's own default harness, never the contract's
actual one. Every prior test used a stubbed runner that ignores the job
entirely, so nothing caught it until a real probe of banyandb-fix's Codex-only
`code-review-v2` would have silently asked Claude Code instead. Fixed by
having `recordAssignment` (§4.1) capture which harness carried a contract
alongside its assignment text, so `probe` can pin the real job to that same
harness (`executor: {id: CODING_AGENT_RUN_ID}`, `input: {assignment,
harness}`) instead of falling through to a default. (8) That same real probe
also showed `MAX_PROBE_MODEL_CALLS: 3` (sized for "one assignment in, one
result out, plus a little correction room") is too tight for a tool-heavy
contract: open-code-review's own delegation workflow spends a model-request
reservation per round trip before it ever produces an answer, and the first
real run was terminated mid-workflow with no result at the old bound. Raised
to 10; the real run that prompted it finished in 5. (9) The scenario-file
client (`requireScenario`, the reply/command/assignment cursor files, the
two env var names) moved from `executors/coding-agent/src/rehearsal/
scenario.ts` into `@graphloom/sdk` (`rehearsal-client.ts`), once the command
executor's own stand-in needed it too: the env var names and the cursor
files' shape are a cross-process invariant between whichever process wrote
the scenario (`rehearse`) and whichever reads it, so a second hand-duplicated
copy was the wrong call (unlike, say, `dispatchKey`'s small, independently-
stable duplication elsewhere in this codebase) — both packages already
depended on the SDK, so this widens nothing. The old module path still works,
re-exporting the SDK's own. (10) `--record-from` groups agent results by
`EvidenceRecord.resultSchema` (the dispatching job's own declared contract,
stamped unconditionally by `recordJobEvidence`), not `EvidenceRecord.contract?.name`
(only populated once a validator actually checks the result against a
contract the *current* definition still declares) — confirmed against the
real recorded `879ee04f-e57`, where every one of its 20 records has
`contract: undefined` (the run stopped on a budget before any validate ever
ran) yet each carries its own `resultSchema`. A failed agent result pairs
with its sibling `executorFailure` record by `operationId` for the fail
reply's summary. Environment-check command evidence (the once-per-run
preflight and every checkout's own re-preparation) is excluded from the
recorded `commands` map by the same `environment` payload stamp
(`environment.ts`) the earlier quick-mode-stubbing routing fix (§3.2) relies
on — those commands are never stubbed, so recording them would be noise no
rehearsal ever reads. (11) `--offline`'s GitHub stand-in runs unrestricted,
like the command and coding-agent stand-ins, not sandboxed like the real
`@graphloom/executor-github` package it replaces — found live, twice, by
running a real rehearsal rather than a unit test against the stand-in alone.
First: a sandboxed child inherits none of the parent's environment (only
what its binding's own `env` sets), so the stand-in's `requireScenario()`
never saw `GRAPHLOOM_REHEARSAL_SCENARIO` at all. Fixing only that surfaced
the second, structural one: Node's permission model grants a sandboxed
package `--allow-fs-read` over its own package closure and nothing else, with
no `--allow-fs-write` at all — so even with the env var visible, the
stand-in's cursor sidecar (the same file-beside-the-scenario mechanism
`nextReply`/`nextCommandOutcome` already use, since every read is a fresh
child process) could read the scenario once but could never write its own
cursor or log an unrecorded read. Both are symptoms of the same mismatch:
the sandboxed/unrestricted split exists for *plugin-facing* executors (real
network calls, a real token, a real write to GitHub), not for shipped,
trusted stand-in code whose only side effect is a sidecar file inside the
rehearsal's own scratch directory — exactly the trust and isolation already
given to every other stand-in. `cli-runner.ts` now overrides the stand-in's
own manifest copy to `isolation: "unrestricted"` (plus the matching
`allowUnrestricted: true` on its binding) only when `--offline`'s module is
substituted; the real package's own manifest, served whenever a live run or
an online rehearsal uses it, is untouched. (12) `--synthesized` is one
boolean, carried as an env var (`GRAPHLOOM_REHEARSAL_SYNTHESIZED`) the same
way `REHEARSAL_SCENARIO_ENV`/`REHEARSAL_HOME_ENV` already are — in-process
for Pi, `passEnv`-forwarded to the spawned Claude Code and Codex stand-ins —
rather than a new scenario field or a second code path through each
stand-in's reply logic: every stand-in already computed `scripted ??
synthesized`, so the flag only needed to force the left side to `undefined`.
It touches only the three agent stand-ins; quick mode's command stub and
`--offline`'s GitHub stand-in have no schema to synthesize from and are
unaffected. (13) `--adversarial` surfaced a real, previously-undiscovered bug
in `checkReferences` (`packages/sdk/src/result-contract.ts`), found by
exercising the reference-description repair mutation against a path shaped
like banyandb-fix's own declared ones (`"findings[].finding"`) rather than
the simpler top-level path (`"finding"`) every existing test used:
`walkAndCheck`'s array branch tested `Array.isArray(node)` on the *parent*
object a path segment's own array flag describes, before ever navigating to
the array that flag actually names, so the check was always false and every
array-wrapped reference path — the only shape any real plugin (banyandb-fix)
declares — silently passed every value through unchecked and unrepaired,
never flagging a bad reference or reconciling a shown description. Fixed by
navigating to the named property first and branching on its own array-ness
second; `mutateAdversarially`'s own `setAtPath` (the injection side) had the
identical inversion and got the identical fix. Both are now covered directly
(`packages/sdk/src/result-contract.test.ts`), independent of `--adversarial`,
since this is a live-run correctness bug, not a rehearsal-only one. (14) The
out-of-scope effect's own path is a sibling inside the worktree
(`.graphloom-adversarial-stray-write`), not a parent of it
(`../graphloom-adversarial-stray-write.txt`, the first attempt) — found live,
the rehearsal reaching `ready` when it should not have: the controller's own
scope check (§4.7) diffs the worktree's own git status, which cannot see a
write that landed outside the worktree directory at all, so the stray file
was real but invisible to the only mechanism meant to catch it. (15) B3's job
identity travels as one JSON-encoded env var (`GRAPHLOOM_JOB_IDENTITY`), not
three separate ones, set alongside the existing `JOB_CONTRACT_ENV` at the
exact same call site in each harness adapter — the identity and the contract
name have the same lifetime and the same one real consumer (a rehearsal
stand-in), so one encoding is simpler than three without losing anything.
`operationId` needed no new plumbing at all (`ctx.operationId` already
reaches `run.ts`); `stageId`/`purpose` do not exist anywhere below the
controller's own `JobSpec`, so `cli-runner.ts` — the one place already
holding both the full `JobSpec` and the input object it hands the agent
executor — injects them into that input alongside what the plugin itself
declared, rather than widening `ExecutorContext` (every executor's protocol,
not just coding-agent's) to carry two fields only one rehearsal check reads.
`checkB3`/`producerOf` moved from private to exported so the CLI could reuse
the controller's own canonical "malformed agent evidence" check instead of a
second copy, merging it with the call-log cross-check the same way `--offline`
already merges into B2.

Follows
[agent–harness contract robustness](design-agent-contract-robustness.md),
which fixed what the live runs of
[`examples/plugins/banyandb-fix`](../examples/plugins/banyandb-fix/) found. This
design is about finding the next defect of that class in under a minute and for
zero provider calls, instead of after a run has spent its budget, and about
making the finding durable: a verdict that names the boundary, and a fixture
that keeps the defect found.

## 1. What the live runs cost, and what they needed

The recorded run (`graphloom-state/879ee04f-e57` under the BanyanDB checkout)
stopped with zero receipts after 600 provider calls and about 48 minutes of
active time: one plan (98 calls), six plan-review passes (33–111 calls each),
nine command results, no acceptance. Every defect it exposed was structural — a
review recorded under the wrong kind, an id written as its description, a budget
with nothing reserved for recovery. None depended on what the model *said*,
only on how its output moved through the harness and the controller. A stand-in
model returning a canned, well-formed review would have reproduced all three in
one pass of the graph. The second live attempt verified the point fix the same
expensive way, because nothing cheaper existed.

The repository already holds most of a cheap verifier, scattered across test
fixtures and never reachable from the CLI: a Pi harness on a faux provider
(`apps/graphloom/test/fixtures/pi-faux-harness.mjs`), a Claude Code protocol
peer (`executors/coding-agent/test/fake-claude.mjs`), a Codex stand-in
(`fake-codex.mjs`), a scripted runner and supervisor, each plugin's validator
qualification cases (`scripts/qualify.mjs`), and the graph's own environment
checks (`definition.environment.checks`). What is missing is the composition:
stand-ins that answer from what the plugin declared, an evaluation of a finished
run that says more than `status`, and a gate that runs it before a live run.

Prior art: Vajra, a sibling Go orchestrator, solves the same problem with
`vajra workflow dryrun` — a stand-in agent CLI behind the real adapters,
hand-written per-workflow scenarios, and a report that names its one seam of
unreality. Four of its lessons were paid for with real bugs and are taken here:
a stand-in must read the prompt, not only its playbook (§4.3); the seam must be
proven before the run, because a mis-wired stand-in looks like a slow run, not
a broken one (§4.2); a scenario must be able to fail, hang and go silent, not
only succeed (§4.4); and a report must name what it stood in for and what it
did not check (§4.7). §8 records what Vajra does that this design deliberately
does not take.

## 2. Goals and non-goals

Goals:

- An operator, or `graphloom run` itself, learns in under a minute and for zero
  provider calls whether this graph, this plugin version, this runner
  configuration and this machine can carry a run from intake to receipts.
- The verdict names the boundary that failed (B1–B10 of the contract-robustness
  design) and the evidence record, not "stopped" — and names what it did not
  check, so a green verdict is read next to its own limits.
- Every failed live run becomes a replayable fixture, so the defect it found
  stays found when the plugin or the harness changes.
- Real tokens are spent only opt-in, bounded per contract, and only on the one
  question a stand-in cannot answer: how the real model behaves against a real
  schema on this harness.
- The controller, SDK and CLI learn no plugin notion: fixtures are plugin data,
  stand-ins compare strings the plugin declared or the job carries, evaluation
  reads generic state.

Non-goals:

- Judging the quality of a model's work. Rehearsal judges plumbing and
  convergence, not whether a fix is right.
- Replacing unit tests of plugins or packages.
- Guaranteeing a live run succeeds. It guarantees the run can *proceed*: every
  boundary carries a well-formed result, and the graph converges on one.

## 3. A verification ladder

Each rung is cheaper than the one above it and answers a narrower question.
`run` climbs the first two itself (§3.5). A rung that cannot run on this
machine — no stand-in for a configured harness, a plugin host that will not
start — reports a named `skipped`, never a silent pass.

| Rung | Command | Time | Provider calls | Answers |
|---|---|---|---|---|
| L0 static | `graphloom check <task.yaml>` | < 10 s | 0 | Does the declared data agree with itself — contracts, requirements, validators, fixtures — do the harness binaries have what the adapters use, and would the real validators accept the scenario's replies? |
| L1 rehearsal | `graphloom rehearse <task.yaml>` | 20–60 s quick; minutes in full mode | 0 | Does a well-formed result travel every boundary and get accepted? Does the graph converge within a small budget? |
| L2 replay | `graphloom replay <stateDir>` | < 5 s | 0 | Would a recorded run's real outputs be accepted under the current code and plugin? |
| L3 probe | `graphloom probe <task.yaml> --contract <name>` | ~1 min per contract | ≤ 3 per contract | Does the real model on the real harness produce what this contract demands? |
| L4 live | `graphloom run <task.yaml>` | hours | 10²–10³ | The task. |

### 3.1 L0: static check

Intake the task, load the pinned bundle in its child host, `describe()`, run
`environment.checks` (fast, already real), then check what can be checked
without running the graph:

- every requirement whose `evidenceSchema` names a declared contract has a
  validator binding, and every declared contract's schema uses only the keyword
  subset `validateResultShape` enforces — an unsupported keyword is refused,
  not silently ignored, so a contract cannot look stricter than it is;
- each enabled harness binary has the capabilities its adapter uses, asked of
  the binary rather than read from a version: every flag the adapter passes
  (`--json-schema`, `--output-format stream-json`, `--resume`,
  `--output-schema`, …) appears in the binary's `--help`. A binary whose help
  cannot be read is `unverified`, never a pass. A stale binary that silently
  lacks a feature is a B2 defect found here for free;
- the plugin's own qualification cases pass (`scripts/qualify.mjs` against the
  installed bundle itself, the check repair already runs);
- the scenario's replies (§4.4), when the bundle ships them, each validate
  against their contract through the same `validateResultShape` the controller
  uses — a fixture can be no more lenient than the run — and are then walked
  through the plugin's real validators, statically: each reply is classified
  exactly as `recordJobEvidence` would classify it (kind, `contract`), staged
  as that stage's evidence, and the stage's validators are called on it in the
  plugin host, read-only. A validator that reads only agent evidence gives a
  deterministic verdict; one that also needs command or file evidence quick
  mode stubs is reported `unverified` for this walk, not guessed. This is the
  contract-versus-parser check (B5) at L0 cost: a scenario can be green under a
  plugin's unit simulation and still assert a journey the real validators would
  refuse.

L0 cannot see which contracts `advance()` actually asks for, or in what order;
that is plugin code, and L1's job.

### 3.2 L1: rehearsal

The real system end to end, with one substitution. Real controller, real plugin
child host, real `createCliRunner`, real executor child processes, real harness
adapters (Pi's session machinery and `submit_result`, Claude Code's stream-json
protocol and `--json-schema`, Codex's `exec` and `--output-schema`), real
GitHub reads (fast, and they verify the token; `--offline` replays recorded
ones). Substituted:

- the model, by a stand-in (§4.1) that answers from the plugin's scenario by
  contract name and checks the assignment asked for what it is about to say
  (§4.3);
- command jobs, stubbed from the scenario by default (`--commands stub`),
  because BanyanDB's `make test-ci` dominates wall time; `--commands run`
  executes them for the full environment verdict;
- the supervisor, by a scripted one whose default script is "no decision
  expected": entering recovery is a finding unless the scenario's `expect`
  names the trigger it meant to reach (§4.4).

*Quick mode* is the default and what the gate runs: the model is a stand-in
and command jobs are stubbed, so the only real work is process startup and the
graph's own routing — tens of seconds. *Full mode* (`--commands run`) keeps the
stand-in model but executes every command job for real against the real
checkout, so the toolchain, the build and the tests are verified on this
machine; on BanyanDB that is as long as `make test-ci` takes. Environment checks
run for real in both modes; they are fast and are the graph's own statement of
what the machine must have.

Budgets are small (`agentInvocations: 24` unless the scenario says otherwise;
a stand-in turn costs one call like a real one), so a graph that cannot
converge cheaply surfaces as a `stalled` or budget finding in seconds rather
than running long. The rehearsal runs hermetically (§4.6) in its own worktree
and state directory under `<stateRoot>/rehearsals/<fingerprint>/`, removed on
a `ready` verdict unless `--keep`.

What L1 would have reported for the three live-run defects, before their fixes:

1. Evidence kind: the stand-in's review reply records as `kind: "other"`; the
   graph sees "no review yet" and dispatches again; `dispatchesSinceReceipt`
   reaches 4 and the run stops `stalled`. Report: B4 failed — contract
   `review-verdict-v1` result recorded as `other`; 4 review dispatches, 0
   receipts for stage `fix`. Thirty seconds, no tokens.
2. Reference identity: the `correction` scenario's second review reply names
   `P1` in `prior`; the ledger never recognises a repeat, the scenario's
   `expect` (a verified or dismissed finding by pass 2) fails. Report: B6.
3. Budget starvation: with `agentInvocations: 24` and a scripted supervisor, the
   run reaches zero with recovery unable to decide. Report: B10 — no reserve
   left for recovery. After the fix, the same rehearsal ends with the floor
   intact.

### 3.3 L2: replay

Load a recorded `state.json` and, with the *current* bundle's `describe()`:

- re-classify every agent evidence record (`payload.codingAgent.output` with
  its stamped `resultSchema`) against the current `resultContracts`, and report
  valid/invalid/repaired per contract next to the kinds the run recorded;
- step the graph: give `advance()` the recorded evidence prefix after each
  recorded dispatch and compare its decision with the recorded one, stopping at
  the first point it would dispatch something new (replay cannot mint model
  output) and reporting where that is in the recorded run;
- re-run the current validators on the recorded evidence, per stage.

For `879ee04f-e57` under the current code the expected report is: six
`review-verdict-v1` results valid, kind `review`; the plan ledger sees pass 2's
repeated findings (two reconciled from their descriptions); `advance()` would
have verified or escalated at pass 2 instead of dispatching pass 3. That is
§6.10 of the contract design, delivered as a command that applies to every
future recorded run instead of one hand-written test. Limitation: a dispatch's
`knownReferences` is not stamped on evidence, so reference replay comes from
stepping the graph (which recomputes them), not from the record alone.

### 3.4 L3: probe

For each named contract: take the real assignment text the rehearsal's dispatch
produced for it (kept in the rehearsal report), run one real job on the
configured harness with `agentInvocations: 3` and commands stubbed, and judge
the single result with the controller's own contract check. Report
valid/invalid/repaired, the problems verbatim, and the usage the harness
reported. This is the only rung that spends tokens — one assignment in, one
result out — and the only one that catches "the model writes the description
where the id goes" before a live run does. Opt-in; `run` never probes, and
`probe` refuses to run against a stand-in.

### 3.5 The gate in `run` — reverted 2026-10-04

`graphloom run` briefly performed L0, then L1 quick, before intaking the live
run, keyed by a fingerprint (bundle digests, runner config, environment check
outputs, GraphLoom version, the harness binaries' capability probe (§3.1)),
with `not-ready` stopping before any provider call and `inconclusive`
proceeding with a note. It was reverted the same day it shipped: the first
real run attempted against a plugin's actual target (banyandb-fix against the
real `apache/skywalking-banyandb`, not its own CI fixture) reported
`not-ready` and stopped before any provider call — not because anything was
broken, but because L1's replay is a literal recording of one historical
interaction with a tiny synthetic fixture repo (§4.4-§4.5), and the stand-in's
finite, fixed replies can never satisfy a graph's real requirements against a
repo they were not recorded against. Against the real target this is not an
occasional false positive; it is the outcome for every real request, every
time, since no repo other than the one recorded ever converges. A check that
fails 100% of real use while passing 100% of CI is not a pre-flight gate, it
is a wall — see §8 for the fuller account and the rejected alternative (making
`not-ready` degrade to `inconclusive` on a repo-identity mismatch) that was
considered and set aside in favor of simply not gating `run` at all.
`check`/`rehearse`/`replay`/`probe` are unaffected: run only when an operator
or CI explicitly invokes them, against the fixture they were built for, they
are exactly what §2's goals describe. `apps/graphloom/src/gate.ts` (`runGate`,
the L0+L1-quick-plus-fingerprint combinator this section used) stays, tested
directly, in case a future explicit, opt-in command wants it; it is no longer
reachable from `run`.

## 4. Design

### 4.1 Stand-in models, real harnesses

The live-run defects lived in adapter and controller code, so the stand-in
replaces exactly one thing: the model. Per harness:

- Pi: `createModelRuntime` registers pi-ai's `fauxProvider`, as
  `pi-faux-harness.mjs` does today; the real `createPiHarness` runs the
  session, the tools, `submit_result`'s validation and in-turn correction, and
  budget reservation.
- Claude Code: `claude.command` points at the shipped stand-in binary (today's
  `fake-claude.mjs`), which speaks the stream-json protocol, honours
  `--json-schema`, emits `structured_output`, and can run `bash` steps; the
  real `claude-harness.ts` runs unchanged.
- Codex: `codex.command` points at the stand-in (`fake-codex.mjs`), honouring
  `--output-schema`.

The three move from `test/` into a shipped entry,
`@graphloom/executor-coding-agent/rehearsal`, and the CLI runner selects them
through the module and command overrides the tests already use when the runner
config (or `rehearse`) sets `standIn: true`. The executor package's own unit
tests keep driving the real adapters against these shipped stand-ins, not
private copies, so a protocol drift between an adapter and its stand-in breaks
CI before it breaks a rehearsal.

Each stand-in sits behind a generic *rehearsal wrapper* around the real adapter.
Before delegating `session.run(request)`, the wrapper resolves the scenario's
next reply for `request.resultContract?.name` — a string the plugin declared —
and hands it to the stand-in: for Pi through `faux.setResponses`, for Claude
Code and Codex through a sidecar file named by an environment variable the
wrapper adds to the pass list. The adapter code between the wrapper and the
model is the production code. A reply with `effects` is applied before the
result is submitted — through the harness's own tools where the harness has
them (Pi's `write`/`bash`), so write-scope enforcement is exercised too. The
stand-in logs every reply it gave with the job identity it was given
(`operationId`, contract, stage, purpose), and the evaluator checks that log
against the evidence producers the controller recorded: a reply that landed
under a different job than the one that asked — a continued session mixing
turns, a stale result applied fresh — is a B3 finding with both identities.

No reply for a contract → `synthesizeFromSchema(contract.schema)`: the
smallest instance that validates (required properties only, first `enum`
value, empty arrays, the property name as a string). A synthesized reply the
plugin's parser then rejects is a finding, not noise: the contract admits what
the parser refuses (B5), which is exactly the quiet drift this system exists to
catch.

### 4.2 The seam, proven before the run

Vajra's authors learned that a stand-in that silently fails to intercept
produces a run that looks slow rather than broken: the real CLI runs, spends
tokens, and the suite goes green. Two guards keep this design's one seam
honest, and both act before the first dispatch rather than after the last:

- The stand-in refuses to impersonate a harness unless it was handed a
  scenario. A stand-in binary found on `PATH` without one exits non-zero
  naming itself and the missing scenario; the faux Pi provider does the same
  on its first request.
- Before dispatching, the rehearsal resolves each enabled harness the way the
  adapter will — Pi: the registered provider is the faux one; Claude Code and
  Codex: `command` resolves inside the shipped rehearsal entry — and fails the
  rehearsal at B2 otherwise, printing the resolved path as the report's one
  seam of unreality.

The stand-in's call counter and the zero-provider-call assertion at the end
confirm what the guards promised; they are not the only line of defence. CI
keeps a decoy `claude`/`codex` test whose binaries print a marker, asserting
that a mis-wired rehearsal fails at the guard and that the marker never
appears in a passing one.

### 4.3 Assignment fidelity: the stand-in reads the prompt

A stand-in that answers from a playbook is a perfect agent working from a
perfect prompt, so a prompt that never asks for a field the contract requires
passes every rehearsal and fails only live, where a real model cannot produce
what it was not asked for. Vajra added this rule after exactly that bug cost
it two expensive runs, and it applies here unchanged: a property the stand-in
is about to emit — from a scenario reply or synthesized — must be named in the
rendered assignment it received (the full dotted path or its leaf segment,
matched as a whole word, case-insensitively) or be declared `harnessSupplied`
by the reply. Otherwise the stand-in fails the turn naming the property, the
contract and the job, and the report shows it under B2 as a prompt defect.

The check is deliberately one-sided. It proves only that the prompt is not
silent about a field — a prompt that names a field and explains it badly still
passes — and it reads the whole rendered assignment, so a field name present
for another reason (an input file's contents, a prior handoff) counts as asked
for. A green rehearsal here is not evidence that the prompts are well written,
only that they are not silent; that limit is recorded in `notCovered`.

### 4.4 Scenarios

Scenarios are plugin data, like `resultContracts`. The bundle manifest gains
`entryPoints.rehearsal`, a module exporting:

```ts
interface GraphRehearsal {
  /** "happy" is required; "correction" is expected of any graph with a review. */
  scenarios: Record<string, RehearsalScenario>;
}
interface RehearsalScenario {
  /** Replies by the contract name the plugin declared, consumed in order; the last repeats. */
  results: Record<string, RehearsalReply[]>;
  /** Canned command results by command id, used when commands are stubbed; `failTimes` fails that many calls first. */
  commands?: Record<string, { exitCode: number; stdout?: string; stderr?: string; failTimes?: number; retryAfterMs?: number }>;
  /** Recorded GitHub read payloads by executor id, used with --offline. */
  reads?: Record<string, unknown[]>;
  /** Supervisor decisions, in order, when the scenario tests recovery. */
  supervisor?: GraphDecision[];
  /** Smaller or larger than the rehearsal defaults when the scenario needs it. */
  budgets?: Partial<RunBudgets>;
  /** What this scenario must reach, so the evaluator judges the run instead of only finishing it. */
  expect: {
    status: "succeeded" | "stopped";
    receipts?: string[];
    maxAgentDispatches?: number;
    stopReason?: string;
    /** Recovery triggers this scenario means to reach, in order; any other recovery entry is a finding. */
    recovery?: string[];
    /** How many times each executor id was invoked, read from evidence producers. */
    executorCalls?: Record<string, number>;
  };
}
interface RehearsalReply {
  output?: unknown;
  /** Files the stand-in leaves in the worktree before submitting, as a work job's agent would. */
  effects?: Array<{ path: string; bytes: string } | { patch: string }>;
  /** Properties of `output` the assignment need not name (the harness or controller supplies them). */
  harnessSupplied?: string[];
  /** Instead of a result: finish without submitting, exit non-zero with a summary, or go silent for `ms`. */
  fail?: { kind: "no-result" } | { kind: "exit"; summary: string } | { kind: "hang"; ms: number };
}
```

Replies are consumed in order; when a contract's list is exhausted the last
reply repeats, whatever its kind, and the rehearsal's small budget bounds a
repeating failure. A reply that fails is how a scenario reaches what a happy
path never does: the "finished without submitting" refusal, `executor_failed`
recovery, the harness watchdogs (a `hang` outlives the rehearsal's shortened
timeouts, §4.6), and the retry timing an executor asks for. `commands[id]`
with `failTimes`/`retryAfterMs` injects the transient command failure the
wait-budget path exists for. `expect.recovery` says which recovery entries the
scenario meant; `expect.executorCalls` asserts the calls the graph made, not
only the effects it left.

One format, deliberately: a plugin's own unit simulation (banyandb-fix's
`simulate()` today) loads the same scenario files rehearsal replays, recorded
ones included, rather than inline literals. The moment the fast simulation and
the rehearsal read different fixtures, the two drift and one of them lies.

Scenarios come from recorded live runs (§4.5), not from hand-written replies:
CI judges a graph only by recorded scenarios and by schema synthesis. A
hand-written scenario — banyandb-fix's test-suite `PLAN` and verdicts would make
one — is a development convenience for a plugin before its first live run, and
never decides a CI verdict. Nothing in the controller or CLI reads a scenario;
only the rehearsal wrapper does, by strings the job carries.

Two scenarios need no plugin data. `--adversarial` mutates the `happy` replies
on the way to the stand-in: drops a required property, writes a shown
description into a reference field, returns the right shape under a job whose
purpose may not produce its kind, writes an effect outside the job's write
scope. Its expectations are generic — an in-turn rejection then acceptance on
Pi, `contract_violation` on Claude Code and Codex, a `repaired` record for the
description, a scope-violation failure for the stray write — and verify that
the robustness machinery itself is wired on this machine. `--synthesized`
ignores scenario replies and uses schema synthesis throughout, the
contract-versus-parser check of §4.1.

### 4.5 Recording scenarios from live runs

`graphloom rehearse --record-from <stateDir>` extracts from a recorded run
every agent result (`codingAgent.output` by stamped `resultSchema`, in order),
every GitHub read payload (into `reads`), and every command result (into
`commands`), into a scenario file committed with the plugin. Replies a real
model wrote are the most realistic stand-in replies available, and they cost
nothing more than the run already spent; they are the only replies CI
rehearses with. A recorded scenario reproduces the run's shapes faithfully,
invalid ones included, so a failed run records as a regression scenario and a
successful one as `happy`.

The consequence for bootstrapping: `879ee04f-e57` records today as a
regression scenario (and replays, §3.3). banyandb-fix's own `happy` scenario
waited on exactly this — its first successful live run — and now has one
(2026-10-04, §1): a plugin with no successful live run yet still rehearses on
schema synthesis until it earns one, a full plumbing verdict on B1–B4 and B10,
`inconclusive` on convergence, which is the honest state of a graph that has
never finished.

One thing `--record-from` cannot recover: a work dispatch's own file write is
only replayable evidence when the graph itself `observe()`s it afterward
(`observeWorkspace`, `packages/controller/src/loop.ts` — no other path turns a
file's bytes into evidence). A validator that reads the real checkout directly
instead of the graph's own evidence (as RED/GREEN command checks do) never
causes that `observe()`, so a successful work dispatch's written files can be
entirely absent from the recorded scenario's `effects` even though the real
run genuinely wrote them. The gap is in the recorded evidence, not in
`--record-from`'s reading of it: the missing bytes have to be supplemented by
hand, same as a hand-written scenario's own development-convenience bytes,
just copied verbatim from the live run's own worktree instead of invented.

### 4.6 Hermeticity and time

A rehearsal must not be able to reach a real model, a real credential, or an
operator's own configuration, and it must finish in seconds even when a
scenario scripts a hang:

- `standIn: true` in the runner config refuses to load any credential binding
  or `GRAPHLOOM_*_API_KEY`-style environment the harnesses would otherwise
  pass; the rehearsal fails at setup if one is present, rather than running
  with a key a stand-in cannot use.
- Each stand-in runs with an isolated `HOME`, config dir and Pi agent dir
  under the rehearsal's state directory, so a developer's real sessions,
  settings and auth files are neither read nor written. The report records
  that the paths resolve there.
- Watchdogs and job timeouts are shortened for rehearsal (startup and response
  timeouts in the low seconds, job timeout well under a minute) so a `hang`
  reply ends in the watchdog path it exists to exercise. The scenario can
  lengthen them; the defaults assume a stand-in that answers instantly.
- Network: GitHub reads are real by default because they are cheap and verify
  the token; `--offline` replays the scenario's `reads`, and a rehearsal that
  needs a read it has no recording for reports `unverified` for that read,
  never a fabricated payload.

### 4.7 Evaluation and verdict

A rehearsal, a replay and a probe all end in a `RehearsalReport`, computed from
generic durable state by `packages/controller/src/rehearsal.ts`:

```ts
interface RehearsalReport {
  verdict: "ready" | "not-ready" | "inconclusive";
  /** The first failing boundary and why, when not ready. */
  blocker?: { boundary: Boundary; reason: string; evidenceRefs: string[] };
  boundaries: Record<Boundary, { status: "passed" | "failed" | "unverified" | "unexercised"; notes: string[] }>;
  /** What this run stood in for, named: the stand-in modules, their resolved paths, the stubbed command ids, replayed reads. */
  substituted: string[];
  /** Fixed trailer: model behaviour, provider health, prompt quality beyond field presence, command results when stubbed. */
  notCovered: string[];
  stages: Record<string, { dispatches: Record<string, number>; receipts: number; modelCalls: number }>;
  contracts: InspectReport["contracts"];
  convergence: { expected: RehearsalScenario["expect"]; actual: { status: string; receipts: string[]; stopReason?: string; recovery: string[] }; met: boolean };
  cost: { wallMs: number; providerCalls: number; usage?: CodingUsage };
  fingerprint: string;
  environment: Record<string, string>;
}
type Boundary = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7" | "B8" | "B9" | "B10";
```

How each boundary is read from state, with no plugin vocabulary. A reply the
scenario scripted to fail is expected to fail, and its failure counts for the
boundary it exercises, not against B2/B3:

| Boundary | `passed` when | `unverified` when |
|---|---|---|
| B1 | no `contract rejected` or `scope rejected` stop; every agent dispatch was admitted | — |
| B2 | the seam guard resolved every harness to a stand-in; the capability probe found every adapter flag; no fidelity failure (§4.3) | a binary's `--help` could not be read |
| B3 | every unscripted-failure agent job has `codingAgent.status: "completed"` with an `output`; every stand-in reply landed under the job that asked (§4.1) | — |
| B4 | every record with `contract` is `valid` or `repaired`, and its `kind` equals the declared `evidenceKind` | — |
| B5 | every stage that received a contract-valid result minted its receipt on the next validate | the stage's validators also need command or file evidence that was stubbed |
| B6 | no `contract.problems` on a reference path; repairs are listed, not failed | — |
| B7–B9 | recovery entered only with the triggers `expect.recovery` names, in order; no `plugin_*` trigger; the scripted supervisor was never asked for a decision it did not have | — |
| B10 | max `dispatchesSinceReceipt[*].agent` ≤ `maxAgentDispatches`; `budgets.agentInvocations ≥ recoveryReserve` at the end unless the scenario drove the budget down on purpose; no unexpected `stalled` | — |

Verdict rules, in precedence order:

1. `not-ready` when any boundary is `failed`, convergence is not met, or a
   rung the gate needs was `skipped` for a reason the operator can fix (a
   stand-in missing for a configured harness).
2. `inconclusive` when nothing failed but a declared contract or stage was
   never exercised, or a boundary the scenario meant to exercise is
   `unverified`.
3. `ready` otherwise — including boundaries `unverified` by design in quick
   mode (B5 under stubbed commands), which the report lists under
   `notCovered` rather than hiding behind the verdict.

Every rendered report ends with `substituted` and `notCovered`, so a green
verdict is read next to the list of what it did not prove.

### 4.8 Placement

| Piece | Where | Owner |
|---|---|---|
| `GraphRehearsal` types, `synthesizeFromSchema`, adversarial mutations, fidelity word match | `packages/sdk` | sdk |
| `RehearsalReport`, evaluation from `DurableRunState`, verdict rules, fingerprint, replay stepping | `packages/controller/src/rehearsal.ts` | controller |
| Rehearsal wrappers, stand-in binaries (moved from `test/`), seam guard, per-adapter `requiredFlags` for the capability probe | `executors/coding-agent/src/rehearsal/` | executors |
| `check`, `rehearse`, `replay`, `probe`; `--offline`, `--commands`; hermetic setup | `apps/graphloom` | cli |
| `gate.ts` (`runGate`: L0+L1-quick, fingerprint cache), built for `run` then reverted (§3.5) — tested directly, wired to no command | `apps/graphloom` | cli |
| `entryPoints.rehearsal`, scenarios, unit simulation reading them | hello, release, banyandb-fix | plugins |

## 5. Interfaces and seams

| Interface | Change | Owner |
|---|---|---|
| Bundle manifest | `entryPoints.rehearsal` (optional) | sdk, plugins |
| `RunnerConfig` | `standIn?: true`: stand-in modules and commands, credential refusal, isolated dirs, rehearsal timeouts | cli |
| Harness adapters | each exports `requiredFlags` (the CLI flags it passes) for the capability probe | executors |
| `RunRequest`/`IntakePin` | `rehearsalGate?: { fingerprint: string; verdict: "ready" \| "not-ready" \| "inconclusive" \| "skipped"; notes: string[] }`, optional; the controller still accepts and records it, but `run` no longer supplies it (§3.5) | controller |
| `createCliRunner` | module and command overrides become a supported parameter, not a test hook | cli |
| `RunReport`/`InspectReport` | `rehearsalGate` summary, present whenever a caller supplied one; `run` no longer does (§3.5) | controller |
| Stand-in binaries | shipped under `@graphloom/executor-coding-agent/rehearsal`, same protocols as today's fakes, refuse to run without a scenario | executors |
| `@graphloom/executor-github` | `githubRehearsalModule`: `--offline`'s stand-in, serving read-only ids from `scenario.reads`; runs unrestricted (§4.6), unlike the real sandboxed package | executors |
| `packages/sdk/src/rehearsal-client.ts` | `nextRead`/`recordUnverifiedRead`/`readUnverifiedReads`, the `reads` analog of `nextReply`/`nextCommandOutcome`; `synthesizedRepliesOnly()`/`REHEARSAL_SYNTHESIZED_ENV` for `--synthesized`; `adversarialMutationOnly()`/`REHEARSAL_ADVERSARIAL_ENV` for `--adversarial` | sdk |
| `packages/sdk/src/rehearsal.ts` | `mutateAdversarially`: picks and applies one of the three generic mutations (§4.4) to a reply | sdk |
| `packages/sdk/src/rehearsal-client.ts` | `recordCall`/`readCallLog` (§4.1, §4.7): the per-dispatch call log B3's provenance check reads | sdk |
| `executors/coding-agent/src/harness.ts` | `JobIdentity`/`JOB_IDENTITY_ENV`, `CodingRunRequest.identity` (§4.1, §4.7) | executors |
| `packages/controller/src/rehearsal.ts` | `checkB3`/`producerOf` exported, so the CLI can merge its own call-log cross-check into the controller's canonical default | controller |

## 6. Verification

1. `rehearse` of hello, release and banyandb-fix in CI, on each plugin's
   recorded scenarios where it has one and on schema synthesis otherwise,
   finishes each under 60 s with commands stubbed, with the stand-in's call
   counter asserting zero provider calls.
2. Removing `review-verdict-v1` from hello's declared contracts: L0 fails naming
   it; with L0 skipped, L1 reports B1 with the admission refusal.
3. A banyandb-fix review fixture in its pre-contract shape (no `prior`): L0's
   validator walk and L1 both report B5 — contract-valid result, validator
   refused — not "stopped".
4. `--adversarial`: a dropped required property shows Pi's own in-turn
   rejection and corrected resubmission, and shows Claude Code/Codex's
   `contract_violation` (neither retries); a reference set to its own shown
   description shows a `repaired` record; an effect given any reply at all
   shows the out-of-scope write failing the job as a scope violation — each
   verified directly against its own stand-in. `hello`'s own `--adversarial`
   rehearsal demonstrates the scope-violation path end to end, through the
   real controller: `not-ready`, `executor_failed` recovery, unresolved
   (the happy scenario scripts no supervisor decision for it) — the expected
   result, not a failure of the mode.
5. `replay` of `879ee04f-e57`, committed as a fixture under
   `examples/plugins/banyandb-fix/test/fixtures/runs/`, reports six valid
   review results and pass 2's two reconciled repeats.
6. The gate (`apps/graphloom/src/gate.ts`'s `runGate`, tested directly, no
   longer reachable from `run` — §3.5): a `not-ready` rehearsal stops before
   live intake and returns the rehearsal report; `inconclusive` proceeds and
   is visible in `inspect`; a second call with the same fingerprint does not
   rehearse again; `skip: true` is visible in `inspect`.
7. `probe` against a faux provider standing in for a real one spends ≤ 3 calls
   and reports the contract check and usage; `probe` against `standIn: true`
   refuses.
8. CI never probes: the rehearsal job's runner config sets `standIn: true` and
   carries no credentials, so the rule is enforced by configuration rather
   than assumed.
9. Seam guard: a decoy `claude`/`codex` on `PATH` that prints a marker makes
   the rehearsal fail at B2 before dispatch, and the marker never appears in
   any passing rehearsal's transcript; a stand-in invoked without a scenario
   exits naming itself.
10. Assignment fidelity: hello's reviewer instruction with "summary" removed
    makes the stand-in fail the review turn naming `summary`, reported under
    B2, instead of a green run on a prompt that never asked; a reply that
    declares `summary` as `harnessSupplied` passes.
11. Scripted failures: a `fail: exit` reply reaches `executor_failed` recovery
    and the scripted supervisor's decision; a `hang` reply ends in the
    watchdog path within the rehearsal timeout; `commands[id].failTimes: 2`
    charges the wait budget twice and then succeeds; each is `expect`ed and
    the verdict is `ready`.
12. Hermeticity: a rehearsal started with a provider key in the environment
    fails at setup naming the variable; the stand-ins' `HOME`, config and
    agent dirs resolve under the rehearsal's state directory; `--offline`
    replays recorded reads and reports an unrecorded one as `unverified`.
13. Provenance: a stand-in's own call log disagreeing with the contract name
    the controller recorded evidence under, for the same `operationId`, is a
    B3 finding naming both — verified directly against the cross-check logic,
    and against a real rehearsal's own sidecar call log, byte for byte
    matching the controller's own evidence producers for every real dispatch.
14. The executor package's unit tests drive the real adapters against the
    shipped stand-ins; `requiredFlags` of each adapter matches the flags the
    adapter actually passes, checked by a test that diffs the two.

## 7. Rollout

1. Ship the stand-ins and wrappers (moving the fakes), the seam guard, the
   fidelity check and hermetic setup, `check`, and `rehearse` with schema
   synthesis only; every plugin is rehearsable from day one, and the cheapest
   lessons from Vajra are in from the first release.
2. Add `replay` and `--record-from`; commit `879ee04f-e57` as banyandb-fix's
   regression scenario and replay fixture. Record `happy` scenarios from the
   next successful live run of each plugin; until then CI rehearses on
   synthesis. Point each plugin's unit simulation at its scenario files. Done
   2026-10-04 for all three example plugins (§1, §4.5).
3. Replace the hand-written e2e runs that a recorded scenario duplicates with
   `rehearse` invocations in CI. Done 2026-10-04: release's own "clean run
   through both work stages" e2e test duplicated `rehearsal.test.ts`'s
   "reaches ready for release's happy scenario" exactly (same claim — clean
   convergence through bump→changelog→review — proven more cheaply by a
   genuine recording than a hand-maintained script can be) and was removed.
   banyandb-fix's own e2e test stays: its real value is exact delivery-text
   and evidence-shape assertions `rehearse`'s deliberately generic evaluator
   never inspects, not happy-path convergence alone.
4. Turn on the gate in `run`, cached by fingerprint. Done 2026-10-04, then
   reverted the same day (§3.5, §8): the first real run against a plugin's
   actual target reported `not-ready` for a reason that had nothing to do with
   the plugin being broken, and would have for every real request. Add `probe`
   last; it is the only rung that costs anything to try.

## 8. Decisions and open questions

Decided 2026-10-03:

- CI relies on recorded fixtures only. Probing spends tokens and is an
  operator's step before a live run, never CI's; hand-written replies never
  decide a CI verdict (§4.4, §4.5).
- The gate in `run` is quick mode (commands stubbed, §3.2): it answers whether
  the graph can proceed on this machine, not whether the build passes here;
  full mode is for a nightly job.
- `inconclusive` does not block the gate; `not-ready` does (§3.5).
- The gate's fingerprint uses `@graphloom/sdk`'s `PROTOCOL_VERSION`, not the
  CLI's own hardcoded `"0.0.0"`: the latter is a placeholder with no real
  releases behind it yet, while the protocol version is the number that
  actually governs compatibility between a cached report and a later run.
- Only a `ready` verdict is cached, at `<stateRoot>/rehearsals/<fingerprint>/
  report.json`; `not-ready` and `inconclusive` always rerun L0+L1 rather than
  caching a verdict that would need re-checking to trust anyway, and
  `--skip-rehearsal` computes no fingerprint at all (so skipping pays none of
  L0's own cost, which is the point of the flag).

Decided 2026-10-04:

- `--adversarial`'s "a job whose purpose may not produce its kind" mutation is
  not built. §4.4 frames `--adversarial`/`--synthesized` as needing no plugin
  data, but this one mutation has no reply-content lever to pull at all: a
  coding-agent job's evidence `kind` is hard-coded `"other"` by the executor
  (`run.ts`) and only ever reclassified from the *job's own declared*
  `resultSchema`/contract, never from anything a reply carries, and the check
  it would exercise (`contractAdmissionRefusal`, feeding B1) runs *before*
  dispatch — the job never reaches a stand-in in the failing case. Exercising
  it needs a job-dispatch-level mutation (flipping `purpose`/`readOnly` on a
  specific dispatch), a different mechanism than "mutate the reply on the way
  to the stand-in," and it is plugin-specific by nature (which jobs legitimately
  produce which contracts is the plugin's own stage/requirement wiring, not
  generic scenario data) — the opposite of what makes the other three
  mutations reusable across any plugin. B1 already fails a real admission
  refusal generically, with or without `--adversarial`.
- `--adversarial` mutates every eligible agent reply unconditionally — no
  claim-once bookkeeping, no attempt to make exactly one mutation fire per
  run. A happy scenario scripts no supervisor decisions, so the first
  mutation that produces an unrecoverable failure (every kind except the
  reference-description repair, which resolves transparently as `repaired`
  evidence, and Pi's own in-turn retry, which resolves within its own
  dispatch) ends the run before any later dispatch happens anyway — mutating
  every eligible reply costs nothing extra over mutating only the first, and
  is strictly better for the two non-halting cases, which can fire more than
  once in one run. Demonstrating all four boundary expectations
  (§6 item 4) in a single rehearsal of a single plugin would need the
  recovery episode itself to resolve generically — e.g. a built-in
  "retry the same dispatch" supervisor decision — which does not exist today
  and is out of scope here; each plugin's own `--adversarial` run instead
  demonstrates whichever its own first eligible dispatch offers.
- Priority between the three mutations (an effect outside scope, before a
  reference's shown description, before a dropped required property) is
  fixed and generic, not per-plugin: a reply with any effect at all
  demonstrates the scope-violation path (the most distinctive of the three,
  and the one every harness and reply shape can offer); a contract with
  `references`/`knownReferences` demonstrates the repair; everything else
  falls back to the one mutation every schema with a required property can
  offer.
- A scope violation surfaces only as a generic `executor_failed` recovery
  trigger with a distinguishing summary string (`scopeViolation`,
  `packages/controller/src/loop.ts`), not a dedicated trigger code; nothing
  new distinguishes it from any other unscripted executor failure in
  `evaluateRehearsal`'s own boundary checks. Not built: the verification this
  session relies on reads `convergence.actual.recovery`/the evidence
  directly, which is enough to prove the mechanism fired; a dedicated
  B-boundary assertion for "specifically a scope violation" is a smaller,
  separate addition left for whenever `--adversarial`'s own verdict handling
  needs it.

Decided 2026-10-04 (reverting an earlier decision from the same day):

- The gate in `run` (§3.5) is reverted; `run` goes back to its pre-rollout-
  step-4 behavior, with no automatic rehearsal. Dispatching a real run of
  banyandb-fix against issue apache/skywalking#14067, in the real
  `apache/skywalking-banyandb` checkout, was the first time anything in this
  design ran against a plugin's actual target rather than its own CI fixture.
  `run` reported `not-ready` and refused to start. Root cause, confirmed by
  reproducing it directly through `rehearse` (same failure with the scenario's
  own original issue number against the real repo; same failure regardless of
  which issue the request named): the committed `happy` scenario is a literal
  recording of one run against a 3-file synthetic Go module
  (`apps/graphloom/test/banyandb-fix-rehearsal.test.ts`'s `makeEnv()`), with a
  finite, fixed sequence of canned plan/review replies written for that one
  planted defect. `rehearse` correctly runs this scenario through the real
  controller against the live task's own real repo (§4.1's "the real graph
  logic sees the same task it would on a live run" is working as designed).
  Pointed at the real upstream repo, with real GitHub reads, the canned
  replies cannot satisfy the real requirement set; `fix` never mints a
  receipt, hits its dispatch ceiling, and enters recovery; the scripted
  supervisor — recorded from a run that needed no recovery at all — has no
  decision for it, and `run` stops.
  - `evaluateRehearsal`'s B7 check (unscripted recovery → `not-ready`) is
    working exactly as its own unit tests require (`packages/controller/src/
    rehearsal.test.ts`, "fails B7-9 when recovery was entered for a trigger
    the scenario did not name") and was not touched — weakening it would
    break the one thing this whole design exists to catch (Vajra's "a
    mis-wired stand-in looks like a slow run, not a broken one," §4.2).
  - A narrower fix was considered and rejected: tag a recorded scenario with
    the identity of the repo it was captured against (cheapest candidate: the
    recording run's own `pinnedHead`) and degrade a `not-ready` caused by
    unscripted recovery to `inconclusive` when the live task's repo doesn't
    match. This would have kept `run`'s gate alive for the common case (CI,
    or an operator re-running the exact fixture) while not hard-blocking a
    genuinely different real target. Not built: it only patches the one
    symptom this run exposed (B7); B5 (a contract-valid result that never
    mints a receipt, §3.1) and others can fail the same way for the same
    underlying reason, each would need its own mismatch-aware carve-out, and
    every carve-out weakens exactly the regression-catching property §4.2
    was written to protect. The simpler, more honest fix is to not use a
    fixture-bound recording to gate production use at all.
  - This also corrects an un-costed assumption in §2's own goals: "an
    operator, or `graphloom run` itself, learns... whether this graph... can
    carry a run from intake to receipts" was written assuming a scenario's
    convergence says something general about the graph; in this
    implementation a scenario is a recording of one specific historical
    interaction, so the goal as wired only ever answered "does this one
    historical interaction still replay," which is a materially weaker claim
    that happens to equal the intended one only when rehearsing against the
    exact fixture the scenario was recorded from.
  - `check`/`rehearse`/`replay`/`probe` keep working exactly as before: they
    are invoked explicitly, by an operator or CI, against the fixture they
    were built and recorded for, which is precisely what §2's goals describe
    and what §6's verification items test. Nothing about them changes.

Not borrowed from Vajra, on purpose: its edge-coverage generation builds one
case per branch from a workflow's declarative predicates and gates on 100%.
GraphLoom graphs are TypeScript — `advance()` is code, not data — so coverage
of its branches is a unit-test concern, not something a rehearsal can derive
from the plugin's declarations. Its real GitHub side effects behind a
recording wiretap are also not taken: GraphLoom's only external calls in a
rehearsal are reads, already recorded as evidence producers and replayable
with `--offline`.

Open:

- Whether `check` should refuse a bundle with no rehearsal entry. Proposed: no.
  Synthesis makes every graph rehearsable; a plugin without scenarios just gets
  a weaker verdict (`inconclusive` on convergence), which is itself information.
- Recorded runs include the task's issue text and assignments. The runner
  redacts credentials before anything becomes durable, so the fixture is safe
  to commit, but it is large; a replay fixture may want only the agent results,
  reads, command results and decisions, not the whole state.
- The fidelity check reads the whole rendered assignment (§4.3). Reading only
  the plugin's own instruction text would be stricter and catch a field that is
  present by accident, but the executor does not see that boundary today; it
  would need the job to carry it.
