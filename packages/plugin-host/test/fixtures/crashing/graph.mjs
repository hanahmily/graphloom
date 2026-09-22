const definition = {
  graphId: "crashing",
  version: "1.0.0",
  stages: [{ id: "x", name: "X", requirementIds: ["r"] }],
  requirements: [
    { id: "r", statement: "unused", evidenceSchema: "x" },
  ],
  defaultValidators: [{ requirementId: "r", validatorId: "v", version: "1" }],
};

export function createGraph() {
  return {
    describe() {
      return structuredClone(definition);
    },
    advance() {
      process.exit(7);
    },
  };
}
