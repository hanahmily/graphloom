# Supervisor harnesses: Pi, Claude Code, and Codex

Status: proposed design, 2026-10-26; S1 (the shared harness library, §3)
implemented, S2 to S6 not implemented. This supersedes the
Pi-only backend choice in the [core design](design-typescript-core.md) §6
("Standalone Pi SDK session implementation") and in the
[Pi supervisor design](design-pi-supervisor.md). Pi stays a supported harness,
and that document still governs the Pi harness's details. Recovery authority,
admission, the case file, the remedy table, and episode records stay as the
[supervisor robustness design](design-supervisor-robustness.md) specifies them.

## 1. Decision

The supervisor becomes a **harness-neutral supervisor host** with three
interchangeable agent backends (**supervisor harnesses**):

- Pi, in-process, as today;
- Claude Code, the user's own `claude` CLI and login;
- Codex, the user's own `codex` CLI and login.

The two CLI harnesses talk to the supervisor through **the same streaming JSON
protocol the coding-agent executor already uses**. For Claude Code that is
`-p --output-format stream-json --input-format stream-json` with
`--session-id`/`--resume`. For Codex it is `codex exec --json` events with
`exec resume`. There is no MCP bridge and there are no hooks. The CLI harnesses
keep their native tools for investigation, and bwrap confines what they can
write. They return each decision as JSON in their final message.

The process code for driving all three agents moves into one shared library,
`@graphloom/agent-harness`. The coding-agent executor and the supervisor both
use it.

The plugin states which harness it prefers, as data. The operator's
configuration says which harnesses are enabled and holds their logins and
models. The controller pins one harness when the run starts, and only
`resume --supervisor <harness>` changes it. The default order is `pi`,
`claude-code`, `codex`.

