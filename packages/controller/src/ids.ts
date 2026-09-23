/** Safe single-segment run IDs for filesystem paths and git refs. */
const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSafeRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId) || runId.includes("..")) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/** Graph IDs must be a single path segment (no separators / traversal). */
const GRAPH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSafeGraphId(graphId: string): string {
  if (!GRAPH_ID_RE.test(graphId)) {
    throw new Error(`invalid graph id: ${JSON.stringify(graphId)}`);
  }
  return graphId;
}
