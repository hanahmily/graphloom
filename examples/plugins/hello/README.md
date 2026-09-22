# Hello TypeScript graph plugin

Source-repairable Write → Review bundle for GraphLoom. Implements the public
`@graphloom/sdk` `GraphPlugin` / `Validator` contracts as ordinary TypeScript.
The controller owns Accept; this plugin only Dispatches, Observes, Validates,
Reenters, Supervises, or Stops.

## Layout

```text
examples/plugins/hello/
  package.json
  tsconfig.json
  graphloom.manifest.json
  src/graph.ts          # describe + advance
  src/validators.ts     # exact greeting + independent review
  src/constants.ts
  src/index.ts          # createGraph() export for plugin-host
  test/hello.test.ts
  dist/                 # build output
```

## Behavior

| State | Action |
|---|---|
| Compatible task, no writer yet | Dispatch writer (`writeScope: GREETING.txt`) |
| Writer done, no observations | Observe file bytes + workspace manifest |
| Observed bytes/scope OK | Validate Write |
| Missing newline / unrelated paths | Dispatch bounded correction (then Supervise if repeated) |
| Write receipt present | Dispatch read-only reviewer |
| Review approved | Validate Review |
| Review request_changes | Reenter Write |
| Unfamiliar failure | Supervise |
| Incompatible task / exhausted budgets | Stop |

Required bytes: `Hello, GraphLoom!\n` at `GREETING.txt` only.

```sh
npm run build -w @graphloom/plugin-hello
npm test -w @graphloom/plugin-hello
npm run manifest -w @graphloom/plugin-hello   # refresh digests after source/lock changes
```

The bundle ships `package-lock.json`, pinned toolchain (`typescript`/`vitest` as
devDependencies), and `graphloom.manifest.json` digests for source/lock inputs.
`@graphloom/sdk` is linked via a relative `file:` dependency for isolated rebuild
inside this monorepo.

Authoritative contracts: [design §3](../../../docs/design-typescript-core.md#3-plugin-package-and-trust)
and [§11](../../../docs/design-typescript-core.md#11-minimal-example-and-verification).
