# GraphLoom implementation roadmap

Status: TypeScript target, 2026-09-22. This supersedes the native Go plugin roadmap;
existing Go source remains available during migration.

The authoritative scope and completion criteria are in the
[implementation plan](design-typescript-core.md#12-implementation-plan), with
[release scenarios](design-typescript-core.md#11-minimal-example-and-verification).

1. **M1:** TypeScript SDK, source bundle, and isolated plugin process.
2. **M2:** Durable Write → Review execution and controller-owned acceptance.
3. **M3:** Supervisor recovery without plugin-specific repair handlers.
4. **M4:** Qualified plugin/gate repair, same-run version transitions, and local release.

These milestones describe work to implement, not completed runtime capabilities.
