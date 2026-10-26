# Pi SDK supervisor integration

Status (2026-09-25, #43; episode sessions #120): Pi-backed `createPiSupervisor`
decides recovery through GraphLoom admission tools, one logical supervisor per run
with a fresh Pi session per recovery episode and a controller-owned case file as
its memory, with durable session binding, per-decision turn caps settled against `agentInvocations`, operator Stop
during a prompt or patch, and journaled model switching with crash reconciliation.
The supervisor's Pi session writes qualified repairs itself into admitted
candidate trees through candidate-scoped coding tools; unconstrained edit/write on
the user worktree remains forbidden. The CLI composes a Pi supervisor from an
operator config file. These paths are verified with faux Pi providers; live
qualification against configured accounts is tracked in #30, and
BeforeProviderRequest interception is not implemented. Scripted supervisors stay
the CI default.
This document specializes the [core design](design-typescript-core.md).

The proposed [supervisor harnesses design](design-supervisor-harnesses.md)
supersedes Pi as the only supervisor backend: a harness-neutral supervisor host
drives Pi, Claude Code, or Codex, and the plugin declares which it prefers. This
document remains the specification of the Pi harness.

## Driver scope

This document specifies the **standalone** supervisor backend. In proposed
[agent-host mode](design-agent-host.md), the attached coding session fulfills the
supervisor role and writes admitted repairs itself; a second Pi supervisor is not
started. Pi credentials, provider switching, and private session internals below
are backend-specific, not universal requirements for every GraphLoom driver.
Both drivers preserve controller-owned acceptance and independent repair review.

## SDK choice and scope

Use `@earendil-works/pi-coding-agent` for the supervisor's agent/session runtime.
Pi supplies model access, conversational sessions, tool calls, and streaming events;
GraphLoom supplies recovery authority, budgets, evidence, and durable graph state.
The SDK's current documented package name differs from older Pi examples.
GraphLoom's supervisor package and lockfile now pin version 0.87.1. Its declared
runtime requirement is Node >=22.19.0; the live check used Node 24.6.0. Qualify SDK
upgrades explicitly instead of following moving `latest` documentation.
[SDK](https://pi.dev/docs/latest/sdk),
[package metadata](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json).

“One backend” in the minimal core means one Pi integration supporting multiple
configured providers; it does not mean one fixed provider or model. DeepSeek,
MiniMax, and OpenAI GPT model switching is required. Anthropic API access is also
supported by the selected SDK. Exact models are selected by provider/model ID from
the qualified registry; GraphLoom must not silently substitute another model.

## Initial MiniMax configuration

The selected initial supervisor model is **`minimax-cn/MiniMax-M3`**, matching
OpenCode's most recently used `minimax-cn-coding-plan/MiniMax-M3`. This is the
current operator setup, not a model hard-coded into graph plugins. Future switching
uses the same explicit provider/model selection protocol described below.

| Setting | Configured value |
|---|---|
| SDK | `@earendil-works/pi-coding-agent@0.87.1` |
| Pi provider / model | `minimax-cn` / `MiniMax-M3` |
| Endpoint | `https://api.minimaxi.com/anthropic` |
| Credential source | OpenCode's `minimax-cn-coding-plan` API credential |
| Pi model defaults | `~/.pi/agent/settings.json` |
| Pi credential binding | `~/.pi/agent/auth.json`, using an API-key command reference |
| Local credential reader | `~/.config/graphloom/opencode-minimax-key.py` |

The reader resolves the key from `~/.local/share/opencode/auth.json` and emits it
only to Pi's credential resolver. Pi's auth file stores the command reference;
there is no duplicated key in Pi configuration, repository files, task YAML, or
plugin bundles. Auth/settings files are mode 0600 and the reader is mode 0700.
These are operator-local files, not portable repository configuration.

The CLI reads the operator's supervisor config from `$GRAPHLOOM_SUPERVISOR_CONFIG`,
or `~/.config/graphloom/supervisor.json` when unset: initial `provider` and
`modelId`, the other `models` it may switch to (`"provider/model"`), an optional
Pi `agentDir`, `promptTimeoutMs` and `promptTotalTimeoutMs` (see Prompt
timeouts), and `quotaRetryMs` (see Provider failures). The file never holds credentials (`apiKey` is
refused). Without it, `graphloom run` has no supervisor. The run's Pi transcripts,
one per episode session, live under `<stateDir>/supervisor`; `resume` restores the
logical supervisor on its bound model with the config's current model list and
starts a fresh session, never reopening a transcript.

The adapter receives an explicit operator credential-store path and
provider/model selection rather than discovering credentials from the target repo.
It must resolve the existing reference without exposing the key to prompts,
transcripts, plugin processes, or activity events. A missing credential is a
configuration failure, not permission to silently select another account/region.
For key rotation, reopen the runtime so its cached credential-command result is
refreshed. Keep secrets outside the durable run record; record only the provider,
model, and nonsecret credential reference.

MiniMax returns its thinking blocks with an empty signature (`signature: ""`).
Pi's `anthropic-messages` request builder keeps such a block as thinking only when
the model's `compat.allowEmptySignature` is true; otherwise it replays the block as
a plain `text` block of the assistant turn, so the model reads its own private
reasoning as something it said. Neither Pi's built-in `minimax-cn` entries nor an
operator's custom entry in `models.json` set the flag, so the supervisor host sets
it on every session model it uses for `minimax` and `minimax-cn`: when a session
is created (including each episode session and the first one after a restart) and
on every model switch. The host sets it on a copy of the registry's model, never
on the shared registry object.

### Verified setup and limits of the check

On 2026-09-23, a real `createAgentSession` request using that credential reference
returned exactly `PI_MINIMAX_OK` with stop reason `stop`. The check used an
in-memory session, no active tools, an explicit resource loader, and disabled
automatic retries, compaction, and cache warming. It sent only a connectivity-test
prompt, with a bounded output and cancellation timeout. Project type checks passed
after installing the SDK.

This verifies the China endpoint, credential resolution, and a basic Pi agent
request. It does not verify coding-plan quota accounting, tool calling, durable
supervisor recovery, session restoration, or switching to DeepSeek/OpenAI. Those
remain implementation and qualification work. No alternate provider account or
model was tested as a fallback.

## Authentication and Claude Code plan gap

Interpret “Claude Code coding plan” as Claude Pro/Max subscription allowance.
These three cases are different:

| Route | Finding | GraphLoom decision |
|---|---|---|
| Claude through Pi with an Anthropic API key | Supported API credential path | Baseline direct-Pi route; separate provider billing |
| Claude subscription OAuth through Pi | Pi has OAuth support, but warns that third-party usage uses paid extra usage rather than included Claude plan limits | Do not promise included-plan access or copy Claude Code tokens into GraphLoom |
| User-authenticated, unmodified Claude Code | Anthropic documents subscription use through its genuine binary under its stated conditions | The coding-agent executor's Claude Code harness runs the user's own `claude` CLI and login ([executors](design-executors.md)); it is not a Pi model switch. A Claude Code supervisor harness is proposed in the [supervisor harnesses design](design-supervisor-harnesses.md) |

Pi's current provider documentation recognizes Anthropic OAuth tokens. Its
interactive-mode source explicitly distinguishes third-party extra-usage billing
from included plan allowance. Technical OAuth support therefore does not establish
subscription-quota compatibility.
[Pi authentication](https://pi.dev/docs/latest/providers),
[Pi subscription warning](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L281-L282).

Anthropic's current documentation distinguishes genuine unmodified Claude Code,
where end users authenticate themselves, from third-party applications collecting
or routing Claude subscription credentials. It directs product integrations to
API keys or supported cloud providers. GraphLoom's Pi backend uses those supported
credential paths. The Claude Code coding harness runs the unmodified CLI with
the user's own login and never reads or copies its credentials. Nothing may
masquerade as Claude Code or proxy its subscription credentials into Pi.
[Anthropic authentication and product-integration rules](https://code.claude.com/docs/en/legal-and-compliance).

For the requested direct providers, Pi documents `DEEPSEEK_API_KEY`,
`MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`, and `OPENAI_API_KEY`. Select the regional
endpoint and credential that match the account. An account usable in another
coding tool is not proof that its subscription includes this API traffic.
[Provider authentication reference](https://pi.dev/docs/latest/providers).

## Episode sessions and the case file

One logical supervisor serves the run; its identity (`supervisorBinding.sessionId`),
budgets and switch journal are run-wide. Each **recovery episode** runs in its own
Pi `AgentSession` (`createAgentSession` with explicit `ModelRuntime`,
`SessionManager`, settings, resource loader, and tools): `createPiSupervisor`
opens a fresh session on the current model when `decide` sees a new episode id.
Every turn of that episode, including a qualified repair's `patchCandidate`, runs
in that session; the next episode starts with no chat at all. A run-long chat grew
past the model's window in a dogfood run (about 926k input tokens) and carried
conclusions about earlier code across resumes; per-episode sessions remove both.

Memory across episodes is the controller-owned **case file** (`CaseFile` in
`@graphloom/sdk`, `caseFile` in run state), bounded by `MAX_CASE_FACTS` and its
siblings:

- **Facts** and **refuted claims**, added with the `record_finding` tool (which does
  not end the turn). The controller keeps one only when it cites at least one
  evidence ref and every cited ref names evidence the run recorded; otherwise the
  tool answers why. Each records the candidate digest and the plugin (active version
  and pinned bundle digest) it depends on (both by default; `dependsOn` narrows
  that), and the controller marks it stale for good when either changes, including
  when an operator's `resume --update-plugin` replaces the bundle under the same
  version. Stale entries stay in run state for replay
  but never reach the model; the oldest stale ones are dropped first at the bound.
- **Attempts**, written by the controller from its settlement of each proposal, never
  by the model: before the next decision, or when the controller's loop ends first
  (a stop the supervisor proposed, or a run its graph finished after a return).
- **Open questions** an episode leaves, newest last.

`SupervisorInput.caseFile` carries only the live part. An episode's prompt is the
trigger, a short state summary (budgets, current stage, receipts and agent sessions
a dispatch may continue, counts of older evidence, descriptions of the current
generation's evidence, the latest repair candidates, each list capped), the live
case file, the settlement of the previous proposal, and the tool list. Its size
does not grow with the run's total evidence, so Pi's compaction remains only a
guard that a normal run does not reach.

Resume needs no preamble: the restored supervisor opens a fresh session even when
the run stopped mid-episode, and anything a code or plugin change made untrue is
already marked stale. A run resumed in recovery is not handed to the supervisor on
its old trigger. The controller returns it to normal mode first, so the graph
retries what failed. Only a recurrence opens a new episode, with a fresh trigger
and post-resume evidence. That episode's settlement says the operator's resume
overtook the last proposal. A run saved with the retired step-limit pause is the one
exception and continues the episode. The supervisor's `stop` tool takes an
optional `retryable` (default `true`): `false` marks a blocker no retry can
clear, and a resume then surfaces the same blocker until the plugin, the
workspace change or a budget changes. See the core design, section 8
("Resume retries what failed"). `supervisorBinding.sessionFile` names the latest episode's
transcript; it is used to reconcile an interrupted model switch and to locate the
transcript directory, never reopened. A run recorded before episode sessions still
loads: its binding's run-long transcript is left on disk, a missing `caseFile`
reads as empty, and its `resumedSinceLastDecision` flag is ignored.

Pi's SessionManager owns each session's conversational context; GraphLoom's store
owns run progress, accepted evidence and the case file. Every prompt reinjects
current pinned requirements, fixed steps, remaining budgets, and admitted state;
conversation cannot override those facts.
[Session lifecycle and storage](https://pi.dev/docs/latest/sdk).

## Multiple models

Model selection uses `ModelRuntime.getModel(provider, id)` and configured-model
discovery. Pi's `session.setModel(model, { persist: false })` checks configured
authentication and records a model change in the session. It does not itself prove
live access, sufficient account quota, or compatibility with every historical
message. GraphLoom checks idle state before switching and owns fallback policy.
[Model example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/02-custom-model.ts),
[setModel implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts#L1975-L1999).

For each switch:

1. Require an operator-configured provider/model and credential reference. Match
   the target's tool support, context limits, and input modalities to the request.
2. Wait until idle or explicitly abort and settle the active request. Reconcile
   pending controller operations before continuing with another model.
3. Record a switch intent containing old/new model, reason, session identity,
   current run revision, and remaining budgets; call `setModel` on that session.
4. Commit the actual selection before another prompt. On restart, reconcile Pi's
   transcript model-change record with the controller's intent. A partial switch
   must not result in silent fallback or a second logical supervisor session.
5. Preserve the episode's history, tool results, fixed steps, and all counters.
   If the target cannot consume the current context, use an explicitly budgeted
   compaction or report incompatibility. Do not silently drop evidence or reset
   the conversation mid-episode; the next episode opens on the switched model.

A switch alone does not spend a correction attempt, but its decision and subsequent
model calls spend their applicable allowances. Authorized automatic fallback may
select among configured models after a provider failure; there is no fallback to
an unconfigured provider. Authentication presence is not live-provider validation.

Implemented switching has two triggers and no automatic fallback. The operator runs
`graphloom switch-model <run> <provider/model> --reason …`, which leaves a durable
request applied before the run's next supervisor prompt, including after resume.
The supervisor can call its `switch_model` tool, limited to configured models; the
call ends its turn and the controller applies the switch while the session is idle.
The controller journals the intent in run state before `setModel` and the outcome
after, so it refuses a switch for a supervisor without a durable session binding.
Operator requests are written atomically with an id, and the owner removes only
the request it applied. A refused or failed switch (unconfigured target, missing credential) is
journaled as failed; the run continues on the current model and the next prompt
reports the failure. On resume, an intent without an outcome is committed if the
session file's last `model_change` entry names its target, and failed otherwise.

Each recovery prompt opens with the controller's settlement of the previous
proposal: new evidence (including executor failures), receipts, repair-candidate
transitions, stage, generation, a changed workspace candidate, and switch
outcomes. These are controller observations, not the supervisor's claims; the
controller also writes each one to the case file as an attempt.
Pi documents persistent model changes and calls out cross-provider handoff as a
provider test requirement.
[Model selection](https://pi.dev/docs/latest/models),
[Provider integration testing](https://pi.dev/docs/latest/custom-provider).

## Tools, authority, and spend accounting

Construct the SDK with explicit resources. Disable project-discovered extensions,
skills, settings, and prompt templates. Do **not** grant unconstrained default
bash/edit/write against the user run worktree or live plugin install.

Tooling has two layers:

1. **GraphLoom-owned admission tools** — observe, dispatch, validate, reenter,
   qualify_repair, activate_repair, return, stop, plus switch_model, and
   record_finding for the case file (the only one that does not end the turn). Each tool's
   parameters are a JSON Schema of its action spec, so Pi returns malformed calls
   to the model for correction. The first valid call ends the turn and becomes the
   proposal; the controller admits it and reports its settlement at the start of
   the next prompt. Pi ends a tool batch on its own only when every result in it
   terminates, so a batch that pairs `record_finding` with an admitted action would
   go back to the model for a summary nobody reads (and could yield a second
   action). The prompt therefore takes a `done()` predicate: once a proposal is
   admitted, or the turn's rejection allowance is spent, the next turn is aborted
   at `turn_start`, before its provider request. That end is neither a failure nor
   a timeout, and the aborted turn is not charged. A plain JSON decision reply remains a fallback for models
   without tool calling. Pi cannot mint Accept or alter pinned steps/requirements.
   After `Reenter` (or on a recovery `Dispatch`), the supervisor **supplies the
   job instruction** for that trial; it does not have to reuse the plugin's
   original prompt. Overrides remain bound to task, evidence contract, write
   scope, and reviewer independence.
2. **Pi coding tools for qualified repair** — after the controller admits
   `QualifyRepair` and materializes a candidate tree, the episode's supervisor
   `AgentSession` gets Pi's full coding toolset (read, bash, edit, write, grep,
   find, ls) with the candidate root as its working directory, so it can
   investigate, edit, and build and run the candidate's tests while patching.
   The grant is accepted only for a controller-issued
   `<stateDir>/repairs/<artifactId>/candidate` and is revoked when the patch
   settles; decision turns see admission tools only. The working directory is not
   a sandbox: `bash` and absolute paths reach anything the user can. GraphLoom
   does not confine them without an OS sandbox, so it detects instead. Right
   after the patch, before anything builds or runs the candidate, the controller
   compares the live install's digest, the run worktree, and the saved run state
   with their state before the patch. Any change rejects the candidate and stops
   the run, because the change cannot be undone and later steps would run
   against it. It then rebuilds and tests the candidate in preflight, requires
   independent review, and refuses activation when the live install's digest
   changed. The supervisor writes
   plugin/validator source repairs itself through the Pi SDK; coding is not
   delegated to a separate non-Pi repair agent. When no explicit patch author is
   configured, the controller calls `Supervisor.patchCandidate`, which sends one
   repair prompt (target, reason, candidate root, tool rules) to that session under
   a separate patch timeout. This fallback requires the supervisor to expose
   grant, revoke, and provider-call accounting. Before the patch, the controller
   durably reserves the remaining `agentInvocations` as the patch's turn cap; Pi
   aborts any turn past the cap before its provider request, unused calls are
   refunded when the patch settles, and a crash leaves the reservation spent.
   The reply, bounded to 2,000 characters for every patch author, is recorded as
   the artifact's `patchSummary`, including when a later qualification step
   rejects the candidate. Revoke or rebind those tools when the qualification
   episode ends. An independent read-only reviewer uses a different session and
   must not share write tools with the patching supervisor.

Pi must not directly mutate the run worktree or authoritative controller state.
The fixed step list and acceptance requirements remain enforced by the controller.
[SDK configuration](https://pi.dev/docs/latest/sdk),
[Explicit resource configuration example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts).

Every request and tool submission carries the run generation, state revision,
episode, and stable operation ID. Replayed tool calls obtain the recorded result;
they do not repeat external effects. A model switch does not change these rules.

Pi has automatic retry, compaction, and cache-warming behavior. For the first
adapter, disable background cache warming and automatic model retries/compaction;
add explicit budgeted paths only when each actual model request can reserve and
settle its allowance. A `prompt()` can include multiple model/tool turns, so one
prompt must not be counted as exactly one model invocation. Establish interception
of every provider request before claiming the global invocation limit is enforced.
The SDK-version-specific interception seam is an implementation qualification item.
[Settings](https://pi.dev/docs/latest/settings).

Subscribe to lifecycle events for usage, errors, tool activity, and concise summaries.
Use settled/idle semantics, not a single low-level `agent_end`, before switching
or closing a supervisor request; queued work or automatic recovery can follow that
event. Operator Stop aborts the request and waits for idle, then the controller
reconciles in-flight effects. Filter private thinking from user-facing activity.

The controller does not prompt a metered supervisor with no `agentInvocations`
left, and caps each decision prompt at the invocations remaining. A Stop during a
decision or a candidate patch aborts that prompt; the run records an operator stop.
[SDK events and cancellation](https://pi.dev/docs/latest/sdk).

### Prompt timeouts

A prompt has two limits, and neither one cuts off a model that is still producing
output:

- **Inactivity** (`promptTimeoutMs`, default 120000): the prompt is aborted once
  the session has emitted no Pi event for this long. Events include a text or
  thinking delta, a tool call, a turn, and a compaction. Each one re-arms the
  timer. Time a local tool spends executing, such as a candidate build, does not
  count. This field used to be a single wall-clock limit (60000 by default). It now
  sets the inactivity limit, so a thinking model that streams slowly is never
  killed mid-reply.
- **Total** (`promptTotalTimeoutMs`, default 900000): a backstop for a reply that
  streams but never finishes. A candidate patch prompt uses its own total cap
  (`patchTimeoutMs`, default 600000).

A standalone compaction keeps a single deadline, by default `promptTimeoutMs`.
Stop interrupts a prompt immediately, under either limit.

A prompt that reaches either limit fails with class `timeout`. Its message is
`no output for 120s` or `no complete reply within 900s`. The first timeout in a
decision turn retries the turn once in a fresh episode session, opened the same way
as for a new episode, because the aborted session may still be busy and refuse
reuse. The fresh session receives the turn's full recovery prompt, followed by any
re-ask or rejection that was pending (never the opening twice). The retry is charged to the turn's
provider-call allowance and recorded as the remedy `fresh_session_retry`. A second
timeout in the same turn stops the run, for example with
`supervisor provider timeout: no output for 120s (not remedied: already retried once)`.

### Provider failures

A decision turn that yields no proposal is classified from the provider's last
assistant message (`stopReason`, `errorMessage`), not from the missing JSON:
`quota` (429 and rate/usage limits; any reset time the message states becomes
`retryAt`), `overflow` (Pi's own `isContextOverflow`), `auth` (401/403 and
credential refusals), `transient` (see below), `interrupted` (see below), `empty` (no tool call and no
text, including thinking-only replies), `malformed` (text that is not a GraphDecision), `timeout` (see Prompt
timeouts), or `unknown`. The host
applies a fixed remedy without asking the model what to do: a quota error with a
reset time waits until then (at most three waits a turn, only within the
`maxWaitMs` the controller passes from the run's `waitMs`) and retries the turn;
an overflow compacts the session and retries once.

A provider error is `transient` when the provider failed on its side and the
request can simply be sent again: a leading HTTP status of 500, 502, 503, 504
or 529, an Anthropic-style error type `api_error` or `overloaded_error`, or a
message saying "internal server error", "overloaded", "service unavailable",
"bad gateway", "gateway timeout", "temporarily unavailable" or "please retry"
(case-insensitive). Quota (429), overflow and auth are checked first, so a 429
that says "please retry" stays `quota`. Live run cbef664d-c46 stopped on one:
`{"type":"error","error":{"type":"api_error","message":"Internal server error.
Please retry your request. (500)"}}`. The host backs off and retries the turn,
at most three times a turn: 2s, then 4s, then 8s (the supervisor option
`transientRetryBaseMs` sets the first backoff), or until a retry time the
message states, parsed as for quota. Each wait is charged to the same
`maxWaitMs` as quota waits, each retry to the turn's provider-call allowance,
and each is recorded as the remedy `backoff_and_retry` (`waitBasis` `backoff`
or `provider`). Stop interrupts the wait. A fourth transient failure stops the
run, for example `supervisor provider transient: ... (not remedied: still
failing after 3 retries in this turn)`; so does a backoff longer than the
remaining wait budget, or no provider call left.

A reply is `interrupted` when it ended normally (`stopReason` `stop`, the
provider's `end_turn`), carries no tool call and no non-empty text, and its usage
bills more than 32 output tokens beyond thinking (`usage.output -
usage.reasoning`; Pi records `reasoning` as a subset of `output`). Raw stream
captures from 28 replays of the failing prompt on live
`minimax-cn/MiniMax-M3.1-Flash-Preview` show why. In both thinking-only failures,
the stream held only a `thinking` block and `end_turn`, yet usage billed
non-thinking output that was never delivered: `output_tokens` 3694 with
`thinking_tokens` 3118 (576 undelivered), and 2374 with 1796 (578). Successful
replies spend 220 to 780 non-thinking tokens on their `tool_use` blocks. The
failures' thinking is indistinguishable from the successes', and it ends by
committing to the calls ("Let me write it."). The model generated the tool calls
and MiniMax's server dropped them, about 7% of the time on this prompt. The
threshold is small enough to catch a dropped call and large enough to ignore a
few tokens of framing. A reply with no reasoning breakdown, or with no surplus,
stays `empty`.

The model did not choose to stop, so nothing about the prompt needs correcting.
An interrupted reply gets up to two identical resends a turn, before the slip
remedies below. Each resend omits the prompt's user message and the broken
reply from the model's context, using Pi's own context-edit omission (the
mechanism behind its auto-retry; the transcript keeps both). It then sends the
same prompt text again, with no re-ask wording, so the request the model sees is
the one it was first sent. Each resend is charged to the turn's provider-call
allowance and recorded as the remedy `resend_interrupted`, whose message gives
the undelivered token count. A prompt that ran tool turns before the interrupted
reply is not resent, because resending it would repeat those turns; it goes to
the slip remedies, as does a third interrupted reply. Stop still wins over a
resend, and with no provider call left the turn stops by name.

An empty, malformed, or still-interrupted reply is a model slip, not a provider error. Live replays
against MiniMax show it is rare (about one first reply in 20, one re-ask in 10),
so one slip must not stop the run. Each slip in a turn gets the next of three
remedies, shared by both kinds:

1. Re-ask once in the same session, saying what was wrong (`reask`).
2. Retry the turn in a fresh episode session, opened as for a timeout, with the
   turn's full recovery prompt and any pending rejection (`fresh_session_retry`).
   This step is shared with, but counted apart from, the timeout retry.
3. When another model is configured, retry once on the next configured model in
   the operator's order, in its own session (`model_retry`, naming the model).
   This change applies to that attempt only: the episode's bound session is set
   aside, not closed, and the turn returns to it when `decide` ends, whatever the
   outcome. The binding never names the transient model, so the switch journal,
   which exists to reconcile a binding change interrupted by a crash, has
   nothing to record. A crash mid-attempt restores on the bound model, which is
   the correct state. The remedy record names the model for the operator.

A further slip stops the run, naming its class and what was tried, for example
`(not remedied: already re-asked once, then retried in a fresh session, then
retried on minimax-cn/MiniMax-M3 in this turn)`. A step that cannot run is named
too: `the host cannot open a fresh session` or `no other configured model to try`.
Each attempt is checked against the allowance first. With no calls left the
turn stops (`no provider calls left in the run's budget to retry`), and Stop
always wins. A provider error class (quota, transient, overflow, auth, timeout, unknown)
keeps its own handling and never counts as a slip. Every retried call,
compaction, re-ask, slip retry and rejection re-ask counts against the turn's
provider-call allowance. A provider failure is never sent to admission,
so it is not counted as an inadmissible proposal and is not charged to
`decisions`. The compaction honors the run's Stop
and the prompt timeout: either aborts Pi's summarization request and fails the
remedy.

Some providers give no reset time; MiniMax's quota 429 `(2056)` is one. For
those, the operator may set `quotaRetryMs` in the supervisor config
(`~/.config/graphloom/supervisor.json`, or `GRAPHLOOM_SUPERVISOR_CONFIG`), for
example `"quotaRetryMs": 300000`. A quota error with no parsed reset time then
waits that long and retries the turn. The wait has the same bounds as a
provider-stated one: the run's remaining `waitMs` and at most three waits a turn.
The remedy is recorded with `waitBasis: "operator"`. Without `quotaRetryMs`, such
an error stops the run. `drainRemedies()` reports what was
done; the controller charges the waits to `waitMs` and records each remedy in the
run's `remedies` (shown by `inspect`). A failure with no remedy left stops the
run with `stopReason` `supervisor provider <class>: <provider message>`, and the
blocker adds why no remedy applied (for example, no reset time, wait budget,
already compacted once, already retried once, still failing after 3 retries).

## Implementation and verification gaps

| Gap | Required work |
|---|---|
| Admission and candidate coding tools swap through private `AgentSession` fields | Replace with a public Pi tool-registry API when available; qualify on each Pi upgrade |
| Context/tool compatibility on switch | Check the target's context limits and modalities before switching; budgeted compaction or reported incompatibility |
| Invocation accounting | Turn caps count prompt turns; interception of compaction/retry provider calls is still required (both are disabled) |
| Live provider qualification | DeepSeek, MiniMax, and OpenAI accounts in the user's authorized scope (#30) |
| Claude included subscription allowance | Not supplied by direct Pi integration; the proposed Claude Code supervisor harness ([supervisor harnesses](design-supervisor-harnesses.md)) |

Faux-provider tests cover: each recovery episode, and the first turn after a
restart, opens a fresh session with no prior chat while the logical id stays;
switching DeepSeek → MiniMax → OpenAI keeps the episode's history in its session
and the next episode opens on the switched model; a credential failure (Anthropic without a key) keeps the current model;
Stop during a decision prompt or candidate patch settles as an operator stop; a
crash between switch intent and outcome reconciles from the session file; decisions
are capped at the remaining invocations and refused at zero; admission tools reject
malformed specs and end the turn on a valid one; a slowly streaming reply outlives
the inactivity limit, while a silent provider is retried once in a fresh session
and then stops by name; a `[record_finding, reenter]` batch is one provider call;
an interrupted reply is resent once or twice with the identical request and
none of the broken reply, then falls into the slip remedies, while a
thinking-only reply with no undelivered output still re-asks;
a thinking-only reply and re-ask recover in a fresh session, a third slip
recovers on the next configured model for that turn only, and exhausted remedies
or allowance stop by name; a `minimax-cn` session replays an empty-signature
thinking block as thinking (through a local Anthropic-compatible endpoint); and
settlements reach the next prompt. The MiniMax connectivity check above remains the only live check.

## Episode records and replay scoring (#122)

Every `decide()` call leaves one record in `DurableRunState.supervisorEpisodes`
(newest 50 kept): the trigger, the run view, the case file, the last settlement, the rejection and the
provider-call and wait allowances the call ran under, every inspection or `record_finding`
call with its result, the proposal, the error if it failed, the controller's
admission outcome (`admitted`, `inadmissible`, `model_switch`, `error`,
`aborted`) with the turn's rejections, and the provider calls spent. Tool results
are bounded at 8,000 characters and a record at 64 KB (`truncated: true`): what
does not fit is shrunk field by field, long strings cut and long arrays reduced
to their newest entries, so every field keeps its shape. The
controller wraps `input.inspect` and `input.recordFinding`, so any supervisor is
recorded the same way.

`replayEpisodes` (`@graphloom/supervisor`) feeds recorded episodes to a supervisor
configuration. Tool results come from the record, and admission is judged against
the facts recorded for the episode. The score is the share of proposals inside
each episode's labeled acceptable set, plus inadmissible proposals, probes
(`check_*` calls), provider calls and tokens per episode. A label is keyed by episode id and turn and lists acceptable actions, each
with an optional stage and, for `dispatch`, a purpose. A proposal the recorded
facts refuse (by type or by a parameter such as an unqualified artifact id), or a
turn that spent its three-rejection allowance, counts as an inadmissible stop.
A record keeps the call's rejection feedback and its provider-call and wait
allowances, and replay restores them. A tool call that threw live rejects in
replay, and one the record does not hold is reported as not recorded, never
answered with another call's result. The `Supervisor` interface reports
provider calls, not tokens, so tokens come from an optional `tokens` callback
(0 when absent). An episode whose `decide()` does not settle within the timeout is
aborted and scored as failed.

The 12 fixtures in `packages/supervisor/fixtures/episodes/9bfa446d-4ea/` are
reconstructed from the issue's description of run 9bfa446d-4ea; each label's note
says so. CI (`npm test`) scores a scripted baseline over them with no provider
calls. To score a live configuration (opt-in, spends provider calls):

```sh
GRAPHLOOM_REPLAY_LIVE=1 npm run replay:live -w @graphloom/supervisor -- \
  --provider minimax-cn --model MiniMax-M3
```

## Raw provider stream capture

`rawStreamCapture: true` in the supervisor config records every supervisor
provider request and its response bytes, one JSON line per request, in
`<stateDir>/supervisor/raw/<sessionId>.raw.jsonl`
(`packages/supervisor/src/raw-stream.ts`). Each record holds the request
payload (model, messages, tools, thinking), the status, the content-block
types and stop reasons the stream carried, the block types Pi's
Anthropic-messages parser does not turn into message content
(`unknownBlockTypes`), and the raw body. Request headers, which carry
credentials, are never written. It is off by default: it exists to show where
a model's output went when the recorded message lacks it — Pi's own
transcript cannot, because its parser skips block types it does not
recognize without an error. The capture wraps the session agent's stream
function and passes a teeing `fetch` through Pi's per-request options; it
fails loudly if a Pi upgrade removes that hook. Only Pi APIs whose adapters
pass a per-request `fetch` through are captured; Google Generative AI and
Google Vertex reject a custom `fetch`, so their requests are left untouched
and the log records once that they are not captured. Codex's adapter tries
a WebSocket first and uses `fetch` only on its SSE path, so capture selects
the SSE transport for `openai-codex-responses` requests. A response that breaks
off part-way (a dropped connection, an aborted prompt) is still recorded,
with the bytes that arrived and a `readError`.

