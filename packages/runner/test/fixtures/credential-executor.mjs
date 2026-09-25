/** Child-worker fixture: credential delivery, effect grants, pins, and schemas. */
export const executors = [
  {
    id: "acme.cred/echo",
    version: "2",
    effect: "read",
    inputSchema: (v) => typeof v === "object" && v !== null && typeof v.msg === "string",
    async execute(input, ctx) {
      const token = await ctx.credentials.get("api");
      return {
        status: "ok",
        summary: `echo ${input.msg} with ${token ?? "no token"}`,
        evidence: [{ kind: "other", payload: { seen: token, env: process.env.GL_LEAK ?? null } }],
      };
    },
  },
  {
    id: "acme.cred/post",
    version: "2",
    effect: "write",
    async execute() {
      return { status: "ok", summary: "posted" };
    },
  },
];
