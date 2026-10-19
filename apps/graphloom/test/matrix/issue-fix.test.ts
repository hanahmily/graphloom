import { afterEach, describe, it } from "vitest";
import { createScope, goVersion } from "@graphloom/testkit";
import { CONDITIONS, runCell } from "./matrix.js";

const scope = createScope();
afterEach(() => scope.dispose());

// The fixture repository is a Go module, as in issue-fix-e2e.test.ts. The
// supervisor conditions run in issue-fix-supervisor.test.ts, in parallel.
describe.skipIf(goVersion() === undefined)("issue-fix end to end under each realistic condition (#144)", () => {
  it.each(CONDITIONS.filter((c) => c.supervisor === undefined && (c.graphs?.includes("issue-fix") ?? true)).map((c) => [c.id, c] as const))("%s", async (_id, condition) => {
    await runCell(scope, "issue-fix", condition);
  }, 120_000);
});
