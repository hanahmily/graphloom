#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors
// Builds the two animated terminal SVGs in docs/assets/ and copies them to site/assets/.
// Every quoted line comes from a recorded run (the pull request that added this script
// maps each line to its source file or command); the watcher's intermediate moves are
// rebuilt from the run's stage timeline in the form `graphloom watch` prints.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const W = 900;
const LH = 17;
const TOP = 52;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const COLORS = { fg: "#c9d1d9", dim: "#8b949e", prompt: "#7ee787", cmd: "#f0f6fc", blue: "#79c0ff", red: "#ff7b72", green: "#7ee787", yellow: "#e3b341", mag: "#d2a8ff" };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lines are [seconds, segments, tag]; segments are [class, text] pairs. */
function build({ name, title, desc, lines, total, hold }) {
  const groups = new Map();
  const rows = lines.map(([t, segs, tag], i) => {
    const key = t.toFixed(2);
    if (!groups.has(key)) groups.set(key, groups.size);
    return { i, key, segs, tag };
  });
  const height = TOP + rows.length * LH + 22;
  let css = `text{font-family:${FONT};font-size:12.5px;white-space:pre}` + Object.entries(COLORS).map(([k, v]) => `.${k}{fill:${v}}`).join("") + ".b{font-weight:700}.tag{text-anchor:end}";
  css += `.l{animation-duration:${total}s;animation-iteration-count:infinite;animation-timing-function:steps(1,end)}`;
  for (const [key, g] of groups) {
    const p = (Number(key) / total) * 100;
    const end = ((total - hold) / total) * 100;
    css += `.g${g}{animation-name:k${g}}@keyframes k${g}{0%{opacity:0}${p.toFixed(3)}%{opacity:1}${end.toFixed(2)}%{opacity:0}100%{opacity:0}}`;
  }
  css += "@media (prefers-reduced-motion:reduce){.l{animation:none!important;opacity:1!important}}";
  const body = rows
    .map((r) => {
      const y = TOP + (r.i + 1) * LH - 5;
      const tspans = r.segs.map(([c, t]) => `<tspan class="${c}">${esc(t)}</tspan>`).join("");
      const tag = r.tag ? `<text x="${W - 20}" y="${y}" class="dim tag">${esc(r.tag)}</text>` : "";
      return `<g class="l g${groups.get(r.key)}"><text x="20" y="${y}" xml:space="preserve">${tspans}</text>${tag}</g>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img" aria-labelledby="${name}-t ${name}-d">` +
    `<title id="${name}-t">${esc(title)}</title><desc id="${name}-d">${esc(desc)}</desc>` +
    `<style>${css}</style>` +
    `<rect width="${W}" height="${height}" rx="10" fill="#0d1117" stroke="#30363d"/>` +
    `<circle cx="22" cy="20" r="6" fill="#ff5f56"/><circle cx="42" cy="20" r="6" fill="#ffbd2e"/><circle cx="62" cy="20" r="6" fill="#27c93f"/>` +
    `<text x="${W / 2}" y="24" text-anchor="middle" class="dim" style="font-size:12px">${esc(title)}</text>` +
    `<line x1="0" y1="38" x2="${W}" y2="38" stroke="#30363d"/>` +
    body +
    `</svg>\n`;
  for (const d of ["docs/assets", "site/assets"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, `${name}.svg`), svg);
  }
  console.log(name, rows.length, "lines", svg.length, "bytes");
}

/** A number sets the clock; every other item is a line (blank included) that follows 0.22 s after the last. */
function script(items) {
  const out = [];
  let t = 0;
  for (const it of items) {
    if (typeof it === "number") t = it;
    else {
      out.push([t, ...it]);
      t += 0.22;
    }
  }
  return out;
}
const $ = (cmd) => [[["prompt b", "$ "], ["cmd b", cmd]]];
const B = [[["fg", ""]]];
const c = (cls, text, tag) => [[[cls, text]], tag];

// ---------- pr-review on apache/skywalking-banyandb#1460 ----------
const pr = [
  0.3, $("graphloom task new pr-review apache/skywalking-banyandb#1460 --repo … --profile profile.json"),
  1.4, $("cat task.yaml"),
  c("fg", "graph: pr-review"),
  c("fg", "config: profile.json"),
  c("fg", 'request: "Review on apache/skywalking-banyandb#1460 at 62a1344d82e71ad3ac5f74e18848f18c1b126b56."'),
  B,
  3.4, $("graphloom run task.yaml"),
  c("dim", "supervisor: pi (plugin: the plugin's preference (pi, claude-code, codex): pi)"),
  c("dim", "graphloom: run 78e26eb2-57c started; state …/graphloom-state/78e26eb2-57c"),
  B,
  5.6, $("graphloom watch 78e26eb2-57c"),
  c("dim", "# earlier moves not shown: Fetch to Review ran first (Round 1: no open issue); the last move and the stop:"),
  B,
  9.0, c("blue", "[graphloom watch] move · run 78e26eb2-57c · stopped · draft#1", "+20m 35s"),
  c("fg", "- entered stage draft, attempt 1"),
  c("fg", "- stage review accepted"),
  c("fg", "- stage draft accepted"),
  c("fg", "7/8 stages complete"),
  10.5, c("yellow b", "[graphloom watch] attention · run 78e26eb2-57c · stopped · draft#1"),
  c("yellow", "stopped: stopped (posting not enabled) · final"),
  c("fg", `blocker: "draft ready; posting is not enabled (set the runner config's github.writeTokenEnv and …"`),
  B,
  13.0, c("dim", "# the operator enables the GitHub write token and resumes; nothing is posted before that"),
  $("graphloom resume 78e26eb2-57c"),
  15.0, $("cat .graphloom-watch/stopped"),
  c("green", "succeeded 78e26eb2-57c complete"),
  16.5, $("graphloom stats 78e26eb2-57c | head -2"),
  c("fg", "run 78e26eb2-57c  pr-review@0.23.1  succeeded (complete)"),
  c("fg", "recorded 2026-11-04T12:27:10.325Z .. 2026-11-04T13:08:17.113Z (41m 07s wall clock, stops included)"),
  B,
  18.5, $("gh api repos/apache/skywalking-banyandb/pulls/1460/reviews/5768856844 --jq .body | grep -v '^<!--'"),
  21.5, c("mag b", "Changes requested: 2 open"),
  B,
  c("fg", "Round 1 (design and architecture, from the change report and its questions): no open issue."),
  B,
  c("fg", "Round 2 (details, functionality, algorithms): 2 open findings. Reviewed the whole pull request, 5 files fo…"),
  B,
  c("fg", "2 items are commented on the diff."),
  B,
  24.0, $("gh api …/reviews/5768856844/comments --jq '.[] | .path, (.body | split(\"\\n\")[0])'"),
  c("blue", "mcp/src/config.ts"),
  c("fg", "**[P2] minor** · maintainability · non-behavioral"),
  c("blue", "mcp/src/config.test.ts"),
  c("fg", "**[P2] minor** · maintainability · non-behavioral"),
  B,
  26.5, c("green b", "→ https://github.com/apache/skywalking-banyandb/pull/1460#pullrequestreview-5768856844"),
];
build({
  name: "demo-pr-review",
  title: "graphloom · pr-review on apache/skywalking-banyandb#1460",
  desc: "A recorded GraphLoom run reviewing apache/skywalking-banyandb pull request 1460. The task is created and run, the watcher reports the last move, to Draft, the run stops because posting is not enabled, the operator enables it and resumes, the run succeeds after 41 minutes, and the posted review begins Changes requested: 2 open, with two inline comments.",
  lines: script(pr),
  total: 35,
  hold: 1.5,
});

// ---------- issue-fix on apache/skywalking#14169 ----------
const fix = [
  0.3, $("graphloom run task-decisions.yaml"),
  c("dim", "supervisor: pi (plugin: the plugin's preference (pi, claude-code, codex): pi)"),
  c("dim", "graphloom: run ab228e59-834 started; state …/graphloom-state/ab228e59-834"),
  1.8, $("sed -n '/^request/,$p' task-decisions.yaml | grep . | head -3"),
  c("fg", "request: |"),
  c("fg", "  Fix apache/skywalking#14169. Decisions:"),
  c("fg", "  Bump the file format version: CurrentVersion becomes 1.6.0, and versions.yml lists 1.4.0, 1.5.0, 1.6.0."),
  B,
  4.0, c("yellow b", "PLAN", "planner · claude-code"),
  c("fg", "apache/skywalking-banyandb#1237 changed the trace blockMetadata on-disk layout without bumping the"),
  c("fg", "segment file format version, so 0.11 accepts 0.10 trace segments (both 1.5.0) and every query that …"),
  c("fg", "test: ./pkg/fileformat  TestCurrentVersionAndCompatibleList"),
  c("fg", 'The operator\'s Decisions: CurrentVersion == "1.6.0" and CompatibleVersions() == [1.4.0, 1.5.0, 1.6.0]. …'),
  B,
  7.0, c("red b", "RED", "on the base"),
  c("dim", "=== RUN   TestCurrentVersionAndCompatibleList"),
  c("fg", "    version_test.go:31:"),
  c("fg", "        Error:      Not equal:"),
  c("fg", '        expected: "1.6.0"'),
  c("fg", '        actual  : "1.5.0"'),
  c("fg", "    version_test.go:32:"),
  c("fg", "        Error:      Not equal:"),
  c("fg", '        expected: []string{"1.4.0", "1.5.0", "1.6.0"}'),
  c("fg", '        actual  : []string{"1.4.0", "1.5.0"}'),
  c("red", "--- FAIL: TestCurrentVersionAndCompatibleList (0.00s)"),
  c("red", "FAIL    github.com/apache/skywalking-banyandb/pkg/fileformat    0.004s"),
  B,
  11.0, c("yellow b", "FIX", "6 files · PR #1459"),
  c("fg", "  CHANGES.md                                       | +2"),
  c("fg", "  docs/operation/upgrade.md                        | +6"),
  c("fg", '  pkg/fileformat/version.go                        | +1 -1   CurrentVersion = "1.6.0"'),
  c("fg", "  pkg/fileformat/version_test.go                   | +6"),
  c("fg", "  pkg/fileformat/versions.yml                      | +1"),
  c("fg", "  test/e2e-v2/cases/cluster/expected/node-info.yml | +4 -2"),
  B,
  14.0, c("green b", "GREEN", "with the fix"),
  c("dim", "=== RUN   TestCurrentVersionAndCompatibleList"),
  c("green", "--- PASS: TestCurrentVersionAndCompatibleList (0.00s)"),
  c("green", "ok      github.com/apache/skywalking-banyandb/pkg/fileformat    0.004s"),
  c("fg", "build exit 0 (2m 03s)   check exit 0 (1m 27s)"),
  B,
  17.5, c("blue b", "REVIEW", "independent code-review job"),
  c("fg", "contract dedupe-1: 0 comments, 6/6 files reviewed"),
  B,
  20.0, $("graphloom inspect ab228e59-834 | jq -r '.receipts[] | \"\\(.requirementId) \\(.validatorId) \\(.valid)\"'"),
  c("fg", "decisions-recorded decisions-recorded true"),
  c("fg", "reproduces red-reproduces true"),
  c("fg", "passes green-passes true"),
  c("fg", "builds build-checks true"),
  c("fg", "in-scope write-scope true"),
  c("fg", "changelog-entry changes-entry true"),
  c("fg", "code-review open-code-review true"),
  22.5, $("graphloom stats ab228e59-834 | head -2"),
  c("fg", "run ab228e59-834  issue-fix@0.16.0  succeeded (complete)"),
  c("fg", "recorded 2026-11-03T12:23:35.993Z .. 2026-11-03T12:33:27.563Z (9m 52s wall clock, stops included)"),
  B,
  25.0, c("mag b", "DELIVERED", "branch fix/14169 · commit 3c0fdc48099b…"),
  c("fg", "Bump segment file format to 1.6.0 and document that 0.10 trace data is unreadable"),
  c("green b", "→ https://github.com/apache/skywalking-banyandb/pull/1459"),
];
build({
  name: "demo-issue-fix",
  title: "graphloom · issue-fix on apache/skywalking#14169",
  desc: "A recorded GraphLoom issue-fix run for apache/skywalking issue 14169 in BanyanDB, succeeded in 9 minutes 52 seconds. The planner names the regression test, the test fails on the base (RED) with expected 1.6.0 and actual 1.5.0, the fix touches six files, the same test passes (GREEN), the independent review accepts, and the branch fix/14169 is delivered. It became pull request 1459.",
  lines: script(fix),
  total: 33,
  hold: 1.5,
});
