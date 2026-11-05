# Contributing to GraphLoom

Thank you for helping. This page covers how to build, test, and propose a change.
Before architectural work, read the [README](README.md), the
[TypeScript core design](docs/design-typescript-core.md), and the project
vocabulary in [CONTEXT.md](CONTEXT.md). [AGENTS.md](AGENTS.md) describes the
packages and working rules, and is the file coding agents read first.

## Build and test

GraphLoom needs Linux, Node.js 22.19 or newer (CI pins a specific Node release),
Git, and util-linux `flock`.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`npm run typecheck` checks test files too. `npm test` runs the whole suite and
`npm run check:headers`, so it is heavy: while working, run the tests of the
package you changed, for example `npx vitest run <file>` inside that workspace,
and run the full suite once before you open the pull request.

## Source headers

Hand-written `.ts`, `.js`, `.mjs`, and `.sh` files start with the two-line SPDX
header (after any shebang). Add it to new files with:

```sh
node scripts/check-headers.mjs --fix
```

Markdown files and vendored directories are not header-checked.

## Example plugins

After you edit an example plugin's sources, regenerate its manifest:

```sh
npm run manifest -w examples/plugins/<plugin>
```

## Pull requests

1. Open an issue first for anything larger than a small fix, so the approach can
   be agreed.
2. Branch from `main` and keep the change to one purpose. Add or update tests that
   show the behavior; documentation-only changes need consistent links and
   formatting.
3. Follow the commit style of `git log`: a short `type(scope): summary` subject
   and a body that says why.
4. Open a pull request against `main` and describe what changed and how you
   verified it. Do not rewrite shared history.

Design decisions live in the documents under [docs/](docs); change the design in the
same pull request as the behavior it describes. By contributing you agree that your
work is licensed under the [Apache License 2.0](LICENSE).

## Conduct and security

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public
issues.
