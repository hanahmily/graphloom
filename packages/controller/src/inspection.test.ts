// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord, Receipt } from "@graphloom/sdk";
import { admitValidation } from "./admit.js";
import { HostObservationError } from "./host-validators.js";
import { createRecoveryFence, createSupervisorInspection, type InspectionHooks } from "./inspection.js";
import type { DurableRunState } from "./state.js";

vi.mock("./admit.js", async (importActual) => ({ ...(await importActual<typeof import("./admit.js")>()), admitValidation: vi.fn() }));

/** The supervisor's inspection port (#119), against a state it must not be able to change. */
function setup(overrides: Partial<InspectionHooks> = {}) {
  const evidence: EvidenceRecord[] = [{ ref: "ev-1", kind: "file", generation: 1, payload: { path: "a.txt", bytes: "x" } }];
  const receipts = [{ id: "rcpt-1", stageId: "write", requirementId: "r", valid: true }] as Receipt[];
  const state = {
    evidence,
    receipts,
    worktreePath: "/nonexistent",
    stateRevision: 7,
    definition: { stages: [], requirements: [] },
  } as unknown as DurableRunState;
  const reserved: string[] = [];
  const hooks: InspectionHooks = {
    state: () => state,
    validators: {},
    hasRepairHooks: false,
    reserveProbe: async () => {
      reserved.push("probe");
      return { id: `probe-${reserved.length}` };
    },
    recordProbe: async () => undefined,
    signal: () => undefined,
    recoverHost: async () => undefined,
    ...overrides,
  };
  return { state, hooks, reserved, inspection: createSupervisorInspection(hooks).inspection };
}

