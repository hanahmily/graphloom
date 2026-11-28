// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseTaskYaml } from "./index.js";

/**
 * Golden values: the JSON the task parser produced before `repo:` became
 * optional (computed once from the parser at commit 617560c). A hub run's
 * managed intake digest hashes `JSON.stringify(task)` without sorting keys, so
 * the key order of a task that has `repo:` must never change.
 */
const GOLDEN: ReadonlyArray<readonly [string, string]> = [
  ["graph: g\nrepo: ./r\nrequest: do it\n", '{"graph":"g","repo":"./r","request":"do it"}'],
  ["request: do it\nrepo: ./r\ngraph: g\n", '{"graph":"g","repo":"./r","request":"do it"}'],
  ["graph: g\nrepo: ./r\nrequest: do it\nbase: main\nconfig: cfg.json\n", '{"graph":"g","repo":"./r","request":"do it","config":"cfg.json","base":"main"}'],
  [
    "graph: g\nrepo: ./r\nrequest: do it\ngrants:\n  sourceRepair: true\n  validatorSubstitution: false\n  hostRepair: true\nbudgets:\n  jobs: 5\n  decisions: 7\n",
    '{"graph":"g","repo":"./r","request":"do it","grants":{"sourceRepair":true,"validatorSubstitution":false,"hostRepair":true},"budgets":{"jobs":5,"decisions":7}}',
  ],
  [
    'base: abc123\nconfig: c.json\nbudgets:\n  jobs: 5\ngraph: g\nrepo: "./my repo"\nrequest: "quoted \\"x\\""\ngrants:\n  sourceRepair: yes\n',
    '{"graph":"g","repo":"./my repo","request":"quoted \\"x\\"","grants":{"sourceRepair":true,"validatorSubstitution":false},"budgets":{"jobs":5},"config":"c.json","base":"abc123"}',
  ],
];

/** What `authorizeManagedRun` hashes (managed.ts), with the parts this test does not vary fixed. */
const intakeDigest = (task: unknown): string => createHash("sha256").update(JSON.stringify({ task, config: undefined, repoPath: "/r", pinnedHead: "h", bundle: {} })).digest("hex");

describe("a task with repo: parses as before repo: became optional", () => {
  it.each(GOLDEN)("keeps the key order and the managed intake digest (%#)", (text, golden) => {
    const parsed = parseTaskYaml(text);
    expect(JSON.stringify(parsed)).toBe(golden);
    expect(intakeDigest(parsed)).toBe(intakeDigest(JSON.parse(golden)));
  });
});

describe("an empty repo: is no repository", () => {
  it.each(['repo: ""', "repo: ''", "repo:   ", "repo: \"  \"", "repo:"])("reads %j as absent", (line) => {
    const task = parseTaskYaml(`graph: g\n${line}\nrequest: do it\n`);
    expect("repo" in task).toBe(false);
    expect(JSON.stringify(task)).toBe('{"graph":"g","request":"do it"}');
  });
});
