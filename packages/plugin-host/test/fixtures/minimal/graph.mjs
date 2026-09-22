import { dispatch } from "@graphloom/sdk";

const definition = {
  graphId: "minimal",
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
      return structuredClone(definition);
    },
    advance(view) {
      return dispatch(
        {
          stageId: view.current.stageId,
          kind: "agent",
          purpose: "work",
          instruction: "write greeting",
        },
        "minimal dispatch",
      );
    },
  };
}