describe("supervisor inspection (#119)", () => {
  it("returns copies, so a supervisor cannot change the run's evidence or receipts through what it reads", () => {
    const { state, inspection } = setup();
    inspection.getEvidence("ev-1")!.payload = "tampered";
    (inspection.listEvidence({})[0] as { ref: string }).ref = "ev-evil";
    inspection.listReceipts()[0]!.valid = false;
    inspection.listReceipts().length = 0;
    expect(state.evidence[0]).toMatchObject({ ref: "ev-1", payload: { path: "a.txt", bytes: "x" } });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]!.valid).toBe(true);
  });

  it("does not start a probe or a read once the run is stopping or the call was aborted", async () => {
    const stopping = new AbortController();
    stopping.abort();
    const { inspection, reserved } = setup({ signal: () => stopping.signal });
    await expect(inspection.checkActivation("repair-1")).rejects.toThrow(/stopping/);
    expect(await inspection.readCandidate("a.txt")).toMatchObject({ error: expect.stringMatching(/stopped/) });
    expect(await inspection.diffCandidate()).toHaveProperty("error");

    const call = new AbortController();
    call.abort();
    const live = setup();
    await expect(live.inspection.checkValidate({ stageId: "write" }, call.signal)).rejects.toThrow(/stopping/);
    // Nothing was reserved: an aborted call costs no probe.
    expect(reserved).toEqual([]);
    expect(live.reserved).toEqual([]);
  });

  it("reports what each validator reported, not what receipts were minted: an earlier pass, the failing gate, the requirement never evaluated", async () => {
    // Admission mints no receipt unless every requirement passes, so a partial pass leaves none to infer from.
    vi.mocked(admitValidation).mockResolvedValueOnce({
      state: {} as DurableRunState,
      accepted: false,
      evaluated: true,
      reason: "validation failed: second broke",
      requirements: [
        { requirementId: "first", status: "passed", reason: "first ok" },
        { requirementId: "second", status: "failed", reason: "second broke" },
      ],
    });
    const { state, inspection } = setup();
    (state as unknown as { definition: unknown }).definition = {
      stages: [{ id: "write", name: "Write", requirementIds: ["first", "second", "third"] }],
      requirements: [],
    };
    const probe = await inspection.checkValidate({ stageId: "write" });
    expect(probe).toMatchObject({ accepted: false, evaluated: true, probeId: "probe-1", stateRevision: 7 });
    expect(probe.requirements).toEqual([
      { requirementId: "first", status: "passed", reason: "first ok" },
      { requirementId: "second", status: "failed", reason: "second broke" },
      { requirementId: "third", status: "not_evaluated", reason: "not evaluated: validation failed: second broke" },
    ]);
  });

  it("labels a probe with the revision of the snapshot it evaluated, even if the run moved on meanwhile", async () => {
    const { state, inspection } = setup();
    (state as unknown as { definition: unknown }).definition = { stages: [{ id: "write", name: "Write", requirementIds: ["r"] }], requirements: [] };
    vi.mocked(admitValidation).mockImplementationOnce(async () => {
      // recordFinding saves and bumps the revision while the probe is still evaluating.
      state.stateRevision = 8;
      return { state, accepted: true, evaluated: true, reason: "accepted write", requirements: [{ requirementId: "r", status: "passed", reason: "ok" }] };
    });
    expect(await inspection.checkValidate({ stageId: "write" })).toMatchObject({ accepted: true, stateRevision: 7 });
  });

  it("replaces a plugin host that crashed or timed out in a probe, and answers instead of throwing", async () => {
    const recovered: string[] = [];
    const { state, inspection } = setup({
      recoverHost: async (code) => {
        recovered.push(code);
        return undefined;
      },
    });
    (state as unknown as { definition: unknown }).definition = { stages: [{ id: "write", name: "Write", requirementIds: ["r"] }], requirements: [] };
    vi.mocked(admitValidation).mockRejectedValueOnce(new HostObservationError("timeout", "validator gate host error: timeout: no reply"));
    const probe = await inspection.checkValidate({ stageId: "write" });
    expect(recovered).toEqual(["timeout"]);
    expect(probe).toMatchObject({ accepted: false, evaluated: false, probeId: "probe-1" });
    expect(probe.reason).toMatch(/host error: timeout.*the plugin host was replaced/);

    // A host that cannot be replaced says so.
    const stuck = setup({ recoverHost: async () => "host restart unavailable after child failure" });
    (stuck.state as unknown as { definition: unknown }).definition = { stages: [{ id: "write", name: "Write", requirementIds: ["r"] }], requirements: [] };
    vi.mocked(admitValidation).mockRejectedValueOnce(new HostObservationError("crash", "validator gate host error: crash"));
    expect((await stuck.inspection.checkValidate({ stageId: "write" })).reason).toMatch(/could not be replaced: host restart unavailable/);
  });

  it("kills the git subprocesses of a check when its signal aborts, and leaves other git calls alone", async () => {
    const { candidateChange, withGitCancellation } = await import("./worktree.js");
    const stop = new AbortController();
    const dir = os.tmpdir();
    // Not a git checkout either way; the point is whether the call is cancelled or merely fails.
    const plain = await candidateChange(dir, "HEAD").catch((err: Error) => err);
    expect((plain as Error).name).not.toBe("AbortError");
    stop.abort();
    const cancelled = await withGitCancellation(stop.signal, () => candidateChange(dir, "HEAD")).catch((err: Error) => err);
    expect((cancelled as Error).name).toBe("AbortError");
  });

  it("does not replace the plugin host for a probe that was cancelled before its validator failed", async () => {
    const recovered: string[] = [];
    const { state, inspection } = setup({
      recoverHost: async (code) => {
        recovered.push(code);
        return undefined;
      },
    });
    (state as unknown as { definition: unknown }).definition = { stages: [{ id: "write", name: "Write", requirementIds: ["r"] }], requirements: [] };
    let fail!: () => void;
    vi.mocked(admitValidation).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = () => reject(new HostObservationError("crash", "validator gate host error: crash")))),
    );
    const call = new AbortController();
    const probe = inspection.checkValidate({ stageId: "write" }, call.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    call.abort();
    await expect(probe).rejects.toThrow(/stopped/);
    fail();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recovered).toEqual([]);
  });

  it("lists evidence by stage, kind, generation and candidate digest, combined, in recorded order", () => {
    const rec = (ref: string, kind: EvidenceRecord["kind"], generation: number, candidateDigest?: string, stageId?: string): EvidenceRecord => ({
      ref,
      kind,
      generation,
      ...(candidateDigest !== undefined ? { candidateDigest } : {}),
      ...(stageId !== undefined ? { payload: { producer: { stageId } } } : {}),
    });
    const { state, inspection } = setup();
    state.evidence = [
      rec("e1", "file", 1, "d1", "write"),
      rec("e2", "command", 1, "d1", "write"),
      rec("e3", "file", 2, "d2", "write"),
      rec("e4", "file", 2, "d2", "review"),
      rec("e5", "review", 2, undefined, "review"),
      rec("e6", "file", 2),
    ];
    const refs = (filter: Parameters<typeof inspection.listEvidence>[0]) => inspection.listEvidence(filter).map((e) => e.ref);
    expect(refs({})).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(refs({ stageId: "write" })).toEqual(["e1", "e2", "e3"]);
    expect(refs({ kind: "file" })).toEqual(["e1", "e3", "e4", "e6"]);
    expect(refs({ generation: 2 })).toEqual(["e3", "e4", "e5", "e6"]);
    expect(refs({ candidateDigest: "d1" })).toEqual(["e1", "e2"]);
    expect(refs({ stageId: "write", kind: "file", generation: 2 })).toEqual(["e3"]);
    expect(refs({ stageId: "review", kind: "file", candidateDigest: "d2" })).toEqual(["e4"]);
    expect(refs({ stageId: "nowhere" })).toEqual([]);
  });
});

