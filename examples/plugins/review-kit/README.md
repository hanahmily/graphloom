# review-kit

The pull-request review machinery that the review graphs share
([design-pr-review-split.md §2](../../../docs/design-pr-review-split.md#2-two-graphs-two-plugins)).
It is a plain source tree, not a package: each plugin that uses it carries a
byte-identical copy in its own `src/kit/`, so the copy is inside the plugin's
manifest digest and a qualified repair in one plugin's run cannot change another
plugin.

Consumers: `pr-review` (`examples/plugins/pr-review/src/kit/`) and `pr-design-review`
(`examples/plugins/pr-design-review/src/kit/`).

## Changing the kit

1. Edit `src/` here, never a plugin's `src/kit/` copy.
2. Copy it into each consumer: `npm run vendor -w @graphloom/plugin-pr-review` and
   `npm run vendor -w @graphloom/plugin-pr-design-review`
   (runs `vendor.mjs`, which replaces the plugin's `src/kit/`).
3. Rebuild and regenerate each consumer's manifest:
   `npm run build -w <plugin> && npm run manifest -w <plugin>` for each.

Each consumer's `test/kit-drift.test.ts` fails, naming the file, when its copy
differs from `src/` here. The kit is tested through its consumers' suites.

## What it holds

Fetch (the snapshot reads, the head checkout, the base export, the principles
read), the ledger (v2 layout, section reads and compare-and-swap writes, the v1
migration), the change report (template, detectors, briefing, claim check,
diagrams, large mode, Markdown rendering, part-set writes), the measurements and
coverage with their recomputation (`metrics/`), symbol extraction, searches and
test mapping, the profile parser, and the `task new` plan (`taskplan.ts`). It
also holds the post of one review (`post.ts`: the item and head markers, the
reconcile before posting and the read-back of comment ids), the published-review
ledger write (`PUBLISHED_WRITE`, `publishBaselines` in `ledger.ts`), the item
text parts (`answertext.ts`), the secret scan, the treemap and the attempt
bookkeeping.

Where the two graphs differ, the kit takes a parameter: `parseProfile(config,
graph)` (the design review accepts `pr-review`'s keys unread, refuses `rounds`
and reads `comments.designPassedNote`), `requestedPull(request, profile, graph)`,
the head marker a post carries (`PostSpec.marker`), `metrics.staticOnly` (set by
the design review's parser: complexity and nesting only, hotspots by complexity
then nesting), `groundworkState({ perSymbol })` and the ledger write's commit
message.

The kit expects its consumer's bundle to provide `tools/gometrics/` and the built
entry `dist/metrics/tsmetrics-cli.js`, and, for coverage (`pr-review` only),
`tools/cover/` and `dist/metrics/tscover-cli.js`, which its commands run from the
plugin root.
