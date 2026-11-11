// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The template of the config repro.sh generates for one finding's TypeScript test (design §8.2): the workspace's own config
// with the test set to the one scratch file, and one `enforce: "pre"` plugin whose resolveId resolves every import of the
// scratch file as if it were imported from the module's directory, so relative imports, workspace packages, node_modules and
// vi.mock paths resolve exactly as for a test the author would add there. The @TOKENS@ are filled by repro.sh with paths only
// it computed (never text of the pull request).
import * as baseModule from "@BASE@";

const scratch = "@SCRATCH@";
const virtual = "@VIRTUAL@";

const loaded = baseModule.default ?? {};
const base = typeof loaded === "function" ? await loaded({ command: "serve", mode: "test" }) : loaded;

const resolver = {
  name: "graphloom-repro-resolve",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (importer === undefined || importer.split("?")[0] !== scratch || source.startsWith("\0")) return null;
    return this.resolve(source, virtual, { ...options, skipSelf: true });
  },
};

const { workspace: _workspace, ...rest } = base.test ?? {};

export default {
  ...base,
  root: "@WS@",
  plugins: [resolver, ...(Array.isArray(base.plugins) ? base.plugins : [])],
  server: { ...(base.server ?? {}), fs: { ...((base.server ?? {}).fs ?? {}), allow: ["@TMP@", "@WS@", "@ROOT@"] } },
  // Only the scratch test runs: what redirects test discovery (the repository's projects or workspace, a shard, a name filter) is
  // dropped (the keys are omitted, not set to undefined: Vitest 4 rejects a `workspace` key of any value); its transform, resolve,
  // setup and environment settings stay.
  test: { ...rest, projects: undefined, shard: undefined, testNamePattern: undefined, dir: "@TMP@", include: [scratch], exclude: [], typecheck: { enabled: false }, coverage: { enabled: false }, watch: false },
};
