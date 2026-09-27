import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimRunOwner, isClaimStale, readOwnerClaim, renewRunOwner } from "./owner.js";

describe("run ownership", () => {
  it("refuses to claim a live controller after its lease time expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-owner-test-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const claim = { ownerId: "live-controller", controllerPid: child.pid!, claimedAt: new Date(0).toISOString(), expiresAt: 0 };
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
});
