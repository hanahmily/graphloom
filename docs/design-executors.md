# Built-in and plugin-owned executors

Status: accepted design, 2026-09-24; implemented: the executor contract, the
packaged GitHub executor, the coding-agent harness with its child-operation
protocol, and supervisor recovery through executors. Pins currently cover executor
identity and code digest; schemas, runtime, and grants are not yet part of the pin.
This specializes the [TypeScript core design](design-typescript-core.md).

## Driver scope

The coding-agent harness described here launches worker sessions under standalone
controller ownership. Proposed [agent-host mode](design-agent-host.md) instead
binds compatible implementation jobs to an existing session using durable work
offers and claims. Built-in/custom executors, child-operation evidence, validation,
and independent reviewers still use this design's lifecycle. Its host-facing MCP
service is separate from the existing MCP bridge serving tools to a launched job.
Native host actions have only the enforcement and accounting coverage explicitly
negotiated at attachment; they do not inherit isolation from this job protocol.

## Ownership

Plugins own domain execution logic. The controller owns admission, durable
lifecycle, budgets, cancellation, and acceptance. GraphLoom supplies built-in
executors for common needs, including GitHub. Plugins may reuse them, compose
their results, or supply their own implementations through the same interface.
The controller does not implement GitHub queries or label classification rules.

| Module | Responsibility |
|---|---|
| Graph callbacks | Decide what work to run and interpret recorded results; filter issues and classify known labels using ordinary pure functions |
| Executor | Perform actual I/O or computation, including API requests, commands, and agent invocation; return typed results |
| Controller | Admit work, record intent/result, enforce scope and limits, manage execution processes, and supply recovery evidence |
| Supervisor | Diagnose failures and request retries, alternative executors, or qualified repairs within fixed steps and authority |

An executor is an implementation of a bounded job, not another graph step.
Fetching issues, filtering them, and classifying labels can support one existing
stage. Ambiguous labels may call for an agent job as normal domain behavior.

## Built-in and custom implementations

Provide built-ins as versioned packages included with the standard installation,
starting with common GitHub access alongside existing agent/command execution.
Their implementation runs outside the controller process, just like custom code.
Built-ins are conveniences, not a privileged or closed catalog of allowed work.

The initial GitHub interface should support listing/fetching issues and pull
requests, bounded pagination, and normalized results. Follow with explicitly
requested writes such as creating a PR or adding a comment. Query and label
policies remain plugin code. Return pagination cursors and completeness metadata;
a page of results must not masquerade as every matching issue. Surface rate limits
and retry timing rather than hiding unbounded retries inside the executor.

Use distinct qualified identities, for example `graphloom.github/list-issues`
and `acme.github/select-candidates`. Resolve them through explicit imports or
bindings; a custom executor must never silently shadow a built-in name. A plugin
can explicitly select a custom implementation when the built-in cannot satisfy it.
Both receive only their admitted inputs, credential bindings, and execution scope.
Installing code does not grant permission to use new accounts or perform writes.

### Built-in executor packages

Built-in executor packages live under `executors/<name>/`, one npm workspace
each. A package depends only on `@graphloom/sdk`, the same boundary a graph
plugin has. The host composes it; the package never imports the runner,
controller, or supervisor. To add one:

1. Create `executors/<name>/` exporting `executors: ExecutorDefinition[]` from
   an entry module. Qualify every id as `graphloom.<name>/<operation>`.
2. Export an `ExecutorPackageManifest` that lists the entry module, the executor
   ids, the credential binding names it reads, and the non-secret `configEnv`
   names it accepts. Optionally export a helper that turns package-specific
   operator settings into an `ExecutorBinding`, like `githubBinding`.
3. Test executors in-process through the SDK contract. Put tests that need the
   executor process, the controller, or a live service in the host
   (`apps/graphloom/test`).

The operator serves packages through `createBuiltinExecutorRunner` in
`@graphloom/runner`:

```ts
createBuiltinExecutorRunner({
  packages: [{ manifest: githubExecutorPackage, ...githubBinding({ token, allowWrites: true }) }],
  fallback: agentRunner,
});
```

The runner rejects ids outside `graphloom.`, ids served by two packages, and
credentials or configuration a manifest did not declare. Each package gets its
own executor process. That process receives only its bound credentials over
stdin, its declared configuration, and its effect grant, which defaults to
`read`. Every non-empty bound credential is redacted from job results, and an
empty credential is rejected. A job that outlasts the binding's `timeoutMs`,
or the runner's default of 30 seconds when the binding sets none, fails.

