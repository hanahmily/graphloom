// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Format 1 -> 2: evidence payload parts over the threshold move out of `state.json` into the run's
 * content-addressed evidence store (docs/design-typescript-core.md, "Evidence storage"). The migrator is pure:
 * the blobs are files of its result (`evidence/sha256/<hex>.json`), which `resume --upgrade` writes durably
 * before `state.json`, the commit point. Format 2's protected view hydrates, so the migration machinery checks
 * that every record still says exactly what it said.
 */
import {
  evidenceBlobName,
  externalizePayload,
  hydrateRecord,
  parseEvidenceBlob,
  EvidenceUnavailableError,
  type EvidenceRecord,
} from "@graphloom/sdk";
import type { ProtectedView, StateFiles, StateMigrator } from "./index.js";

interface StateShape {
  receipts?: unknown;
  evidence?: EvidenceRecord[];
  definition?: { stages?: unknown; requirements?: unknown };
}

export const externalizeEvidenceMigrator: StateMigrator = {
  from: 1,
  to: 2,
  migrate(files: Readonly<StateFiles>): StateFiles {
    const state = JSON.parse(files["state.json"] ?? "{}") as StateShape;
    const out: StateFiles = { ...files };
    const evidence = (state.evidence ?? []).map((record) => {
      if (record.payload === undefined || record.payload === null || record.externalized !== undefined) return record;
      const moved = externalizePayload(record.payload);
      if (moved.externalized.length === 0) return record;
      for (const blob of moved.blobs) out[evidenceBlobName(blob.sha256)] = blob.text;
      return { ...record, payload: moved.payload, externalized: moved.externalized };
    });
    out["state.json"] = JSON.stringify({ ...state, evidence }, null, 2);
    return out;
  },
};

/** What a format 2 migration must preserve: receipts, evidence with its externalized parts read back in, steps, requirement statements. */
export const formatTwoProtectedView: ProtectedView = (files) => {
  const state = JSON.parse(files["state.json"] ?? "{}") as StateShape;
  const read = (part: { sha256: string }): unknown => {
    const text = files[evidenceBlobName(part.sha256)];
    if (text === undefined) throw new EvidenceUnavailableError(part.sha256, "blob is not among the migration's files");
    return parseEvidenceBlob(part, text);
  };
  return {
    receipts: state.receipts ?? [],
    evidence: (state.evidence ?? []).map((record) => hydrateRecord(record, read)),
    stages: state.definition?.stages ?? [],
    requirements: state.definition?.requirements ?? [],
  };
};