describe("candidate reads and diffs (#119)", () => {
  const sh = promisify(execFile);
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function worktree() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-candidate-"));
    dirs.push(dir);
    const git = (...args: string[]) => sh("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "T");
    await writeFile(path.join(dir, "kept.txt"), "one\ntwo\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const pinnedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(dir, "kept.txt"), "one\nTWO\n");
    await writeFile(path.join(dir, "new.txt"), "fresh\n");
    await symlink("/etc/passwd", path.join(dir, "link"));
    const base = setup().state;
    (base as unknown as { worktreePath: string; intake: unknown }).worktreePath = dir;
    (base as unknown as { intake: unknown }).intake = { pinnedHead };
    return setup({ state: () => base }).inspection;
  }

  it("reads the candidate's real files and refuses a missing, escaping or symlinked path", async () => {
    const inspection = await worktree();
    expect(await inspection.readCandidate("kept.txt")).toEqual({ text: "one\nTWO\n" });
    expect(await inspection.readCandidate("new.txt")).toEqual({ text: "fresh\n" });
    expect(await inspection.readCandidate("absent.txt")).toEqual({ error: "absent.txt is not a file in the workspace" });
    expect(await inspection.readCandidate("../outside.txt")).toMatchObject({ error: expect.stringMatching(/escapes worktree/) });
    expect(await inspection.readCandidate("link")).toMatchObject({ error: expect.stringMatching(/symlink rejected/) });
  });

  it("diffs tracked changes against the pinned base and names the untracked files", async () => {
    const inspection = await worktree();
    const result = await inspection.diffCandidate();
    expect(result).toHaveProperty("diff");
    const { diff } = result as { diff: string };
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain("# untracked files (read them with read_candidate): ");
    expect(diff).toContain("new.txt");
    expect(diff).toContain("link");
  });

  it("finishes a host replacement already under way when the turn ends, and starts none afterwards", async () => {
    const fence = createRecoveryFence();
    const events: string[] = [];
    let finish!: () => void;
    const replacing = fence.run(async () => {
      events.push("started");
      await new Promise<void>((resolve) => (finish = resolve));
      events.push("replacement installed");
      return undefined;
    })!;
    // Teardown begins while the replacement is still being made: it waits.
    const closing = fence.close().then(() => events.push("closed"));
    expect(fence.run(async () => events.push("started too late"))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["started"]);
    finish();
    await replacing;
    await closing;
    expect(events).toEqual(["started", "replacement installed", "closed"]);
  });

  it("lets concurrent failures of the same host share one replacement, and starts a new one for a later failure", async () => {
    const fence = createRecoveryFence();
    let built = 0;
    let finish!: () => void;
    const first = fence.runOnce("plugin-host", async () => {
      built += 1;
      await new Promise<void>((resolve) => (finish = resolve));
      return built;
    })!;
    const second = fence.runOnce("plugin-host", async () => {
      built += 1;
      return built;
    })!;
    expect(second).toBe(first);
    finish();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    // The failure was handled; a later one is a new dead host.
    expect(await fence.runOnce("plugin-host", async () => ++built)).toBe(2);
    await fence.close();
    expect(fence.runOnce("plugin-host", async () => ++built)).toBeUndefined();
    expect(built).toBe(2);
  });

  it("checks a reverse patch against what a real checkout holds: ignored files are not there", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-checkout-"));
    dirs.push(dir);
    const git = (...args: string[]) => sh("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "T");
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "kept.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const pinnedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(dir, "new.txt"), "fresh\n");
    await writeFile(path.join(dir, "ignored.txt"), "build output\n");
    const base = setup().state;
    (base as unknown as { worktreePath: string }).worktreePath = dir;
    (base as unknown as { intake: unknown }).intake = { pinnedHead };
    const { inspection } = setup({ state: () => base });
    const adds = (file: string, line: string) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;

    // A changed, unignored file is in the checkout: undoing its addition applies.
    expect(await inspection.checkCheckout({ from: "candidate", revertPatch: adds("new.txt", "fresh") })).toMatchObject({ accepted: true });
    // An ignored file exists in the worktree only: the real checkout has nothing to remove.
    const ignored = await inspection.checkCheckout({ from: "candidate", revertPatch: adds("ignored.txt", "build output") });
    expect(ignored).toMatchObject({ accepted: false });
    expect(ignored.reason).toMatch(/revertPatch touches ignored\.txt, which a candidate checkout does not contain/);
    // A patch that deletes a file creates it when reversed: a file added and later removed is not "missing".
    const restores = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed later\n";
    expect(await inspection.checkCheckout({ from: "candidate", revertPatch: restores })).toMatchObject({ accepted: true });
  });
});