On a timeout or a run stop, the runner sends the executor process SIGTERM.
That aborts the executor's `signal` and refuses the tool and model requests it
is still waiting on, so it can stop processes it started in their own process
groups, such as an agent CLI and its commands. The job settles only when the
process has exited, or after a 10-second grace, when it is killed. Processes an
executor leaves behind after ignoring its signal are not tracked.

The process runs under Node's permission model. It may read only its own
package and the dependencies Node resolves for it. File writes, child
processes, worker threads, native addons, and WASI are denied. The runner
refuses to start built-in packages on a Node release without a stable
permission model (below 22.13) rather than run them unconfined.

Node's permission model has no network scope, so the host does not restrict
where a built-in package connects. Built-in packages are first-party code that
contacts only its configured API URL. Untrusted executors that need egress
limits require an OS-level sandbox, which this runner does not provide.

A manifest may declare `isolation: "unrestricted"` for work the sandbox cannot
host, such as a coding agent that edits the worktree and runs commands. Such a
package runs with the user's full permissions and environment, and the runner
refuses to serve it unless the operator's binding sets `allowUnrestricted`.
The controller still admits its tool calls, budgets, cancellation, and
evidence, but it cannot confine what the package does on the machine. It
detects worktree writes outside the job's `writeScope` after the fact, as
described below, but not effects elsewhere on the machine.

`@graphloom/executor-github` (`executors/github`) is the first built-in package:

- Reads (effect `read`): `graphloom.github/list-issues`, `list-pulls`,
  `get-issue`, `get-pull`, `list-issue-comments`, `list-labels`, and
  `list-milestones`.
- Writes (effect `write`): `create-issue-comment`, `create-pull`,
  `create-pull-review` (request changes, comment, or approve, with optional
  inline comments), `add-labels`, `remove-labels`, and `update-issue` (title,
  body, and milestone; a `null` milestone removes it). The label executors and
  `update-issue` accept either an issue or a pull request number.

How the package behaves:

- `githubBinding` maps the token, the API URL, and `allowWrites` to the
  package's binding. The token travels over stdin, never argv or the
  environment, and the runner redacts it from job results. Writes stay refused
  unless the operator sets `allowWrites`.
- Custom runners cannot register ids under the reserved `graphloom.` namespace.
  The worker refuses a pinned version other than the installed one, and it
  enforces the input and output schemas.
- List results carry the query, retrieval time, start and next cursors, and
  `complete`. Pages per call are bounded, and pull requests returned by the
  issues endpoint are counted but excluded.
- A rate limit fails the job with retry timing. The executor never sleeps or
  retries on its own.
- Comments, reviews, and pull requests embed
  `<!-- graphloom-op: <runId>/<idempotencyKey> -->`. The executor reconciles by
  that marker, or by an open pull request with the same head and base, before
  posting and again after an ambiguous POST. An unconfirmed outcome is reported,
  never blindly repeated.
- Label and field edits converge on a desired state. The executor re-reads the
  issue first, so labels already present (or already absent, for removal) or
  fields already matching need no write. It re-reads again after an ambiguous
  request. `add-labels` refuses a label the repository does not define unless
  `createMissing` is set, in which case it creates the label explicitly before
  adding it.
  `update-issue` records the prior values it replaced. With
  `expectedUpdatedAt`, it reports a conflict rather than overwriting an edit
  made after the supervisor read the issue. This check is best-effort: GitHub's
  REST API has no conditional update, so an edit that lands between the
  executor's re-read and its PATCH can still be overwritten. The recorded prior
  values are the recovery path.
- GitHub's validation details are passed through in failure summaries. Examples
  are reviewing your own pull request, an unknown milestone, or an inline comment
  on a line outside the diff.
- With a single GitHub account, GraphLoom usually opened the pull request it is
  reviewing. GitHub refuses `REQUEST_CHANGES` and `APPROVE` from the author, so
  a graph that asks for fixes on its own pull request should post a `COMMENT`
  review. The refusal is a definite failure: nothing is posted, and a retry
  fails the same way.

`@graphloom/executor-coding-agent` (`executors/coding-agent`) serves
`graphloom.coding-agent/run`. It adapts an agent harness to the executor
protocol:

- A `CodingHarness` opens a session in the run worktree with the job's tools,
  abort signal, credentials, and a `reserveModelCall` hook, then runs the
  assignment. The package ships the harness interface, the Claude Code
  harness (`@graphloom/executor-coding-agent/claude`), the Pi harness
  (`@graphloom/executor-coding-agent/pi`), the read-only Codex harness
  (`@graphloom/executor-coding-agent/codex`), and a scripted harness for tests
  (`@graphloom/executor-coding-agent/testing`).
