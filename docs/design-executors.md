# Built-in and plugin-owned executors

Status: accepted design, 2026-09-24; partially implemented (executor contract and
the packaged GitHub executor; the child-operation protocol and executor recovery
remain). This specializes the [TypeScript core design](design-typescript-core.md).

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
empty credential is rejected.

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
evidence, but it cannot confine what the package does on the machine,
including writes outside the job's `writeScope`.

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
  assignment. The package ships the harness interface and a scripted harness
  for tests (`@graphloom/executor-coding-agent/testing`); a production Pi
  harness is a separate adapter.
- The executor process loads the harness named by `GRAPHLOOM_CODING_HARNESS`.
  `codingAgentBinding({ harness })` sets it, grants read and write effects, and
  consents to the package's unrestricted isolation.
- The job result is the agent's claim: its status, structured output, the tool
  calls it made with their child operation ids, and its model request count.

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
validation. Executor jobs neither insert steps nor bypass this ordering.

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

## Enforcement

The controller process never imports executor implementation code. The runner
provides actual process, filesystem, credential, and network isolation. A wrapper
or TypeScript declaration alone does not enforce permissions or limits. Any host
profile unable to enforce required constraints must reject that execution rather
than advertise guarantees it cannot provide. A GitHub read grant cannot authorize
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
