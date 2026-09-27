# GraphLoom implementation roadmap

Status: TypeScript target, revised 2026-09-27. This supersedes the native Go plugin roadmap;
existing Go source remains available during migration.

The authoritative scope and completion criteria are in the
[implementation plan](design-typescript-core.md#12-implementation-plan), with
[release scenarios](design-typescript-core.md#11-minimal-example-and-verification)
and the [executor design](design-executors.md).

1. **M1:** TypeScript SDK, source bundle, and isolated plugin process.
2. **M2:** Durable Write → Review execution and controller-owned acceptance.
3. **M3:** [Pi supervisor](design-pi-supervisor.md), provider/model switching, recovery without plugin-specific repair handlers, and **in-session Pi coding** against admitted repair candidate trees.
4. **M3.5 / executor slice:** Common [executor lifecycle](design-executors.md), custom example, packaged GitHub support, coding-agent child protocol; independent of controller releases within the protocol.
5. **M4:** Qualified plugin/gate/executor repair (supervisor Pi authors the patch; independent reviewer), same-run version transitions, and local release.

These milestones describe work to implement, not completed runtime capabilities.
M1–M2 and M3 are largely in tree: scripted recovery, and Pi recovery admission
with model switching verified against faux providers. So are the executor
contract, the packaged GitHub executor (qualified against a fake server), the
coding-agent child protocol with explicit session continuation on reentry
(Claude Code and Pi harnesses, verified against a fake Claude Code CLI and
faux Pi providers), and executor recovery. Live provider qualification (#30)
and M4 remain outstanding.

## Agent-host mode (proposed)

The [agent-host design](design-agent-host.md) adds a second driver without changing
graph requirements or replacing the shared controller:

1. **H1:** Resumable controller transitions, host protocol, durable assignments and claims.
2. **H2:** Claude Code plugin, native coding, executor evidence, and separate review.
3. **H3:** Same-host supervisor recovery, qualified source repair, and release qualification.
4. **H4:** Compatible Pi host adapter after the first Claude-host release.

No host-mode feature is implemented by this design change. See the design for
crash/stop, stale-host, independence, and accounting acceptance criteria.