- The executor process loads the harness named by `GRAPHLOOM_CODING_HARNESS`.
  `codingAgentBinding({ harness })` sets it, grants read and write effects, and
  consents to the package's unrestricted isolation. It also sets the job
  timeout to one hour unless `timeoutMs` says otherwise, because a coding job
  runs far longer than the runner's default.
- The job result is the agent's claim: its status, structured output, the tool
  calls it made with their child operation ids, and its model request count.

Both production harnesses provide coding tools in the worktree and include
`writeScope` and `readOnly` in the assignment. Claude also checks file-tool
permission requests and denies shell use by reviewers; Pi retains advisory
scope instructions. Writer shell commands remain unrestricted. For every
dispatch, the controller compares the worktree before and after the job:

- It checks tracked and untracked paths that differ from HEAD, by content, and
  skips ignored paths. A `writeScope` entry covers that exact path or, as a
  directory, every file under it.
- A read-only job may change nothing. Restoring a path to HEAD is not a change,
  so a correction may undo an earlier stray edit.
- Any other changed path fails the job, even if the executor reported success.
  The changes stay in the worktree, and the failure lists them for recovery.

Job tools are the one mediated path. Each call goes to
the controller as a child operation with a harness-generated id that is fresh
for every turn, so a continued session never reuses an earlier id, and the
agent sees the recorded `ToolCallResult`.

The Claude Code harness runs the user's `claude` CLI headless
(`createClaudeCodeHarness`, or the module at `claudeCodeHarnessModule`
configured from the environment):

- It runs `claude -p` with stream-json input/output, `--tools default`, and
  `--permission-prompt-tool stdio` in permission mode `default`. File-tool
  permissions enforce the job's write scope; read-only jobs cannot use file
  mutation tools or Bash. Unknown permission requests are denied. Writer shell
  commands remain unrestricted; see the [live-mode design](design-claude-live-mode.md).
  Job tools are
  served on a loopback MCP endpoint with a per-run bearer token, as the
  `graphloom` server (`--strict-mcp-config`, so no other MCP servers load).
  The endpoint forwards tool calls to the controller one at a time, even when
  Claude Code sends several at once.
- Claude Code has no hook before each provider request. The harness reserves
  the first request before launching, and each later one when the stream
  shows it coming: at the first tool result of a response, or at a response it
  has not yet charged. A refusal stops the process, so at most the request
  already in flight runs past the budget. Subagents' responses reach the
  stream (`--forward-subagent-text`, marked with `parent_tool_use_id`) and are
  charged the same way. Subagents run concurrently with the main thread, so
  each running thread can have one request in flight past a refusal.
  Requests Claude Code makes outside the transcript's responses, such as
  context compaction or `WebFetch`'s summarizing, are never charged per
  request; their tokens still appear in the reported usage.
- Cancelling the job first sends an `interrupt` control request, allowing the
  CLI to save the interrupted turn. An unresponsive process receives SIGTERM
  after an interrupt grace period, then SIGKILL. Saved sessions remain resumable.
- Claude Code gets a minimal environment, not the executor's: `PATH`, `HOME`,
  user, shell, temp, locale (`LANG`, `LC_*`, `TZ`), `SSH_AUTH_SOCK`, XDG
  directories, proxy and CA settings, plus `CLAUDE_CONFIG_DIR` set to the
  binding's config dir. Anything else, such as Bedrock or Vertex settings,
  must be named in `passEnv` (`GRAPHLOOM_CLAUDE_PASS_ENV`, comma-separated). An
  ambient `ANTHROPIC_API_KEY` is never passed, and a `passEnv` naming it is
  refused; bind the credential instead.
  Gateway settings belong in the config dir's `settings.json`.
- A watchdog stops a quiet run. Model output (assistant messages, tool results,
  and `system/thinking_tokens`) is progress. The run fails as stalled when
  none arrives within `startupTimeoutMs` of launch (default 300 s,
  `GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS`) or for `responseTimeoutMs` afterwards
  (default 600 s, `GRAPHLOOM_CLAUDE_RESPONSE_TIMEOUT_MS`). The response timer
  pauses while a tool or subagent is running; 0 disables either timer. A
  stalled run still saves its session, so a later job can continue it.
  `codingAgentBinding` refuses a timer that is not shorter than the job
  timeout, because the runner would kill the job before the stall is reported.
- The run's token totals (input, output, cache read, cache write) and cost are
  reported as `usage` in the job's `codingAgent` evidence. They come from the
  last `result` event's `modelUsage` and `total_cost_usd`, which cover every
  turn and subagent (a background subagent's report adds a turn with its own
  `result`). Those totals span the whole session: on resume Claude Code
  restores them from the transcript's last `cost-state` record, so the harness
  subtracts that record's totals. If the final totals fall below that record's,
  Claude Code did not restore them and they are reported as they are.
