import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Plain executor export for child-worker tests (no SDK import required). */
export const executors = [
  {
    id: "acme.hello/write-greeting",
    version: "1",
    effect: "write",
    async execute(_input, ctx) {
      const file = "GREETING.txt";
      await writeFile(path.join(ctx.worktreePath, file), "Hello, GraphLoom!\n", "utf8");
      return {
        status: "ok",
        summary: "custom wrote greeting",
        evidence: [{ kind: "other", payload: { wrote: file } }],
      };
    },
  },
];
