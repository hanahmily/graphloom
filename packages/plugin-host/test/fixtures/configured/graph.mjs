// Echoes the config each call receives, so a test can see what the host sent.
export function createGraph() {
  return {
    describe(config) {
      return {
        graphId: "configured",
        version: "1.0.0",
        stages: [{ id: "s", name: "S", requirementIds: ["r"] }],
        requirements: [{ id: "r", statement: `describe saw ${JSON.stringify(config ?? null)}`, evidenceSchema: "x-v1" }],
        defaultValidators: [{ requirementId: "r", validatorId: "echo", version: "1" }],
      };
    },
    advance(view) {
      return { action: { type: "stop", stop: { reason: "echo", blocker: JSON.stringify(view.config ?? null) } }, reason: "echo the config" };
    },
  };
}

export function validatorById(id) {
  if (id !== "echo") return undefined;
  return { evaluate: (input) => ({ status: "passed", reason: JSON.stringify(input.config ?? null) }) };
}

export function rehearsal(config) {
  return { scenarios: { happy: { results: {}, expect: { status: "stopped", stopReason: JSON.stringify(config ?? null) } } } };
}
