# Troupe as a monitoring renderer reference

Researched 2026-11-19 against Troupe commit
[`c844a457132be4a87c12c3a6007d151ddacd96dc`](https://github.com/hitianqi/troupe/commit/c844a457132be4a87c12c3a6007d151ddacd96dc),
whose package identifies itself as `troupe-cli` 0.7.0. This is source inspection,
not a rendering benchmark or a claim that its code has been integrated into
GraphLoom. No Troupe scripts were run and no source code was copied.

The user clarified that complex GraphLoom topology is already under
implementation. That is the target of this research; a serial stage strip is
not an adequate replacement.

## Finding

Troupe supplies a useful **implementation reference**, rather than an
installable panel/chart component library. It renders the interface itself in
TypeScript, with no runtime npm dependencies. Its package exposes the `troupe`
CLI and contains only Node type definitions and TypeScript as development
dependencies. It does not use Ink, termcn, React, ELK, or another graph/chart
library. [Package manifest](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/package.json)

The reusable idea is a character canvas with semantic style runs for terminal
frames and plain snapshots. Subsequent HAPI inspection supersedes the earlier
plain-only chat recommendation: native static colored panels can use its
existing KaTeX Markdown path, with a separate serializer. Shared semantic panel
data is the primary cross-host contract; a cell frame is not universal.
Complex graph placement and routing remain separate; Troupe's specialized
dependency-tree layout does not solve that general case. The
[HAPI delivery evidence](run-hub-monitoring-ui.md#hapi-delivery-evidence-and-boundaries)
records the source inspection and bounded browser check.

## What draws each part

| Part | Troupe implementation | What GraphLoom can take from it |
| --- | --- | --- |
| Panel borders and text | `Canvas` stores a grid of styled cells; `put`, `runs`, and `box` draw into it; `lines()` produces styled text runs. | A small, pure rendering primitive shared by all panels. |
| Terminal updates | `Screen` turns runs into colored cells; `full` and `diff` serialize full frames or changed cells. | Keep terminal transport separate from panel rendering. |
| Topology | `flow` places role boxes and dependency/reviewer lanes directly on the canvas. `wire` merges box-drawing junctions. | Node styling, visible edge states, selection, and cell drawing. |
| Token history | `Motion` samples output-token deltas and draws Braille sparklines. | Compact per-node activity history, separate from exact values. |
| Event history | `logPage` draws a small Braille event-rate strip. | A concise activity indicator alongside events. |
| Interaction | Hit rectangles come out of drawing; input transitions produce explicit effects. | Selection can remain separate from effects such as cancellation. |

Sources: [canvas.ts](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/canvas.ts),
[screen.ts](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/screen.ts),
[draw.ts](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/draw.ts),
[motion.ts](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/motion.ts),
[panel-input.ts](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/panel-input.ts).

### Panels and output

`Canvas` separates geometry from output encoding: its `Line[]` representation
contains text and optional style, rather than escape sequences in every
string. `paint` emits ANSI; `textOf` emits text. Wide characters occupy two cells
and combining marks are attached to preceding cells. This already addresses
the basic CJK-width problem found in the earlier beautiful-mermaid experiment.
The width implementation uses hand-maintained code-point ranges, so it is not
evidence of complete grapheme-cluster or emoji-sequence support.
[Canvas source](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/canvas.ts)

The live transport uses the alternate screen, raw input, mouse reporting, and
synchronized terminal updates. It polls model data every two seconds and
animates at a 40 ms interval only while motion is active. `--once` or non-TTY
input/output takes a snapshot path; `--plain` removes styles. These are useful
seams for GraphLoom's terminal and chat outputs, but its fullscreen loop should
not be embedded into a chat session.
[Panel lifecycle](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/panel.ts#L62-L225)

### Topology: attractive, but specialized

Troupe's dependency ordering is deterministic for a fixed role list. It visits
roots in plan order and places a dependent after the last prerequisite that
has been placed. That prerequisite becomes the one visual parent. A role can
name several dependencies, but this representation is a tree projection rather
than a general all-edges graph. Its role checker rejects dependency cycles;
the renderer's defensive fallback puts otherwise unplaced roles at the root.
[Validation and tree ordering](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/plan.ts#L168-L242)

`flow` uses fixed-height boxes, fixed indentation and explicit orthogonal
segments. It labels all prerequisites but draws the selected parent edge. One
reviewer can occupy a side lane connected to each reviewed builder; multiple
reviewers or a narrow terminal move reviewers below the builders. The `wire`
function merges shared stems into Unicode junctions. Status changes alter
styles without changing role placement; width or structure changes can change
placement. There is no incremental layout cache or general graph router here.
[Flow renderer](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/draw.ts#L542-L688)

For GraphLoom, preserve every declared edge and its meaning from the topology
contract. A fan-in with three prerequisites needs three discoverable edges,
not one parent arrow plus a dependency label. Branches, cycles, live paths and
supervisor-only nodes should be represented according to GraphLoom's actual
contracts, rather than translated into Troupe's builder/reviewer roles.
Conditional labels or parallel groups must not be invented where the source
contract does not declare them. This is a recommendation derived from the
difference in domain models, not a claimed Troupe capability.

### Charts: sparklines, not an area-chart package

`Motion.sample` derives tokens/second from cumulative output-token counts and
elapsed time. It retains 64 samples, ignores intervals shorter than one second,
and resets the counter baseline when the count falls. The renderer maps a rate
to `rate / (rate + 40)`, then draws two samples per Braille character, with at
least one dot per column. It is a compact activity indicator with a nonlinear
scale. `Motion` stores this history in the viewer, rather than obtaining a
durable time series from the service.
[Sampling and scaling](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/motion.ts#L17-L66),
[sparkline rendering](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/motion.ts#L180-L188)

The event strip counts events in 48 buckets of 15 seconds, caps each bucket's
visual value, and renders Braille cells. It is another specialized sparkline.
The inspected code does not provide a general multirow area chart with axes,
numeric scales, arbitrary series or stacking.
[Event strip](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/draw.ts#L1156-L1200)

For a GraphLoom resource panel, keep exact values, units and sample timestamps
in its data contract. Implement a small Braille or block-cell chart primitive
over that data, using a visible scale for quantitative area charts. Preserve
missing samples as gaps, distinguish zero from unavailable, and bucket by time
instead of assuming every poll arrived on schedule. Sampling belongs in the
monitoring data layer so opening a chat panel does not reset its history.

## Coupling and reuse boundary

Troupe's `modelOf` is a pure projection into `PanelModel`, but that model is
mission-specific: roles, gates, stages, plans, git work, results and agent
screens are all included. The reader acquires missions, workflow stages and
live role state, including tmux-related data. Its main `draw.ts` is a single
1,433-line file at the inspected commit, with private functions for multiple
pages. These are not independently published panel APIs.
[Model](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/model.ts),
[reader](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/panel-model.ts),
[drawing module](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/draw.ts)

The live panel also performs effects: refresh flushes queued approval answers
and delivers notices, while user input can send messages or answer gates. A
GraphLoom monitoring renderer must remain a read-only consumer; command
adapters should separately issue authorized hub operations.
[Refresh and input dispatch](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/panel.ts#L146-L194),
[panel effects](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/src/panel-actions.ts)

Recommended GraphLoom seam:

```text
hub/controller observations + topology + metric samples
                         |
                 typed panel snapshot
                  /                   \
       terminal/plain adapter      HAPI KaTeX adapter
      styled cells + hit targets   compact native layout
             /       \                    |
         ANSI host   plain text     Markdown message
       input, diff    fallback      static colored panel
```

Each panel receives only its own data: topology, run overview, usage, events, or
job detail. A terminal layout may compose them, but no renderer requires the
whole dashboard. JSON remains available to agents that need semantic data
rather than the human visual. HAPI's native colored snapshot has its own layout;
it need not reproduce the terminal grid. A plain representation remains available
for unsupported hosts and failed rendering. Interactive embedding is separate
and host-specific; neither ANSI output nor a native static panel automatically
creates an interactive widget.

## HAPI follow-up: native colored snapshots

The inspected local HAPI source at
`0cfc3b4ed2535cfa3a136d0cb837cd00d9655026` enables `remark-math` and
`rehype-katex` for Markdown. Its fixed Shiki language set includes `diff` but
does not include `ansi`; unsupported code languages fall back to plain text.
Its tool-result renderer also displays HTML-looking strings as code, and some
tool views force code output. Therefore the colored panel should arrive as
Markdown on a verified path, not as ANSI escapes or returned HTML.
[Markdown source](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/components/assistant-ui/markdown-text.tsx),
[Shiki source](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/lib/shiki.ts),
[result-rendering source](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/components/ToolCard/views/_results.tsx)

KaTeX supports `\textcolor`, `\texttt`, `array`, and `\boxed`; these can express
compact colored labels, rows and borders. A browser sample using KaTeX
`0.16.27`, `trust: false`, and explicit colors produced zero parse errors during
this investigation. This is component-level evidence, not a full deployed-HAPI
delivery test or proof of terminal-grid fidelity. The intended route requires
no screenshots or HAPI changes. It does require bounded content, escaped labels,
and a plain fallback. KaTeX supplies text layout, not arbitrary graph routing or
a general area-chart engine. [Functions](https://katex.org/docs/supported#style-color-size-and-font),
[options and trust behavior](https://katex.org/docs/options)

Tracked-source searches in HAPI's `web`, `shared`, `cli`, and `hub` found no
`ext-apps`, `mcp-ui`, `AppBridge`, or `ui.resourceUri` integration. MCP Apps remain
an optional future route for interactive panels, requiring the host to fetch and
render a declared UI resource and handle communication. `@mcp-ui/client`'s
`AppRenderer` is a possible host component, not something GraphLoom can activate
merely by returning HTML. [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview),
[host-support boundary](https://apps.extensions.modelcontextprotocol.io/api/),
[MCP-UI components](https://github.com/MCP-UI-Org/mcp-ui)

## Concrete recommendation

1. **Share semantic panel data; use Troupe as the terminal reference.** Build
   small pure GraphLoom cell renderers for terminal/plain output and a separate
   HAPI KaTeX serializer for native static color. Do not add `troupe-cli` as a
   dependency or copy its mission application.
2. **Keep the terminal host independent.** Ink can still provide the optional
   interactive shell, but it is not required to draw these panels. Choose one
   owner for redraw/input; do not nest Troupe-style fullscreen control inside
   Ink or an agent chat renderer.
3. **Use a real layout step for complex topology.** ELK remains a candidate
   from the earlier library research. Give it measured cell-based node sizes,
   then draw its positions and routes on the canvas. Validate the resulting
   cell routing; naively rounding continuous coordinates can merge distinct
   edges. Cache geometry by topology, viewport and label-size revision so
   telemetry changes do not move nodes.
4. **Draw charts as independent primitives.** A small Braille sparkline covers
   per-node activity; a separate area-chart renderer handles numeric scales,
   gaps, labels and multiple rows. Troupe does not supply the latter. termcn
   remains an alternative to evaluate if its area-chart API proves easier to
   maintain; it is not needed merely to match Troupe's sparklines.

These are implementation recommendations, not completed dependency choices or
an assertion that GraphLoom already has these rendering modules.

## Verification to carry forward

Troupe has source-level tests for Chinese labels and hit targets, box closure,
parallel roots, reviewer lanes, narrow layouts, deep chains, wide-character
overwrites, differential output and rate sampling. Those tests were read,
not run. [Drawing tests](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/tests/draw.node.mjs),
[screen and sample tests](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/tests/screen.node.mjs)

GraphLoom should additionally verify all-edge preservation through branching
and joins; readable cycle/reentry edges; stable placement during status
updates; no edge crossings through node interiors; Unicode grapheme handling;
bounded snapshots at narrow chat widths; correct chart scale and missing-data
behavior; and consistent semantic state across plain and terminal output.
For HAPI, also verify a real message through the deployed Markdown path,
escaping, narrow widths, dark/light contrast, unsupported-glyph fallback and
the exact semantic values in KaTeX versus plain output. Do not require pixel-
or cell-identical layouts across these renderers.

The repository is MIT licensed. If actual source is later copied or adapted,
retain the copyright and license notice and follow GraphLoom's third-party
notice convention. This note alone introduces no vendored code.
[Troupe license](https://github.com/hitianqi/troupe/blob/c844a457132be4a87c12c3a6007d151ddacd96dc/LICENSE)
