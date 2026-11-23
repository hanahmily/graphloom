# Run hub monitoring UI research

Research date: 2026-11-19 (workspace date). Status: research and proposed choices;
no monitoring UI or dependency has been implemented by this note. Sources are
official documentation, source repositories, and their release metadata fetched
during this research. Version entries describe those observations; they are not
permanent claims about the latest release. No comparative performance benchmark
was run.

Updated recommendation after inspecting Troupe and HAPI: **shared semantic
panel snapshots, with a Troupe-inspired cell renderer for terminal/plain output
and a separate KaTeX adapter for native static colored HAPI messages**. ELK.js
remains the proposed complex-topology layout engine. The
[Troupe source analysis](troupe-monitoring-reference.md) explains its bespoke
canvas/chart code and the limits of its tree router. The cell frame is a useful
terminal/plain intermediate, not the universal representation for every host.

The earlier plain-only chat recommendation is superseded for HAPI's verified
Markdown rendering path. Native colored snapshots do not require screenshots
or HAPI changes; deployed delivery still needs an end-to-end check. Other hosts
use their verified capabilities, with plain output as the default fallback.
Ink remains an optional terminal shell, termcn an area-chart alternative, and
React Flow an optional browser inspector. MCP Apps are an optional future
interactive delivery route requiring host integration. The
[panel design](../design-monitor-panels.md) makes a full dashboard optional.
Nothing is installed or adopted by this research update.

## HAPI delivery evidence and boundaries

Read-only inspection of the local HAPI checkout at
`0cfc3b4ed2535cfa3a136d0cb837cd00d9655026` found the following. The three cited
files were unchanged relative to that commit when inspected.

| Surface | Verified evidence | Consequence for panels |
| --- | --- | --- |
| Assistant Markdown | `markdown-text.tsx` includes `remark-math` and `rehype-katex` in its renderer plugins. | A Markdown message can carry native KaTeX output without adding a HAPI component. |
| Code fences | `shiki.ts` loads a fixed language set including `diff`, and its `getLoadedLanguages()` guard falls back to plain text for unsupported languages. `ansi` is absent. | An `ansi` fence does not provide arbitrary terminal colors in this renderer. Diff syntax highlighting is not a general status-palette API. |
| Tool results | `_results.tsx` renders HTML-looking strings as code; Bash results also use code output. Other result views can use Markdown. | Returning HTML or KaTeX through an arbitrary tool result does not guarantee a rendered panel. Select a verified Markdown delivery path. |
| Interactive MCP UI | A tracked-source search in `web`, `shared`, `cli`, and `hub` found no `ext-apps`, `mcp-ui`, `AppBridge`, or `ui.resourceUri` references. | No existing MCP Apps integration was found in that inspected source scope. Do not assume interactive widgets work because ordinary MCP tools work. |

