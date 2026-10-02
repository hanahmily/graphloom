import { createHash, randomUUID } from "node:crypto";
import { stableHash as stableDigest } from "@graphloom/sdk";
import type {
  EvidenceRecord,
  GraphDefinition,
  Receipt,
  ValidateSpec,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { DurableRunState } from "./state.js";
import { candidateChange, readWorktreeFile, workspaceChangeManifest } from "./worktree.js";

/** Sync SDK validators or async host-backed evaluators. */
export type AdmissionValidator = {
  evaluate(
    input: import("@graphloom/sdk").ValidationInput,
  ):
    | import("@graphloom/sdk").ValidationResult
    | Promise<import("@graphloom/sdk").ValidationResult>;
};

export class AdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionError";
  }
}

/** Fresh evidence only: matching controller generation. Kept for callers unrelated to candidate-identity freshness (e.g. correction-handoff evidence refs). */
export function freshEvidence(state: DurableRunState): EvidenceRecord[] {
  return state.evidence.filter((e) => e.generation === state.generation);
}

/** Evidence produced for the given accepted identity (or carrying no identity at all, e.g. environment checks); oldest first. */
function evidenceForIdentity(state: DurableRunState, identity: string | undefined): EvidenceRecord[] {
  return state.evidence.filter((e) => e.candidateDigest === undefined || e.candidateDigest === identity);
}

/** Evidence for a since-superseded identity: context only, never sufficient to satisfy a requirement alone. */
export function supersededEvidence(state: DurableRunState, identity: string | undefined): EvidenceRecord[] {
  return state.evidence.filter((e) => e.candidateDigest !== undefined && e.candidateDigest !== identity);
}

/**
 * Latest observation per file path / kind for the given accepted identity.
 * Older same-identity observes (e.g. pre-correction) are superseded.
 */
export function candidateEvidence(state: DurableRunState, identity: string | undefined): EvidenceRecord[] {
  const current = evidenceForIdentity(state, identity);
  const latest: EvidenceRecord[] = [];
  const seenFiles = new Set<string>();
  const seenKinds = new Set<string>();
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const e = current[i]!;
    if (e.kind === "file") {
      const filePath = (e.payload as { path?: unknown } | undefined)?.path;
      if (typeof filePath !== "string" || seenFiles.has(filePath)) {
        continue;
      }
      seenFiles.add(filePath);
      latest.unshift(e);
      continue;
    }
    if (e.kind === "workspace" || e.kind === "review") {
      if (seenKinds.has(e.kind)) {
        continue;
      }
      seenKinds.add(e.kind);
      latest.unshift(e);
      continue;
    }
    latest.unshift(e);
  }
  return latest;
}

export function candidateFingerprint(evidence: EvidenceRecord[]): string {
  const h = createHash("sha256");
  for (const e of evidence) {
    h.update(e.ref);
    h.update(e.kind);
    h.update(e.fingerprint ?? "");
    h.update(JSON.stringify(e.payload ?? null));
  }
  return h.digest("hex");
}

export function stageRequirementsMet(
  state: DurableRunState,
  stageId: string,
  requirementIds: string[],
): boolean {
  return requirementIds.every((requirementId) =>
    state.receipts.some(
      (r) => r.stageId === stageId && r.requirementId === requirementId && r.valid,
    ),
  );
}

export function earliestIncompleteStage(
  state: DurableRunState,
): GraphDefinition["stages"][number] | undefined {
  return state.definition.stages.find(
    (s) => !stageRequirementsMet(state, s.id, s.requirementIds),
  );
}

/** Digest of the live workspace change, or undefined when the worktree is not a Git checkout of the pinned base. */
export async function liveCandidateDigest(state: DurableRunState): Promise<string | undefined> {
  try {
    return (await candidateChange(state.worktreePath, state.intake.pinnedHead)).digest;
  } catch {
    return undefined;
  }
}

/**
 * Why the final stage's receipts no longer describe the workspace: they
 * accepted a different change than the one the run would deliver.
 */
