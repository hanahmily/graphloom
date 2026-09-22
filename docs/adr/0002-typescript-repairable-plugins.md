# TypeScript graphs with qualified source repair

Accepted direction, 2026-09-22; implementation pending. GraphLoom uses TypeScript
for its controller, SDK, and executable graph plugins, replacing the native Go
plugin direction in [ADR 0001](0001-native-graph-plugins.md). Repairable plugins ship
source, readable requirements, locked build inputs, and tests; plugins run in
separate processes so the supervisor can coordinate tested, independently reviewed
repairs and recorded same-run activation without changing required outcomes.

Controller-owned acceptance separates evidence admission from potentially broken
normal routing. Opaque implementations retain explicit recovery limits. The
[current design](../design-typescript-core.md) owns the full contract.
