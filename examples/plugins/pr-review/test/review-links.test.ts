// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { computeLeads, type LeadInput } from "../src/leads.js";
import type { SymbolDef } from "../src/kit/symbols.js";
import { REHEARSAL_DESIGN_HEAD, REHEARSAL_HEAD } from "../src/rehearsal.js";
import { writtenDraftFiles } from "../src/reviewdraft.js";
import { simulate } from "./support.js";
import { citeText } from "../src/context.js";

const sym = (id: string, kind: string, body: string, path = "pkg/a/a.go"): SymbolDef => ({ id, path, language: "go", scope: "a", dir: "pkg/a", kind, name: id, qualified: `a.${id}`, exported: true, startLine: 1, endLine: 3, signature: body.split("\n")[0]!, body, change: "new" });

describe("test-gap leads are about callable declarations only", () => {
  const input = (symbols: SymbolDef[]): LeadInput => ({ records: [], groundwork: { symbols, testMap: new Map(), candidates: [], prSimilar: [] }, changes: [], scope: new Set(symbols.map((s) => s.path)), changed: new Set(symbols.map((s) => s.path)), similarity: 0.5, searched: true });

  it("gives an untested func and method a missing-test lead, and an exported constant, a variable or a type none", () => {
    const leads = computeLeads(input([sym("Run", "func", "func Run() {}"), sym("Get", "method", "func (s *S) Get() int { return 1 }"), sym("Limit", "const", "Limit = 10"), sym("Default", "var", "Default = New()"), sym("Opts", "type", "type Opts struct{}")]));
    expect(leads.map((l) => l.subject).sort()).toEqual(["a.Get", "a.Run"]);
  });

  it("counts a function-valued TypeScript const as callable, and a plain one not", () => {
    const ts = (id: string, body: string): SymbolDef => ({ ...sym(id, "const", body, "src/a.ts"), language: "typescript" });
    const leads = computeLeads(input([ts("handler", "export const handler = async (req: Req): Promise<void> => {}"), ts("ONE", "export const ONE = 1;")]));
    expect(leads.map((l) => l.subject)).toEqual(["a.handler"]);
  });
});

describe("a design report of an earlier head", () => {
  it("links this run's findings and leads at this head, and keeps the report's own citations at the design head", () => {
    const sim = simulate({ scenarioName: "design-review-earlier-head" });
    const appendix = writtenDraftFiles(sim.evidence).appendix;
    expect(appendix.state).toBe("read");
    const html = appendix.state === "read" ? appendix.value : "";
    const findings = html.slice(html.indexOf("<h3>Findings</h3>"), html.indexOf("<h3>Draft</h3>"));
    expect(findings).toContain(`/blob/${REHEARSAL_HEAD}/`);
    expect(findings).not.toContain(`/blob/${REHEARSAL_DESIGN_HEAD}/`);
    expect(html).toContain(`/blob/${REHEARSAL_DESIGN_HEAD}/`);
  });
});

describe("the design seed's citations", () => {
  it("keep the tree of a Q&A citation (base, head, dependency) and the side of a report cite", () => {
    expect(citeText({ path: "pkg/a.go", tree: "base", start: 3, end: 5 })).toBe("pkg/a.go:3-5 (base)");
    expect(citeText({ path: "github.com/x/y/z.go", tree: "dependency", start: 1, end: 1 })).toBe("github.com/x/y/z.go:1 (dependency)");
    expect(citeText({ path: "pkg/a.go", tree: "head", start: 2, end: 2 })).toBe("pkg/a.go:2");
    expect(citeText({ path: "pkg/a.go", side: "base", start: 2, end: 2 })).toBe("pkg/a.go:2 (base)");
  });
});