Pinned primary sources:
[Markdown renderer](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/components/assistant-ui/markdown-text.tsx),
[Shiki language guard](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/lib/shiki.ts),
[tool-result renderer](https://github.com/tiann/hapi/blob/0cfc3b4ed2535cfa3a136d0cb837cd00d9655026/web/src/components/ToolCard/views/_results.tsx).
The search is bounded evidence about this checkout, not a claim about all HAPI
versions, integrations or deployed configurations.

KaTeX documents `\textcolor`, `\texttt`, `array`, and `\boxed`, which provide
colored labels, aligned rows and borders for compact static panels. Use an
explicit palette and textual status labels. This is a host-specific serializer
of semantic data; it is not a general graph-layout or chart engine, nor a
promise of identical terminal-cell geometry. Long content, system-font fallback
and the absence of automatic line wrapping in display math need bounded output
and a plain fallback. [Supported functions](https://katex.org/docs/supported#style-color-size-and-font),
[rendering options](https://katex.org/docs/options)

During this investigation, a compact colored sample was checked in a browser
with KaTeX `0.16.27`, `trust: false`, and explicit colors; it produced zero parse
errors. That establishes a component-level rendering result. It does **not**
establish deployed HAPI message delivery, exact terminal-grid reproduction,
large-graph readability, or correctness in every chat host. The serializer
should escape data as text, emit a bounded supported subset, and require no
trust-dependent HTML or image commands. KaTeX defaults `trust` to false.
[Trust option](https://katex.org/docs/options)

For complex topology or usage history that exceeds a compact KaTeX panel,
render an explicitly scoped view plus ordinary text describing omitted context,
or use a complete plain adjacency/metric view. Keep edge identity, states,
timestamps and values in the shared snapshot. Do not force arbitrary topology
through a mathematical array or silently drop connections to fit it.

### Optional future interactive delivery

MCP Apps associate a tool with a `ui://` HTML resource through
`_meta.ui.resourceUri`; a supporting host fetches it, renders a sandboxed
interface, and handles communication. That can support interactive topology
selection and charts, but requires host support. It is separate from the
KaTeX static-message route. [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview),
[official API and host-support boundary](https://apps.extensions.modelcontextprotocol.io/api/)

`@mcp-ui/client` provides `AppRenderer` for MCP Apps hosts, distinct from its
legacy `UIResourceRenderer`. Adding a server-side UI resource alone cannot
install this host integration. Given the HAPI inspection above, this is a future
option, not a prerequisite for the user's native colored static panels.
[MCP-UI host components](https://github.com/MCP-UI-Org/mcp-ui)

## GraphLoom's topology target is already under implementation

The initial research read this monitor worktree at `85f66e5`, whose SDK only
declares ordered stages. The user corrected the target, and a read-only inspection
of `main` at `245283cd7f91dae44379a8f4747e2ca5ae1af1fb` confirmed the new
[SDK contracts](https://github.com/hanahmily/graphloom/blob/245283cd7f91dae44379a8f4747e2ca5ae1af1fb/packages/sdk/src/types.ts)
and [topology design](https://github.com/hanahmily/graphloom/blob/245283cd7f91dae44379a8f4747e2ca5ae1af1fb/docs/design-graph-topology.md).
The SDK includes directed edges, start/terminal nodes, supervisor-only entry,
normalization of legacy definitions, and a topology view with path and side visit.
Traversal integration is ongoing; this is not evidence of a fully shipped engine.

The target renderer must support branching and cycles, preserve all visible
incoming/outgoing edges, and overlay live path, current work and side visits
without confusing them. Do not count off-path or supervisor-only nodes as work
that every run must complete. Older runtimes get a labelled compatibility view;
their shape does not limit the new renderer. UI libraries consume the runtime's
topology and observations; they do not discover or authorize execution routes.

## Terminal UI candidates

The current [CLI package](../../apps/graphloom/package.json) declares no TUI
framework. [Progress](../../apps/graphloom/src/progress.ts),
[statistics](../../apps/graphloom/src/stats.ts) and
[watch](../../apps/graphloom/src/watch.ts) already supply text/JSON and categorized
reports. Watch batches moves over 60 seconds, emits quiet heartbeats after 15
minutes, and bounds reports to about 1 KB. The
[agent-skills design](../design-agent-skills.md#21-graphloom-watch) describes the
existing HAPI notification bridge. That is a reusable pattern, not evidence of a
working multi-run hub or host-independent chat delivery.

| Candidate | Verified properties | Project assessment |
| --- | --- | --- |
| Ink | React terminal renderer with Yoga/Flexbox layout; MIT. Observed npm version `8.0.0` requires Node >=22 and React >=19.3. | Optional interactive shell. The revised Troupe-inspired cell renderer can work without React; if Ink is used, it must own terminal redraw rather than compete with another screen writer. |
| OpenTUI | TypeScript over a native Zig renderer, with React/Solid bindings, scrolling and input components; MIT. Observed `0.9.3` supports Bun >=1.3.14 or Node >=26.4 with `--experimental-ffi`. | Credible current alternative for a richer full-screen terminal product. Adds native platform artifacts and FFI/runtime qualification. GraphLoom's bundled Node 26.13 meets the stated Node version; its documented source-development minimum of 22.19 does not. |
| Pi TUI | Differential terminal rendering, component-based text/layout, and main/alternate-screen modes in upstream docs; MIT. The inspected main-branch package is `1.5.0`, Node >=22.19. | Relevant TypeScript alternative if avoiding React matters. GraphLoom's lockfile already includes a nested `0.87.1` through Pi; that is not a public CLI dependency or proof the newer documented features exist at that pin. |
| Bubble Tea | Go TUI framework based on the Elm architecture, with terminal rendering and input support; MIT. | Credible terminal framework, but would add a Go executable/toolchain seam to a TypeScript product. No need for that change for the requested monitor. |

Ink: [project and layout model](https://github.com/vadimdemedes/ink),
[v8 package requirements/license](https://raw.githubusercontent.com/vadimdemedes/ink/v8.0.0/package.json),
[release history](https://github.com/vadimdemedes/ink/releases).
OpenTUI: [release-tagged introduction](https://raw.githubusercontent.com/anomalyco/opentui/v0.9.3/packages/core/README.md),
[runtime support](https://opentui.com/docs/getting-started/runtime-support/),
[release history](https://github.com/anomalyco/opentui/releases).
Pi TUI: [upstream package metadata](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/package.json),
[upstream renderer documentation](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/README.md),
[local lockfile](../../package-lock.json).
Bubble Tea: [official project](https://github.com/charmbracelet/bubbletea).
GraphLoom runtime comparison: [release pin](../../release/node.json) and
[supervisor engines](../../packages/supervisor/package.json).

`npm view` independently confirmed the current registry versions and engines for
Ink and OpenTUI during this research. Compatibility above is a requirements
comparison, not a successful GraphLoom packaging or interactive-terminal test.
Neither library derives graph topology from GraphLoom state; the application must
provide that projection and draw it or use a separate graph renderer.

## A terminal/chat topology bridge: beautiful-mermaid

`beautiful-mermaid` offers `renderMermaidASCII` for Unicode/ASCII text and
`renderMermaidSVG` for SVG without a DOM. It is a renderer, not a live monitor or
TUI interaction framework. Its package is MIT and depends on ELK.js and entities;
ELK's separate license remains relevant. The ASCII implementation has its own
grid/routing pipeline; do not assume the SVG layout and terminal layout are
identical. [Project/API](https://github.com/lukilabs/beautiful-mermaid),
[package metadata](https://raw.githubusercontent.com/lukilabs/beautiful-mermaid/main/package.json),
[ASCII implementation](https://github.com/lukilabs/beautiful-mermaid/blob/main/src/ascii/index.ts).

The registry reported `1.1.3`, which was the version smoke-tested. The observed
GitHub Releases page called `1.1.2` latest; this is why a release-page label alone
is insufficient to select an npm artifact.
[Registry artifact metadata](https://registry.npmjs.org/beautiful-mermaid/1.1.3),
[GitHub releases](https://github.com/lukilabs/beautiful-mermaid/releases).

### Small local smoke test

Installed only `beautiful-mermaid@1.1.3` and its dependencies in a temporary
directory, with install scripts disabled; no repository dependencies changed.
Executed the published ESM entry on Node `26.13.0`. This tested three small inputs,
not rendering performance or full Mermaid compatibility:

| Input | Observed result |
| --- | --- |
| Three stages, left to right, English labels | Unicode and ASCII border output, no ANSI with `colorMode: none`; SVG also produced |
| Same stages plus labelled Review → Build return edge | Returned an image/string, but the terminal view merged the forward/return connection into a compact double-arrow segment; the return relation was hard to distinguish |
| Three stages with CJK labels | SVG produced; terminal labels exceeded the display width of their boxes |

The successful compact path was:

```text
┌─────────┐  ┌─────────────┐  ┌──────────────┐
│Plan done├─►│Build running├─►│Review pending│
└─────────┘  └─────────────┘  └──────────────┘
```

Reproduction inputs, with options `colorMode: 'none', paddingX: 2, paddingY: 1,
boxBorderPadding: 0`:

```text
graph LR
 A[Plan done] --> B[Build running] --> C[Review pending]
```

Add `C -.->|reentry| B` for the return-edge case. For the width case use:

```text
graph TD
 A[计划完成] --> B[实现执行中] --> C[审查等待]
```

Inspection of the published source found `.length`-based text placement in its
ASCII canvas and multiline utilities, consistent with the CJK result. This is a
local test finding; no claim is made about other versions, all Unicode characters,
or every possible terminal. `useAscii: true` changes drawing characters, not the
language of labels, so non-ASCII labels remain non-ASCII by design.
[Canvas source](https://github.com/lukilabs/beautiful-mermaid/blob/main/src/ascii/canvas.ts),
[multiline placement](https://github.com/lukilabs/beautiful-mermaid/blob/main/src/ascii/multiline-utils.ts).

Adoption should require narrow-terminal, Unicode-width, cycle/reentry and
unsupported-syntax cases. A compact stage strip is a legacy fallback, not the
target for the complex topology under implementation. The selected graph view
must preserve edges or explicitly report filtering; a complete adjacency list
is the narrow-width fallback. Stable node positions should not change on every
counter update; status labels and colors are overlays.

The official Mermaid v13 work also documents ASCII output, but it is separately
advertised as alpha in the current stable docs. Track it as a frontier option;
do not attribute those APIs to the stable Mermaid package without qualification.
[v13 ASCII design](https://github.com/mermaid-js/mermaid-v13/blob/mermaid-v13/v13/docs/ascii.md),
[stable Mermaid documentation](https://mermaid.js.org/syntax/flowchart.html).

## Graph visualization candidates

The fit assessments below are recommendations for this project. Features and
licenses are linked to their owning sources. Browser canvas libraries do not
provide a terminal dashboard or delivery into an agent conversation.

| Candidate | Verified capabilities and layout | License | Fit for the run hub |
|---|---|---|---|
| React Flow with ELK.js for complex layout | React components as custom nodes; selection, zoom, pan, and configurable editing interactions. Automatic layout is supplied separately; ELK handles directed layouts, ports, node sizes, subflows, and routing. | React Flow MIT; ELK.js EPL-2.0. | Preferred optional browser inspector: stage cards with status, elapsed time, usage, and evidence links. Use ELK for the complex topology target and preserve positions across telemetry updates; a legacy chain can use fixed positions. |
| AntV G6 | Framework-independent graph engine with custom elements, nested groups called Combos, interaction behaviors, and built-in directed, force, and tree layouts. Some layouts support worker execution. | MIT. | Strong browser alternative for extensive grouping and graph analysis; does not itself supply reusable terminal/chat cell panels. |
| Cytoscape.js | Graph visualization and analysis, compound nodes, selectors, layouts, and a headless API. ELK and Dagre adapters are available as extensions. | Core and first-party extensions MIT; check separately selected extensions. | Good if dependency queries and graph algorithms become central. Headless operation computes graph data/layout; it does not draw terminal characters. |
| Sigma.js with Graphology | Sigma provides WebGL rendering and graph interactions. Graphology provides the data model, graph events, algorithms, and layout ecosystem. | Both MIT. | Appropriate for exploring large relationship networks across runs. Less direct than custom React stage cards for a single workflow's operational details. |
| Mermaid | Text-defined diagrams, styling, and automatic flowchart layout. Current v12 docs describe bundled ELK as the default, with Dagre selectable. | MIT for Mermaid; bundled dependencies retain their own licenses. | Useful for portable snapshots in documentation or a chat host that supports Mermaid. A diagram block by itself does not subscribe to hub updates. Keep a plain-text fallback. |
| FlowGram | Workflow-development framework with fixed/free canvases, node forms, variable scopes, materials, and runtime integration. | MIT. | Credible newer AI-workflow tooling, but its authoring/runtime scope substantially exceeds a read-only hub monitor. Revisit if GraphLoom later needs a visual authoring product. |

React Flow sources: [custom nodes](https://reactflow.dev/learn/customization/custom-nodes),
[interaction API](https://reactflow.dev/api-reference/react-flow),
[layout comparison](https://reactflow.dev/learn/layouting/layouting),
[license](https://github.com/xyflow/xyflow/blob/main/LICENSE).
ELK sources: [layout engine and worker support](https://github.com/kieler/elkjs),
[EPL-2.0 license](https://github.com/kieler/elkjs/blob/master/LICENSE.md).

G6 sources: [features and license](https://github.com/antvis/G6),
[layout API](https://g6.antv.antgroup.com/en/api/layout/),
[Combos and tree-layout caveat](https://g6.antv.antgroup.com/en/manual/element/combo/overview).
Cytoscape.js sources: [official API, layouts, and license](https://js.cytoscape.org/).

Sigma and Graphology sources: [Sigma renderer](https://www.sigmajs.org/),
[Sigma license](https://github.com/jacomyal/sigma.js/blob/main/LICENSE.txt),
[Graphology capabilities](https://graphology.github.io/),
[Graphology license](https://github.com/graphology/graphology/blob/master/LICENSE.txt).
Mermaid sources: [flowcharts](https://mermaid.js.org/syntax/flowchart.html),
[layout behavior](https://mermaid.js.org/config/layouts.html),
[project and license](https://github.com/mermaid-js/mermaid).
FlowGram sources: [framework and license](https://github.com/bytedance/flowgram.ai),
[canvas, form, and variable architecture](https://flowgram.ai/guide/getting-started/introduction.html).

## Release and maintenance evidence

These are recent stable release records observed from the projects' GitHub APIs
and release pages, not installed or tested versions. Releases establish activity;
they do not guarantee maintenance quality or compatibility with GraphLoom.
Documentation can track a newer branch than a package, so implementation must
pin and verify the actual package chosen.

| Project | Observed release | Published (UTC) | Primary evidence |
|---|---|---|---|
| React Flow | `@xyflow/react@13.0.2` | 2026-11-17 | [Release](https://github.com/xyflow/xyflow/releases/tag/%40xyflow/react%4013.0.2) |
| ELK.js | `0.12.1` | 2026-10-28 | [Release](https://github.com/kieler/elkjs/releases/tag/0.12.1) |
| G6 | `5.1.1` | 2026-04-17 | [Release](https://github.com/antvis/G6/releases/tag/5.1.1) |
| Cytoscape.js | `3.35.0` | 2026-11-10 | [Release](https://github.com/cytoscape/cytoscape.js/releases/tag/v3.35.0) |
| Sigma.js | `4.0.6` | 2026-11-10 | [Release](https://github.com/jacomyal/sigma.js/releases/tag/sigma%404.0.6) |
| Graphology | `0.26.0` | 2025-02-08 | [Release](https://github.com/graphology/graphology/releases/tag/0.26.0) |
| Mermaid | `12.3.0` | 2026-11-03 | [Release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.3.0) |
| FlowGram repository | `1.0.16` | 2026-10-13 | [Release](https://github.com/bytedance/flowgram.ai/releases/tag/v1.0.16) |

Graphology's older core release does not establish abandonment; it is a separate
data-model dependency with its own release cadence. FlowGram is a monorepo, so
its repository tag does not promise that every package shares that version.
Mermaid's documentation advertises a v13 alpha separately; preview features
should not be assumed to exist in the stable v12 package.
[Graphology repository](https://github.com/graphology/graphology),
[FlowGram packages](https://github.com/bytedance/flowgram.ai/tree/main/packages),
[Mermaid documentation](https://mermaid.js.org/syntax/flowchart.html).

## Practical selection boundaries

1. **Keep terminal and chat first.** The browser candidates above are optional
   inspection surfaces. Their graph renderers do not solve terminal repainting,
   cursor restoration, non-TTY output, event delivery, or agent notification.
   All surfaces should consume the same versioned, timestamped projection of
   controller facts and hub scheduling state.
2. **Use React Flow only for a browser view.** Its custom components and
   interaction controls fit a selectable, read-only stage diagram. Disable graph
   editing while preserving keyboard access and drill-down. Its documentation
   recommends controlling unnecessary rerenders and collapsing large trees;
   neither rich HTML nodes nor a WebGL label guarantees a particular scale.
   [React Flow interaction API](https://reactflow.dev/api-reference/react-flow),
   [performance guidance](https://reactflow.dev/learn/advanced-use/performance).
3. **Use layout appropriate to the declared graph.** ELK is the proposed
   geometry engine for complex topology; it is not a renderer. The terminal
   adapter must qualify routing after conversion to character cells, and preserve
   all visible directed edges. A compact legacy chain can bypass general layout.
   [ELK.js](https://github.com/kieler/elkjs),
   [React Flow layout guidance](https://reactflow.dev/learn/layouting/layouting).
4. **Preserve the operator's mental map.** As a project design choice, update
   status and usage without relaying out unchanged topology. Recompute positions
   on expansion or structural changes. Do not make a node jump every time a token
   count arrives. Bound attempt history and expose older attempts on demand.
5. **Benchmark representative traces before adopting a scale claim.** Include
   long labels, many attempts, recovery, nested jobs, and frequent status updates.
   Measure layout time, redraw time, and interaction latency separately. Sigma's
   WebGL focus motivates considering it for large networks; it does not establish
   that it is faster for GraphLoom's stage-card workload.
   [Sigma architecture](https://www.sigmajs.org/).
6. **Treat chat diagrams as snapshots.** Include run ID, snapshot timestamp,
   current stage/attempt, live path, acceptance, slot state, and any action needed
   in ordinary text. Use KaTeX for compact colored HAPI messages through its
   verified Markdown path, with a plain fallback. This host-specific layout
   shares semantic data with the terminal renderer, not necessarily its cells.
   Mermaid support and versions also belong to the host; neither a Markdown
   code fence nor an MCP tool automatically creates an interactive view. A
   snapshot must remain useful when its richer rendering is unavailable.

The optional browser recommendation is **React Flow with ELK for complex layout**.
G6 and Cytoscape are credible alternatives if graph analysis becomes a primary
requirement; Sigma addresses a different visualization workload. This selection
does not require expanding the local-daemon scope into a network service.
