/** Child-worker fixture: declares an input shape that shows which environment the worker was given. */
export const executors = [
  {
    id: "acme.env/shape",
    version: "1",
    effect: "read",
    inputSchema: (v) => typeof v === "object" && v !== null,
    inputShape: {
      schema: { type: "object", description: `leak=${process.env.GL_AMBIENT ?? "none"} bound=${process.env.GL_BOUND ?? "none"}` },
    },
    async execute() {
      return { status: "ok", summary: "ran" };
    },
  },
];
