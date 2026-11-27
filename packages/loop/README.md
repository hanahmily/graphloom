# @graphloom/loop

The generic loop machinery: a loop definition, a pure start-decision engine and a
durable per-loop store. It holds no forge vocabulary; a bundle's `loopCandidates`
hook (types and `validateLoopReply` in `@graphloom/sdk`) says what could start.
See [docs/design-loop.md](../../docs/design-loop.md).

- `parseLoopDefinition`: validate a parsed definition (name, every, graph, profile, sink, limits).
- `decide`: candidates and known run keys in, start/skip decisions with reasons out. No clock, no IO.
- `LoopStore`: `state.json` (`graphloom-loop-v1`) under a single-writer lock; write-ahead
  `intent` then `started`, `recover()` for unfinished intents, `unpark` bumps the generation.

Not here yet: the evaluator, the hub timer, CLI commands.
