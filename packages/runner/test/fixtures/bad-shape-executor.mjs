/** Child-worker fixture: one executor declares an input shape that cannot be serialized. */
const circular = { type: "object" };
circular.self = circular;

export const executors = [
  {
    id: "acme.shape/circular",
    version: "1",
    effect: "read",
    inputShape: { schema: circular },
    async execute() {
      return { status: "ok", summary: "ran" };
    },
  },
  {
    id: "acme.shape/fine",
    version: "1",
    effect: "read",
    inputShape: { schema: { type: "object" }, example: {} },
    async execute() {
      return { status: "ok", summary: "ran" };
    },
  },
];
