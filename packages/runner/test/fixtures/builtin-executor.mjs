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
    id: "graphloom.fixture/probe",
    version: "1",
    effect: "read",
    async execute(input) {
      const attempt = async (fn) => {
        try {
          await fn();
          return "allowed";
        } catch (err) {
          return err.code ?? String(err);
        }
      };
      const fs = await import("node:fs");
      const token = await attempt(() => undefined);
      return {
        status: "ok",
        summary: "probed",
        evidence: [
          {
            kind: "other",
            payload: {
              control: token,
              readOwnPackage: await attempt(() => fs.readFileSync(new URL("../../package.json", import.meta.url))),
              readOutside: await attempt(() => fs.readFileSync(input.outside)),
              write: await attempt(() => fs.writeFileSync(`${input.outside}.written`, "x")),
              spawn: await attempt(async () => (await import("node:child_process")).execFileSync(process.execPath, ["-e", "1"])),
              worker: await attempt(async () => {
                const { Worker } = await import("node:worker_threads");
                await new Promise((resolve, reject) => {
                  const w = new Worker("1", { eval: true });
                  w.once("error", reject);
                  w.once("exit", resolve);
                });
              }),
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
