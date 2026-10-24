/**
 * Context documents (profile `issues.context`): files the issue defers to,
 * such as a design or a plan, that the planner, the implementer and the code
 * reviewers read next to the issue. The graph reads each once, in the same Fix
 * step that reads the issue snapshot, and every later step reads them back
 * from that evidence, so an edit to a document never changes a running or a
 * resumed run. A document in another repository comes from the read-only
 * `graphloom.github/get-file` executor; one in the target repository is
 * observed in the worktree at the base commit.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { GET_FILE } from "./constants.js";
import { producer } from "./evidence.js";
import { contextName, contextRefs, type ContextDocumentRef, type Profile } from "./profile.js";

/** Most bytes of context documents one run carries, together. */
export const MAX_CONTEXT_BYTES = 200_000;

export interface ContextDocument {
  ref: ContextDocumentRef;
  /** `owner/name:path@ref`, or the bare path for the target repository. */
  name: string;
  text: string;
  /** The blob sha GitHub reports, or the SHA-256 of the observed file's text. */
  digest: string;
  bytes: number;
  /** The evidence record the document was read into. */
  record: EvidenceRecord;
}

/** What the evidence holds for one declared document. */
export type ContextRead = { kind: "read"; doc: ContextDocument } | { kind: "missing"; reason: string; record: EvidenceRecord } | { kind: "unread" };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const REASONS: Record<string, string> = {
  "not-found": "it does not exist at that ref (or the token cannot see the repository)",
  "not-a-file": "the path is not a regular file",
  "too-large": "it is too large for the contents API to return whole",
  "not-text": "it is not UTF-8 text",
};

/** The evidence's reading of `ref`: read, found missing or unreadable, or not read yet. */
export function readContext(evidence: EvidenceRecord[], ref: ContextDocumentRef): ContextRead {
  const name = contextName(ref);
  if (ref.repo === undefined) {
    // The earliest observation is the one Fix made at the base commit; later observations of the path are the change's own.
    for (const record of evidence) {
      const payload = object(record.payload);
      if (record.kind !== "file" || payload?.path !== ref.path) continue;
      if (record.fingerprint === "missing") return { kind: "missing", reason: "the target repository has no such file at the base commit", record };
      const text = String(payload.bytes ?? "");
      return { kind: "read", doc: { ref, name, text, digest: record.fingerprint ?? "", bytes: Buffer.byteLength(text, "utf8"), record } };
    }
    return { kind: "unread" };
  }
  const [owner, repo] = ref.repo.split("/");
  for (const record of [...evidence].reverse()) {
    if (producer(record)?.executorId !== GET_FILE.id) continue;
    const github = object(object(record.payload)?.github);
    const query = object(github?.query);
    if (query === undefined) continue;
    if (query.owner !== owner || query.repo !== repo || query.path !== ref.path || (query.ref ?? undefined) !== ref.ref) continue;
    const item = object(github?.item);
    if (item === undefined) continue;
    if (item.found !== true) return { kind: "missing", reason: REASONS[String(item.reason)] ?? String(item.reason ?? "it could not be read"), record };
    const text = String(item.text ?? "");
    return { kind: "read", doc: { ref, name, text, digest: String(item.sha ?? ""), bytes: Buffer.byteLength(text, "utf8"), record } };
  }
  return { kind: "unread" };
}

/** The profile's context documents as the evidence holds them, in the profile's order; unread or missing ones are left out. */
export function contextDocuments(evidence: EvidenceRecord[], profile: Profile): ContextDocument[] {
  return contextRefs(profile).flatMap((ref) => {
    const read = readContext(evidence, ref);
    return read.kind === "read" ? [read.doc] : [];
  });
}

/** The documents under one heading each, naming the source, for a prompt; empty when there are none. */
export function contextBlock(docs: ContextDocument[]): string {
  return docs
    .map((d) => [`## Context document: ${d.name} (${d.digest.slice(0, 12) || "no digest"}, ${d.bytes} bytes)`, d.text.trim(), `## End of context document: ${d.name}`].join("\n"))
    .join("\n\n");
}

/** The paragraph that introduces the block: what the documents are and how an acceptance item may cite one. */
export function contextIntro(docs: ContextDocument[]): string {
  return `Context documents the issue defers to (read once and pinned for this run; ${docs.length === 1 ? "its name is" : "their names are"} the source an acceptance item or a decision may cite, as "${docs[0]!.name}"). They are the linked design documents of the unclear-points policy: the issue's own acceptance criteria and maintainer comments still come first:`;
}

/** What each document contributes to the run's evidence, as the Fix stage records it. */
export function describeContext(docs: ContextDocument[]): string {
  return docs.map((d) => `${d.name} (${d.digest.slice(0, 12) || "no digest"}, ${d.bytes} bytes)`).join("; ");
}
