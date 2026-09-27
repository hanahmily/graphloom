# Pi SDK supervisor integration

Status (2026-09-25, #43): Pi-backed `createPiSupervisor` decides recovery through
GraphLoom admission tools on one durable session per run, with durable session
binding, per-decision turn caps settled against `agentInvocations`, operator Stop
during a prompt or patch, and journaled model switching with crash reconciliation.
The supervisor's Pi session writes qualified repairs itself into admitted
candidate trees through candidate-scoped coding tools; unconstrained edit/write on
the user worktree remains forbidden. The CLI composes a Pi supervisor from an
operator config file. These paths are verified with faux Pi providers; live
qualification against configured accounts is tracked in #30, and
BeforeProviderRequest interception is not implemented. Scripted supervisors stay
the CI default.
This document specializes the [core design](design-typescript-core.md).

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
Pi `agentDir`, and `promptTimeoutMs`. The file never holds credentials (`apiKey` is
refused). Without it, `graphloom run` has no supervisor. The run's Pi transcript
lives under `<stateDir>/supervisor`, and `resume` reopens it with the config's
current model list.

The adapter receives an explicit operator credential-store path and
provider/model selection rather than discovering credentials from the target repo.
It must resolve the existing reference without exposing the key to prompts,
transcripts, plugin processes, or activity events. A missing credential is a
configuration failure, not permission to silently select another account/region.
For key rotation, reopen the runtime so its cached credential-command result is
refreshed. Keep secrets outside the durable run record; record only the provider,
model, and nonsecret credential reference.

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
| User-authenticated, unmodified Claude Code | Anthropic documents subscription use through its genuine binary under its stated conditions | The coding-agent executor's Claude Code harness runs the user's own `claude` CLI and login ([executors](design-executors.md)); it is not a Pi model switch, and the supervisor stays on Pi |

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

## One logical session, multiple models

Create one Pi `AgentSession` for the run-wide supervisor using
`createAgentSession`, with explicit `ModelRuntime`, `SessionManager`, settings,
resource loader, and tools. Keep it in a dedicated supervisor process controlled
by the controller. The process can be restarted; the logical session and durable
history remain associated with the same GraphLoom run.

Pi's SessionManager owns its finalized conversational context; GraphLoom's store
owns run progress and accepted evidence. Persist session ID/file and active branch
alongside GraphLoom's supervisor metadata. Restore through SessionManager rather
than assigning an in-memory messages array. Reinject current pinned requirements,
fixed steps, remaining budgets, and admitted state after recovery; conversation
history cannot override those facts.
[Session lifecycle and storage](https://pi.dev/docs/latest/sdk).

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
5. Preserve history, tool results, fixed steps, and all counters. If the target
   cannot consume the current context, use an explicitly budgeted compaction or
   report incompatibility. Do not silently drop evidence or reset the conversation.

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
transitions, stage, generation, and switch outcomes. These are controller
observations, not the supervisor's claims.
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
   qualify_repair, activate_repair, return, stop, plus switch_model. Each tool's
   parameters are a JSON Schema of its action spec, so Pi returns malformed calls
   to the model for correction. The first valid call ends the turn and becomes the
   proposal; the controller admits it and reports its settlement at the start of
   the next prompt. A plain JSON decision reply remains a fallback for models
   without tool calling. Pi cannot mint Accept or alter pinned steps/requirements.
   After `Reenter` (or on a recovery `Dispatch`), the supervisor **supplies the
   job instruction** for that trial; it does not have to reuse the plugin's
   original prompt. Overrides remain bound to task, evidence contract, write
   scope, and reviewer independence.
2. **Pi coding tools for qualified repair** — after the controller admits
   `QualifyRepair` and materializes a candidate tree, the **same** supervisor
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

## Implementation and verification gaps

| Gap | Required work |
|---|---|
| Admission and candidate coding tools swap through private `AgentSession` fields | Replace with a public Pi tool-registry API when available; qualify on each Pi upgrade |
| Context/tool compatibility on switch | Check the target's context limits and modalities before switching; budgeted compaction or reported incompatibility |
| Invocation accounting | Turn caps count prompt turns; interception of compaction/retry provider calls is still required (both are disabled) |
| Live provider qualification | DeepSeek, MiniMax, and OpenAI accounts in the user's authorized scope (#30) |
| Claude included subscription allowance | Not supplied by direct Pi integration; separate genuine Claude Code backend if needed |

Faux-provider tests cover: two recovery episodes and a restart share one session
file; switching DeepSeek → MiniMax → OpenAI keeps prior history in the same
session; a credential failure (Anthropic without a key) keeps the current model;
Stop during a decision prompt or candidate patch settles as an operator stop; a
crash between switch intent and outcome reconciles from the session file; decisions
are capped at the remaining invocations and refused at zero; admission tools reject
malformed specs and end the turn on a valid one; and settlements reach the next
prompt. The MiniMax connectivity check above remains the only live check.
