# @graphloom/monitor

Read-only GraphLoom monitoring projections and terminal/chat serialization. The
owning runtime collects a `MonitorSnapshot`; this package never loads a run,
schedules work, sends a notification, or changes execution.

```ts
import { projectPanels, renderPanels } from '@graphloom/monitor';

const panels = projectPanels(snapshot, {
  kinds: ['overview', 'topology', 'usage'],
  pageSize: 32,
});
const report = await renderPanels(panels, {
  format: 'markdown',
  chatRenderer: 'katex',
  width: 80,
});
// The host chooses where to deliver report.output and reports delivery failures.
```

`projectPanels` creates independent value projections for overview, topology,
stages, jobs, activity, selected job, usage and selected output. An explicit
operation/attempt selection stays fixed through retries. `followCurrent` is an
explicit alternative. Absent observations remain unknown. Page cursors include
the view and revision; every topology node and edge is retrievable. A changed
revision or selection resets a cursor with a notice.

`renderPanels` returns bounded output and renderer/fallback/continuation metadata.
Formats are `text`, `ansi`, `markdown`, and `json`. The default is plain text.
`chatRenderer` is valid only with Markdown. Its `auto` mode uses plain Markdown
unless the host supplies a qualified capability profile for that exact delivery
surface. Explicit `katex` emits a fixed, escaped math subset plus ordinary text
for detailed topology, charts, identities, evidence and output. It does not
execute user math or turn a chat message into a live application. Pass `noColor`
from the CLI's `NO_COLOR` policy; the module itself reads no environment variables.

The diagram adapter lazily runs ELK orthogonal layout, then validates rounded node
and edge geometry. Ambiguous crossings, overlaps, dense graphs, legacy sources,
or a narrow viewport select directed adjacency. Geometry is cached independently
of live status. The area primitive retains units, time/value scales, zero, source
range, and explicit gaps. Its rate aggregation weights measurements by time and
never bridges missing measurements.

The default report budget is 32 KiB; generated math fragments are at most 8 KiB.
Smaller host limits apply. A report that cannot fit identifies omissions and
provides a smaller-page request; `truncated` and `fallbackReasons` are machine
readable. JSON remains valid and identifies omitted panels instead of cutting a
serialized value. Large individual instructions/output should be inspected
through their owning artifact references rather than copied into a notification.

Dependencies: ELK.js is used under EPL-2.0 and string-width under MIT. No Troupe
code is copied. KaTeX is a development dependency used to validate the generated
subset with trust disabled. Actual HAPI assistant, notification and tool-result
surfaces require separate host qualification; passing parser tests does not
qualify a deployed host.
