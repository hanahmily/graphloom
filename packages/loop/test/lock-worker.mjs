// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Test worker: opens the loop store on argv[2], reports "held" or "refused" on
// stdout, and (when held) keeps the lock until killed or stdin closes.
import { LoopStore } from "../dist/index.js";

try {
  const store = await LoopStore.open(process.argv[2]);
  process.stdout.write("held\n");
  process.stdin.resume();
  process.stdin.on("end", () => { void store.close().then(() => process.exit(0)); });
} catch {
  process.stdout.write("refused\n");
  process.exit(0);
}