- With `resultSchema`, Claude Code validates its final answer against
  `--json-schema`: the inline JSON object schema, or an open object named for
  the schema. A run without structured output fails the job.
- Claude Code keeps its own login, so a Claude subscription works as is.
  `GRAPHLOOM_CLAUDE_BIN` and `GRAPHLOOM_CLAUDE_MODEL` pick the executable and
  model, and a job may pick a model with `harnessOptions.model`. An API key
  bound as the `anthropic-api-key` credential
  (`codingAgentBinding({ harness, claude: { apiKey } })`) reaches Claude Code
  only as `ANTHROPIC_API_KEY` in its environment.
- The config dir holds Claude Code's login and `settings.json`, so it picks
  the account or gateway. `codingAgentBinding({ claude: { configDir } })`
  (an absolute path, `GRAPHLOOM_CLAUDE_CONFIG_DIR`) sets it per binding, so one
  workflow can use a gateway and another a first-party account. The default is
  the executor's `CLAUDE_CONFIG_DIR`, then `~/.claude`.
- Claude Code writes transcripts under its config dir. After each run the harness copies the transcript to
  `<sessionDir>/<sessionRef>.jsonl`, with `<sessionRef>.json` naming its
  project directory, model, and system prompt digest. The session's side
  directory is mirrored to `<sessionDir>/<sessionRef>/`, regular files only,
  and removed there when the session no longer has one. A transcript that is a
  symlink is not saved, and a file replaced between scanning and copying (by a
  symlink, a special file, or a new file) fails the copy.
  That directory holds subagent transcripts, which a resumed session needs to
  continue a subagent with `SendMessage`, and tool output spilled to files. A
  resume validates the saved copy, writes the transcript and side files back
  into Claude Code's store, replacing its own, and runs `--resume`. A missing,
  empty, or corrupt copy fails the resume before Claude Code starts; a symlink
  or special file among the side files counts as corrupt. So does a different model or system prompt: Claude Code would
  resume under either, and the earlier turns would pass as continuity.

The Pi harness runs a Pi coding agent in-process (`createPiHarness`, or the
module at `piHarnessModule` configured from the environment):

- Pi's built-in tools are all active: `read`, `bash`, `edit`, `write`, `grep`,
  `find`, and `ls`, next to the job tools.
- Pi runs inside the executor process, but its `bash` commands get the same
  minimal environment as Claude Code (without `CLAUDE_CONFIG_DIR`), not the
  executor's. Other variables must be named in `passEnv`
  (`GRAPHLOOM_PI_PASS_ENV`, comma-separated).
- Every provider request reserves budget through `reserveModelCall()` first. A
  refusal ends the session with `model request budget exhausted`, and cancelling
  the job aborts the session.
- With `resultSchema`, the agent submits its result through a `submit_result`
  tool. An inline JSON object schema is enforced on the call; a schema name is
  only shown to the model. Finishing without submitting fails the job.
- The provider and model come from `GRAPHLOOM_PI_PROVIDER` and
  `GRAPHLOOM_PI_MODEL`, and Pi's `auth.json` and `models.json` from
  `GRAPHLOOM_PI_AGENT_DIR` (default `~/.pi/agent`). A job may choose another
  model of the same provider with `harnessOptions.modelId`. An API key bound as
  the `pi-api-key` credential (`codingAgentBinding({ harness, pi: { apiKey } })`)
  is set on the provider runtime only, never in prompts or the transcript.
- Sessions are saved as `<sessionDir>/<sessionRef>.jsonl`, with
  `<sessionRef>.json` recording the provider, model, and system prompt digest.
  A missing, empty, or corrupt session file fails a resume with a clear reason.
  So do a missing settings record and a different provider, model, or system
  prompt, before any provider request.

The Codex harness runs the user's `codex` CLI headless (`createCodexHarness`,
or the module at `codexHarnessModule` configured from the environment):

- It serves read-only jobs without job tools, and refuses others before
  starting: Codex cannot confine writes to a write scope, and it has no bridge
  to the controller's tools. It is not resumable.
- Each job runs `codex exec --json --ephemeral --sandbox read-only` in the
  worktree, with the assignment on stdin. The model, reasoning effort and
  Codex home come from `GRAPHLOOM_CODEX_MODEL`,
  `GRAPHLOOM_CODEX_REASONING_EFFORT` and `GRAPHLOOM_CODEX_HOME` (then
  `CODEX_HOME`). Codex uses its own login. Its environment is the same minimal
  set as Claude Code's, plus `GRAPHLOOM_CODEX_PASS_ENV` names.
