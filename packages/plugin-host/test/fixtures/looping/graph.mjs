// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

const definition = {
  graphId: "looping",
  version: "1.0.0",
  stages: [{ id: "x", name: "X", requirementIds: ["r"] }],
  requirements: [{ id: "r", statement: "unused", evidenceSchema: "x" }],
  defaultValidators: [{ requirementId: "r", validatorId: "v", version: "1" }],
};

export function createGraph() {
  return {
    describe() {
      return structuredClone(definition);
    },
    advance() {
      throw new Error("not used");
    },
    loopCandidates(input) {
      const mode = input.profile && input.profile.mode;
      if (mode === "hang") return new Promise(() => {});
      if (mode === "throw") throw new Error("hook exploded");
      if (mode === "async") return Promise.resolve({ candidates: [{ key: `day:${input.now.slice(0, 10)}`, taskArgs: [] }] });
      return { candidates: [{ key: `round:${input.round}`, taskArgs: [String(input.results.length)] }] };
    },
  };
}
