# Supervisor harnesses: Pi, Claude Code, and Codex

Status: proposed design, 2026-10-26; not implemented. This supersedes the
Pi-only backend choice in the [core design](design-typescript-core.md) §6
("Standalone Pi SDK session implementation") and in the
[Pi supervisor design](design-pi-supervisor.md). Pi stays a supported harness,
and that document still governs the Pi harness's details. Recovery authority,
admission, the case file, the remedy table, and episode records stay as the
[supervisor robustness design](design-supervisor-robustness.md) specifies them.

## 1. Decision

The supervisor becomes a **harness-neutral supervisor host** with three
interchangeable agent backends (**supervisor harnesses**): Pi (in-process, as
today), Claude Code (the user's own `claude` CLI and login), and Codex (the
user's own `codex` CLI and login). The plugin states which harness it prefers,
as data. The operator's configuration says which harnesses are enabled and
holds their logins and models. The controller pins one harness when the run
starts, and only `resume --supervisor <harness>` changes it.

Why: a user who has only a Claude Code subscription or only a Codex login
cannot get automatic recovery today. `graphloom run` composes a Pi supervisor
only from `supervisor.json`
(`apps/graphloom/src/supervisor-config.ts:159`), and Pi needs a model API
credential. The coding-agent executor already runs both CLIs headless with
their own logins (`executors/coding-agent/src/claude-harness.ts`,
`codex-harness.ts`). The supervisor should reuse that, not copy subscription
credentials into Pi. Copying them is ruled out by the
[authentication findings](design-pi-supervisor.md#authentication-and-claude-code-plan-gap).

What does not change: one logical supervisor per run, with a fresh model
session per recovery episode. The controller admits the supervisor's decisions
without veto, and the admission tools still validate their shape. The step set
is fixed. Only the controller issues receipts. Budgets stay finite. Qualified
repair keeps its procedure: forked candidate trees, preflight, an independent
reviewer, and activation under the run lock.

Non-goals: [agent-host mode](design-agent-host.md), where an attached session
drives the run, is a separate design. So are mixing harnesses within one
supervisor session and adding a remote harness.

## 2. Today's seams

The code already splits along the line this design needs:

| Seam | Where | Harness-specific? |
|---|---|---|
| Controller port `Supervisor` (`decide`, `patchCandidate`, grants, `drainProviderCalls`, `drainRemedies`, `switchModel`, `requiresCitedEvidence`) | `packages/supervisor/src/types.ts:248` | No |
| `SupervisorInput` (trigger, `RunView` with `escalation`, `lastSettlement`, `caseFile`, `inspect`, `admission`, `rejection`, `maxProviderCalls`, `maxWaitMs`, `signal`) | `types.ts:37` | No |
| Decision loop: episode sessions, admission-tool turn, JSON fallback, slip/timeout/quota/transient/overflow remedies, per-turn allowance | `createPiSupervisor`, `pi-supervisor.ts:149`, `decideTurn` `:261` | No, apart from the type of the session it drives |
| Session port: `prompt(text, {tools, done, maxTurns, …})`, `drainTurnCount`, `lastReplyFailure`, `omitLastExchange`, `compact`, `setModel`, candidate grants | `PiSupervisorSession`, `pi-session.ts:136` | Its name and its tool type (Pi `ToolDefinition`) |
| Admission, inspection, and `record_finding` tools | `createAdmissionTools`, `tools.ts:299` | Only the Pi `ToolDefinition` shape |
| JSON fallback and normalization | `parseSupervisorDecision` (`decision.ts:18`), `normalizeProposalInput` (`item-arrays.ts:87`), `localRefusal`/`sanitizeProposal` (`pi-supervisor.ts:808`, `:837`) | No |
| Provider failure classes | `classifyAssistantMessage` (`provider-failure.ts:108`) | Reads Pi's `AssistantMessage` |
| Episode records, replay | Controller wraps `inspect` and `recordFinding` (`episode.ts`); `replayEpisodes` drives any `Supervisor` | No |
| Restore | `restorePiSupervisorFromBinding` (`restore.ts:52`), which the controller uses as its default (`packages/controller/src/controller.ts:1039`) | Yes, and the controller default is a layering leak |
| Repair and proposal reviewers | `piRepairDeps` (`apps/graphloom/src/repair-config.ts:59`) | Yes, Pi only |
| CLI process mechanics: minimal env, process groups, early session save, MCP bridge, quota and transient text classifiers | `executors/coding-agent/src/{child-env,process-group,harness,mcp-bridge,quota,transient}.ts` | Shared by the Claude and Codex executors |

So the controller's port is already neutral. The work is to (a) rename the Pi
session port into a harness port with a neutral tool type, (b) write two CLI
adapters for that port, and (c) move the CLI process mechanics where both the
executor and the supervisor can use them.

## 3. Supervisor harness contract

### 3.1 Layers

```text
controller ── Supervisor (unchanged port) ──► SupervisorHost   (packages/supervisor)
                                                │  decision loop, remedies, prompts,
                                                │  admission/inspection tools, binding
                                                ▼
                                      SupervisorHarness ── opens ──► HarnessSession
                                        pi | claude-code | codex      one per episode,
                                                                       plus reviewer sessions
```

- **`SupervisorHost`** is today's `createPiSupervisor`, renamed
  `createSupervisorHost`, and it takes a harness in place of a Pi session
  opener. It implements `Supervisor`. Everything in the robustness design lives
  here once and applies to every harness: the in-turn rejection loop, the
  three-rejection safe default, the grounding rule, the JSON fallback, the
  slip ladder, timeouts, quota and transient waits, and the per-turn provider
  allowance.
- **`SupervisorHarness`** opens sessions and declares what it can do.
- **`HarnessSession`** is today's `PiSupervisorSession` port
  (`pi-session.ts:136`) under a neutral name, with `SupervisorTool` in place
  of Pi's `ToolDefinition`.

```ts
type SupervisorHarnessName = "pi" | "claude-code" | "codex";

/** Harness-neutral tool; tools.ts builds these, and each harness adapts them. */
interface SupervisorTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments; a harness rejects a call that does not satisfy it before execute. */
  parameters: Record<string, unknown>;
  execute(callId: string, args: unknown, signal?: AbortSignal):
    Promise<{ text: string; isError?: boolean; terminate?: boolean }>;
}

interface HarnessCapabilities {
  /** Pi: setModel keeps the episode's chat. CLI harnesses switch by opening a fresh session (§3.4). */
  inSessionModelSwitch: boolean;
  /** Pi: compact(). CLI harnesses answer an overflow with a fresh session (§6). */
  compaction: boolean;
  /** Pi: omitLastExchange() for resend_interrupted. */
  exactResend: boolean;
  /** Pi: provider requests are counted at the turn hook. CLI: reserved from the event stream, as the executors do. */
  exactProviderCalls: boolean;
  rawStreamCapture: boolean;
}

interface SupervisorHarness {
  readonly name: SupervisorHarnessName;
  readonly capabilities: HarnessCapabilities;
  /** Why this harness cannot serve now (binary, flags, login presence, bwrap), or undefined. Spends no provider call. */
  probe(): Promise<string | undefined>;
  openSession(args: {
    model: SupervisorModelRef;
    role: "decide" | "review";
    /** Tag only: the host enforces that each episode gets its own session. */
    episodeId?: string;
  }): Promise<HarnessSession>;
  /** Re-attach a logical supervisor after a restart; it never reopens a transcript (§3.3). */
  restore(binding: SupervisorBinding): Promise<{ model: SupervisorModelRef }>;
}

/** Today's PiSupervisorSession with neutral tool types; members marked optional stay optional. */
interface HarnessSession {
  readonly sessionId: string;            // harness-native: Pi id, Claude session UUID, Codex thread id
  readonly sessionFile: string | undefined; // GraphLoom's copy under <stateDir>/supervisor/<harness>/
  readonly model: SupervisorModelRef;
  prompt(text: string, options?: {
    tools?: SupervisorTool[]; done?: () => boolean; signal?: AbortSignal;
    timeoutMs?: number; maxTurns?: number; reservedTurns?: () => number;
  }): Promise<string>;
  drainTurnCount?(): number;
  peekTurnCount?(): number;
  lastReplyFailure?(): ProviderFailure | undefined;
  omitLastExchange?(): boolean;
  compact?(o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  setModel?(ref: SupervisorModelRef): Promise<void>;
  grantCandidateCoding?(candidateRoot: string): Promise<void>;
  revokeCandidateCoding?(): Promise<void>;
  /** Usage of the last prompt, for episode records and replay scoring. */
  lastUsage?(): { inputTokens: number; outputTokens: number } | undefined;
  close(): Promise<void>;
}
```

`SupervisorModelRef` keeps `{ provider, modelId, thinkingLevel? }`. For a CLI
harness, `provider` is the harness name. So `claude-code/opus` and
`codex/gpt-5-codex` are valid model refs, and `graphloom switch-model` and the
`switch_model` tool work unchanged.

### 3.2 One supervisor turn

A turn takes the same input as today. `decide(input)` receives the trigger
(`RecoveryTrigger`) and the `RunView` with `escalation.repeatedProposals`
(the [run convergence design](design-run-convergence.md) §4.3). It also
receives `lastSettlement`, the live case file, `inspect`, `admission`
(narrowing facts, `check`, and `refuse`), any pending `rejection`, the
provider and wait allowances, and the stop signal. The host builds the
recovery prompt (`buildRecoveryPrompt`) and the tool set
(`createAdmissionTools`), then calls `session.prompt` on the episode's
session.

A turn returns what it returns today: one `SupervisorProposal`. That is a
`GraphDecision` that the controller's pre-admission check accepted, or a
`switch_model` request. A turn that cannot produce one throws a classified
`SupervisorProviderError`. The controller then admits the proposal without
veto, through the same `admit` path for every harness.

Each harness must provide these behaviors. The CLI harnesses get them through
the bridge in §4:

1. **Tool-shape validation.** A call whose arguments break the tool's JSON
   Schema returns an error to the model and does not end the turn. Pi does
   this from `parameters`. The MCP bridge must do the same on the server side
   (§4.2).
2. **The first admitted action ends the turn.** The action tool's
   `execute` returns `terminate: true`, and the host's `done()` turns true.
   Pi aborts at the next `turn_start` (today's behavior). A CLI harness stops
   its process right after it delivers that tool result: Claude Code gets the
   stream-json `interrupt` control request that the executor already sends
   (`claude-harness.ts:505`), and Codex gets SIGINT to its process group.
   Provider calls that already started are charged. None is started after
   `done()`.
3. **`record_finding` and inspection tools do not end the turn.**
4. **No other writing tool is available while deciding** (§5).

### 3.3 One logical session across episodes

Identity, budgets, and the switch journal are run-wide
(`supervisorBinding.sessionId`). Model chat is per episode, and the case file
is the only memory across episodes (robustness §4.4). That rule is what makes
the three harnesses interchangeable. Continuity is only ever needed *within*
one episode: from a turn to the next turn after settlement, and from the
decision to `patchCandidate`.

| | Pi | Claude Code | Codex |
|---|---|---|---|
| New episode | `createAgentSession` (today) | New UUID, first call `--session-id <uuid>` | `codex exec` with no thread. The id comes from `thread.started` |
| Next turn, same episode | Same `AgentSession` | `--resume <uuid>` in a new process | `codex exec … resume <thread> -` |
| Follow-ups within one turn (rejection re-ask, slip re-ask) | Same prompt loop | Extra `user` messages on the same process's stream-json stdin | `exec resume` of the same thread |
| Fresh-session remedy (timeout, slip step 2, overflow) | `openSession` | New UUID; the turn's full opening prompt plus any pending rejection | New thread, same prompt |
| Transcript evidence | Pi session file under `<stateDir>/supervisor/` | Copy of the transcript at `<stateDir>/supervisor/claude-code/<ref>.jsonl`, saved during the turn with `sessionSaver` and `completeJsonl` (`harness.ts`, the early capture from #204) | Copy of the rollout at `<stateDir>/supervisor/codex/codex-<thread>.jsonl`, same saver |
| Controller restart | Fresh session on the bound model; transcripts never reopened (`restore.ts`) | Same: fresh session. Copies stay for evidence | Same |
| Session lost mid-episode (store wiped, copy corrupt) | n/a | Write GraphLoom's copy back into Claude Code's store, as the executor's resume does. If that fails, use the `fresh_session_retry` remedy. Not fatal | Same, with the rollout written back into the Codex home |

`supervisorBinding` gains `harness: SupervisorHarnessName`. A binding without
it reads as `pi`, so every recorded run still loads. `sessionFile` names
GraphLoom's copy of the latest episode transcript, and it is never reopened.
The controller stops importing `restorePiSupervisorFromBinding` as its default
(`controller.ts:1039`). The CLI composition root passes `restoreSupervisor`
for the bound harness, so the controller knows no backend.

### 3.4 Model switching per harness

The operator's model list is per harness. `switch_model` and
`graphloom switch-model` accept only models of the run's pinned harness. A
model on another harness is refused, and the refusal says to use
`resume --supervisor` instead.

- **Pi:** unchanged. `setModel` keeps the episode's chat. Intent and outcome
  are journaled, and a crash is reconciled from the session file's
  `model_change`.
- **Claude Code / Codex:** a committed switch takes effect at the next prompt.
  The harness opens a fresh episode session on the new model and resends the
  turn's opening prompt. It does not resume the old transcript under another
  model. The executors refuse a cross-model resume for the same reason: the
  earlier turns would pass as continuity (`docs/design-executors.md`, Claude
  and Codex resume). Nothing is lost, because the case file holds the memory.
  Crash reconciliation is simpler than Pi's. An `intent` without an outcome
  is committed when the settings record beside GraphLoom's newest session
  copy (`<ref>.json` or `codex-<thread>.json`, which record the model as the
  executors' copies do) names the target model, and failed otherwise.
- The `model_retry` slip remedy uses the next model *of the pinned harness*
  for that attempt only, as today.
- `thinkingLevel` maps to Codex `model_reasoning_effort` (`--config`, which
  the executor already passes). For Claude Code it has no flag and is ignored,
  with a `check` warning when it is set.

### 3.5 Evidence, replay, and private reasoning

Episode records (`DurableRunState.supervisorEpisodes`) are built by the
controller around `inspect` and `recordFinding` (`episode.ts`), so they are
already harness-neutral. Each record gains `harness` and the model the session
actually reported. `replayEpisodes` drives any `Supervisor`. The live replay
script gains `--harness claude-code|codex|pi --model <id>`.

The activity feed carries tool calls, settlements, and the bounded reply text.
Thinking blocks (Claude Code's `thinking`, Codex's `reasoning` items) are
dropped, as Pi's are. The design rule holds: show concise reasons, not private
model reasoning.

## 4. Tool surface per harness

### 4.1 The tools

The tools stay those of `tools.ts`: the eight action tools
(`GRAPHLOOM_SUPERVISOR_ACTIONS`), narrowed by `AdmissionFacts`,
`switch_model`, `record_finding`, and the eight inspection and probe tools
(`INSPECTION_TOOL_NAMES`). In S1 `createAdmissionTools` returns
`SupervisorTool[]`, and one adapter per harness exposes them:

| Harness | How the tools reach the model |
|---|---|
| Pi | In-process. `SupervisorTool` is wrapped into Pi `ToolDefinition`, which is today's code with the type moved out |
| Claude Code | **GraphLoom MCP server over loopback HTTP**, given with `--mcp-config` and `--strict-mcp-config`. Tools appear as `mcp__graphloom__<name>` |
| Codex | **The same MCP server, through a stdio relay** that Codex launches as `mcp_servers.graphloom` (`--config`) |

**Claude Code: reuse the existing HTTP bridge, not a new stdio server.** The
tools' authority (`admission.check`, `inspect`, `recordFinding`) lives in the
controller process, so a stdio server would have to call back into it over IPC
anyway. `startToolBridge` (`executors/coding-agent/src/mcp-bridge.ts:32`)
already does this, with a per-turn bearer token, loopback only, and one call
at a time. Claude Code's executor turns already connect to it. bwrap does not
unshare the network (`packages/runner/src/confine.ts`), so a confined CLI can
reach loopback.

**Codex: MCP, not `--output-schema`.** Without tools, Codex could not call
`list_evidence`, `check_validate`, or `record_finding`. The host would have to
set `requireCitedEvidence: false` (`pi-supervisor.ts:114`), and that brings
back the ungrounded `stop`s and repairs that robustness §2.1 was written to
remove. `--output-schema` is also a poor fit. The schema must be strict
(every property required, no extras, per `docs/design-executors.md`), and
`GraphDecision` is a union of eight action shapes. It would also force a JSON
final message even after an action tool was already admitted. The relay is a
small stdio MCP server (`supervisor-mcp-relay.mjs` in the shared package). It
forwards JSON-RPC to the loopback bridge and reads the URL and token from its
environment (`mcp_servers.graphloom.env`), so neither appears in argv. Codex
supports stdio MCP servers everywhere. Streamable-HTTP support with bearer
tokens differs between Codex versions, so the relay avoids depending on it.

**JSON fallback stays for every harness.** A reply with no admitted tool call
is parsed with `parseSupervisorDecision`, normalized with
`normalizeProposalInput` (the `{"item": …}` array encoding), and passed
through `localRefusal` and `admission.check` (`pi-supervisor.ts:600-635`).
This covers a CLI build whose MCP connection failed during a turn. The
Claude Code `system/init` event reports each MCP server's status, and the
executor already reads it (`claude-harness.ts:665`). The host then also
removes the probe-dependent grounding for that turn (`requiresCitedEvidence`
false for that `decide` only) and records `mcp_unavailable` on the episode.
A harness whose bridge never connects fails `probe()`, and the run never
selects it (§7).

### 4.2 Bridge changes (S2)

- The bridge now lists `inputSchema: {type: "object", additionalProperties:
  true}` for every tool (`mcp-bridge.ts:58`). It will publish each tool's real
  schema, and on `tools/call` it validates the arguments against that schema.
  A violation returns `isError: true` with the message. That matches Pi's
  validation from `parameters` (§3.2 item 1).
- A tool result with `terminate: true` triggers the harness's turn end
  (§3.2 item 2) after the result is written.
- The bridge, `minimalEnv`, `process-group`, `sessionSaver`/`completeJsonl`,
  `classifyQuota`, and `classifyTransient` move from
  `executors/coding-agent/src` into a new internal workspace package,
  **`@graphloom/agent-cli`** (`packages/agent-cli`). Both
  `@graphloom/executor-coding-agent` and `@graphloom/supervisor` depend on it.
  The supervisor must not depend on an executor package: executor bytes are
  pinned per run and may be repaired run-locally.

### 4.3 Investigation and repair writes

While deciding, every harness sees the same evidence: the tools above, which
read recorded evidence, receipts, and the workspace candidate, and run dry
probes. That is Pi's surface today. Claude Code runs with `--tools ""`, so it
has no built-in tools, only the GraphLoom MCP tools. Codex cannot turn off its
shell. It runs `--sandbox read-only` inside bwrap, so its shell can read but
not write. That is the one documented difference (§9).

Writes that change the run go only through admission tools (`dispatch`,
`validate`, `reenter`, `qualify_repair`, `activate_repair`, and the rest),
which the controller admits. The one filesystem write an agent makes itself
is the **qualified repair patch** (`patchCandidate`). It happens after
`qualify_repair` is admitted and the controller has materialized a candidate
under `<stateDir>/repairs/<artifactId>/candidate`, and it writes only into
that tree. This is today's procedure (core §7), with the same grant and revoke
calls and the same post-patch digest checks of the live install, the run
worktree, and the state. CLI harnesses add OS confinement (§5.1):

- **Claude Code patch:** a turn in the episode's session (`--resume`) with
  `--tools default` and `--permission-prompt-tool stdio`. Every native tool
  request is judged by `evaluateClaudePermission`
  (`executors/coding-agent/src/claude-permissions.ts`) with `cwd` set to the
  candidate root, `writeScope: ["**"]`, and `readOnly: false`. It allows
  Bash, since the candidate needs building and testing. Claude Code keys its
  sessions by project directory. The harness therefore moves GraphLoom's copy
  of the episode transcript into the candidate's project directory before the
  patch turn, using the executor's write-back. If the move fails, the patch
  runs in a fresh session: `buildRepairPrompt` already carries the target,
  reason, root, and review feedback.
- **Codex patch:** `codex exec --sandbox workspace-write --cd <candidate root>
  resume <thread>`. The executor refuses Codex writes because Codex "cannot
  confine writes to a write scope" (`codex-harness.ts:109-121`). Here the
  scope is the whole candidate tree, which `workspace-write` plus bwrap
  enforces. If the pinned Codex's own sandbox cannot start inside bwrap (a
  nested user namespace), S3 runs `--sandbox danger-full-access` inside
  GraphLoom's bwrap, whose only writable paths are the candidate, the scratch
  directory, and the Codex home. GraphLoom's bwrap is the authority in either
  case.

### 4.4 Reviewer sessions

The repair reviewer and the proposal reviewer (robustness §4.5) open sessions
on the run's pinned harness with `role: "review"`. Pi is not required: a
Claude-only user still gets independent review. A reviewer session is a
different session id with no shared chat. It is read-only: Pi gets
`createCandidateReviewTools`, Claude Code gets `--tools "Read,Grep,Glob"`
judged with `readOnly: true`, and Codex runs `--sandbox read-only --cd
<candidate>`. Today's `piRepairDeps` becomes `harnessRepairDeps(harness,
config)`.

## 5. Confinement, credentials, budgets

### 5.1 Confinement

Every Claude Code or Codex supervisor process runs under bwrap through the
runner's `confineWorker` (`packages/runner/src/confine.ts`). The CLI
composition root injects it as a `launch` function, so
`@graphloom/supervisor` does not depend on `@graphloom/runner`.

| Process | Read | Write (bwrap binds) |
|---|---|---|
| Decide turn | Whole filesystem read-only (`--ro-bind / /`). Claude Code uses none of it (no native tools). Codex reads through its read-only sandbox | `<stateDir>/supervisor/<harness>/scratch`, and the harness's own state dir (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`) as `trustedWritable`, like the executor's `ownState` (`executors/coding-agent/src/package.ts:59`, `packages/runner/src/registry.ts:601`) |
| Patch turn | Same | The above plus the admitted candidate root only |
| Review session | Same | Scratch and own state dir only |

Never writable: the run worktree, the source checkout, the live plugin or
executor install, `<stateDir>` outside the supervisor scratch, and the
operator's other config. The state dir has to stay writable: the CLI writes
transcripts and refreshes its OAuth token there, and GraphLoom must not copy
credentials elsewhere. Its contents are the user's own, as for executor jobs.
A host without working bwrap fails `probe()` for both CLI harnesses, which
then cannot be selected (§7). Pi runs in-process and keeps its current
detection-based guard for patches (core §7).

User-level Claude Code hooks, plugins, and MCP servers must not run inside the
supervisor. `--strict-mcp-config` excludes the user's MCP servers. S2 also
passes `--settings` turning hooks off (`disableAllHooks`), and the capability
probe confirms the flags the adapter needs (`capability-probe.ts`, with new
`CLAUDE_SUPERVISOR_FLAGS` and `CODEX_SUPERVISOR_FLAGS` lists).

### 5.2 Credentials

- **Claude Code** uses the user's existing login in its config dir: genuine,
  unmodified Claude Code, authenticated by the user, in line with the
  documented rule. GraphLoom never reads, copies, or proxies that login. The
  child gets `minimalEnv` plus `claude.passEnv`. `ANTHROPIC_API_KEY` is not
  passed, so a subscription user is not billed on an API key by accident. An
  operator who wants API billing binds a key explicitly, as the executor
  allows.
- **Codex** uses its own login in `CODEX_HOME`, with the same minimal
  environment rules.
- **Pi** is unchanged: an operator credential reference, never in
  `supervisor.json` (`apiKey` is refused, `supervisor-config.ts:79`).
- Neither CLI harness needs an API key. `supervisor.json` keeps refusing
  secrets for every harness.

### 5.3 Budgets

| Budget | Pi | Claude Code / Codex |
|---|---|---|
| `agentInvocations` (provider calls) | Counted at each turn start (`drainTurnCount`) | Reserved like the executors: one before the process starts, one more each time the stream shows a tool result going back to the model (`claude-harness.ts:418`, `:543`; `codex-harness.ts:331`, `:400`). A refused reservation interrupts the process. `maxProviderCalls` and `reservedTurns` bound a turn as today |
| `decisions` | Charged by admission (`refuse`, `check`) | Same, harness-independent |
| `waitMs` | Quota and transient waits within `maxWaitMs` | Same (§5.4) |
| `probes` | Inspection probes | Same |

`outstandingProviderCalls` reports the reservations a running process has
made and not yet settled. Token usage comes from Claude Code's `result`
(`modelUsage`, minus the resumed `cost-state` baseline, as the executor
computes it) and Codex's `turn.completed`. It goes to `lastUsage` for episode
records and replay scoring, not into budgets.

### 5.4 Quota, timeouts, and transient errors

The host's remedy code stays as it is. Each harness only has to classify its
failures into `ProviderFailure`:

- **Quota / usage limit.** Subscription limits ("You've hit your session
  limit · resets 12:20pm (UTC)", Codex's usage-limit message) are classified
  by `classifyQuota(harness, text)` (`executors/coding-agent/src/quota.ts:146`),
  which becomes `failureClass: "quota"` with `retryAt = resetAt`. The existing
  in-turn remedy applies: wait until `retryAt` plus a 30 s margin (the
  executors' margin) when that fits the turn's `maxWaitMs`, with at most three
  waits a turn, then retry. Otherwise the run stops, retryable:
  `supervisor provider quota: … (not remedied: the reset at … is …s away; …s
  of the run's wait budget remain)`. `resume` after the reset continues it.
  Executor jobs and the supervisor often share one subscription. Both then
  wait on the same `resetAt`, and neither treats the limit as a model error.
- **Timeouts.** `promptTimeoutMs` (inactivity, counted as no stream event:
  stream-json events for Claude Code, `--json` events for Codex, with a
  running MCP tool or command not counted) and `promptTotalTimeoutMs` keep
  their meaning and defaults. On a timeout the host kills the process group
  (`process-group.ts`), and the remedy is `fresh_session_retry` once, then a
  named stop, as today. Claude Code's startup watchdog (`startupTimeoutMs`)
  also applies.
- **Transient errors.** `classifyTransient(harness, text)`
  (`transient.ts:93`) maps capacity, 5xx, overloaded, and connection-reset
  messages to `transient`. The host's `backoff_and_retry` (2 s, 4 s, 8 s, at
  most three, charged to `waitMs`) then resumes the same session and resends
  the turn's prompt. Inspection calls the failed attempt made are read-only
  and recorded, so repeating them is safe. An admitted action ends the turn
  before any failure can follow it. The executor's own retry policy
  (`GRAPHLOOM_CODING_RETRY_*`) does not apply to supervisor turns, so the
  remedy table keeps one owner.
- **Auth.** "Not logged in" or an expired login is `auth`. The run stops
  naming the harness and `claude /login` or `codex login`. It never falls back
  to another harness mid-run (§7.3).

## 6. Failure modes and parity

| Failure | Pi (today) | Claude Code | Codex |
|---|---|---|---|
| Quota with a reset time | wait_and_retry | Same, via `classifyQuota` | Same |
| Quota without a reset time | `quotaRetryMs`, else stop | Same | Same |
| Transient 5xx / overloaded | backoff_and_retry ×3 | Same, via `classifyTransient`; resume the session | Same |
| Context overflow | compact_and_retry once | **fresh_session_retry** ("Prompt is too long"). The CLI's own auto-compaction stays on, and the case file is the memory | **fresh_session_retry**. Codex auto-compacts on its own |
| Timeout | fresh_session_retry once | Same (kill the group, new UUID) | Same (new thread) |
| Empty or thinking-only reply | reask, fresh session, model_retry | Same ladder. Detected from the final `result`: no tool call and empty `result` text | Same. Detected from an empty `--output-last-message` with no MCP call |
| Interrupted (output billed but dropped) | resend_interrupted ×2 | Not detectable: CLI output is already parsed. Treated as `empty` | Same |
| Malformed JSON reply | Slip ladder; JSON parser and normalization | Same code | Same code |
| Inadmissible proposal | In-turn rejection; three per turn, then the safe default | Same (rejections are tool results) | Same |
| Repeated no-progress proposal (convergence §4.3) | Rejected in-turn by the admission tools (`supervisorProposalKey`); the JSON path checks too (`pi-supervisor.ts:640`) | Same code | Same code |
| Process crash or nonzero exit without a result | n/a | `unknown`, with the stderr tail. One fresh_session_retry is counted as the timeout retry, then stop | Same |
| MCP bridge not connected | n/a | That turn uses the JSON fallback without grounding (§4.1). If the probe fails, the harness is not selectable | Same |
| Session lost | Never reopened | Write the copy back, else a fresh session | Same |
| Operator Stop | Abort, then idle | Interrupt, then SIGTERM, then SIGKILL after grace. Settles once the group is gone (`drainOnExit`) | SIGINT, then the same |

**Pi-only at first, and why:**

- `compact_and_retry`: CLI harnesses compact on their own and do not expose
  it as a call GraphLoom can count. A fresh session is the equivalent here.
- `resend_interrupted`: it needs Pi's context-edit omission, and CLI output
  does not show undelivered tokens.
- In-session model switch: CLI harnesses switch by opening a fresh session
  (§3.4).
- `rawStreamCapture`: it needs Pi's per-request `fetch`. CLI harnesses record
  their own event stream and transcript copy, and `check` warns when the flag
  is set for them.
- Exact provider-call counting: CLI harnesses reserve from the stream, as the
  executors do.
- MiniMax `allowEmptySignature`: provider-specific to Pi.

None of these changes the recovery contract. Each degrades to a remedy that
already exists.

## 7. Selection and pinning

### 7.1 Plugin declaration (data)

`GraphDefinition` (`packages/sdk/src/types.ts:53`) gains an optional field.
Like `defaultBudgets`, the plugin returns it from code, and its profile can
vary it:

```ts
interface SupervisorPreference {
  /** Harnesses in the plugin's order of preference. */
  harnesses: Array<"pi" | "claude-code" | "codex">;
  /** Model hints per harness, by modelId; honored only when the operator configured that model. */
  models?: Partial<Record<"pi" | "claude-code" | "codex", string[]>>;
  /** Refuse to run, rather than fall back, when none of `harnesses` is available. Default false. */
  required?: boolean;
}
interface GraphDefinition { /* … */ supervisor?: SupervisorPreference }
```

The SDK validates the shape only. The controller stores the preference and
the resolved selection as opaque data and never branches on harness names.
The CLI composition root does the selection, and it knows nothing of the
plugin. This keeps the memory rule: the plugin declares its contract as data.
The preference is read at intake and not compared again on resume or repair,
the same way `defaultBudgets` is treated.

### 7.2 Operator configuration

`supervisor.json` gets a per-harness form. Today's flat Pi form still parses
as `{ harnesses: ["pi"], pi: { … } }`.

```json
{
  "harnesses": ["claude-code", "codex", "pi"],
  "select": "claude-code",
  "claude": { "command": "claude", "configDir": "~/.claude", "models": ["opus", "sonnet"] },
  "codex": { "command": "codex", "codexHome": "~/.codex",
             "models": [{ "modelId": "gpt-5-codex", "thinkingLevel": "high" }] },
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "models": ["deepseek/deepseek-chat"] },
  "promptTimeoutMs": 120000,
  "promptTotalTimeoutMs": 900000,
  "quotaRetryMs": 300000
}
```

- `harnesses` is the allowlist, in the operator's fallback order. A harness
  that is not listed is **forbidden**, whatever the plugin prefers.
- `select` is optional and **overrides** the plugin for every run.
- The first model listed for a harness is that harness's initial model, and
  the rest are switch targets. A plugin model hint reorders the configured
  models. A hint for a model the operator did not configure is ignored, with
  a `check` warning, because there is no silent model substitution.
- Credentials are refused, as today.

### 7.3 Precedence and fallback

Resolved once, at `run` (and reported by `check`), in this order:

1. `graphloom run --supervisor <harness>`. It must be listed in `harnesses`
   and pass `probe()`, or `run` refuses.
2. `supervisor.json` `select`, with the same conditions.
3. The plugin's `supervisor.harnesses`, in plugin order: the first that is
   enabled and passes `probe()`.
4. If none matches: with `required: true`, `check` fails and `run` refuses
   with `supervisor: plugin requires one of claude-code, codex; enabled and
   available: pi`. Otherwise use the first enabled, available harness in the
   operator's order, and print and record the reason (`plugin prefers
   claude-code; claude-code is not enabled; using pi`).
5. If no harness is available: no supervisor, as when there is no config
   today, with a `check` warning.

"Available" means `probe()` passed. That checks the binary and the adapter's
flags (capability probe), login presence where it can be read without a
provider call, bwrap for the CLI harnesses, and a Pi credential reference.
A probe spends no provider call, so a login that has expired surfaces at the
first turn as `auth` (§5.4).

### 7.4 Pinning

Intake records `state.supervisorSelection = { harness, source:
"flag"|"operator"|"plugin"|"fallback", reason, preference }`. The binding's
`harness` must equal it. The selection is fixed for the run, like the executor
catalog:

- `resume` checks the pinned harness. If it is no longer listed or no longer
  passes `probe()`, the run stops with `supervisor harness pin mismatch:
  claude-code is not available (…); resume with --supervisor <harness>`.
  Nothing falls back silently, and nothing switches mid-run on a provider
  failure.
- `graphloom resume <run> --supervisor <harness>` is the explicit transition,
  the supervisor's counterpart of `--update-executors`. It keeps the logical
  session id, budgets, case file, and episode records. It records
  `supervisorTransitions` (from, to, reason, generation), a
  `supervisorUpdate` evidence record, and an `inspect` line. The next episode
  opens on the new harness. This is the "explicit host rebind" that core §6
  already allows.

### 7.5 issue-fix declares a supervisor (S4)

issue-fix profiles gain `"supervisor": { "harnesses": ["claude-code",
"codex", "pi"] }`, and `profile.ts` returns it in `GraphDefinition.supervisor`.
`graphloom.json` keeps its executor `harnesses` (implementer `claude-code`,
reviewer `codex`). The supervisor preference is independent of those, and the
reviewer independence rules do not depend on it.

## 8. Testing

All tests below run in CI with no provider calls unless they are marked live.

- **Contract tests (S1).** The current Pi supervisor suites
  (`pi-supervisor*.test.ts`, `pi-session*.test.ts`, `episode-replay*.test.ts`,
  `restore.test.ts`) run unchanged against `createSupervisorHost` with the Pi
  harness. A shared `harnessConformance(harness)` suite runs every remedy
  path through a scripted `HarnessSession`: rejection loop, slips, timeout,
  quota, transient, the switch journal, and grants. Every harness must pass it.
- **Fake CLIs.** `executors/coding-agent/test/fake-claude.mjs` already
  scripts MCP tool calls (`{ tool, args }` steps through the `--mcp-config`
  server), `{ limit }`, `{ error }`, `{ hang }`, `{ crash }`, resume, and the
  interrupt protocol. S2 adds `--tools ""` handling and a check that no native
  tool is requested while deciding. `fake-codex.mjs` gains MCP tool steps
  through the stdio relay, `exec resume`, a usage-limit message, and a
  transient error. Both move to `packages/testkit` for the supervisor tests.
- **MCP plumbing.** Bridge tests for: schema rejection with `isError`, a
  terminating result ending the turn and interrupting the process, a wrong or
  missing bearer token refused, the relay forwarding and keeping its token out
  of argv, and serialized calls.
- **Confinement.** On CI hosts with bwrap (#170 installs it), a fake CLI
  tries to write the worktree, the live install, and the state dir during
  decide and patch turns. Each write fails, and the candidate root is
  writable only during a patch turn.
- **Selection.** Table tests for the precedence in §7.3, the `required`
  refusal, the forbid allowlist, pin mismatch on resume, and the
  `--supervisor` transition: identity, budgets, and case file kept, and
  transition evidence written.
- **Replay fidelity.** The `9bfa446d-4ea` replay set scores the same with a
  scripted harness behind each adapter (S1 to S3). The live scorer takes
  `--harness`.
- **Live (opt-in).** `GRAPHLOOM_SUPERVISOR_LIVE=claude-code|codex`, with the
  user's login: one recovery episode on a fixture run (an `executor_failed`
  that needs `reenter`), one qualified repair patch with review, and one
  resume across a restart. They are skipped without the env var, like
  `pi-supervisor-live.test.ts`.

## 9. Phases

| Phase | Scope | Verification |
|---|---|---|
| **S1. Contract extraction** | `SupervisorTool`, `HarnessSession`, `SupervisorHarness`; `createSupervisorHost` (renamed from `createPiSupervisor`, with an alias kept); Pi harness adapter; `binding.harness` (absent reads as `pi`); controller drops its Pi restore default. No behavior change | All existing supervisor and controller tests pass unmodified; the replay set scores identically; a recorded run without `harness` resumes |
| **S2. Claude Code harness** | Extract `@graphloom/agent-cli` (executors keep behavior); bridge schema validation and turn end; Claude decide, patch, and review sessions; bwrap launch; quota and transient classification; transcript copies; capability-probe flags | Conformance suite; fake-claude MCP and interrupt tests; confinement tests; executor suites unchanged; one opt-in live episode on a Claude subscription with no API key in the environment |
| **S3. Codex harness** | Stdio relay; Codex decide, patch, and review; `exec resume` continuity; the nested-sandbox decision from §4.3; usage-limit mapping | Conformance suite; fake-codex relay tests; confinement tests; opt-in live episode with a Codex login only |
| **S4. Plugin selection** | `GraphDefinition.supervisor`; per-harness `supervisor.json`; `run --supervisor`, `resume --supervisor`; `state.supervisorSelection` and transitions; `check` reporting; issue-fix profiles declare a preference | Selection table tests; `check` output for each §7.3 branch; an issue-fix rehearsal shows the resolved harness; `inspect` shows the selection and any transition |
| **S5. Docs and doctor** | README, examples guide, design cross-links; the doctor's "Supervisor config" check covers each enabled harness's `probe()`; `graphloom stats` per-harness supervisor usage | Link, format, and consistency checks; doctor output on hosts with Claude only, Codex only, and Pi only |

## 10. Open questions

1. **Investigation reads for Claude Code.** Should decide turns get
   read-only `Read`, `Grep`, and `Glob` over the run worktree and plugin
   source? That gives more diagnostic power, but file contents then enter the
   transcript. Proposed: no, for parity with Pi. The inspection tools read
   the candidate.
2. **Reviewer harness.** Should an operator be able to put the repair or
   proposal reviewer on a different harness from the supervisor (for example,
   Codex reviewing a Claude Code patch) for stronger independence? Proposed:
   same harness at first, with an optional `reviewer.harness` later.
3. **issue-fix default order.** Proposed `claude-code`, `codex`, `pi`. Confirm,
   or put `pi` first for operators who already have the MiniMax setup.