- With `resultSchema`, an inline JSON object schema goes to
  `--output-schema`, so it must suit strict structured output: every property
  required, no extra ones. The final message must parse as a JSON object, or
  the job fails.
- Codex has no hook before each provider request. The first is reserved up
  front, and one more after each command whose output goes back to the model;
  a refusal stops the process. Usage comes from `turn.completed`, with cached
  input reported as cache reads.
- `GRAPHLOOM_CODEX_RESPONSE_TIMEOUT_MS` (default ten minutes) stops a Codex
  that emits nothing while no command runs. Cancelling the job stops its
  process group.

### Continuing an agent session

Every agent dispatch gets a controller-owned session directory under the run's
state directory (`ctx.session.dir`). A harness that sets `resumable` saves its
transcript there and returns a `sessionRef`. The controller records the ref
against the run, stage, attempt, generation, and dispatch key. The dispatch key
is the job's `jobId`, or its purpose and executor id. The record is written
whether the job succeeded or failed, because a failed attempt's context is what
a retry lacks. `RunView.agentSessions` lists the recorded sessions without
their refs or paths.

A later dispatch continues a session only when it asks for it explicitly with
`job.continueFrom: <operationId>`. Without that field, the job starts fresh.
The controller admits a continuation only for an agent job, and only when the
operation settled in this run with a recorded session, for the same stage and
dispatch key, in the current
generation or an earlier one, and has not already been continued. It rejects
anything else before the job runs, with `continuation rejected`. A continued
job gets the same directory, and `ctx.session.resume` names the session.

The continued session's transcript is context, not authority:

- The assignment starts with a notice that the worktree and services may have
  changed and that earlier tool results belong to an earlier attempt.
- Scopes, tools, credentials, and budget come only from the new dispatch, and
  model requests are charged to the run as usual.
- Tool calls from earlier turns are never replayed. Reusing an earlier call id
  is refused, and the agent must make a new call, which is admitted and
  budgeted like any other.
- An earlier write whose outcome is unknown (`ambiguous`) blocks the same call
  (the same id, or the same tool with the same input) until it is reconciled.

A session that cannot be restored fails the job with `agent session <ref> could
not be restored: <reason>`. A harness that is not resumable fails the job too.
A sandboxed executor cannot write, so the runner gives it no session directory
and fails a continuation sent to it. None of these starts a fresh session in its
place. With a supervisor, the failure
becomes the recovery trigger; without one, the run stops. Records and
transcripts live in the state directory, so a continuation survives a
controller stop and resume. When the run finishes (`succeeded` or `failed`),
the controller deletes its `agent-sessions/` directory, since nothing can
continue those sessions and transcripts with subagents grow large. The records
stay in run state. A `resume` of a finished run deletes any directory a crash
left behind.

Continue when the earlier attempt's reasoning is still useful: the agent was
interrupted, ran out of budget, or needs only a correction to finish. Start
fresh when that context would mislead the agent. For example, the task or plan
changed, a repair replaced the executor or graph behavior, or the transcript is
anchored on an approach the supervisor has rejected. The graph or supervisor
makes this choice; the controller never continues a session on its own. The
Claude Code, Pi, and scripted test harnesses all implement resume.

Built-in packages and plugin bundles can be installed or upgraded independently
of the controller when compatible with its executor protocol. No controller
release is required for another API integration or custom processing function.
A new lifecycle primitive or unsupported isolation capability may require host
changes; arbitrary new permissions are not granted by an executor implementation.

## Invocation and lifecycle

The SDK should expose one executor interface with input/output schemas, an
implementation entry point, requested capabilities, and effect/reconciliation
metadata. The following is an illustrative target interface, not shipped SDK:

```ts
// Plugin-owned implementation: this code performs the actual GitHub request.
export const listIssues = defineExecutor({
  id: "acme.github/list-issues",
  inputSchema: issueQuerySchema,
  outputSchema: issuePageSchema,
  effect: "read",
  async execute(input, ctx) {
    return github.listIssues(input, {
      token: await ctx.credentials.get("github"),
      signal: ctx.signal,
    });
  },
});

// Normal graph decision: use this implementation or an imported built-in.
return dispatch({
  executor: listIssues,
  input: { repo: "apache/skywalking", labels: ["bug"], pageSize: 50 },
});
```

The SDK serializes a pinned executor reference and bounded input; it does not
send functions, closures, or secrets over IPC. Graph decision callbacks remain
pure, and executors run in separately scoped processes. Plugin code is executing
the operation; the controller only manages its lifecycle. A convenience execution
wrapper must use this same admission protocol, never call untracked I/O from a
decision callback or pretend a JavaScript stack can survive process restart.

For each execution:

