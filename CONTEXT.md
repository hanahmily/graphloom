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

**Qualified repair**:
A proposed implementation change with reproduced defect evidence, regression
checks, and independent review, eligible for an authorized version transition.
Each attempt patches an isolated snapshot of a specific base plugin version so
concurrent candidates cannot share or mutate one another's trees.