export async function deliveryDrift(state: DurableRunState): Promise<string | undefined> {
  const last = state.definition.stages.at(-1);
  if (last === undefined) return undefined;
  const bound = state.receipts.filter((r) => r.valid && r.stageId === last.id && r.candidateDigest !== undefined);
  if (bound.length === 0) return undefined;
  const live = await liveCandidateDigest(state);
  const stale = bound.filter((r) => r.candidateDigest !== live);
  if (stale.length === 0) return undefined;
  return `the workspace changed after ${last.id} accepted it (${stale.map((r) => r.requirementId).join(", ")})`;
}

/** Re-read worktree and ensure Observe fingerprints still match. */
export async function assertLiveWorkspaceMatchesEvidence(
  state: DurableRunState,
  evidence: EvidenceRecord[],
): Promise<string | undefined> {
  for (const e of evidence) {
    if (e.kind === "file") {
      const payload = e.payload as { path?: string } | undefined;
      if (!payload?.path || typeof payload.path !== "string") {
        return "malformed file evidence";
      }
      const live = await readWorktreeFile(state.worktreePath, payload.path);
      const liveFp = live === undefined ? "missing" : sha256(live);
      if (liveFp !== e.fingerprint) {
        return `workspace file changed since observe: ${payload.path}`;
      }
    }
    if (e.kind === "workspace") {
      const livePaths = await workspaceChangeManifest(state.worktreePath);
      const liveFp = sha256(JSON.stringify(livePaths));
      if (liveFp !== e.fingerprint) {
        return "workspace manifest changed since observe";
      }
      if (state.workspaceRevision && state.workspaceRevision !== liveFp) {
        return "workspace revision mismatch";
      }
    }
  }
  return undefined;
}

/**
 * Controller-owned Validate → optional Accept (receipt).
 * Never called from plugin/supervisor decisions directly as Accept.
 */
