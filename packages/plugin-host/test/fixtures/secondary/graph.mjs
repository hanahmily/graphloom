import { stop } from "@graphloom/sdk";

const definition = {
  graphId: "secondary",
  version: "2.0.0",
  stages: [{ id: "only", name: "Only", requirementIds: ["ok"] }],
  requirements: [
    {
      id: "ok",
      statement: "Secondary plugin marker requirement.",
      evidenceSchema: "marker-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "ok", validatorId: "mark", version: "1" },
  ],
};

export function createGraph() {
  return {
    describe() {
      return structuredClone(definition);
    },
    advance() {
      return stop(
        { reason: "secondary complete", blocker: "none" },
        "secondary stop",
      );
    },
  };
}
