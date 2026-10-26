// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimRunOwner, isClaimStale, readOwnerClaim, readProcessIdentity, reapOwnerProcesses, renewRunOwner, updateOwnerChildPid, type RunOwnerClaim } from "./owner.js";

describe("run ownership", () => {
  it("refuses to claim a live controller after its lease time expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const claim = { ownerId: "live-controller", controllerPid: child.pid!, controllerIdentity: readProcessIdentity(child.pid!)!, claimedAt: new Date(0).toISOString(), expiresAt: 0 };
      await writeFile(path.join(dir, "run.owner.json"), JSON.stringify(claim));
      expect(isClaimStale(claim)).toBe(false);
      await expect(claimRunOwner(dir)).rejects.toThrow("run already owned");
      child.kill("SIGKILL");
      await exited;
      expect(isClaimStale(claim)).toBe(true);
      await expect(claimRunOwner(dir)).resolves.toMatchObject({ controllerPid: process.pid });
    } finally {
      child.kill("SIGKILL");
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes complete owner records while independent readers inspect renewals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    try {
      const claim = await claimRunOwner(dir);
      await Promise.all([
        (async () => { for (let i = 0; i < 100; i++) await renewRunOwner(dir, claim.ownerId); })(),
        (async () => {
          for (let i = 0; i < 200; i++) expect(await readOwnerClaim(dir)).toMatchObject({ ownerId: claim.ownerId });
        })(),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "wrong boot", "wrong start"] as const)("never signals live PIDs with %s identity", async (kind) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    const target = liveProcess();
    try {
      const actual = readProcessIdentity(target.child.pid!)!;
      expect(actual).toBeDefined();
      const identity = kind === "missing" ? undefined : {
        ...actual,
        ...(kind === "wrong boot" ? { bootId: "different-boot" } : { startTime: "0" }),
      };
      const claim: RunOwnerClaim = {
        ownerId: "old-controller", controllerPid: target.child.pid!, childPid: target.child.pid!,
        claimedAt: new Date(0).toISOString(), expiresAt: 0,
        ...(identity !== undefined ? { controllerIdentity: identity, childIdentity: identity } : {}),
      };
      await writeFile(path.join(dir, "run.owner.json"), JSON.stringify(claim));
      expect(isClaimStale(claim)).toBe(kind !== "missing");
      expect(await reapOwnerProcesses(dir)).toEqual({ killedChild: false, signaledController: false });
      expect(() => process.kill(target.child.pid!, 0)).not.toThrow();
      expect(readProcessIdentity(target.child.pid!)).toEqual(actual);
    } finally {
      await target.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("signals only the controller and child whose persisted identities still match", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    const controller = liveProcess();
    const plugin = liveProcess();
    try {
      const claim: RunOwnerClaim = {
        ownerId: "matched-controller", controllerPid: controller.child.pid!, childPid: plugin.child.pid!,
        controllerIdentity: readProcessIdentity(controller.child.pid!)!,
        childIdentity: readProcessIdentity(plugin.child.pid!)!,
        claimedAt: new Date(0).toISOString(), expiresAt: 0,
      };
      await writeFile(path.join(dir, "run.owner.json"), JSON.stringify(claim));
      expect(isClaimStale(claim)).toBe(false);
      expect(await reapOwnerProcesses(dir)).toEqual({ killedChild: true, signaledController: true });
      await Promise.all([controller.exited, plugin.exited]);
      expect(controller.child.signalCode).toBe("SIGTERM");
      expect(plugin.child.signalCode).toBe("SIGKILL");
      expect(isClaimStale(claim)).toBe(true);
    } finally {
      await Promise.all([controller.close(), plugin.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves identities on renewal and does not adopt a reused child PID", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    const first = liveProcess();
    const second = liveProcess();
    try {
      const claim = await claimRunOwner(dir, { childPid: first.child.pid! });
      expect(claim.controllerIdentity).toEqual(readProcessIdentity(process.pid));
      expect(claim.childIdentity).toEqual(readProcessIdentity(first.child.pid!));
      const staleIdentity = { bootId: "old-boot", startTime: "0" };
      await writeFile(path.join(dir, "run.owner.json"), JSON.stringify({ ...claim, childIdentity: staleIdentity }));
      const renewed = await renewRunOwner(dir, claim.ownerId, { childPid: first.child.pid! });
      expect(renewed.controllerIdentity).toEqual(claim.controllerIdentity);
      expect(renewed.childIdentity).toEqual(staleIdentity);
      await updateOwnerChildPid(dir, claim.ownerId, first.child.pid!);
      expect((await readOwnerClaim(dir))?.childIdentity).toEqual(staleIdentity);
      await updateOwnerChildPid(dir, claim.ownerId, second.child.pid!);
      expect(await readOwnerClaim(dir)).toMatchObject({
        controllerIdentity: claim.controllerIdentity,
        childIdentity: readProcessIdentity(second.child.pid!),
      });
      await updateOwnerChildPid(dir, claim.ownerId, undefined);
      expect(await readOwnerClaim(dir)).not.toHaveProperty("childIdentity");
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  });

});


function liveProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return { child, exited, async close() { child.kill("SIGKILL"); await exited; } };
}
