# Pi SDK supervisor integration

Status: Pi-backed `createPiSupervisor` wires recovery decisions and durable
session binding (2026-09-24); provider call accounting settles against
`agentInvocations`. Cross-provider live switching qualification and
BeforeProviderRequest interception for multi-turn prompts remain follow-on
within #43. Scripted supervisors stay the CI default. This document specializes
the [core design](design-typescript-core.md).

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

The future adapter should receive an explicit operator credential-store path and
provider/model selection rather than discover credentials from the target repo.
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
| User-authenticated, unmodified Claude Code | Anthropic documents subscription use through its genuine binary under its stated conditions | Separate possible harness adapter; not a native Pi model switch and not implemented here |

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
credential paths; a later genuine Claude Code adapter needs its own integration
and session handoff qualification. It must not masquerade as Claude Code or proxy
its subscription credentials into Pi.
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
Pi documents persistent model changes and calls out cross-provider handoff as a
provider test requirement.
[Model selection](https://pi.dev/docs/latest/models),
[Provider integration testing](https://pi.dev/docs/latest/custom-provider).

## Tools, authority, and spend accounting

Construct the SDK with explicit resources and only GraphLoom-owned custom tools.
Disable default bash/edit/write and project-discovered extensions, skills, settings,
and prompt templates. Route observation, dispatch, validation, reentry, repair,
and Return requests through controller admission; tool results report actual
settlement. Pi must not directly mutate the run worktree or authoritative state.
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
[SDK events and cancellation](https://pi.dev/docs/latest/sdk).

## Implementation and verification gaps

| Gap | Required work |
|---|---|
| SDK dependency and MiniMax connection are ready; session adapter creates a durable Pi transcript | Wire controller recovery admission/results loop and GraphLoom-owned tools |
| Controller currently stops on Supervise | Wire one durable recovery decision owner and admission/results loop |
| Cross-provider switching | Serialize selection, journal switches, enforce context/tool compatibility, retain session/history |
| Invocation accounting | Count actual provider calls, including compaction/retry paths; avoid unmetered background work |
| Restart and cancellation | Reconcile session metadata, tool operations, active model, and generation fences |
| Claude included subscription allowance | Not supplied by direct Pi integration; separate genuine Claude Code backend if needed |

Tests must cover: two recovery episodes use the same logical session; switching
DeepSeek → MiniMax → OpenAI preserves prior tool evidence; credential failure does
not silently choose another provider; stop during a request settles safely; crash
between switch intent and completion reconciles correctly; no hidden SDK tool or
resource discovery; malformed/stale decisions cannot alter state; every model call
is budgeted; and the supervisor cannot add or remove plugin steps. Use scripted
provider transports for repeatable tests, followed by live qualification for
configured accounts within the user's authorized scope. The completed MiniMax
connectivity check above is the initial baseline; it does not satisfy these
recovery and cross-provider test requirements.
