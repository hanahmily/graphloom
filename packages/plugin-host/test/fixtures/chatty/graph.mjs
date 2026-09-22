const definition = {
  graphId: "chatty",
  version: "1.0.0",
  stages: [{ id: "write", name: "Write", requirementIds: ["r1"] }],
  requirements: [
    {
      id: "r1",
      statement: "A greeting file exists with the required bytes.",
      evidenceSchema: "bytes-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "r1", validatorId: "v1", version: "1" },
  ],
};

export function createGraph() {
  return {
    describe() {
      console.log("plugin noise on console.log");
      process.stdout.write("plugin noise on stdout\n");
      return structuredClone(definition);
    },
    advance(view) {
      console.info("advance noise", view.current.stageId);
      process.stdout.write("more stdout noise\n");
      return {
        action: {
          type: "stop",
          stop: { reason: "done", blocker: "none" },
        },
        reason: "chatty stop",
      };
    },
  };
}