Why: a user who has only a Claude Code subscription or only a Codex login
cannot get automatic recovery today. `graphloom run` composes a Pi supervisor
only from `supervisor.json` (`apps/graphloom/src/supervisor-config.ts:159`),
and Pi needs a model API credential. The executor already runs both CLIs
headless with their own logins (`executors/coding-agent/src/claude-harness.ts`,
`codex-harness.ts`). Copying subscription credentials into Pi is ruled out by
the [authentication findings](design-pi-supervisor.md#authentication-and-claude-code-plan-gap).

What does not change:

- one logical supervisor per run, with a fresh model session per recovery
  episode;
- the controller admits the supervisor's decisions without veto, while
  admission checks still validate their shape;
- the step set is fixed;
- only the controller issues receipts;
- budgets stay finite;
- qualified repair keeps its procedure: forked candidate trees, preflight, an
  independent reviewer, and activation under the run lock.

Non-goals: [agent-host mode](design-agent-host.md), mixing harnesses within one
supervisor session, and remote harnesses.

## 2. Today's seams

| Seam | Where | Harness-specific? |
|---|---|---|
| Controller port `Supervisor` (`decide`, `patchCandidate`, grants, `drainProviderCalls`, `drainRemedies`, `switchModel`, `requiresCitedEvidence`) | `packages/supervisor/src/types.ts:248` | No |
| `SupervisorInput` (trigger, `RunView` with `escalation`, `lastSettlement`, `caseFile`, `inspect`, `admission`, `rejection`, `maxProviderCalls`, `maxWaitMs`, `signal`) | `types.ts:37` | No |
| Decision loop: episode sessions, tool turn, JSON fallback, slip/timeout/quota/transient/overflow remedies, per-turn allowance | `createPiSupervisor` (`pi-supervisor.ts:149`), `decideTurn` (`:261`) | Only through the session type it drives |
| Session port | `PiSupervisorSession` (`pi-session.ts:136`) | Its name and its Pi `ToolDefinition` |
| JSON fallback and normalization | `parseSupervisorDecision` (`decision.ts:18`), `normalizeProposalInput` (`item-arrays.ts:87`), `localRefusal` and `admission.check` (`pi-supervisor.ts:600-635`), the repeated-proposal check (`:640`) | No |
| Episode records, replay | The controller wraps `inspect` and `recordFinding` (`episode.ts`); `replayEpisodes` drives any `Supervisor` | No |
| Restore | `restorePiSupervisorFromBinding` (`restore.ts:52`), used as the controller's default (`packages/controller/src/controller.ts:1039`) | Yes; the controller default is a layering leak |
| Repair reviewer | `piRepairDeps` (`apps/graphloom/src/repair-config.ts:59`) | Yes, Pi only |
| CLI and Pi process mechanics | `executors/coding-agent/src/{claude,codex,pi}-harness.ts`, `child-env`, `process-group`, `harness.ts` (`sessionSaver`, `completeJsonl`), `session-files`, `quota`, `transient` | Executor-only today |

The controller's port is already neutral. The remaining work is in three
parts:

1. Move the agent-driving code into a shared library.
2. Rename the Pi session port into a harness port.
3. Add a JSON-reply decision protocol for the two CLI harnesses.

## 3. Shared harness library

### 3.1 `@graphloom/agent-harness`

A new workspace package, `packages/agent-harness`, owns everything about
**running an agent session**. It knows nothing about jobs, graphs, or recovery.

| Module | Moved from | Responsibility |
|---|---|---|
| `claude/` | `claude-harness.ts` | Spawn; stream-json in and out, including the `initialize` handshake, user messages, the `interrupt` control request, `can_use_tool` control requests answered by a caller-supplied policy, and `result`; session id and `--resume`; transcript and side-dir capture and write-back; usage totals with the `cost-state` baseline; startup and response watchdogs |
| `codex/` | `codex-harness.ts` | Spawn `exec --json`; event parsing (`thread.started`, `item.*`, `turn.completed`, errors); `exec resume`; rollout capture and write-back; usage |
| `pi/` | `pi-harness.ts`, `pi-session.ts` | Pi `AgentSession` creation with an isolated resource loader, credentials, the model and `thinkingLevel`, the turn hook, and session-file capture |
| `session/` | `harness.ts`, `session-files.ts` | `sessionSaver` (early capture, #204), `completeJsonl`, safe file scans and copies |
| `process/` | `process-group.ts`, `child-env.ts` | Process groups, `drainOnExit`, `minimalEnv`, `passEnv` |
| `classify/` | `quota.ts`, `transient.ts` | `classifyQuota` (`resetAt`), `classifyTransient`, `retryAfterMs` |
| `launch` | — | A `launch(command, args, env, cwd, { writable, trustedWritable, readPaths })` function returning the `{ command, args, env }` to spawn. Callers inject the runner's `confineWorker` (`packages/runner/src/confine.ts`); the library does not depend on the runner. The default, `directLaunch`, spawns the command as given |

As built in S1, each driver exposes the turn-level functions the executor
already had, with the executor-specific parts passed in:

- **Claude Code:** `runClaudeProcess` runs one stream-json turn. The caller
  passes its own flags (`--settings`, `--tools`, `--append-system-prompt`,
  `--mcp-config`, `--model`, `--json-schema`), the prompt, a `toolPolicy` for
  `can_use_tool`, `reserveModelCall` for each later provider request, and an
  optional MCP server that must connect. The function returns a failure
  summary or the successful `result` event, plus native tools and usage.
  `openClaudeSession` and `captureClaudeTurn` restore, capture early, and
  save the session.
- **Codex:** `runCodexProcess` (with `sandbox` and `ephemeral` as options and
  the caller's `--output-schema` as extra flags) returns a failure summary or
  the final message. `openCodexThread` and `captureCodexTurn` handle the
  rollout.
- **Pi:** `createPiAgent` (the isolated loader, the tool activation, and the
  reservation hook on `streamFunction`), `promptPiAgent`,
  `openPiSessionManager`, `piSessionReporter`, `piBashTool`, `piNativeTools`,
  and the session settings record. `packages/supervisor/src/pi-session.ts`
  stays in the supervisor until S2 builds the host on the library.
- **`classify/`, `session/`, `process/`:** moved unchanged. The executor's
  `transient.ts` keeps only its retry loop (policy, backoff, worktree
  fingerprint) and re-exports the classifiers.

The neutral API below is the target for S3. It is built on those functions
when its first consumer, the Claude Code supervisor harness, needs a live
event stream. S1 does not add it: nothing would use or test it yet.

```ts
interface AgentRun {
  send(text: string): void;               // Claude: next stream-json user message; Codex/Pi: next prompt
  events: AsyncIterable<AgentEvent>;      // text, thinking (filtered by callers), tool_call, tool_result,
                                          // command, file_read, usage, error, result
  interrupt(): Promise<void>;
  done: Promise<AgentRunResult>;          // final message text, usage, sessionRef, failure text
}
interface AgentDriver {
  start(opts: {
    cwd: string; model?: string; systemPrompt: string;
    sessionDir: string; resume?: string;
    toolPolicy?: ToolPolicy; launch: Launch; env: NodeJS.ProcessEnv;
    signal?: AbortSignal; onSessionSaved?(ref: string): void;
  }): Promise<AgentRun>;
}
```

These stay in `executors/coding-agent`, because they are executor concepts:

- the `CodingHarness` and `CodingSessionOptions` adaptation;
- job graph tools and their MCP bridge (`mcp-bridge.ts`);
- result contracts (`--json-schema` / `StructuredOutput`, Codex
  `--output-schema`, Pi `submit_result`) and in-turn contract correction;
- the write-scope permission policy (`claude-permissions.ts`), passed as a
  `ToolPolicy`;
- the `reserveModelCall` wiring;
- `failureKind`, `effects`, `retryLimit`, and the executor's own transient
  retry loop;
- the package descriptor;
- the rehearsal stand-ins.

### 3.2 Digests and pins

A run pins each executor by `digestExecutorSource` over its source root, and
that digest **skips `node_modules`** (`packages/runner/src/digest.ts:33`). A
separately installed shared package would therefore change executor behavior
without a pin mismatch.

Decision: **the executor vendors the library.**
`executors/coding-agent`'s build copies `@graphloom/agent-harness`'s `dist`
into `dist/vendor/agent-harness/` and imports it from there. The executor's
digest covers the harness code. Run-local executor repair (`executorRepair`)
can then patch a harness defect too, in the run's copy.

Mechanism (S1):

- The executor imports `#agent-harness/<module>`, a Node subpath import that
  its `package.json` maps to `./dist/vendor/agent-harness/*/index.js`.
  TypeScript resolves the vendored `.d.ts` files the same way.
- `executors/coding-agent/scripts/vendor-agent-harness.mjs` runs before
  `tsc` in `build` and `test`. It copies the library's built `.js` and
  `.d.ts` files, with their source-map comments removed, from
  `../../packages/agent-harness/dist`.
- A copy of the package that stands alone has no library beside it. That
  covers a repair candidate under `<stateDir>/repairs/` and an installed
  release. There the script keeps the vendored copy as it is, so a
  candidate's build never overwrites the harness code under review.
- The library is only a `devDependency` of the executor, so repair does not
  link it into a candidate. In S1 nothing loads it at run time except through
  the vendored copy, so the release does not ship `packages/agent-harness`.
  S2 adds it to the release's core packages when the supervisor imports it.
- `apps/graphloom/test/agent-harness-vendor.test.ts` checks four things:
  - the vendored files match the built library;
  - the executor resolves the harness only from `dist/vendor`;
  - changing one vendored byte changes `digestExecutorSource`;
  - rebuilding from a changed library changes it too, while a standalone
    copy keeps its own patched vendored code.

What a harness fix means:

- **For executors:** new executor bytes. An existing run's `resume` stops
  with `executor pin mismatch`, and the operator moves it with
  `--update-executors`, as for any executor change. New runs pin the new
  digest.
- **For the supervisor:** the supervisor imports the library as a normal
  dependency of the GraphLoom install. It is versioned with the product, like
  the controller, and it is not pinned per run. A run pins the harness *name*
  and model (§7.4), not its bytes. A fix takes effect at the next process
  start or resume. Episode records carry the product version, so a behavior
  change is attributable.

S1 must leave every executor's behavior unchanged. The digest of
`executors/coding-agent` changes once in S1, through the move itself. S1
release notes call out the need for `--update-executors` on runs started
before it.

## 4. Supervisor harness contract

### 4.1 Layers

```text
controller ── Supervisor (unchanged port) ──► SupervisorHost   (packages/supervisor)
                                                │ episode sessions, remedies, prompts,
                                                │ reply protocol, admission, binding
                                                ▼
                                      SupervisorHarness ── opens ──► HarnessSession
                                        pi | claude-code | codex      (on @graphloom/agent-harness)
```

- **`SupervisorHost`** is today's `createPiSupervisor`, renamed
  `createSupervisorHost`, with a harness in place of a Pi session opener. It
  implements `Supervisor`. Everything in the robustness design lives here
  once:
  - the in-turn rejection loop and the three-rejection safe default;
  - the grounding rule;
  - the slip ladder;
  - timeouts, quota and transient waits;
  - the per-turn provider allowance.
- **`HarnessSession`** is today's `PiSupervisorSession` port under a neutral
  name. `prompt(text, { tools?, done?, signal, timeoutMs, maxTurns, reservedTurns })`
  returns the final message text. It keeps `drainTurnCount`,
  `peekTurnCount`, `lastReplyFailure`, the optional `omitLastExchange`,
  `compact`, and `setModel`, the candidate grants, and `close`. It adds:
  - `investigation(): InvestigationStep[]` (§5.2);
  - `lastUsage()`.
  `tools` is used only by the Pi harness.
- **`SupervisorHarness`**: `name`, `capabilities`
  (`toolCalling`, `inSessionModelSwitch`, `compaction`, `exactResend`,
  `exactProviderCalls`, `rawStreamCapture`), `probe()` (no provider call),
  `openSession({ model, role: "decide" | "review" })`, and `restore(binding)`.

`SupervisorModelRef` stays `{ provider, modelId, thinkingLevel? }`. For a CLI
harness, `provider` is the harness name: `claude-code/opus`,
`codex/gpt-5-codex`.

### 4.2 Decision protocol per harness

- **Pi (unchanged):** in-process admission, inspection, and `record_finding`
  tools (`tools.ts`), with the JSON reply as fallback.
- **Claude Code and Codex: a JSON reply is the primary path.** The decision
  comes back as one JSON object in the agent's final message. The agent's
  native tools are for investigation only. GraphLoom gives them no tools.

The reply is one JSON object, in a `json` code fence or bare, in one of
these forms:

```jsonc
// 1. A decision: today's GraphDecision, parsed by parseSupervisorDecision.
{ "action": { "type": "reenter", "reenter": { "stageId": "fix", "reason": "…" } },
  "reason": "…", "evidence": ["ev-…", "inv-3"],
  "findings": [ { "kind": "fact", "text": "…", "evidence": ["inv-3"] } ] }
// 2. A request for GraphLoom's own inspection or probes (§5.3).
{ "inspect": [ { "tool": "check_validate", "args": { "stageId": "fix" } },
               { "tool": "get_evidence", "args": { "ref": "ev-…" } } ] }
// 3. A model switch.
{ "switch_model": { "provider": "claude-code", "modelId": "opus", "reason": "…" } }
```

A new `parseSupervisorReply` recognizes `inspect` and `switch_model` and
passes anything else to `parseSupervisorDecision`. That function already
nests flattened action fields and rejects `accept`. A decision then takes the
existing JSON-fallback path, unchanged:

1. `normalizeProposalInput` (the `{"item": …}` array encoding, guided by each
   executor's declared input schema).
2. `localRefusal`: write scope, continuation, escaping observe paths.
3. `admission.check`: the controller's preconditions, the grounding rule, and
   repeated no-progress proposals
   ([run convergence](design-run-convergence.md) §4.3).

Each `findings[]` entry goes to `recordFinding` before the decision is
checked. The outcome of each finding is reported on the next prompt.

Feedback goes back into **the same session as the next user turn**. For
Claude Code that is the next stream-json user message on the live process, or
`--resume <uuid>` after the process has exited. For Codex it is
`codex exec … resume <thread> -`. The feedback can be:

- an admission rejection (`buildRejectionPrompt`, with three per turn and then
  the trigger's safe default, as today);
- a malformed or empty reply (`buildReaskPrompt`, then the slip ladder §6);
- the answer to an `inspect` request.

Each follow-up is a provider call charged to the turn's allowance. `inspect`
rounds are bounded at `MAX_INSPECT_ROUNDS` (4) per turn. Past that, the host
asks for a decision.

**`--output-schema` (Codex) and `--json-schema` (Claude Code) are not used
for supervisor turns.** A strict schema must have every property required and
no extras (`docs/design-executors.md`, Codex). The reply is a union of eight
action shapes plus `inspect` and `switch_model`, so it does not fit. A schema
would also force a final answer when the agent should ask to inspect. Parsing
plus normalization is the tested path, built from real model slips. A bad
reply stays a classified `malformed` slip with bounded remedies, rather than a
CLI-level failure.

### 4.3 One logical session across episodes

Identity, budgets, and the switch journal are run-wide
(`supervisorBinding.sessionId`). Chat is per episode, and the case file is the
only memory across episodes (robustness §4.4). So continuity is needed only
*within* an episode: between follow-ups, from one turn to the next after
settlement, and from the decision to `patchCandidate`.

| | Pi | Claude Code | Codex |
|---|---|---|---|
| New episode | `createAgentSession` | New UUID, `--session-id` | `codex exec`; the id comes from `thread.started` |
| Follow-up within a turn | Same prompt loop | Next stream-json user message; `--resume` once the process has exited | `exec resume <thread>` |
| Next turn, same episode | Same session | `--resume <uuid>` | `exec resume <thread>` |
| Fresh-session remedy | `openSession` | New UUID with the full opening prompt and any pending rejection | New thread, same prompt |
| Transcript evidence | Pi session file under `<stateDir>/supervisor/` | `<stateDir>/supervisor/claude-code/<ref>.jsonl` and `<ref>.json` (model, system prompt digest), saved early by the shared `sessionSaver` | `<stateDir>/supervisor/codex/codex-<thread>.jsonl` and `.json` |
| Controller restart | Fresh session, transcripts never reopened (`restore.ts`) | Same | Same |
| Session lost mid-episode | n/a | Write GraphLoom's copy back (the shared write-back), otherwise `fresh_session_retry`. Not fatal | Same, with the rollout |

`supervisorBinding` gains `harness`. A binding without it reads as `pi`.
`sessionFile` names GraphLoom's copy of the latest episode transcript and is
never reopened. The controller drops its Pi restore default
(`controller.ts:1039`). The CLI composition root passes `restoreSupervisor`
for the bound harness.

### 4.4 Model switching

Models are configured per harness. `switch_model` and `graphloom switch-model`
accept only models of the pinned harness. A model on another harness is
refused, and the refusal points to `resume --supervisor`.

- **Pi:** unchanged. `setModel` keeps the chat, and a crash is reconciled
  from the session file.
- **Claude Code / Codex:** a committed switch opens a fresh episode session on
  the new model and resends the turn's opening prompt. The old transcript is
  not resumed under another model; the executors refuse that for the same
  reason (`docs/design-executors.md`). The case file carries the memory. On a
  crash, an `intent` is committed when the newest session copy's `.json`
  record names the target model, and failed otherwise.
- `model_retry` uses the next model of the pinned harness.
- `thinkingLevel` maps to Codex `model_reasoning_effort` (`--config`). Claude
  Code has no equivalent, so it is ignored there, with a `check` warning.

## 5. Investigation, grounding, and evidence

### 5.1 Native tools, confined

Claude Code and Codex keep their native tools while supervising: read, grep,
glob, bash, and the rest. They can read the run worktree, the plugin source,
logs, and the transcripts of earlier jobs. Confinement, not tool restriction,
bounds what they can change (§6.1).

- **Claude Code** runs with `--tools default` and
  `--permission-prompt-tool stdio`. That is the executor's control protocol
  over the same stream, not a hook. The supervisor's `ToolPolicy` allows
  every request, records it, and denies only `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
  outside a granted candidate root. The OS would refuse those writes anyway;
  the policy gives a clear message instead of `EROFS`.
- **Codex** runs with `--sandbox danger-full-access` inside GraphLoom's bwrap,
  which is the authority (§6.1). This avoids depending on whether Codex's own
  sandbox can nest inside bwrap.

A command that needs to write outside the writable set, such as running the
worktree's tests, fails. The agent is told, in its system prompt and by the
failure itself, that it changes the run only by deciding: `dispatch`,
`validate`, `observe`, and so on.

### 5.2 Investigation as evidence

The harness turns the agent's event stream into **investigation steps**.
GraphLoom observes these steps from the CLI's own output; they are not the
model's claims.

| Source | Step kinds |
|---|---|
| Claude Code stream-json | `tool_use` and its `tool_result` (Read, Grep, Glob, Bash, Agent/subagent calls with their forwarded events) |
| Codex `--json` | `item.completed` for `command_execution` (command, exit code, output) and file reads and changes it reports |
| Pi | GraphLoom inspection tool calls (today's `EpisodeToolCall`) |

Each step gets an id `inv-<n>` that is unique within the episode. It records
`{ id, harness, kind, tool, input, output (bounded), exitCode?, at }`. Steps
are stored in the episode record (`supervisorEpisodes`) next to today's tool
calls, under the same bounds (`MAX_EPISODE_TOOL_CALLS`,
`MAX_EPISODE_TOOL_RESULT_CHARS`, and the 64 KB record with field-wise
shrinking).

The host lists the steps it has seen at the top of every follow-up prompt
(`inv-3: Bash "go test ./pkg/x" exit 1`), so the agent can cite them. Thinking
blocks are never recorded or shown.

### 5.3 Grounding

The rule from robustness §4.2 stays: a `stop`, a `reenter`, or a
validator/executor-blaming `qualify_repair` must cite evidence. The citable
ids widen:

- **Recorded run evidence refs**, as today.
- **Probe ids** from GraphLoom's probes. For CLI harnesses, the agent asks for
  probes with an `inspect` reply. There is no MCP, and no GraphLoom CLI
  running inside the sandbox against a copy of run state. The host runs
  `input.inspect.checkValidate` and the other probes in the controller
  process, on the real state copy, and returns the results as the next user
  turn. This keeps one implementation of the probes and gives the sandbox no
  path to the state directory.
- **Investigation step ids** (`inv-<n>`) from this episode.

The controller treats the three kinds differently according to what they can
show. A step id is valid only when the episode record holds it. A claim about
the **controller's or a validator's behavior** must cite a GraphLoom probe or
recorded evidence. This applies to a `stop` that says a stage cannot pass, and
to a `qualify_repair` that targets a validator or executor. An `inv-` step
alone is refused as inadmissible ("cite check_validate for a claim about
validation"). The reason is that only the probe runs the real admission code.
Claims about code or the environment may rest on `inv-` steps: "the patch
fails to build", "file X lacks Y".

The proposal reviewer and repair reviewer receive the cited steps with the
evidence. `requiresCitedEvidence` stays true for every harness.

## 6. Confinement, credentials, budgets

### 6.1 Confinement

Every Claude Code or Codex supervisor or reviewer process runs under bwrap
through the injected `launch`, which is the runner's `confineWorker`:

| Process | Read | Write (bwrap binds) |
|---|---|---|
| Decide turn | Whole filesystem read-only (`--ro-bind / /`) | `<stateDir>/supervisor/<harness>/scratch`, and the CLI's own login/state dir (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`) as `trustedWritable`, like the executor's `ownState` (`executors/coding-agent/src/package.ts:59`, `packages/runner/src/registry.ts:601`) |
| Patch turn | Same | The above plus the controller-issued candidate root (`<stateDir>/repairs/<artifactId>/candidate`), only while the grant is active |
| Repair reviewer | Same | Scratch and own state dir only |

Never writable: the run worktree, the source checkout, the live plugin and
executor installs, `<stateDir>` outside the supervisor scratch, and the
operator's other configuration. All changes to the run go through admission.

The candidate patch keeps today's procedure (core §7): grant and revoke, and
the post-patch digest checks of the live install, the worktree, and the
state. Claude Code patches in the episode's session with `cwd` set to the
candidate root. Claude Code keys sessions by project directory, so the shared
write-back moves the transcript there first. If that fails, the patch runs in
a fresh session, since `buildRepairPrompt` is self-contained. Codex patches
with `exec resume --cd <candidate root>`.

A host without working bwrap fails `probe()` for both CLI harnesses, and they
cannot be selected. Pi runs in-process and keeps its detection-based patch
guard.

### 6.2 Credentials

- **Claude Code:** the user's own login in its config dir, used by genuine,
  unmodified Claude Code that the user authenticated. GraphLoom never reads,
  copies, or proxies it. The process gets `minimalEnv` plus `passEnv`.
  `ANTHROPIC_API_KEY` is not passed unless the operator binds one explicitly.
- **Codex:** its own login in `CODEX_HOME`, with the same environment rules.
- **Pi:** unchanged. An operator credential reference; `apiKey` is refused in
  `supervisor.json` (`supervisor-config.ts:79`).

No CLI harness needs an API key. `supervisor.json` refuses secrets for every
harness.

### 6.3 Budgets

| Budget | Pi | Claude Code / Codex |
|---|---|---|
| `agentInvocations` | Counted at each turn start | Reserved as in the executors: one before each prompt or follow-up, and one more each time the stream shows a tool result going back to the model (`claude-harness.ts:418`, `:543`; `codex-harness.ts:331`, `:400`). A refused reservation interrupts the process |
| `decisions` | Charged by admission | Same |
| `probes` | Inspection probes | `inspect` requests, same budget |
| `waitMs` | Quota and transient waits | Same (§6.4) |

`outstandingProviderCalls` reports the open reservations. Token usage
(Claude Code's `result.modelUsage` minus the resumed `cost-state` baseline;
Codex's `turn.completed`) goes to `lastUsage` for episode records and replay
scoring. It is not charged to any budget.

### 6.4 Quota, timeouts, and transient errors

The host's remedy code is unchanged. Each harness maps its failure text into a
`ProviderFailure` with the shared classifiers:

- **Quota / usage limit:** `classifyQuota(harness, text)` (Claude Code's
  "You've hit your session limit · resets …", Codex's usage-limit message)
  yields `quota` with `retryAt = resetAt`. The host waits until `retryAt`
  plus 30 s when that fits `maxWaitMs`, with at most three waits a turn.
  Otherwise the run stops, retryable:
  `supervisor provider quota: … (not remedied: …)`. `resume` after the reset
  continues the run.
- **Timeouts:** `promptTimeoutMs` (no stream event; a running native tool
  counts as activity, as in the executors' response watchdog) and
  `promptTotalTimeoutMs` keep their meaning. A timeout kills the process
  group, applies `fresh_session_retry` once, then stops by name. Claude
  Code's startup watchdog also applies.
- **Transient:** `classifyTransient(harness, text)` yields `transient`. The
  host applies `backoff_and_retry` (2 s, 4 s, 8 s, charged to `waitMs`), then
  resumes the session and resends the prompt. The executor's own retry loop
  does not apply to supervisor turns.
- **Auth:** "not logged in" yields `auth`. The run stops, naming
  `claude /login` or `codex login`. There is no fallback to another harness
  mid-run.

## 7. Selection and pinning

### 7.1 Plugin declaration (data)

`GraphDefinition` (`packages/sdk/src/types.ts:53`) gains an optional field.
The plugin returns it from code, like `defaultBudgets`, so a profile can vary
it:

```ts
interface SupervisorPreference {
  harnesses: Array<"pi" | "claude-code" | "codex">;              // plugin's order
  models?: Partial<Record<"pi" | "claude-code" | "codex", string[]>>; // hints; honored only if operator-configured
  required?: boolean;                                            // refuse instead of falling back; default false
}
```

The SDK validates the shape only. The controller stores the preference and
the resolved selection as opaque data. The CLI composition root does the
selection, so the controller learns no plugin notion. The preference is read
at intake and not compared again on resume or repair.

### 7.2 Operator configuration

`supervisor.json` gets a per-harness form. Today's flat Pi form still parses
as `{ harnesses: ["pi"], pi: { … } }`.

```json
{
  "harnesses": ["pi", "claude-code", "codex"],
  "select": "claude-code",
  "pi": { "provider": "minimax-cn", "modelId": "MiniMax-M3", "models": ["deepseek/deepseek-chat"] },
  "claude": { "command": "claude", "configDir": "~/.claude", "models": ["opus", "sonnet"] },
  "codex": { "command": "codex", "codexHome": "~/.codex",
             "models": [{ "modelId": "gpt-5-codex", "thinkingLevel": "high" }] },
  "promptTimeoutMs": 120000, "promptTotalTimeoutMs": 900000, "quotaRetryMs": 300000
}
```

- `harnesses` is the allowlist and the operator's fallback order. An unlisted
  harness is **forbidden**.
- When `harnesses` is omitted and more than the flat Pi form is configured,
  the built-in order applies: `pi`, `claude-code`, `codex`.
- `select` **overrides** the plugin for every run.
- The first listed model is the initial one, and the rest are switch targets.
  A plugin hint reorders the configured models. An unconfigured hint is
  ignored, with a `check` warning; there is no silent substitution.

`graphloom setup` writes this file from what `graphloom doctor` discovers, in
the built-in order and without `select`
([release §4.4–§4.5](design-release.md#44-graphloom-doctor)).

### 7.3 Precedence and fallback

The selection is resolved once at `run` and reported by `check`. The first
rule that applies wins:

1. `graphloom run --supervisor <harness>`. It must be enabled and pass
   `probe()`, or `run` refuses.
2. `supervisor.json` `select`, under the same conditions.
3. The plugin's `supervisor.harnesses`, in plugin order: the first that is
   enabled and available.
4. If none matches:
   - with `required: true`, `check` fails and `run` refuses
     (`supervisor: plugin requires one of …; enabled and available: …`);
   - otherwise, the first enabled and available harness in the operator's
     order, with the reason printed and recorded.
5. If no harness is available, there is no supervisor, as today without a
   config, and `check` warns.

"Available" means `probe()` passed. The probe checks:

- for the CLIs, the binary plus the flags the adapter uses (the capability
  probe, `apps/graphloom/src/capability-probe.ts`), login presence where it
  can be read without a call, and bwrap;
- for Pi, a credential reference.

### 7.4 Pinning

Intake records `state.supervisorSelection = { harness, source:
"flag" | "operator" | "plugin" | "fallback", reason, preference }`. The
binding's `harness` must match it.

- `resume` checks the pin. A pinned harness that is no longer enabled or
  available stops the run with `supervisor harness pin mismatch: … ; resume
  with --supervisor <harness>`. Nothing falls back silently.
- `graphloom resume <run> --supervisor <harness>` is the explicit transition,
  the counterpart of `--update-executors`. It keeps the logical session id,
  budgets, case file, and episode records. It records
  `supervisorTransitions` (from, to, reason, generation), a
  `supervisorUpdate` evidence record, and an `inspect` line. This is the
  "explicit host rebind" that core §6 allows.

### 7.5 Repair reviewer rule

**The supervisor and the repair reviewer always use the same agent: the
run's pinned supervisor harness.** The reviewer is independent by session,
not by agent. It runs as a separate read-only session with no shared chat and
a different session id, as core §7 requires. Operators cannot set a
different harness for it. A `resume --supervisor` transition moves both. The
proposal reviewer (robustness §4.5) follows the same rule. `piRepairDeps`
becomes `harnessRepairDeps(harness, config)`.

### 7.6 issue-fix

issue-fix profiles declare
`"supervisor": { "harnesses": ["pi", "claude-code", "codex"] }`, and
`profile.ts` returns it in `GraphDefinition.supervisor`. Executor `harnesses`
(implementer, reviewer, verifier) are independent of it.

## 8. Failure modes and parity

| Failure | Pi (today) | Claude Code / Codex |
|---|---|---|
| Quota (reset stated / not stated) | wait_and_retry / `quotaRetryMs` or stop | Same, via `classifyQuota` |
| Transient 5xx / overloaded | backoff_and_retry ×3 | Same, via `classifyTransient`; resume the session |
| Context overflow | compact_and_retry once | fresh_session_retry. The CLI's own auto-compaction stays on, and the case file is the memory |
| Timeout | fresh_session_retry once, then stop | Same: kill the group, then a new session |
| Empty / thinking-only reply | reask, fresh session, model_retry | Same ladder. Empty final message (`result` text, Codex last message) |
| Interrupted (billed, undelivered) | resend_interrupted ×2 | Not detectable from CLI output; treated as `empty` |
| Malformed JSON reply | Slip ladder | Same parser and ladder; this is the primary path here |
| Inadmissible proposal | Tool error in-turn; three, then safe default | Rejection as the next user turn; three, then safe default |
| Repeated no-progress proposal | Admission tools and the JSON-path check | `admission.check` and the JSON-path check, same code |
| Ungrounded claim about controller behavior | Refused unless it cites a probe or evidence | Same; an `inv-` step alone is refused for these claims (§5.3) |
| Too many `inspect` rounds | n/a | After four, the host asks for a decision |
| Crash or exit with no result | n/a | `unknown` with the stderr tail; fresh_session_retry once (counted as the timeout retry), then stop |
| Session lost | Never reopened | Write the copy back, otherwise a fresh session |
| Operator Stop | Abort, then idle | Claude: interrupt, then SIGTERM, then SIGKILL. Codex: SIGINT, then the same. Settles once the group is gone |

Pi-only features, and why:

- `compact_and_retry`: the CLIs compact internally, so a fresh session is the
  equivalent.
- `resend_interrupted`: needs Pi's context-edit omission.
- In-session model switch: the CLIs open a fresh session instead (§4.4).
- `rawStreamCapture`: needs Pi's `fetch` hook. The CLIs record their event
  stream and transcript instead.
- Exact provider-call counting: the CLIs reserve from the stream.
- MiniMax `allowEmptySignature`.

Each of these falls back to a remedy that already exists.

## 9. Testing

All of this runs in CI with no provider calls unless marked live.

- **S1 extraction:** all executor suites (`claude-harness`, `codex-harness`,
  `pi-harness`, `quota`, `transient-retry`, `session-files`, rehearsal
  stand-ins) pass unchanged against the vendored library. A test asserts
  that the executor digest covers `dist/vendor/agent-harness`: changing one
  vendored byte changes the digest. Unit tests of moved code move with it.
  That covers `session-files`, `completeJsonl`, and the pure
  `parseResetAt`/`classifyQuota`/`classifyTransient`/`retryAfterMs` cases.
  The library adds `sessionSaver` tests and driver tests through an injected
  `launch`.
- **S2 host contract:** the Pi supervisor suites (`pi-supervisor*`,
  `pi-session*`, `episode-replay*`, `restore`) pass unchanged against
  `createSupervisorHost`. A shared `harnessConformance(harness)` suite drives
  every remedy, the rejection loop, `inspect` rounds, findings, switching,
  and grants through a scripted `HarnessSession`.
- **Fake CLIs:** `executors/coding-agent/test/fake-claude.mjs` and
  `fake-codex.mjs` move to `packages/testkit`. They already script text,
  Bash, subagents, `{ limit }`, `{ error }`, `{ hang }`, `{ crash }`, resume,
  and the interrupt and permission protocol. They gain scripted JSON replies,
  multi-message stream-json input, and Codex `command_execution` items.
- **Investigation evidence:** stream events become `inv-` steps with bounded
  output; cited steps validate; an `inv-`-only claim about validation is
  refused; findings citing `inv-` steps are kept.
- **Confinement:** on CI hosts with bwrap (#170 installs it), a fake CLI's
  Bash tries to write the worktree, the live install, and the state dir in
  decide, patch, and review turns. Every attempt fails. The candidate root is
  writable only in a granted patch turn.
- **Selection:** precedence in §7.3, the `required` refusal, the allowlist,
  the pi-first built-in order, pin mismatch, and the `--supervisor`
  transition (identity, budgets, and case file kept; evidence written); the
  reviewer follows the harness.
- **Replay fidelity:** the `9bfa446d-4ea` set scores the same with a scripted
  session behind each harness. The live scorer gains `--harness`.
- **Live (opt-in):** `GRAPHLOOM_SUPERVISOR_LIVE=claude-code|codex`, with the
  user's login and no API key in the environment. One recovery episode (an
  `executor_failed` resolved by `reenter`), one qualified repair with review,
  and one resume across a restart.

## 10. Phases

| Phase | Scope | Verification |
|---|---|---|
| **S1. Shared harness library** | Create `@graphloom/agent-harness` (§3.1); the executor vendors it (§3.2); no behavior change | Executor suites and rehearsals unchanged; digest-coverage test; `npm test`, typecheck, build |
| **S2. Supervisor host contract** | `HarnessSession`, `SupervisorHarness`, `createSupervisorHost` with Pi behind it; `binding.harness`; controller drops its Pi restore default; `parseSupervisorReply` and the investigation-step record (unused by Pi) | Pi supervisor suites and replay scores unchanged; a recorded run without `harness` resumes; conformance suite |
| **S3. Claude Code harness** | Decide, patch, and review sessions on the shared Claude driver; JSON-reply protocol; `ToolPolicy`; bwrap launch; `inv-` steps; quota and transient mapping; `harnessRepairDeps` | Conformance; fake-claude protocol, evidence, and confinement tests; opt-in live episode on a subscription |
| **S4. Codex harness** | The same on the shared Codex driver (`exec --json`, `exec resume`, `danger-full-access` inside bwrap) | Conformance; fake-codex tests; opt-in live episode with a Codex login only |
| **S5. Plugin selection** | `GraphDefinition.supervisor`; per-harness `supervisor.json`; `run`/`resume --supervisor`; `supervisorSelection` and transitions; `check`; issue-fix declares `pi`, `claude-code`, `codex` | Selection table tests; `check` output per branch; issue-fix rehearsal shows the resolved harness; `inspect` shows the selection and transitions |
| **S6. Docs and doctor** | README, examples guide, cross-links; the doctor's supervisor check runs each enabled harness's `probe()`; `stats` shows per-harness supervisor usage | Link, format, and consistency checks; doctor on hosts with Pi only, Claude Code only, and Codex only |

## 11. Unverified CLI assumptions

Each is checked in its phase. A failure changes only the named fallback.

1. **Claude Code permission prompts.** `--permission-prompt-tool stdio`
   prompts also for read-only native tools in `-p` mode with
   `--permission-mode default`. This matters only for recording, since the
   stream's `tool_use` events record the calls anyway. (S3)
2. **Codex event items.** Codex `--json` reports `command_execution` items
   with command, exit code, and output, as the executor already parses. It
   does not report file reads done other than through commands. If file reads
   are invisible, Codex's investigation evidence is its commands only. (S4)
3. **Codex inside bwrap.** `--sandbox danger-full-access` runs inside bwrap
   without Codex's own sandbox attempting a namespace of its own. (S4)
4. **Codex resume with a new cwd.** `exec resume` honors a changed `--cd` for
   the patch turn, as the executor relies on for the same cwd. If it does
   not, the patch runs in a fresh session. (S4)
