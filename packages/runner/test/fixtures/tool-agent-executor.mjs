/** Agent-like fixture: calls admitted tools and reserves model requests while it runs. */
export const executors = [
  {
    id: "acme.agent/tooling",
    version: "1",
    effect: "write",
    async execute(input, ctx) {
      const calls = [];
      for (const step of input.steps ?? []) {
        if (step.model) {
          calls.push({ model: await ctx.usage.reserveModelCall() });
          continue;
        }
        const result = await ctx.tools.call({ toolCallId: step.id, tool: step.tool, input: step.input ?? {} });
        calls.push({ tool: step.tool, result });
      }
      if (input.hang) await new Promise(() => undefined);
      return {
        status: "ok",
        summary: `made ${calls.length} calls`,
        evidence: [{ kind: "other", payload: { calls, tools: ctx.tools?.bindings ?? null } }],
      };
    },
  },
];
