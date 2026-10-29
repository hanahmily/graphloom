// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { ensureDockerImage } from "@graphloom/runner";

export const SANDBOX_USAGE = "graphloom sandbox pull <image@sha256:digest> [--check]";

/**
 * `graphloom sandbox pull <image@sha256:digest> [--check]`: have a docker
 * sandbox image in the local store before a run. A graph's environment check
 * calls it with the image its profile pins, since a sandboxed job runs with
 * `--pull never` and never reaches the network. With `--check` it only reports
 * whether the image is present. Exits 0 when the image is (or now is) present,
 * 1 when it is missing or the pull failed, 2 for a misuse.
 */
export async function sandboxCommand(args: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "pull") {
    err(`usage: ${SANDBOX_USAGE}`);
    return 2;
  }
  const check = rest.includes("--check");
  const images = rest.filter((a) => a !== "--check");
  const unknown = images.find((a) => a.startsWith("--"));
  if (unknown !== undefined || images.length !== 1) {
    err(`usage: ${SANDBOX_USAGE}`);
    return 2;
  }
  const image = images[0]!;
  if (!image.includes("@sha256:")) {
    err(`graphloom sandbox: ${JSON.stringify(image)} is not pinned by digest; a tag can change under a run. Use name@sha256:<64 hex digits>.`);
    return 2;
  }
  const outcome = await ensureDockerImage(image, { pull: !check });
  switch (outcome.status) {
    case "present":
      out(`present: ${image}`);
      return 0;
    case "pulled":
      out(`pulled: ${image}`);
      return 0;
    case "missing":
      err(`missing: ${outcome.reason}; run graphloom sandbox pull ${image}`);
      return 1;
    case "failed":
      err(`failed: ${outcome.reason}`);
      return 1;
  }
}
