# Claude Code stdio permissions and cancellation

Implements [#71](https://github.com/hanahmily/graphloom/issues/71) within the
[unrestricted coding-agent package](design-executors.md). Verified with the fake
CLI; real-account qualification remains separate.

## Protocol and lifecycle

The harness starts Claude Code with `--input-format stream-json`,
`--output-format stream-json`, `--permission-prompt-tool stdio`, and permission
mode `default`. It initializes the control protocol, sends a user message, and
keeps stdin open to answer permission requests. It does not wait for
`system/init` before sending the assignment: Claude Code 2.1.x emits that event
after the first user message. The GraphLoom MCP connection is checked when that
event arrives.

Each executor job owns one child process, including background subagent reports
and their follow-up turns. The bidirectional stream serves model/tool exchanges;
this change does not pool running processes across jobs. After the final result
with no pending background agents, stdin closes, the CLI exits, and its transcript
is copied to the controller's session directory. Another job can restore the same
session through the existing `sessionRef` contract.

The wire envelopes follow Anthropic's
[control protocol implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
Replies echo the incoming request ID. Unsupported control subtypes receive an
error; invalid tool requests receive a denial. Requests outside an active turn
are denied, including those arriving after cancellation.

## What permission decisions enforce

The harness adds explicit `ask` rules for file mutations, Bash, and GraphLoom MCP
tools, so normal auto-allow rules cannot bypass those decisions. Claude's own
deny rules may still reject a request before it reaches the harness; see
[permission evaluation](https://code.claude.com/docs/en/permissions).

| Request | Decision |
|---|---|
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | Require a writer job and a target in its admitted `writeScope` |
| Read-only job's file mutation or `Bash` | Deny |
| `Read`, `Grep`, `Glob`, `StructuredOutput` | Allow |
| `Agent`, `Task` | Require a nonempty subagent prompt; delegated tool calls retain the job's permissions |
| `mcp__graphloom__<name>` | Require an admitted job tool; a read-only job may call only read tools |
| Writer job's `Bash` | Allow under the operator's unrestricted-package grant |
| Unknown tool or malformed input | Deny |

File scopes use the controller's exact-path or directory-prefix semantics,
not glob matching. Paths must remain inside the worktree and cannot enter `.git`.
The check rejects symbolic links along the path and existing hard-linked files.
Missing scopes grant no file mutations. Permission approvals preserve the supplied
tool input and never install broader persistent permission rules.

These are tool-level checks, not an OS sandbox. A shell command can write outside
the worktree, access credentials, or start other processes; its arbitrary effects
cannot be derived safely from command text. Other processes can also change paths
after a permission check. The package therefore remains `isolation: unrestricted`
and still requires `allowUnrestricted`. Read permissions do not confine reads to
the worktree. The controller's post-job write-scope checks remain in place.

## Cancellation and verification

Cancellation sends a correlated `interrupt` control request first. The harness
waits up to `interruptGraceMs` (default 1 second) for the turn to finish and flush
its transcript, then falls back to process-group SIGTERM and, after `killGraceMs`
(default 5 seconds), SIGKILL. An acknowledgment alone does not prove the turn has
finished. Saved transcripts remain resumable; a process killed before it writes
one cannot claim a saved session. Budget exhaustion and stall watchdogs use the
same bounded stop path.

A separate `graphloom stop` writes the stop request and signals the verified
controller owner. Active controller sessions handle SIGTERM cooperatively, so
the stop watcher aborts the executor and its detached Claude process group. The
stop command waits for owner cleanup before returning; a cleanup timeout keeps
the ownership record and reports that stopping is still pending. Persisted
controller and plugin PIDs are paired with the Linux boot ID and process start
time before signaling. Legacy PID-only claims are never signaled; a still-live
PID remains conservatively fenced until it exits or an operator verifies it.
When resume settles an interrupted writer from observed file effects, it also
retains that writer operation ID for independent-review admission.

Tests cover allowed and denied file requests, traversal and link rejection,
read-only shell denial, unknown requests, MCP calls after the first user message,
interrupt-before-signal ordering, forced-stop fallback, and restoring the saved
interrupted session. These tests exercise a fake CLI and make no real model calls.
