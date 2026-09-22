# Minimal hello graph example

Status: TypeScript hello bundle under [`plugins/hello`](plugins/hello/); durable
`graphloom run` arrives in later tickets.

[task.yaml](task.yaml) selects `hello`, the repository, and the request. The
source-repairable bundle includes TypeScript graph/validators, tests, manifest,
and build outputs (`@graphloom/plugin-hello`).

```sh
npm test -w @graphloom/plugin-hello
```

After the controller runtime is implemented, prepare a disposable repository:

```sh
git init test-repo
git -C test-repo -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit --allow-empty -m "Initialize hello fixture"
graphloom run task.yaml
```

Write requires exact bytes `Hello, GraphLoom!\n` at `GREETING.txt` only; Review is
an independent required stage. See
[design §11](../docs/design-typescript-core.md#11-minimal-example-and-verification).
