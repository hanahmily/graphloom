// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Externalized evidence (docs/design-typescript-core.md, "Evidence storage"): the controller's side.
 *
 * Evidence enters the run in its externalized form: every payload part over the threshold is written, durably,
 * to `<stateDir>/evidence/sha256/<hex>.json` at the moment the record is made, so any state save that references
 * it comes after the blob is on disk (a crash in between leaves an orphan blob, never a dangling reference). The
 * record, `state.json` and the wire carry `null` and the part's digest. Readers that show content hydrate first.
 */
import path from "node:path";
import {
  DEFAULT_EXTERNALIZE_THRESHOLD,
  readEvidencePart,
  externalizePayload,
  assertDisjointParts,
  hydrateRecord,
  isEvidenceUnavailable,
  writeEvidenceBlobs,
  type EvidencePartReader,
  type EvidenceRecord,
  type ValidationInput,
} from "@graphloom/sdk";
import { HostObservationError } from "./host-validators.js";

/** The run's blobs live under `<stateDir>/evidence`, so deleting the run's state directory deletes them. */
export const EVIDENCE_DIR = "evidence";

/** A view whose inline evidence is larger than this is recomputed with a lower threshold (8 MB, well under the wire bound). */
export const VIEW_INLINE_LIMIT_BYTES = 8 * 1024 * 1024;

/** The smallest threshold the safety valve lowers to. */
const MIN_VIEW_THRESHOLD = 256;

export function evidenceStoreDir(stateDir: string): string {
  return path.join(stateDir, EVIDENCE_DIR);
}

/** A reader over the run's blobs. */
export function evidenceReaderFor(stateDir: string): EvidencePartReader {
  return (part) => readEvidencePart(evidenceStoreDir(stateDir), part);
}

/**
 * The record with its large payload parts moved into the run's evidence store. Parts already externalized stay;
 * any inline part still over `threshold` is moved too, so calling it again with a lower threshold shrinks the
 * record further. Returns the same record when nothing moves. Deterministic.
 */
export function externalizeRecord(stateDir: string, record: EvidenceRecord, threshold: number = DEFAULT_EXTERNALIZE_THRESHOLD): EvidenceRecord {
  if (record.payload === undefined || record.payload === null) return record;
  let payload: unknown = record.payload;
  let kept = record.externalized ?? [];
  for (;;) {
    const out = externalizePayload(payload, threshold);
    if (out.externalized.length === 0) return payload === record.payload ? record : { ...record, payload, externalized: kept };
    // A new part that contains parts stored earlier is stored whole: read those descendants back in first and
    // go again, so the stored part holds their content and no recorded path lies inside another.
    const inside = kept.filter((old) => out.externalized.some((p) => p.path.length < old.path.length && p.path.every((key, i) => old.path[i] === key)));
    if (inside.length === 0) {
      writeEvidenceBlobs(evidenceStoreDir(stateDir), out.blobs);
      const next = { ...record, payload: out.payload, externalized: [...kept, ...out.externalized] };
      assertDisjointParts(next.externalized);
      return next;
    }
    const read = evidenceReaderFor(stateDir);
    payload = hydrateRecord({ ...record, payload, externalized: inside }, read).payload;
    kept = kept.filter((old) => !inside.includes(old));
  }
}

export function externalizeRecords(stateDir: string, records: readonly EvidenceRecord[], threshold?: number): EvidenceRecord[] {
  return records.map((record) => externalizeRecord(stateDir, record, threshold));
}

const swept = new WeakSet<EvidenceRecord>();

/**
 * The safety net behind every place that records evidence: before a save, externalizes any record that has not
 * been through `externalizeRecord`, in place in `records`. A record is examined once per process.
 */
export function sweepEvidence(stateDir: string, records: EvidenceRecord[]): void {
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (swept.has(record)) continue;
    const next = externalizeRecord(stateDir, record);
    swept.add(next);
    records[i] = next;
  }
}

/** Marks records that were externalized at their creation site, so a save does not examine them again. */
export function markExternalized(records: readonly EvidenceRecord[]): void {
  for (const record of records) swept.add(record);
}

/** The records with every externalized part read back in. Throws EvidenceUnavailableError for a missing or corrupt blob. */
export function hydrateEvidence(stateDir: string, records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const read = evidenceReaderFor(stateDir);
  return records.map((record) => hydrateRecord(record, read));
}

export function hydrateOne(stateDir: string, record: EvidenceRecord): EvidenceRecord {
  return hydrateRecord(record, evidenceReaderFor(stateDir));
}

/** Evidence for a host call: left externalized for a host that hydrates itself, hydrated here for any other. */
export function evidenceForHost(host: { hydratesEvidence?: boolean }, stateDir: string, records: EvidenceRecord[]): EvidenceRecord[] {
  return host.hydratesEvidence === true ? records : hydrateEvidence(stateDir, records);
}

/** Bytes of the records as they would travel inline. */
export function inlineBytes(records: readonly EvidenceRecord[]): number {
  return Buffer.byteLength(JSON.stringify(records), "utf8");
}

/**
 * The evidence of a run view: the stored records, unless their inline size passes the view limit, in which case
 * the threshold is halved (a deterministic function of the state) until they fit or the floor is reached. The
 * extra blobs this writes are content-addressed like any other; the state itself is not changed.
 */
export function evidenceForView(stateDir: string, records: readonly EvidenceRecord[]): EvidenceRecord[] {
  let current = [...records];
  let threshold = DEFAULT_EXTERNALIZE_THRESHOLD;
  while (inlineBytes(current) > VIEW_INLINE_LIMIT_BYTES && threshold > MIN_VIEW_THRESHOLD) {
    threshold = Math.max(MIN_VIEW_THRESHOLD, Math.floor(threshold / 2));
    current = externalizeRecords(stateDir, current, threshold);
  }
  return current;
}

/** The validation input with its evidence and history hydrated. */
export function hydratedInput(stateDir: string, input: ValidationInput): ValidationInput {
  return {
    ...input,
    evidence: hydrateEvidence(stateDir, input.evidence),
    ...(input.history !== undefined ? { history: hydrateEvidence(stateDir, input.history) } : {}),
  };
}

/**
 * The input for one validator: as recorded for a validator that reads externalized evidence itself, hydrated
 * for any other. A blob that cannot be read is a host observation, `evidence_unavailable`.
 */
export function validatorInput(validator: { readsExternalizedEvidence?: boolean }, stateDir: string, input: ValidationInput): ValidationInput {
  if (validator.readsExternalizedEvidence === true) return input;
  try {
    return hydratedInput(stateDir, input);
  } catch (err) {
    if (!isEvidenceUnavailable(err)) throw err;
    throw new HostObservationError("evidence_unavailable", err instanceof Error ? err.message : String(err));
  }
}

/** Hydrated records for a reader that shows content; a record whose blob cannot be read stays as recorded. */
export function hydrateEvidenceBestEffort(stateDir: string, records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const read = evidenceReaderFor(stateDir);
  return records.map((record) => {
    try {
      return hydrateRecord(record, read);
    } catch {
      return record;
    }
  });
}
