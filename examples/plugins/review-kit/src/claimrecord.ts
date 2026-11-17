// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The claim checks of the report, kept past their supersession. A validator sees only the latest review evidence of the candidate
 * (the controller's candidate evidence), so once a later read-only review job of the same candidate is recorded (an answer checker,
 * an aspect reviewer), the claim checks are gone from what the report's validators see. A reentry that sends the run back to Fetch
 * with the candidate unchanged then has to accept the Report stage again, and its report flow, replayed from the validators'
 * evidence, would stand at the checker forever.
 *
 * So the graph records the claim checks once the report is checked (`claimRecordCommands`, a plugin command that writes their
 * evidence records whole), and the report flow (`withRecordedClaimChecks`) puts a recorded check back at its place only when it is
 * missing from the evidence, of the record's own candidate, and kept as the review evidence of a read-only review job. Nothing else
 * changes: a check that is still in the evidence is read from the evidence, and a record of another candidate restores nothing.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { CLAIM_CHECK_SCHEMA_NAME } from "./claims.js";
import { isObject } from "./evidence.js";
import { recordCommands, recordedRecord } from "./parts.js";

export const CLAIM_RECORD_ID = "claim-checks";
const CLAIM_RECORD_DIR = "report";
const SCHEMA = "claim-checks-v1";

interface Entry {
  /** The ref of the nearest earlier record a candidate's evidence always keeps (a command or an agent result that is not review evidence). */
  after: string | null;
  record: EvidenceRecord;
}

/** Whether the controller keeps every record of this kind in a candidate's evidence (it keeps only the latest file, workspace and review records). */
const kept = (e: EvidenceRecord): boolean => e.kind !== "file" && e.kind !== "workspace" && e.kind !== "review";

/** Whether a record is a claim check kept as the review evidence of a read-only review job. */
function reviewCheck(e: EvidenceRecord): boolean {
  if (e.resultSchema !== CLAIM_CHECK_SCHEMA_NAME || e.kind !== "review") return false;
  const p = isObject(e.payload) && isObject(e.payload.producer) ? e.payload.producer : undefined;
  return p !== undefined && p.readOnly === true && p.purpose === "review";
}

/**
 * A record as the claim record keeps it: its identity and its payload read whole, in a fixed shape, so the record is the same
 * whether the plugin worker hands the evidence inline or externalized with lazy getters (packages/sdk/src/evidence-store.ts).
 */
function canonical(e: EvidenceRecord): EvidenceRecord {
  return {
    ref: e.ref,
    kind: e.kind,
    ...(e.candidateDigest !== undefined ? { candidateDigest: e.candidateDigest } : {}),
    ...(e.generation !== undefined ? { generation: e.generation } : {}),
    ...(e.resultSchema !== undefined ? { resultSchema: e.resultSchema } : {}),
    ...(e.contract !== undefined ? { contract: JSON.parse(JSON.stringify(e.contract)) as EvidenceRecord["contract"] } : {}),
    payload: JSON.parse(JSON.stringify(e.payload ?? null)) as unknown,
  } as EvidenceRecord;
}

/** The claim checks the evidence holds as review evidence, each with the record it follows; undefined when there is none. */
export function claimRecordJson(evidence: readonly EvidenceRecord[]): string | undefined {
  const entries: Entry[] = [];
  let after: string | null = null;
  for (const e of evidence) {
    if (reviewCheck(e)) entries.push({ after, record: canonical(e) });
    else if (kept(e)) after = e.ref;
  }
  return entries.length === 0 ? undefined : JSON.stringify({ schema: SCHEMA, checks: entries });
}

/** The commands that record the report's claim checks (none when the evidence holds none). */
export function claimRecordCommands(evidence: readonly EvidenceRecord[]): EnvironmentCommand[] {
  // Over the checks a record already put back too, so the record of a reentered run is the one it wrote.
  const json = claimRecordJson(withRecordedClaimChecks(evidence));
  return json === undefined ? [] : recordCommands(CLAIM_RECORD_ID, CLAIM_RECORD_DIR, json);
}

/**
 * The evidence with each recorded claim check put back after the record it followed, when the evidence no longer holds it (a later
 * review of the same candidate superseded it). Only a check of the record's own candidate, kept as a read-only review job's review
 * evidence, is put back; the evidence is returned as it is when nothing is missing.
 */
export function withRecordedClaimChecks(evidence: readonly EvidenceRecord[]): readonly EvidenceRecord[] {
  const w = recordedRecord(evidence, CLAIM_RECORD_ID, CLAIM_RECORD_DIR);
  if (w.state !== "read") return evidence;
  const writer = evidence.find((e) => e.ref === w.refs.at(-1));
  let doc: unknown;
  try {
    doc = JSON.parse(w.value);
  } catch {
    return evidence;
  }
  if (!isObject(doc) || doc.schema !== SCHEMA || !Array.isArray(doc.checks)) return evidence;
  const refs = new Set(evidence.map((e) => e.ref));
  const out = [...evidence];
  const restored = new Set<string>();
  for (const raw of doc.checks) {
    if (!isObject(raw) || !isObject(raw.record)) continue;
    const record = raw.record as unknown as EvidenceRecord;
    if (typeof record.ref !== "string" || refs.has(record.ref) || !reviewCheck(record)) continue;
    if (writer?.candidateDigest !== undefined && record.candidateDigest !== writer.candidateDigest) continue;
    const after = typeof raw.after === "string" ? out.findIndex((e) => e.ref === raw.after) : -1;
    if (raw.after !== null && after < 0) continue;
    // After its anchor and after the checks already put back there, so checks that followed one record keep their order.
    let at = after + 1;
    while (at < out.length && restored.has(out[at]!.ref)) at += 1;
    out.splice(at, 0, record);
    refs.add(record.ref);
    restored.add(record.ref);
  }
  return out;
}
