# Graphs are native Go plugins

> Superseded by the [TypeScript design](0002-typescript-repairable-plugins.md). The content below
> records the earlier native Go direction and is retained for historical context.

Accepted direction, 2026-09-22; implementation pending. GraphLoom graphs are
user-authored Go `.so` plugins because the domain harness needs executable code
for agent tasks, checks, and routes. Task YAML selects the graph; the supervisor
owns exceptional recovery routing and the controller owns admission and durable
execution. Recovery decisions do not need plugin-specific handlers or plugin veto;
required outcomes and checks remain pinned. This avoids making unforeseen failures
depend on a complete catalog of coded repair routes.

This replaces file-described graphs and supervisor-authored normal routing. The
public SDK must support independent plugin modules. Native loading requires a
matching host build profile, trusted installed code, and pinned bundles on resume;
Linux is the initial target. See the [core design](../core-design.md).
