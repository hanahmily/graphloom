# Historical Go implementation

The TypeScript packages under `/packages` and `/apps` are the current target.
This tree retains the earlier Go host (graph advancer + harness loop) from issues
#2–#3 for reference and selective test porting. It is not built or tested by CI.

```sh
cd legacy/go
go test ./...
```

Do not extend this tree for new MVP features; implement against
`docs/design-typescript-core.md` instead.
