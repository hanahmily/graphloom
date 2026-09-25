/** Built-in package fixture: reports the credential and environment its process received. */
export const executors = [
  {
    id: "graphloom.fixture/echo",
    version: "1",
    effect: "read",
    async execute(_input, ctx) {
      const token = await ctx.credentials.get("fixture");
      return {
        status: "ok",
        summary: `token ${token ?? "none"}`,
        evidence: [
          {
            kind: "other",
            payload: {
              config: process.env.GL_FIXTURE_URL ?? null,
              leaked: process.env.GL_HOST_SECRET ?? null,
            },
          },
        ],
      };
    },
  },
  {
    id: "graphloom.fixture/post",
    version: "1",
    effect: "write",
    async execute() {
      return { status: "ok", summary: "posted" };
    },
  },
];