export async function admitValidation(
  state: DurableRunState,
  spec: ValidateSpec,
  validators: Record<string, AdmissionValidator>,
): Promise<{ state: DurableRunState; accepted: boolean; reason: string; evaluated: boolean }> {
  const stage = state.definition.stages.find((s) => s.id === spec.stageId);
  if (!stage) {
    throw new AdmissionError(`unknown stage ${spec.stageId}`);
  }

  // Invalidate whatever the live candidate/prerequisite state actually
  // affects before reading any receipt validity below. Otherwise a receipt
  // that is stale but not yet marked invalid can make earliestIncompleteStage
  // see a stage as still complete, rejecting the very validation that would
  // have invalidated it.
  const liveDigest = await liveCandidateDigest(state);
  state = await invalidateFromStage(state);

  const needed = earliestIncompleteStage(state);
  if (!needed || needed.id !== spec.stageId) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: `stage ${spec.stageId} is not the next incomplete stage`,
      evaluated: false,
    };
  }

  const reqIds = spec.requirementIds ?? stage.requirementIds;
  const allowed = new Set(stage.requirementIds);
  if (reqIds.some((id) => !allowed.has(id))) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "requirementIds must be a subset of the stage requirements",
      evaluated: false,
    };
  }
  // Admission mints receipts only when the full stage requirement set is covered.
  if (
    reqIds.length !== stage.requirementIds.length ||
    !stage.requirementIds.every((id) => reqIds.includes(id))
  ) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "Validate must cover every requirement declared by the stage",
      evaluated: false,
    };
  }

  const evidence = candidateEvidence(state, liveDigest);
  if (evidence.length === 0) {
    return { state, accepted: false, reason: "no fresh evidence for validation", evaluated: false };
  }

  const drift = await assertLiveWorkspaceMatchesEvidence(state, evidence);
  if (drift) {
    return { state: bumpRevision(state), accepted: false, reason: drift, evaluated: false };
  }

  const fingerprint = spec.candidateFingerprint ?? candidateFingerprint(evidence);
  if (spec.candidateFingerprint && spec.candidateFingerprint !== candidateFingerprint(evidence)) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "candidateFingerprint does not match current evidence",
      evaluated: false,
    };
  }
  const history = supersededEvidence(state, liveDigest);

  // Predecessor receipts: every requirement on earlier stages must be valid.
  const stageIndex = state.definition.stages.findIndex((s) => s.id === spec.stageId);
  for (let i = 0; i < stageIndex; i += 1) {
    const pred = state.definition.stages[i]!;
    if (!stageRequirementsMet(state, pred.id, pred.requirementIds)) {
      return {
        state: bumpRevision(state),
        accepted: false,
        reason: `missing valid predecessor receipts for ${pred.id}`,
        evaluated: false,
      };
    }
  }

  const newReceipts: Receipt[] = [];
  let working = { ...state, receiptSeq: state.receiptSeq };
  for (const requirementId of reqIds) {
    const requirement = working.definition.requirements.find((r) => r.id === requirementId);
    if (!requirement) {
      throw new AdmissionError(`unknown requirement ${requirementId}`);
    }
    const binding = bindingFor(working, requirementId);
    if (!binding) {
      throw new AdmissionError(`no validator binding for ${requirementId}`);
    }
    const validator = validators[binding.validatorId];
    if (!validator) {
      throw new AdmissionError(`validator not registered: ${binding.validatorId}`);
    }

    if (binding.independence === "separate-reviewer") {
      // The plan's own review predates the implementer's edit (the same
      // reason planReviewed's validator searches history): evidence alone,
      // scoped to the live candidate, would no longer contain it.
      const independenceError = assertSeparateReviewer(working, [...history, ...evidence]);
      if (independenceError) {
        return {
          state: bumpRevision(working),
          accepted: false,
          reason: independenceError,
          evaluated: false,
        };
      }
    }

    const result = validator.evaluate({
      requirementId,
      statement: requirement.statement,
      evidence,
      history,
      candidateFingerprint: fingerprint,
      ...(liveDigest !== undefined ? { candidateDigest: liveDigest } : {}),
    });
    const resolved = await Promise.resolve(result);

    if (resolved.status !== "passed") {
      return {
        state: bumpRevision(working),
        accepted: false,
        reason: `validation ${resolved.status}: ${resolved.reason}`,
        evaluated: true,
      };
    }

    working.receiptSeq += 1;
    const identityArtifactSchema = requirement.identityArtifactSchema;
    const acceptedIdentity: Record<string, string> = {};
    const workspaceIdentity = workspaceIdentityDigest(fileEvidenceFingerprints(evidence));
    if (workspaceIdentity !== undefined) acceptedIdentity.workspace = workspaceIdentity;
    if (identityArtifactSchema !== undefined) {
      const artifactDigest = currentArtifactDigest(working, identityArtifactSchema);
      if (artifactDigest !== undefined) acceptedIdentity[identityArtifactSchema] = artifactDigest;
    } else if (liveDigest !== undefined && evidence.some((e) => e.kind === "command")) {
      // A command-backed check (a build or test run in a checkout of the
      // candidate) can depend on any file in the repository, not only the
      // ones explicit file observations named: narrow path-scoped identity
      // cannot cover it, so anchor to the whole candidate instead. A
      // requirement that needs narrower semantics than this declares its own
      // identityArtifactSchema above.
      acceptedIdentity.candidate = liveDigest;
    }
    newReceipts.push({
      id: `rcpt-${working.receiptSeq}`,
      stageId: spec.stageId,
      requirementId,
      validatorBinding: binding,
      candidateFingerprint: fingerprint,
      evidenceRefs: evidence.map((e) => e.ref),
      valid: true,
      ...(liveDigest !== undefined ? { candidateDigest: liveDigest } : {}),
      // Always set, even empty: an empty acceptedIdentity means this
      // receipt's evidence named nothing at all to anchor to (e.g. an
      // environment check or a review with no command or file evidence), so
      // nothing invalidates it — distinct from acceptedIdentity being
      // entirely absent, which only a pre-migration receipt (minted before
      // this field existed) can be.
      acceptedIdentity,
      ...(requirement.prerequisiteRequirementIds !== undefined
        ? { prerequisiteBindings: prerequisiteBindingsFor(working, requirement.prerequisiteRequirementIds, requirementId) }
        : {}),
    });
  }

  // Already invalidated against liveDigest at the top of this function;
  // nothing between there and here adds evidence or changes bindings.
  let receipts = working.receipts;

  // Replace any prior valid receipts for the same stage requirements.
  receipts = receipts.map((r) =>
    r.stageId === spec.stageId &&
    reqIds.includes(r.requirementId) &&
    r.valid
      ? { ...r, valid: false }
      : r,
  );

  return {
    state: bumpRevision({
      ...working,
      receipts: [...receipts, ...newReceipts],
      current: { stageId: spec.stageId, attempt: working.current.attempt },
    }),
    accepted: true,
    reason: `accepted ${spec.stageId}`,
    evaluated: true,
  };
}

