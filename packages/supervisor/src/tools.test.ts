import { describe, expect, it } from "vitest";
import { createAdmissionTools } from "./tools.js";

type Execute = (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; terminate?: boolean }>;

function actionTool(name: string) {
  const toolbox = createAdmissionTools([{ provider: "p", modelId: "m" }]);
  const tool = toolbox.tools.find((t) => t.name === name)!;
  return { toolbox, execute: (tool as unknown as { execute: Execute }).execute };
}
const dispatchTool = () => actionTool("dispatch");

const job = { stageId: "fix", kind: "agent", purpose: "work", instruction: "Implement the fix." };

describe("admission tools", () => {
  it("rejects work without a writeScope so the model can correct it in the same turn", async () => {
    const { toolbox, execute } = dispatchTool();
    const rejected = await execute("1", { reason: "retry", job });
    expect(rejected.terminate).toBeUndefined();
    expect(rejected.content[0]!.text).toMatch(/^Rejected: .*writeScope/);
    expect(toolbox.proposal()).toBeUndefined();

    const accepted = await execute("2", { reason: "retry", job: { ...job, writeScope: ["pkg/timestamp"] } });
    expect(accepted.terminate).toBe(true);
    expect(toolbox.proposal()).toMatchObject({ action: { type: "dispatch", job: { writeScope: ["pkg/timestamp"] } } });
  });

  it("admits read-only work and other purposes without a writeScope", async () => {
    const { toolbox, execute } = dispatchTool();
    await execute("1", { reason: "look", job: { ...job, purpose: "diagnostic", readOnly: true } });
    expect(toolbox.proposal()).toMatchObject({ action: { job: { purpose: "diagnostic" } } });
  });

  it("rejects observe paths outside the run worktree", async () => {
    const { toolbox, execute } = actionTool("observe");
    for (const p of ["/srv/elsewhere", "../outside"]) {
      const rejected = await execute("1", { reason: "look", observe: { paths: [p] } });
      expect(rejected.content[0]!.text).toMatch(/^Rejected: observe paths are relative/);
    }
    expect(toolbox.proposal()).toBeUndefined();
    await execute("2", { reason: "look", observe: { paths: ["CHANGES.md"], includeWorkspaceManifest: true } });
    expect(toolbox.proposal()).toMatchObject({ action: { type: "observe", observe: { paths: ["CHANGES.md"] } } });
  });
});