1. Resolve the pinned implementation and validate input, current stage/attempt,
   authority, and remaining budget. Record durable intent before starting effects.
2. Start the execution process with scoped credentials, filesystem/network access,
   cancellation, deadline, and operation identity. The executor implements the work.
3. Capture bounded progress, result, error, and artifact references; validate the
   envelope and record settlement. Redact secrets from logs and durable inputs.
4. Supply the recorded result to normal routing or supervisor recovery. Executor
   success is an observation, not an accepted stage receipt.

Pure local filtering needs no separate operation. Independent external writes
need separate operation identities unless a composite executor supplies durable
checkpoints and reconciliation for every partial effect. The minimal version
uses separate jobs for such writes. Wrapping many effects in one function must
not hide them from cancellation, budgets, or recovery. Agent/model requests retain
the core design's actual-request accounting, including inside custom executors.

## Example: graph, executor, and coding agent

Consider a plugin with fixed stages **Select → Implement → Review**. This is an
integration example; the minimal Hello graph remains Write → Review. The names
and helpers below illustrate the target interface and are not a shipped SDK.

```text
Select:    GitHub executor fetches issue pages
           → plugin filters candidates and classifies labels
           → controller validates selection evidence and accepts Select
Implement: coding-agent executor invokes the selected harness
           → agent edits the isolated worktree
           → test executor collects results for the submitted candidate
           → validators evaluate evidence; controller accepts Implement
Review:    independent read-only reviewer executor examines that candidate
           → review validator evaluates the report
           → controller accepts Review and completes the run
```