/**
 * Blanket invalidation: every receipt from `stageId` onward, regardless of
 * whether anything about it actually changed. Used for repair activation and
 * resume-recheck, where arbitrary code can change under an identity this
 * module has no way to detect (a validator's own logic, not its evidence).
 * `reenter` and `admitValidation`'s own invalidation use the identity-aware
 * `invalidateFromStage` below instead.
 */
export function invalidateStageAndAfter(
  state: DurableRunState,
  stageId: string,
  definition: GraphDefinition,
): DurableRunState {
  const idx = definition.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) {
    throw new AdmissionError(`reenter unknown stage ${stageId}`);
  }
  const doomed = new Set(definition.stages.slice(idx).map((s) => s.id));
  return bumpRevision({
    ...state,
    receipts: state.receipts.map((r) =>
      doomed.has(r.stageId) ? { ...r, valid: false } : r,
    ),
  });
}

/**
 * Identity-aware invalidation: a receipt invalidates only when its own
 * acceptedIdentity or prerequisiteBindings no longer match the live state —
 * in every stage, not "this stage and everything after." A receipt minted
 * before acceptedIdentity existed invalidates once (SS7 migration).
 *
 * A receipt's workspace component is scoped to the specific paths its own
 * evidence named, not a whole-workspace digest: a graph that builds its
 * candidate incrementally across stages (release's Bump, then Changelog)
 * keeps growing the overall diff by design, and a global digest would
 * spuriously invalidate an earlier stage's receipt every time a later stage
 * touches a path the earlier one never cared about.
 */
export async function invalidateFromStage(state: DurableRunState): Promise<DurableRunState> {
  const liveFingerprintCache = new Map<string, string>();
  let liveCandidate: Promise<string | undefined> | undefined;
  const checks = await Promise.all(
    state.receipts.map(async (r) => {
      if (!r.valid) return true;
      if (r.acceptedIdentity === undefined) return false;
      for (const [key, digest] of Object.entries(r.acceptedIdentity)) {
        const current =
          key === "workspace"
            ? await liveReceiptWorkspaceDigest(state, r, liveFingerprintCache)
            : key === "candidate"
              ? await (liveCandidate ??= liveCandidateDigest(state))
              : currentArtifactDigest(state, key);
        if (current !== digest) return false;
      }
      if (r.prerequisiteBindings !== undefined) {
        for (const [requirementId, binding] of Object.entries(r.prerequisiteBindings)) {
          const admitted = bindingFor(state, requirementId);
          if (admitted?.validatorId !== binding.validatorId || admitted?.version !== binding.version) return false;
        }
      }
      return true;
    }),
  );
  return bumpRevision({
    ...state,
    receipts: state.receipts.map((r, i) => (checks[i] ? r : { ...r, valid: false })),
  });
}

/** `{path: fingerprint}` for every file-kind entry in `evidence`, the basis of a receipt's own workspace identity. */
function fileEvidenceFingerprints(evidence: EvidenceRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of evidence) {
    if (e.kind !== "file") continue;
    const path = (e.payload as { path?: unknown } | undefined)?.path;
    if (typeof path === "string") out[path] = e.fingerprint ?? "";
  }
  return out;
}

/** A digest over `{path: fingerprint}`; undefined when there are no file paths to anchor to. */
function workspaceIdentityDigest(byPath: Record<string, string>): string | undefined {
  return Object.keys(byPath).length === 0 ? undefined : stableDigest(byPath);
}

