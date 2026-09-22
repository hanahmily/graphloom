# Minimal hello graph example

Status: target example for the [TypeScript design](../docs/design-typescript-core.md);
implementation pending. Existing Go and file-described examples remain migration
fixtures.

[task.yaml](task.yaml) selects `hello`, the repository, and the request. The target
bundle is `plugins/hello/`, containing TypeScript source, validators, tests, locked
build inputs, generated manifest, and compiled JavaScript. Bundle preparation is
separate from run startup. The old [native plugin contract](plugins/hello/README.md)
is historical.

After the target runtime is implemented, prepare a disposable repository:

```sh
git init test-repo
git -C test-repo -c user.name=GraphLoom -c user.email=graphloom@example.invalid commit --allow-empty -m "Initialize hello fixture"
graphloom run task.yaml
```

The controller creates an isolated worktree. Write produces GREETING.txt with
exact bytes `Hello, GraphLoom!\n`; the host observes bytes and all changed paths,
and requires independent Review before completion. Source files remain untouched;
there is no automatic commit, push, or merge.

The [release scenarios](../docs/design-typescript-core.md#11-minimal-example-and-verification)
include normal success, output repair, unfamiliar execution failure, and a buggy
validator repaired and activated within the same run. Both required stages and
the shared eight-attempt correction budget remain in force.