Requirements belong to their owning stage. Implement acceptance can require its
relevant tests to pass; the independent issue-resolution/scope review belongs to
Review. Implement must not wait for a later Review receipt, which would create a
cycle. A failed review may request reentry to Implement with fresh downstream
validation, and the reentered dispatch may
[continue the earlier agent session](#continuing-an-agent-session). Executor
jobs neither insert steps nor bypass this ordering.

The graph constructs a job using the selected issue from accepted Select evidence:

```ts
// Inside advance(view), for the current Implement attempt.
if (!view.results.implementation) {
  return dispatch({
    key: "implementation",
    executor: codingAgent.run,
    input: {
      assignment: buildAssignment(view.accepted.select.issue),
      resultSchema: implementationResultSchema,
    },
    scope: { workspace: "run-worktree", access: "write" },
  });
}
// Subsequent decisions request observed candidate evidence, relevant tests,
// and validation; the implementation result alone cannot accept the stage.
```

A key identifies work within its run/stage/attempt; it is not a global cache key.
The controller supplies only current, settled results in that view, so a repeat
of the same decision does not launch another implementation job. An intentional
retry receives a new admitted attempt and retains the previous result.

The coding-agent executor adapts the chosen harness to the executor interface:

```ts
const run = defineExecutor({
  id: "graphloom.coding-agent/run",
  inputSchema: codingAssignmentSchema,
  outputSchema: implementationResultSchema,
  async execute(input, ctx) {
    const session = await harness.createSession({
      cwd: ctx.workspace,
      credentialBinding: ctx.credentialBinding,
      tools: ctx.admittedTools,
    });
    try {
      return await session.run({
        prompt: input.assignment,
        resultSchema: input.resultSchema,
        signal: ctx.signal,
        onEvent: ctx.reportProgress,
      });
    } finally {
      await session.dispose();
    }
  },
});
```

The harness adapter resolves only authorized credentials and enforces tool scope;
secrets are never assignment text. It maps agent events, tool activity, errors,
cancellation, and structured output into the common execution protocol. The agent
chooses investigation, edits, and tests within that scope. Controller-observed
workspace evidence and recorded test execution establish what happened; an agent's
self-reported success or test summary alone is insufficient for acceptance.

This does not require workers to share the supervisor's Pi session. Worker and
reviewer sessions remain separate; the supervisor retains one logical session for
exceptional recovery across the run.

## Agent tools invoking executors

A coding agent may need a supporting operation such as fetching issue comments.
An explicitly exposed harness tool can invoke the same GitHub executor used by
the graph:

```text
Agent calls read_issue_comments
  → harness tool submits a child executor request
  → controller admits and journals the child operation
  → GitHub executor fetches comments
  → recorded result returns as tool output to the waiting agent
```

The tool binding selects an installed, pinned executor and validates arguments.
The agent cannot invent an executor implementation, broaden its grants, or obtain
credentials merely by naming a tool. Controller admission applies to each request.
Pure local computation inside the agent needs no executor dispatch of its own.

Child execution requires an explicit protocol extension; it is not achieved by
letting an executor recursively launch untracked jobs. Record parent job ID,
harness tool-call ID, child operation ID, owning stage/attempt, generation,
implementation identity, and outcome. Child grants cannot exceed the parent's
delegable scope or the run grants. Model calls and child jobs spend the same global
budgets; creating a child must not reset counters or extend the parent's deadline.

The initial child model permits one leaf executor at a time while the parent agent
waits. Suspend the parent's execution slot while servicing the child so serial
scheduling does not deadlock. Do not allow recursive child agents or graph routing
through this interface. The graph's decision owner and stage cursor remain fixed
while the parent job is outstanding.

Stop cancels both processes and fences late results. On restart, reconcile the
child operation before resuming/retrying the parent. Replaying a persisted tool
call returns its existing result; a new harness session must not replay an
ambiguous external write without reconciliation. A lost JavaScript promise is not
a durable continuation. An unavailable parent session becomes an explicit recovery
case with its settled/ambiguous children preserved.

The implemented protocol works as follows:

- A dispatched job declares `tools`: a name, a pinned executor, and the declared
  effect for each. The SDK validates them at admission. The executor sees only
  names and effects, and the runner refuses a pinned executor whose effect
  differs from the declaration.
- The executor worker protocol is two-way. While the job runs, the executor
  sends `tool_call` and `model_call` messages and waits for the replies. The
  runner forwards them to the controller and kills the process when the run
  stops.
- For each call, the controller checks the run is still running, the parent
  is still the outstanding job at its generation, and one job remains reserved
  for the parent. It then journals a child operation record and runs the child
  as a leaf `command` job with the parent's worktree scope. The child gets no
  tools of its own. A parent without a write scope may call only `read` tools.
- Protocol messages need a positive integer sequence number. The runner ignores
  any message that arrives after the job settled.
- On settlement, the child spends one job, and its evidence is recorded with
  the child operation, parent operation, and tool-call ids.
- A model call reserves one agent invocation. A parent that reserved any calls
  is not charged the flat per-dispatch invocation.
- Calls are serviced one at a time; a concurrent call from the same parent is
  refused rather than queued.
- Replay is keyed by stage, attempt, and tool-call id. A settled call returns
  its recorded result; reusing the id with different input is refused. A new
  attempt runs the call fresh.
- Stop aborts the parent and child. Once the parent returns, for any reason
  including a timeout, the loop cancels a child still running and waits for it
  to settle before it settles the parent. A child that finished after the fence
  keeps its result for replay. A write cut short is recorded `ambiguous` and is
  never replayed.
- On restart, a pending read child is marked `abandoned` and may run again. A
  pending write child is marked `ambiguous`, and the run stops once with
  `reconcile required`. The parent is reconciled after its children.
- Agent jobs cannot produce validation evidence about their own work. `command`,
  `file`, and `workspace` evidence from an agent job is recorded as `other` with
  a `selfReported` claim. So is `review` evidence from anything but a read-only
  review job. Command evidence from the agent's tool calls counts, because a
  command executor produced it.

## Validation ownership

The graph plugin declares stage requirements and selects validator bindings.
Validator implementations live in plugin code or versioned reusable packages.
Executors collect evidence; validators evaluate that evidence; the controller
checks provenance and required coverage and records acceptance. Tests run through
a command executor, and semantic review runs through an independent agent
executor. Neither an executor nor an agent creates an accepted receipt.

See [validation declarations](design-typescript-core.md#where-validation-is-defined)
for the requirement, evidence, validator, and controller responsibilities. The
supervisor can qualify repairs to an executor or validator implementation while
preserving pinned outcomes and review independence.

## Restart, versions, and recovery

Pin built-in dependencies and custom executor artifacts at intake: identity,
version, digest, protocol, schemas, runtime, grants, and nonsecret credential
references. Resume resolves that exact committed version, not the newest installed
package. Missing pinned artifacts are a concrete blocker, not a silent upgrade.
Changes for an active run follow qualified repair and recorded activation; built-in
repairs use a run-local source copy or authorized substitute, never mutate the
shared installation. Preserve fixed steps, requirements, and authority.

Completed operation IDs return their recorded result. An intentional fresh read
or retry creates an admitted new attempt; replay must not accidentally refetch
changing GitHub data and alter a past decision. Record query, retrieval time,
pagination state, and relevant remote identities with the observed result.

If execution may have reached GitHub before a crash, its outcome is ambiguous.
A write executor needs an idempotency key where supported, or reconciliation using
stable remote identities and observed state before retry. Creating a PR should
check for the matching repository/head/base and operation evidence; local intent
alone is not proof it was created. If the outcome cannot be established, retain
uncertainty for recovery/operator resolution. Do not promise exactly-once remote
effects or blindly repeat a comment/PR creation. Stop fences results and terminates
local processes; it cannot undo a request already accepted by a remote service.

Both executor kinds surface failures, progress, inputs, and observations through
the same protocol so the supervisor can diagnose, retry, or repair them without a
plugin-specific recovery branch. Rate-limit waits and retries are bounded by run
limits. Source availability and operator authority still constrain repair.

As implemented, the controller pins the runner's executor catalog when a run
starts: each executor's id, where it is served from, its isolation, and a SHA-256
digest of the code it runs. A package's digest covers its tree without
`node_modules`; a single-module executor's covers the module file. Every dispatch,
including an agent's child tool call, carries the pinned digest, and the runner
refuses to run different bytes. A dispatch naming an executor outside the catalog
is refused. Resume stops with `executor pin mismatch` when a pinned executor's
digest, source, isolation, or built-in status changed, or it is no longer
installed.

A failed executor job records its evidence plus an `executorFailure` record
(operation, stage, attempt, pinned executor, status, summary, and any requested
wait). The shape is the same for built-in and custom executors. With a supervisor, the run then
enters recovery with trigger `executor_failed`; without one it stops as before.
In recovery the supervisor may dispatch work for the current stage only, through
an executor the run pinned or a built-in agent/command default. When the runner
cannot describe its executors, only those defaults are allowed. It can retry the
same executor or switch to another one, but cannot add graph steps. An executor
that returns `retryAfterMs` (clamped to 30 days) runs again no earlier than that.
The wait is charged to the run's `waitMs` budget (15 minutes by default); a wait
larger than what remains stops the run with `wait budget exhausted` instead of
sleeping. Stop interrupts the wait. A dispatch stopped or crashed during its
wait never reached the runner, so resume drops it, refunds the unspent wait, and
keeps the retry time.

A failed tool call from an agent writes the same `executorFailure` record and
sets the same retry time. The agent receives the failure, including
`retryAfterMs`, as its tool result. Further calls to that executor are refused
without running until the retry time passes. The parent agent handles its tool
results; the run enters recovery only if the parent job itself fails.

Executor repair uses the qualified repair lifecycle with target `executor` and
requires the task grant `executorRepair: true` (off by default). Qualification
copies the pinned package into the run's state directory, links the dependencies
the installed package resolves, and lets the supervisor patch the copy. The copy
must still define the same executor ids, versions, and effects, then pass
preflight and independent review. Activation serves the copy for every executor
of that package in this run, re-pins them to the copy's digest, and re-checks the
current stage. The shared install is never modified, and resume serves the same
reviewed copy. In-process executors cannot be repaired this way.

## Enforcement

Production executor code runs outside the controller through the declared execution
profile. The runner enforces the restrictions supported by that profile; the
current unrestricted coding profile and Node-based package profile do not provide
general OS/network confinement. A wrapper or TypeScript declaration alone cannot
enforce it. Explicitly distinguish allowed unrestricted execution from executions
requiring confinement: reject the latter when unavailable. Agent-host attachments
must disclose the same distinction and their model-accounting coverage.
A GitHub read grant cannot authorize
creating a PR; neither built-in status nor plugin installation expands that grant.

Publication remains an explicit task/operator permission. The minimal Hello graph
still delivers a local diff with no automatic external writes.

## Delivery and checks

1. Add the SDK executor contract, pinned resolver, child execution protocol, and
   durable admission/results handling. Adapt existing execution paths to this
   interface; do not introduce a second job ledger or budget model.
2. Ship the common GitHub executor package and a custom example. Initially qualify
   read operations and pagination, then explicitly authorized write operations and
   ambiguous-effect reconciliation. Package updates are independent of controller
   releases within the supported protocol.
3. Add the coding-agent harness adapter and explicit child-operation protocol,
   including waiting-parent scheduling, durable tool results, inherited scopes,
   accounting, cancellation, and restart reconciliation.
4. Connect supervisor dispatch and qualified executor repair to the existing
   recovery/version lifecycle. Changes cannot add or remove graph steps.

Verify built-in/custom parity through the public interface, installing a new
executor without rebuilding the controller, schema rejection, scope enforcement,
credential redaction, process timeout/stop, partial pagination, rate-limit bounds,
replay versus fresh reads, crash after remote write, pinned-version resume, and
qualified replacement without changing required outcomes. Also verify graph →
executor → agent execution, agent-tool → child-executor result delivery, serial
parent/child scheduling without deadlock, parent/child stop and restart, shared
budgets, and rejection of stale, missing, or self-reported validation evidence.
Use fake services for
repeatable crash and duplicate-effect tests. Live GitHub writes require an
explicitly authorized test target. These checks are planned, not results of this
documentation change.
