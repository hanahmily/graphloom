# Monitoring panel prototype

Throwaway rendering prototype for review, with fictional data and hand-placed
graph geometry. It does not connect to the hub, execute jobs, or qualify a general
ELK-to-character-cell layout algorithm. No third-party source is copied.

```sh
node apps/graphloom/prototype-monitor-panels/run.mjs
node apps/graphloom/prototype-monitor-panels/run.mjs --plain --panel topology
node apps/graphloom/prototype-monitor-panels/run.mjs --plain --panel usage --width 50
node apps/graphloom/prototype-monitor-panels/run.mjs --ansi --panel topology
node apps/graphloom/prototype-monitor-panels/run.mjs --ansi --panel usage
```

The first command writes the conversation preview and text snapshots to `output/`.
The preview compares Canvas, Compact, and Chat forms. Select a panel, a sample run
state, or a node. All three forms use the same pure renderer and sample observation.
The plain and ANSI commands support `--state running|recovery|waiting|complete`, `--node`,
`--width`, and `--panel` (or `all`). No dependencies or live services are required.
`--ansi` emits character cells with standard ANSI foreground colors: green for
accepted, cyan for active, yellow for attention, and gray for secondary text and
edges. Each styled run and line resets its formatting. It requires a terminal or
an ANSI-aware chat renderer; ordinary Markdown code blocks do not interpret the
escape sequences. The prototype does not change the HAPI frontend.

The updated [panel design](../../../docs/design-monitor-panels.md) adds a separate
static Markdown/KaTeX renderer for native colored HAPI replies, using the same
semantic panel data. That renderer is not implemented in this prototype. Its
small browser proof does not establish full panel or deployed HAPI compatibility;
the preview's Chat form remains plain character output. Screenshots and the HTML
preview are review artifacts, not the proposed production chat transport.

The review question is whether the topology, state distinctions and resource
charts remain legible as independent panels in both a terminal and a chat. The
fixture includes branching, a return edge, a supervisor-only node and a missing
metric sample. This is not production code and has not been committed.
