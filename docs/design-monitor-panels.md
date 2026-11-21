# Reusable monitoring panels

Status: implemented in `packages/monitor`, with the owning-runtime adapter and
hub CLI in `apps/graphloom`. This refines the presentation part of the
[run hub design](design-run-hub.md#8-monitoring). Panels are read-only and require
no dashboard or new controller scheduling authority.

The [throwaway panel prototype](../apps/graphloom/prototype-monitor-panels/README.md)
remains available for comparison. Production tests exercise all eight panels,
text/ANSI/JSON/Markdown rendering, KaTeX parsing with trust disabled, quantitative
charts, complex ELK routing and adjacency fallback. Actual HAPI assistant/tool/
notification surfaces must be qualified separately; `auto` is plain by default.

The topology target is the work already under implementation on `main`, not the
older SDK in this monitor worktree. Reviewed at `245283cd7f91dae44379a8f4747e2ca5ae1af1fb`:
[topology design](https://github.com/hanahmily/graphloom/blob/245283cd7f91dae44379a8f4747e2ca5ae1af1fb/docs/design-graph-topology.md)
and [SDK contracts](https://github.com/hanahmily/graphloom/blob/245283cd7f91dae44379a8f4747e2ca5ae1af1fb/packages/sdk/src/types.ts).
SDK types and normalization are present there; traversal integration is separate
ongoing work. This document does not claim that the full engine has shipped.

## 1. Outcome

An operator or coding agent can request one monitoring panel: topology, stages,
jobs, activity, job details, usage, or output. Each panel works on its own. A
terminal viewer may arrange several panels together, while a chat reply may show
only the topology and the reason a run needs attention.

Reuse the monitor frame, panel projection, identity, and status semantics across
outputs. Render terminal panels as character cells with ANSI colors. Render chat
panels as Markdown, with **native static colors through HAPI's existing KaTeX
renderer** where that delivery surface is qualified. This requires no HAPI source
change, screenshot, browser capture, or MCP connection. Plain Markdown remains
the portable fallback. A cell frame is an intermediate for terminal/plain output;
it is not the data model for every renderer.

The distinction matters for review: a native colored chat report can combine a
small KaTeX status panel with a plain topology or chart detail block. It does not
promise arbitrary ANSI colors, identical cell geometry, a live updating message,
or an interactive dashboard. Complex graph relationships and metric values must
remain available even when the chat renderer cannot draw them legibly.

| Decision | Choice |
| --- | --- |
| Shared interface | Typed monitoring facts and independent panel projections |
| Terminal panels | Small GraphLoom cell renderer, inspired by Troupe; one owner of input/redraw |
| Complex topology layout | ELK.js, qualified through an orthogonal geometry-to-cell adapter |
| Area charts | Bounded GraphLoom cell primitive with numeric scales and gaps; Braille/block glyphs |
| HAPI colored messages | Separate bounded Markdown/KaTeX serializer using existing math support |
| Unknown chat hosts | Escaped plain Markdown and character diagrams or paginated adjacency |
| Live interactive chat | Optional future MCP Apps integration; requires supporting host code |

ELK.js and string-width are installed dependencies; KaTeX is a test dependency,
while the host renders emitted math. ELK.js is unmodified, with a version-specific
EPL-2.0 release-notice exception and upstream source reference. No Troupe code is
copied. The
[hub design](design-run-hub.md) owns scheduling, concurrency, process drainage and
continuation. This document owns what panels mean and how they are rendered and
delivered. Opening a panel has no execution effect.

## 2. What to take from the reference screenshot

The user supplied a terminal-style workflow screen with a role list, stage
checklist, activity feed, a large connected-node diagram, and a selected role's
details and output. Its useful structure is the independent panels and selection
relationship. The persistent tabs, decorative background, duplicated role/status
information, and full-screen arrangement are unnecessary for this request.

| Screenshot area | Proposed panel | GraphLoom meaning |
| --- | --- | --- |
| Task title and current phase | `overview` | Run identity, controller status, current stage/attempt, blocker or next eligible time; hub occupied/limit and queue state when managed |
| Flow diagram with API, web, store and review cards | `topology` | Declared directed graph, live path, visits and supervisor-only nodes; expand a node to inspect recorded jobs |
| Left stage checklist | `stages` | Required outcome, receipts, open attempt and path membership per node; distinguish off-path nodes and supervisor-only nodes |
| Left role list | `jobs` | Jobs and recorded sessions grouped by stage, with executor/harness and status; roles are labels, not independent persistent workers |
| Recent activity | `activity` | Bounded factual events: stage acceptance, reentry, supervisor activity, waiting, admission and stopping |
| Selected API role's goal, model, branch and files | `job` | Selected operation's instruction summary, stage/attempt, harness, declared scope, available workspace/evidence and session references |
| Context bar, token totals and rate | `usage` | Explicitly labelled budgets, reported input/output/cache tokens, cost if available, context measurement if known, and sampled resource usage |
| Live agent window | `output` | Bounded user-visible messages, tool activity and logs for the selected operation; read-only |

The screenshot's repeated 25% appears to represent context usage, given the
selected role's context label. It must not become a task-completion percentage.
Similarly, its scope check mark is not something GraphLoom should infer merely
from a successful process exit or an agent's statement.

The monitor targets the complex topology under implementation. A branching graph
does not by itself mean simultaneous execution: node relationships and actual
running jobs are separate facts. The hub's limit still controls parallel runs;
within-run activity comes from the owning runtime rather than the diagram shape.

## 3. Complex topology and execution overlays

Consume the SDK's `GraphDefinition.stages`, `edges`, `start`, `terminal`, and
per-node `entry`/`maxVisits`, normalized by `normalizeTopology`. Do not invent a
second plugin topology declaration. Use `TopologyView.path` and `sideVisit`
plus owning-runtime visit observations as execution overlays. Stage IDs remain
stable node identities; attempts and visits identify execution history separately.

- Draw every directed edge in the selected view, including fan-in, fan-out and
  cycles. A dependency tree that chooses one parent per node is insufficient.
  Untraversed edges are declared possibilities, not activity.
- Distinguish the live path's tail from `current`: supporting work on an earlier
  node can change `current` without moving the path's tail.
- Mark supervisor-only nodes separately, with visit allowance where reported.
  They have no incoming declared edge. An observed supervisor entry is a labelled
  execution overlay, never a fabricated normal graph edge.
- Keep receipt validity, open attempt, path membership and active work separate.
  Off-path or unvisited branch nodes need not complete for the run to succeed.
  Display path acceptance and controller final status, not an all-nodes completion
  requirement. Existing aggregate stage counts can remain explicitly labelled
  inventory statistics.
- Show cycles on the static graph and visits in a separate history. A loop opens
  another visit of an existing node; it does not multiply definition nodes.
- Jobs expand beneath their owning node. Do not infer job dependencies or
  simultaneous execution from nearby timestamps or graph edges.

Use ELK.js as the layout engine, with an orthogonal layout adapter and
a character-cell rasterizer. ELK computes geometry, not terminal rendering. Supply
node sizes in cell-oriented units, allocate routing space, then validate rounded
positions, ports and bends for overlaps and crossings. Preserve each edge's
original direction, including return edges. A visual crossing must not imply a
semantic junction. The adapter validates cell routes and falls back when geometry cannot be
represented without ambiguity; integer rounding alone is insufficient.

Cache layout by topology identity, dimensions and expansion state. Token samples,
status changes and focus movement should not make nodes jump. Use a scrollable
viewport and selected-node neighbourhood for dense graphs, with explicit counts
of hidden nodes/edges and a complete, paginated adjacency-list fallback. Page
cursors identify the topology revision and selection; a changed revision starts
a new view rather than silently mixing pages. Keep the selected node and its
incoming/outgoing edges discoverable at narrow widths. A page names omitted
counts and how to retrieve the rest; message limits never silently delete edges.

For definitions without explicit edges, use the SDK's implicit chain. Its many
normalized back edges may be folded into a labelled reentry summary by default,
and expanded for a selected node. An older runtime without topology observations
gets a labelled legacy stage view and unknown traversal fields. This fallback
does not constrain the target diagram to a linear strip.

An illustrative compact text rendering of the designed issue-fix topology:

```text
fix-14169 · issue-fix · running · observed 12:21:05 UTC
Declared: Fix -> Review; Review -> Fix
Supervisor-only: Arbitrate -> Fix, Review
Live path: Fix #3 -> Review #3
Current work: Review #3 · side visit: none
```

The full panel draws these nodes and edges; the compact form preserves their
meaning where the available width cannot show the diagram legibly.

## 4. One monitor frame, independently rendered panels

```text
Controller state, runner/harness telemetry, hub queue
                         |
           MonitorSnapshot (monitor frame)
                         |
            select panel(s) and operation
                         |
               semantic panel projection
                /          |           \
              JSON      cell frame    chat layout
                         /    \        /     \
                       ANSI  plain  Markdown KaTeX
```

A monitor frame (`MonitorSnapshot` on the wire) contains a schema version, stable
run/submission identity, observation time, controller revision, hub observation
identity when applicable,
and per-source availability/freshness. A group of panels uses the same frame.
Controller state and hub/process samples are not a single atomic transaction;
preserve their source timestamps and mark unavailable or stale fields. A fresh
poll is not evidence of meaningful graph progress. The frame describes monitoring
state; it is not a job observation or new acceptance evidence.

Keep the initial panel catalog closed and small. A typed panel request names its
kind, run, optional stage/operation and bounded detail level. It produces a
discriminated panel value, not arbitrary HTML, executable plugin widgets, or a
generic dashboard layout language. The value carries its kind, frame identity,
source revisions, title and typed content. A renderer receives that value plus
width and supported output capabilities; it does no fetching or scheduling.

The proposed seam is a new `packages/monitor` module with a small, pure interface:

```text
projectPanels(frame, selection) -> panels
renderPanels(panels, renderOptions) -> renderedReport
```

The first call selects and derives facts once. The second handles layout,
escaping, width/size budgets and capability fallback. Its result names the frame,
requested/used renderer, any fallback reason, and the bounded output. Render
options describe format, width and a capability profile; they cannot change
reported values, units or status. JSON serializes the semantic panels without
ANSI or presentation markup. A KaTeX layout consumes those same panel values
directly, not an ANSI-to-TeX conversion. A formatting failure produces a plain
report from the same facts, not an empty success or a failed graph.

Cell drawing, chart layout and serializers are internal to this module. Shared
value/wire contracts belong in `packages/sdk`.
Owning-version controller observation code supplies the existing progress and
usage semantics; the hub adds queue and lifecycle facts. CLI code owns local
reads/socket access, watch subscriptions and live terminal input/redraw.
Host adapters own capability profiles and message delivery. Neither terminal
control, KaTeX runtime dependencies nor chat SDK dependencies enter the controller
or hub scheduler. The serializer emits supported math syntax; HAPI owns its
already-installed KaTeX runtime. No additional renderer service is required.

This seam can also serve standalone runs later: hub fields are absent when a run
is unmanaged. It does not require one watcher process per panel. Selecting
several panels shares one source subscription.

Selection is explicit and stable. A job panel names an operation ID and attempt;
it does not silently switch to another job when a stage retries. An optional
"follow current" selection is visibly labelled. Snapshot panels retain their
observation timestamp; a live view updates its frame and preserves selection.

## 5. Terminal and chat delivery

### Command interface

These commands are proposed extensions, not current CLI commands:

```sh
graphloom hub inspect <submission> --panel topology --format text
graphloom hub inspect <submission> --panel topology --format ansi
graphloom hub inspect <submission> --panel overview --panel usage --format markdown --chat-renderer katex
graphloom hub inspect <submission> --panel topology --format markdown --chat-renderer plain
graphloom hub inspect <submission> --panel job --job <operation-id> --format json
graphloom hub watch <submission> --panel topology
graphloom hub watch <submission> --panel activity --plain
graphloom hub watch <submission> --json
```

`inspect --format text|ansi|markdown|json` selects a snapshot serializer. The
default is `text`, with no escape sequences. `ansi` is an explicit opt-in for an
ANSI-aware consumer, including redirected output; it is never an inferred chat
format. `--chat-renderer auto|plain|katex` is valid only with `--format markdown`.
`auto` uses a verified delivery profile supplied by the host adapter; without one
it selects plain Markdown. `katex` is an explicit request for the static math
serializer, still subject to its content/size fallback. Merely running this
command inside HAPI or through MCP does not identify the destination renderer.

Allow repeated `--panel` to request a small composition from one frame. With no
panel selection, `hub inspect` returns the overview; a selected-run `hub watch`
starts with overview and topology. The hub-wide watch defaults to the run/queue
list with capacity. An interactive viewer may reveal other panels on selection,
but rendering a panel never requires opening that viewer.

`watch` owns live interaction: use an ANSI terminal view on a TTY, append-only
plain reports when redirected or with `--plain`, and bounded NDJSON with `--json`.
An initial snapshot precedes subsequent updates; reconnect resumes from a cursor
or reports an explicit gap and takes a new snapshot. `NO_COLOR` disables colors
in terminal and KaTeX output without removing status words. Ctrl-C detaches the
viewer, restores the terminal, and leaves runs running. The daemon itself emits
structured service logs and never starts a TUI.

### Terminal panels and area charts

Use [Troupe's rendering approach](research/troupe-monitoring-reference.md) as the
reference: a cell canvas, styled text runs, plain snapshot output, and a separate
terminal screen diff. Troupe is a CLI with bespoke rendering, not an installable
panel library. Its drawing code depends on its role/plan model; do not import the
whole application or its live terminal loop. Any copied primitive must retain
its MIT attribution and have an explicitly recorded source revision.

The revised preferred stack is a small GraphLoom panel/cell renderer plus ELK.js
for general graph layout. Ink can remain an optional interactive shell, but is
not required for the shared rendering module. Choose one owner of terminal input
and screen updates; do not mix Ink's redraw loop with Troupe's screen writer.
termcn area-chart components and React Flow remain alternatives for other
adapters, not requirements of this proposal. The
[library research](research/run-hub-monitoring-ui.md) records those alternatives
and the observed Unicode/return-edge limits of `beautiful-mermaid`.

For charts, follow Troupe's Braille technique for compact sparklines and implement
a bounded, labelled multi-row area primitive over the same canvas. Troupe does
not supply a general quantitative area-chart library. The GraphLoom primitive
needs explicit time/value scales, units, sample gaps and a baseline; zero values
must remain distinct from missing samples. In text mode provide the last value,
range and window beside the plot so it is useful even when glyphs render poorly.
Do not interpolate across telemetry gaps. Bucket high-frequency samples to the
available columns using a stated aggregation; rates use time-weighted values,
and the numeric summary retains the source range. A changed vertical scale must
be visible. Chart shape never substitutes for the numeric budget or rate.

### Native HAPI snapshots without changing HAPI

The inspected HAPI assistant Markdown renderer already registers `remark-math`
and `rehype-katex`. Its code-fence renderer does not interpret arbitrary ANSI,
and HTML returned through a tool is not an embedded application. Therefore the
colored path is a normal Markdown message containing bounded KaTeX, for example
`\textcolor`, `\texttt`, `array` and `\boxed`. Source inspection and the compact
browser proof are recorded in the
[HAPI delivery research](research/run-hub-monitoring-ui.md#hapi-delivery-evidence-and-boundaries).

The same semantic panel can use different geometry in chat. The initial profile
is deliberately hybrid: colored native headers and compact values, with ordinary
Markdown/code blocks for content that needs faithful text or many connections.

| Panel | Static colored chat representation | Detail/fallback |
| --- | --- | --- |
| `overview` | Run status, current stage, slot usage and blocker label | Full reason, next eligible time and identity as text |
| `topology` | Colored node/path summary; a small diagram only for qualified shapes and widths | Cell diagram or paginated declared adjacency, incoming/outgoing edges, path and supervisor overlay |
| `stages` | Compact status rows with stage names and visit/attempt labels | Requirements, receipt validity and long identifiers as text |
| `jobs` | Job state, owning stage and harness labels | Stable operation/session references and scope as text |
| `activity` | Event kind and concise status | Timestamp, factual reason and evidence references as text |
| `job` | Selected operation header and status | Instruction summary, paths, scope and evidence as text |
| `usage` | Numeric counters, budget fractions, rate with units/window | Plain cell area plot or numeric time-window summary; missing samples remain visible |
| `output` | Optional selected-job header | Bounded escaped plain messages/logs; output is never interpreted as math |

This profile does not claim a general colored KaTeX graph or area-chart engine.
For large graphs the diagram and adjacency carry equivalent relationships, not
identical geometry. Every edge remains retrievable. For charts the units, window,
last value, range and gaps survive even when a plot is omitted. Text status labels
such as `running`, `accepted`, `waiting` and `unknown` remain visible; palette
colors alone never establish status or acceptance.

A host profile records the renderer/version, actual delivery surface, tested
math subset, theme/width constraints and maximum message size. Qualify assistant
Markdown separately from tool results and background notifications. A successful
tool call or accepted message is not proof that its contents rendered. The current
proof uses KaTeX 0.16.27 with `trust: false`; deployed HAPI delivery, all eight
panels, light/dark themes, mobile widths and unsupported labels still need tests.
Unknown or incompatible profiles make `auto` choose plain Markdown. An operator
can explicitly request KaTeX for on-demand review without marking the host as
qualified for automatic delivery.

The serializer emits only a fixed command subset and treats every graph label,
reason and metric as data. Escape TeX metacharacters; do not allow labels to create
macros, links, HTML or resource requests. No `trust: true` setting is required.
Use a checked palette with theme-compatible contrast. Unsupported glyphs, excessive
nesting, parse failure, or an exceeded width/size budget select the plain fallback
from the same panel. Display math does not automatically wrap long content; do
not force a wide terminal canvas through an array. Keep identifiers available in
the text detail even if a compact label is shortened.

Proposed defaults are at most 8 KiB per generated math fragment and 32 KiB per
on-demand Markdown report, or a lower host limit. Renderer profiles can impose
stricter row/node/edge limits based on qualification. Overflow produces a scoped
view with omitted counts, continuation references and a short fallback reason;
it never truncates a math expression or disguises partial topology as complete.
Local validation catches syntax/encoding errors; a host rendering failure may
not be observable remotely. Always keep run identity, time and critical status
readable outside math, and make `--chat-renderer plain` available for recovery.

### Inspection, history and notifications

1. **On demand:** the agent invokes the inspection command or an equivalent
   read-only host tool. Return structured panel data with a canonical text or
   Markdown representation. In HAPI the agent can place the generated Markdown
   in its assistant reply; a Bash tool result alone may display the source. The
   panel is deterministic and usable without model interpretation. It includes
   identity, observation time and freshness so it can be quoted accurately.
2. **Notifications:** an explicit subscription to the originating session sends
   a compact overview on meaningful change. Include only relevant panels: for
   example topology on reentry or usage on a budget threshold. Do not stream
   every token, redraw or periodic sample into conversation history. Use the
   hub's bounded coalescing policy and approximately 1 KiB report target; the
   notification budget may require plain output even for a KaTeX-capable host.
3. **History:** each chat report is an immutable, timestamped snapshot. Earlier
   reports do not become live because a later report arrives. A connected
   terminal watch shows current frames and stale/gap indicators. A retained event
   cursor is not a promise to retain every historical metric sample forever.

Reuse the hub's report IDs, cursor/gap handling, coalescing and delivery status.
A subscription records the explicit destination, selected panels, detail limits
and rendering profile/version, not a saved full-screen layout. A destination
change requires an explicit subscription change. Rendering and sampling happen
in code, with no LLM call per metric or redraw. Do not wake an agent solely to
obtain color; if the direct notification path is plain, use plain notifications
and reserve colored assistant replies for on-demand inspection. Delivery retry
never becomes a graph retry, and notification failure never blocks execution.

Notification delivery and opening a viewer cannot consume a run slot or restart
a run. The monitor itself never sends input to a live agent. The
screenshot's "send" shortcut would be a separate control feature; the existing
`graphloom session open` forks eligible recorded sessions rather than attaching
to a live job.

### Optional later interactive view

MCP can expose a read-only snapshot tool without introducing a UI. MCP Apps can
add a `ui://` resource referenced by a tool's `_meta.ui.resourceUri`; a compatible
host must fetch it, display a sandboxed interface and mediate its tool calls.
Installing a server alone cannot add that host support. The inspected HAPI source
does not establish such integration, so interactive topology selection, chart
tooltips and live message replacement are outside the no-HAPI-change proposal.

A later compatible host can reuse the panel data for interactive panels, with
React Flow/ELK and a browser chart adapter if justified. The host bridges reads
to the existing local Unix socket; a phone browser cannot directly reach the
machine's socket or assume its own `localhost` is the hub. Do not expose a public
hub listener to make a preview work. Closing an embedded view changes no run
state, and its data refreshes need no model call. Screenshot attachments and HTML
previews remain optional review/export artifacts, not the normal panel transport.

## 6. Telemetry and panel limits

Existing durable state supplies stage/attempt, receipts, pending dispatch,
recorded sessions, supervisor episodes and budget accounting. Agent session
records largely describe settled dispatches; they are not a complete live role
registry. Model identity, context limits and continuous token samples are not
uniformly available across harnesses. Show unavailable fields explicitly rather
than reconstructing them from console animations.

Live output and sparklines need an additional normalized telemetry path from the
runner/harness, identified by run, launch generation and operation, with sequence
numbers and timestamps. Keep this bounded stream separate from authoritative
acceptance state. Telemetry loss produces a gap/stale indicator, not a failed job.
Begin with available structured messages and bounded log tails; add richer
harness events incrementally without promising identical detail from every host.

Usage measures have distinct meanings:

- **Progress:** live path, accepted/open nodes on that path, active attempt,
  terminal status and any side visit. All-node counts are inventory, not a
  completion denominator for a branching graph. No predicted-time percentage.
- **Context:** last reported input context versus a known effective context
  limit for the same session, when both exist. Lifetime input tokens are not
  current context occupancy; compaction can lower occupancy. A model name alone
  is insufficient to invent a denominator.
- **Tokens and cost:** preserve source and exactness labels, distinguish input,
  output and cache tokens, and do not double-count cumulative totals on resume.
  A rate includes its measurement window and freshness. Settlement-only totals
  cannot honestly produce a real-time token-generation-speed sparkline.
- **CPU and memory:** use the managed launch's process/cgroup scope, not only the
  controller PID. Label external-container coverage and missing samples. Memory
  is an instantaneous measurement; budget usage is a cumulative counter.

Keep output read-only, bounded and escaped for the target renderer. Strip child
terminal controls; protect Markdown code fences; handle Unicode display width.
Use user-visible messages, tool summaries and evidence, not private reasoning.
Retrieve long transcripts or diffs on demand through references instead of
copying them into every panel or notification. Show missing/retired artifacts
explicitly, since retained session metadata does not guarantee a transcript
still exists.

## 7. Implementation and verification order

1. Build the common frame against the topology SDK already under implementation,
   plus overview, stages and usage projections. Implement JSON and plain
   text/Markdown, with explicit capability gaps for older owning runtimes. This
   baseline must work independently of a TUI, KaTeX or MCP host.
2. Add jobs, activity and job-detail panels using recorded execution identities;
   provide bounded output with explicit gaps where live telemetry is unavailable.
   Qualify the ANSI panel and quantitative cell-chart renderers, including Unicode
   widths, sparse samples and readable plain output.
3. Qualify the ELK-to-cell adapter for branches/cycles and add live terminal
   rendering and explicit chat subscriptions using the same panels. Preserve a
   complete adjacency view while routing qualification is incomplete.
4. Implement the bounded KaTeX serializer and qualify the actual HAPI assistant
   delivery path. Extend qualification separately to any notification or tool
   surface that supports it. This enhancement does not block basic hub delivery.
   A complete dashboard, browser UI and MCP Apps integration are optional work.

Behavior checks should cover receipt invalidation on reentry, job success before
stage acceptance, resumed usage counters, stable selection across retries,
missing measurements, source freshness and stream gaps. Graph cases include a
diamond with both incoming edges retained, cycles with correct arrow direction,
supervisor entry distinguished from declared edges, `current` away from the path
tail, off-path nodes, dense implicit back edges and viewport edge visibility.
Cross-renderer checks should establish the same facts and identities in text,
JSON, ANSI and Markdown/KaTeX, not pixel-identical layout. Opening, closing or
changing a panel must not change execution.

| Rendering/delivery case | Required result |
| --- | --- |
| Same frame rendered four ways | Same identities, values, units, status and unknown/gap markers |
| Branching/cyclic graph exceeds a viewport or report budget | Labelled scope/omissions, correct edge directions and complete paginated adjacency |
| CJK, combining/wide characters, long IDs or unsupported math glyphs | Terminal widths handled; safe readable chat fallback retains full identity |
| Label contains TeX, Markdown fences or terminal controls | Data remains inert and legible; no injected command or broken report |
| KaTeX fragment exceeds a bound or fails local validation | Plain report from the same frame with a fallback reason |
| Unknown host or changed capability profile | `auto` uses plain output until that profile/surface is qualified |
| HAPI assistant message, tool result and notification | Test each separately; do not extrapolate from the component proof |
| Light/dark theme, narrow/mobile view or `NO_COLOR` | Readable labels and values; status remains understandable without color |
| Token totals arrive only at settlement, or a sample is lost/reset | Honest sampled/cumulative labels and gaps; no invented real-time rate |
| Notification burst, disconnect or lost acknowledgement | Bounded coalescing/retries, stable report IDs and no effect on run scheduling |
| Old chat snapshot beside a live watch | Distinct observation times and live/stale indications |

Current evidence is deliberately limited:

| Item | Status |
| --- | --- |
| Hub, managed execution contract and production panel module | Implemented with behavior tests; deployment qualification outstanding |
| Complex topology SDK | Reviewed pinned work on `main`; traversal integration remains ongoing |
| Eight-panel prototype | Fictional fixtures, four run states, hand-placed graph; HTML/plain/ANSI review artifact |
| KaTeX renderer | Eight-panel summaries with complete plain details; trust-disabled parser tests and bounded fallback |
| Deployed HAPI profile and live notifications | Not end-to-end qualified |
| ELK-to-cell routing and area charts | Implemented; geometry validation, complete adjacency fallback, scaled charts and explicit gaps tested |

Runtime and rendering checks run with the affected workspace suites. Actual
HAPI delivery qualification is separate from parser and injected transport tests.
