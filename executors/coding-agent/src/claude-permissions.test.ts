import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateClaudePermission } from "./claude-permissions.js";
import type { CodingSessionOptions } from "./harness.js";

let root: string;
let options: CodingSessionOptions;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "claude-permissions-"));
  options = { cwd: root, writeScope: ["src"], readOnly: false, tools: [], reserveModelCall: async () => true };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function denied(tool: unknown, input: unknown, config = options) {
  expect((await evaluateClaudePermission(tool, input, config)).behavior).toBe("deny");
}

describe("Claude tool permissions", () => {
  it.each(["Agent", "Task"])("allows %s delegation while keeping each delegated tool within the job permissions", async (tool) => {
    const input = { prompt: "Review the current implementation", run_in_background: true };
    const reviewer = { ...options, readOnly: true };
    expect(await evaluateClaudePermission(tool, input, reviewer)).toEqual({ behavior: "allow", updatedInput: input });
    await denied(tool, {});
    await denied(tool, { prompt: "" });
    await denied("Write", { file_path: "src/file.ts" }, reviewer);
    await denied("Bash", { command: "touch src/file.ts" }, reviewer);
  });

  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("allows %s only inside an admitted prefix", async (tool) => {
    const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
    const input = { [field]: path.join(root, "src/new/file.ts"), content: "hello" };
    const result = await evaluateClaudePermission(tool, input, options);
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
    if (result.behavior === "allow") expect(result.updatedInput).toBe(input);
    await denied(tool, { [field]: "src-other/file.ts" });
    await denied(tool, { [field]: "src/../../outside.ts" });
    await denied(tool, { [field]: "src/../outside.ts" });
    await denied(tool, { [field]: "/outside.ts" });
    await denied(tool, { [field]: "src/.git/config" });
    await denied(tool, input, { ...options, writeScope: [] });
    await denied(tool, input, { ...options, readOnly: true });
    await denied(tool, {});
    await denied(tool, { [field]: 123 });
  });

  it("allows the whole workspace except excluded paths", async () => {
    const config = { ...options, writeScope: [".", "!api/proto", "!go.mod"] };
    expect((await evaluateClaudePermission("Write", { file_path: "pkg/scheduler.go" }, config)).behavior).toBe("allow");
    expect((await evaluateClaudePermission("Edit", { file_path: "api/protocol.go" }, config)).behavior).toBe("allow");
    await denied("Edit", { file_path: "api/proto/v1/x.proto" }, config);
    await denied("Write", { file_path: "go.mod" }, config);
    await denied("Write", { file_path: ".git/config" }, config);
  });

  it("rejects symbolic links and hard links even within a permitted prefix", async () => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "outside/file"), "private");
    await symlink(path.join(root, "outside"), path.join(root, "src/alias"));
    await symlink(path.join(root, "outside/file"), path.join(root, "src/link"));
    await link(path.join(root, "outside/file"), path.join(root, "src/hardlink"));
    for (const file_path of ["src/alias/file", "src/alias/new", "src/link", "src/hardlink"]) {
      await denied("Write", { file_path });
    }
  });

  it("fails closed for unknown tools and malformed envelopes", async () => {
    for (const input of [null, undefined, [], "text", 12]) await denied("Read", input);
    await denied(undefined, {});
    await denied("Task", {});
    await denied("Bash", {});
    await denied("mcp__other__write", {});
  });

  it("permits read tools and structured output during read-only jobs", async () => {
    for (const tool of ["Read", "Grep", "Glob", "StructuredOutput"]) {
      expect((await evaluateClaudePermission(tool, {}, { ...options, readOnly: true })).behavior).toBe("allow");
    }
    await denied("Bash", { command: "touch src/file" }, { ...options, readOnly: true });
    expect((await evaluateClaudePermission("Bash", { command: "npm test" }, options)).behavior).toBe("allow");
  });

  it("admits only configured GraphLoom tools and denies write effects to reviewers", async () => {
    const config: CodingSessionOptions = {
      ...options,
      tools: [
        { name: "inspect", effect: "read", call: async () => ({ status: "ok", summary: "done" }) },
        { name: "modify", effect: "write", call: async () => ({ status: "ok", summary: "done" }) },
        { name: "unknownEffect", effect: "ambiguous", call: async () => ({ status: "ok", summary: "done" }) },
      ],
    };
    expect((await evaluateClaudePermission("mcp__graphloom__inspect", {}, { ...config, readOnly: true })).behavior).toBe("allow");
    expect((await evaluateClaudePermission("mcp__graphloom__modify", {}, config)).behavior).toBe("allow");
    await denied("mcp__graphloom__modify", {}, { ...config, readOnly: true });
    await denied("mcp__graphloom__unknownEffect", {}, { ...config, readOnly: true });
    await denied("mcp__graphloom__missing", {}, config);
  });
});
