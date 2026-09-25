# GraphLoom implementation roadmap

Status: TypeScript target, 2026-09-24. This supersedes the native Go plugin roadmap;
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
M1–M2 and the scripted recovery path for M3 are largely in tree, as are the
executor contract and the packaged GitHub executor (qualified against a fake
server). Live Pi recovery admission, the coding-agent child protocol, executor
recovery, and M4 remain outstanding.