/**
 * Re-reads the specific paths `r`'s own evidence named and recomputes its
 * workspace digest from their live content, using the same fingerprint
 * (`sha256` of UTF-8 text, "missing" when absent) evidence was recorded
 * with — not `candidateChange`'s git-diff fingerprints, which prefix a
 * `file:`/`exec:` kind and would never match a stored evidence fingerprint.
 * Paths are cached across receipts within one invalidation pass since
 * several receipts (e.g. a later stage that re-observed an earlier stage's
 * file) commonly name the same path.
 */
async function liveReceiptWorkspaceDigest(
  state: DurableRunState,
  r: Receipt,
  cache: Map<string, string>,
): Promise<string | undefined> {
  const refs = new Set(r.evidenceRefs);
  const stored = fileEvidenceFingerprints(state.evidence.filter((e) => refs.has(e.ref)));
  const paths = Object.keys(stored);
  if (paths.length === 0) return undefined;
  const live: Record<string, string> = {};
  for (const path of paths) {
    let fp = cache.get(path);
    if (fp === undefined) {
      const bytes = await readWorktreeFile(state.worktreePath, path).catch(() => undefined);
      fp = bytes === undefined ? "missing" : sha256(bytes);
      cache.set(path, fp);
    }
    live[path] = fp;
  }
  return workspaceIdentityDigest(live);
}

/** The digest of the latest evidence whose producing job declared this resultSchema; anchors a non-workspace requirement's acceptedIdentity component. */
function currentArtifactDigest(state: DurableRunState, resultSchema: string): string | undefined {
  const latest = [...state.evidence].reverse().find((e) => e.resultSchema === resultSchema);
  if (latest === undefined) return undefined;
  const payload = latest.payload !== null && typeof latest.payload === "object" ? (latest.payload as Record<string, unknown>) : latest.payload;
  if (payload === null || typeof payload !== "object") return stableDigest(payload);
  const { producer: _producer, ...content } = payload as Record<string, unknown>;
  void _producer;
  return stableDigest(content);
}

/** The currently admitted binding of every requirement a receipt's evidence depended on, pinned at acceptance time. */
function prerequisiteBindingsFor(
  state: DurableRunState,
  prerequisiteRequirementIds: string[],
  forRequirementId: string,
): Record<string, ValidatorBinding> {
  const out: Record<string, ValidatorBinding> = {};
  for (const id of prerequisiteRequirementIds) {
    const binding = bindingFor(state, id);
    if (!binding) {
      throw new AdmissionError(`no validator binding for prerequisite ${id} of ${forRequirementId}`);
    }
    out[id] = binding;
  }
  return out;
}

function bindingFor(
  state: DurableRunState,
  requirementId: string,
): ValidatorBinding | undefined {
  return (
    state.validatorBindings.find((b) => b.requirementId === requirementId) ??
    state.definition.defaultValidators.find((b) => b.requirementId === requirementId)
  );
}

export interface EvidenceProducer {
  operationId: string;
  stageId: string;
  purpose: string;
  readOnly: boolean;
  kind: string;
  /** Pinned executor identity that produced this evidence, when known. */
  executorId?: string;
  /** For child operations: the agent job that requested it, and its tool call. */
  parentOperationId?: string;
  toolCallId?: string;
}

function assertSeparateReviewer(
  state: DurableRunState,
  evidence: EvidenceRecord[],
): string | undefined {
  const review = [...evidence].reverse().find((e) => e.kind === "review");
  if (!review) {
    return "missing review evidence for separate-reviewer requirement";
  }
  const producer = (review.payload as { producer?: EvidenceProducer } | undefined)?.producer;
  if (!producer) {
    return "review evidence missing producer identity";
  }
  if (!producer.readOnly || producer.purpose !== "review") {
    return "review evidence must come from a read-only review job";
  }
  if (!state.lastWorkOperationId) {
    return "no prior work operation for separate-reviewer check";
  }
  if (producer.operationId === state.lastWorkOperationId) {
    return "reviewer operation must be distinct from the writer";
  }
  return undefined;
}

function bumpRevision(state: DurableRunState): DurableRunState {
  return { ...state, stateRevision: state.stateRevision + 1 };
}

export function newEvidenceRef(state: DurableRunState): string {
  state.evidenceSeq += 1;
  return `ev-g${state.generation}-${state.evidenceSeq}-${randomUUID().slice(0, 8)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
