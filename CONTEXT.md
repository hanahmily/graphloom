# GraphLoom

GraphLoom coordinates agents through executable graphs and verifiable progress.

## Language

**Loom**:
The host that runs installed graphs and preserves the authority and evidence of
one execution.

**Graph**:
A domain harness defining required stages, agent tasks, checks, and transition
rules for a class of tasks.
_Avoid_: Stage list, prompt collection

**Task**:
A request to run a selected graph against a target repository for a stated result.

**Task plan**:
The data a graph's optional `prepareTask` hook returns for `graphloom task new`:
a bounded list of generic steps (fetch a ref, resolve a commit, pin a ref, write
the task) that the CLI validates and executes. It never runs a command.

**Run**:
One execution of a task, with pinned inputs, an isolated workspace, evidence,
and finite resources.

**Stage**:
A declared step on a graph's happy path whose identity, order, and required outcome
are fixed for a run. Several attempts and supporting jobs may satisfy that stage.
_Avoid_: Job

**Job**:
One bounded agent or command execution requested during normal operation or recovery.
_Avoid_: Stage

**Observation**:
A recorded result of executing a job or inspecting its inputs and outputs.
An observation alone does not establish accepted progress.

**Requirement**:
A stated outcome a task must satisfy, independent of the mechanism used to check it.

**Externalized evidence part**:
A large piece of an evidence record's payload that the controller stores in a
content-addressed file under the run's state directory instead of in the record.
The record names it by digest and path; a plugin worker reads it lazily, so plugin
code sees the full payload.

**Validator**:
An implementation that evaluates evidence against a requirement and reports a
pass, failure, or inconclusive result.

**Validator binding**:
The admitted version of a validator assigned to verify a requirement in a run.

**Receipt**:
The loom's record that a stage met its requirements for specific inputs and
admitted validator bindings.

**Supervisor**:
The run-wide agent whose job is to drive the graph to successful completion under
failure—investigating, repairing, and reentering within the task's required
outcomes, granted authority, and finite resources, rather than stopping early.

**Recovery episode**:
A period in which the supervisor directs investigation and repair before returning
to normal graph execution or stopping with an unresolved blocker.

**Reentry**:
A return to a required stage that invalidates affected downstream evidence and
creates new attempts while preserving prior history.

**Retryable stop / final stop**:
How a stop answers an operator's resume. After a retryable stop the resume runs
the graph again and it retries what failed; after a final stop the resume
surfaces the same blocker until something the stop depends on changes (plugin,
workspace change, budgets). Failures recorded before the resume are stale.

**Qualified repair**:
A proposed implementation change with reproduced defect evidence, regression
checks, and independent review, eligible for an authorized version transition.
Each attempt patches an isolated snapshot of a specific base plugin version so
concurrent candidates cannot share or mutate one another's trees.

**Rehearsal**:
A run of the real controller, plugin host, runner and harness adapters with
the model replaced by a stand-in that answers from the plugin's own declared
fixtures by contract name. Spends no provider calls; verifies that a
well-formed result travels every agent–harness boundary and that the graph
converges, before a live run spends its budget.

**Driver mode**:
The run's choice of who supplies its continuation: the loom itself in standalone
mode, or an attached coding-agent host in agent-host mode.

**Primary host**:
The attached agent session that performs assigned work and supplies supervisor
judgment during recovery. It cannot independently review its own output.

**Host claim**:
A time-bounded assignment of admitted work to the primary host for a particular
run and attempt. Reporting completion does not itself establish acceptance.

**Host slice**:
One admitted unit of primary-host work, whether implementation, a recovery proposal,
or repair editing, counted independently from the host's model requests.

**Host epoch**:
The durable fencing number for a run's primary-host binding. Rebind, claim expiry,
detach, and operator stop advance it; a transport reconnect to a still-valid
binding preserves it. Old-epoch requests cannot mutate the run or confirm drainage.
