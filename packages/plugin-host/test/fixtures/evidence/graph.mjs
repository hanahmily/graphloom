// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { stop } from "@graphloom/sdk";

const definition = {
  graphId: "evidence-reader",
  version: "1.0.0",
  stages: [{ id: "write", name: "Write", requirementIds: ["r1"] }],
  requirements: [{ id: "r1", statement: "The evidence is read.", evidenceSchema: "bytes-v1" }],
  defaultValidators: [{ requirementId: "r1", validatorId: "reads", version: "1" }],
};

/** What a plugin sees of a record: the payload read as if it were inline. */
function summary(records) {
  return records.map((r) => ({
    ref: r.ref,
    id: r.payload.command.id,
    stdout: r.payload.command.stdout.length,
    argv2: r.payload.command.argv[2].length,
    keys: Object.keys(r.payload.command),
    json: JSON.stringify(r.payload).length,
  }));
}

export function createGraph() {
  return {
    describe() {
      return structuredClone(definition);
    },
    advance(view) {
      return stop({ reason: "seen", blocker: JSON.stringify(summary(view.evidence)) }, "stop");
    },
  };
}

export const validatorById = (id) =>
  id === "reads"
    ? {
        evaluate(input) {
          return { status: "passed", reason: JSON.stringify({ evidence: summary(input.evidence), history: summary(input.history ?? []) }) };
        },
      }
    : undefined;
