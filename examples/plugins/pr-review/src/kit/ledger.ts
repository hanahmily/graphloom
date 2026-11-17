// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The per-PR ledger (design §9.1, design-pr-review-split §5) is a Git ref in the operator's review clone. Since 0.27 it is
 * `graphloom-pr-ledger-v2`: a top-level `ledger.json` and a section per graph, `design/` (round 1: heads, `N1`, `Q<n>`, the latest
 * report.json, qa.json and necessity.json) and `review/` (round 2: heads and `F<n>`); `ledgerv2.ts` holds the layout and the
 * migration of a v1 ledger. A write advances only its own section, by compare-and-swap: it checks that the ref's current value
 * holds, at that section, exactly the section's baseline (this run's latest accepted write of it, else what Fetch read), carries
 * the other section from the current value unchanged, and retries a lost `update-ref` race at most three times. A section that is
 * not its baseline exits LEDGER_MOVED and the run stops retryably "ledger moved". After Answers, `ledger-write` advances the
 * `design` section with this head's report and Q&A; after the review is posted, Publish advances the sections the review records
 * (`publish.ts`, `ledger-published`).
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { parseLedger, type Ledger } from "./commands.js";
import { COMMAND, LEDGER_JSON_FILE, LEDGER_MD_FILE, LEDGER_MOVED, LEDGER_REVIEW_JSON_FILE, LEDGER_REVIEW_MD_FILE, NECESSITY_JSON, PART_BASE, QA_JSON, REPORT_JSON, ledgerRef } from "./constants.js";
import { commandRuns, isObject, reportText, succeeded, type CommandRun } from "./evidence.js";
import type { PullRequest } from "./request.js";
import { partCommands, sha256 } from "./parts.js";
import { writeChunks } from "./write.js";
import { LEDGER_V1, LEDGER_V2, migratedTrees, migrateV1, reviewMarkdown, topLedgerJson, type Pull, type Section, type Sections } from "./ledgerv2.js";

/** The schema a ledger of 0.21 to 0.26 has; a v2 ledger's top-level `ledger.json` has `LEDGER_V2`. */
export const LEDGER_SCHEMA = LEDGER_V1;
const MAX_COMMAND_BYTES = 200_000;
/** Characters of the prior ledger's registry one command prints (a command report holds 65,536 bytes). */
const PRIOR_CHUNK = 30_000;

export const GIT_IDENTITY = "export GIT_AUTHOR_NAME=graphloom GIT_AUTHOR_EMAIL=graphloom@localhost GIT_COMMITTER_NAME=graphloom GIT_COMMITTER_EMAIL=graphloom@localhost";

/** The shell prelude of a section write: the identity, git with no hook, the tab, and how a commit is told to be a v2 ledger. */
export const SECTION_PRELUDE =
  GIT_IDENTITY +
  String.raw`
g() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
tab=$(printf '\t'); try=0
v2() { g cat-file blob "$1:ledger.json" 2>/dev/null | head -c 64 | grep -q '"schema":"` +
  LEDGER_V2 +
  String.raw`"'; }
`;

/** The record a section write prints: the new commit, the value it swapped from, and each section's subtree in the new commit. */
export const SECTION_RECORD = String.raw`echo "advanced $new"; echo "cur $cur"; for s in design review; do echo "$s $(g rev-parse --verify --quiet "$new:$s" || echo absent)"; done`;

/**
 * The design section's write after Answers (design-pr-review-split §5.2). `$want` is the section's baseline; `$top` the v2
 * top-level `ledger.json` a created or migrated ledger gets; `$mig` says whether `old` is a v1 commit (`v1`) whose migration has a
 * review section (`v1+review`, read from its files). The section's files come from the argv (a count of JSON chunks, then the
 * markdown) or from part-set files (`files`), beside the worktree's report.json, qa.json and necessity.json.
 */
const WRITE =
  String.raw`set -eu; ref="$1"; old="$2"; msg="$3"; sec="$4"; want="$5"; top="$6"; mig="$7"; shift 9; mode="$1"; shift
` +
  SECTION_PRELUDE +
  String.raw`if [ "$mode" = files ]; then a=$(g hash-object -w "$1"); b=$(g hash-object -w "$2")
else json=""; n="$mode"; while [ "$n" -gt 0 ]; do json="$json$1"; shift; n=$((n - 1)); done
md=""; for part in "$@"; do md="$md$part"; done
a=$(printf '%s' "$json" | g hash-object -w --stdin); b=$(printf '%s' "$md" | g hash-object -w --stdin); fi
c=$(g hash-object -w ` +
  QA_JSON +
  String.raw`); d=$(g hash-object -w ` +
  REPORT_JSON +
  String.raw`); e=$(g hash-object -w ` +
  NECESSITY_JSON +
  String.raw`)
sub=$(printf '100644 blob %s\tledger.json\n100644 blob %s\tledger.md\n100644 blob %s\tnecessity.json\n100644 blob %s\tqa.json\n100644 blob %s\treport.json\n' "$a" "$b" "$e" "$c" "$d" | g mktree)
t=$(printf '%s' "$top" | g hash-object -w --stdin); r=""
if [ "$mig" = v1+review ]; then rj=$(g hash-object -w ` +
  LEDGER_REVIEW_JSON_FILE +
  String.raw`); rmd=$(g hash-object -w ` +
  LEDGER_REVIEW_MD_FILE +
  String.raw`); r=$(printf '100644 blob %s\tledger.json\n100644 blob %s\tledger.md\n' "$rj" "$rmd" | g mktree); fi
zero=$(g hash-object --stdin </dev/null | tr '0-9a-f' '0')
while :; do
if cur=$(g rev-parse --verify --quiet "$ref^{commit}"); then if v2 "$cur"; then kind=v2; else kind=v1; fi; else cur=absent; kind=none; fi
if [ "$kind" = v2 ]; then have=$(g rev-parse --verify --quiet "$cur:$sec" || echo absent)
elif [ "$kind" = none ]; then have=absent
elif [ "$cur" = "$old" ] && [ "$mig" != - ]; then have="$want"
else have="a v1 ledger other than $old"; fi
if [ "$have" != "$want" ]; then echo "ledger moved: its $sec section is $have, not the baseline $want" >&2; exit ` +
  String(LEDGER_MOVED) +
  String.raw`; fi
if [ "$kind" = v2 ]; then tree=$({ g ls-tree "$cur" | grep -v "$tab$sec\$" || true; printf '040000 tree %s\t%s\n' "$sub" "$sec"; } | g mktree)
else tree=$({ printf '100644 blob %s\tledger.json\n040000 tree %s\t%s\n' "$t" "$sub" "$sec"; if [ "$kind" = v1 ] && [ -n "$r" ]; then printf '040000 tree %s\treview\n' "$r"; fi; } | g mktree); fi
if [ "$cur" = absent ]; then expect="$zero"; new=$(g commit-tree "$tree" -m "$msg"); else expect="$cur"; new=$(g commit-tree "$tree" -p "$cur" -m "$msg"); fi
if g update-ref "$ref" "$new" "$expect" 2>/dev/null; then ` +
  SECTION_RECORD +
  String.raw`; exit 0; fi
try=$((try + 1)); if [ "$try" -gt 3 ]; then echo "ledger moved: the compare-and-swap lost $try races" >&2; exit ` +
  String(LEDGER_MOVED) +
  String.raw`; fi
done`;

/** What the ledger commit is for, as its message says. */
export const ledgerMessage = (pr: PullRequest): string => `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: report and Q&A`;

/** What a write migrates: nothing (the prior ledger is absent or v2), or a v1 commit, with the review section its migration builds. */
export type Migration = { from: "none" } | { from: "v1"; review: { json: string; markdown: string } | undefined };

const migArgs = (m: Migration): string[] =>
  m.from === "none" ? ["-", "-", "-"] : m.review === undefined ? ["v1", "-", "-"] : ["v1+review", sha256(m.review.json), sha256(m.review.markdown)];

/** The argv positions of a `ledger-write`: the script's `$0` is the id, then the ref, the old value, the message, the section, its baseline, the top-level ledger.json, the migration (and its files' digests), and the mode. */
const AT = { id: 3, ref: 4, old: 5, msg: 6, section: 7, baseline: 8, top: 9, mig: 10, migJson: 11, migMd: 12, mode: 13 } as const;

/**
 * Advances the design section by compare-and-swap with the ledger files in the argv, or undefined when they do not fit one command.
 * `old` is the value the latest ledger read saw (`absent` when it read none), `baseline` the section's baseline (§5.2).
 */
export function ledgerWriteCommand(pr: PullRequest, old: string, baseline: string, json: string, markdown: string, migration: Migration = { from: "none" }): EnvironmentCommand | undefined {
  const parts = writeChunks(json);
  const md = writeChunks(markdown);
  const argv = ["sh", "-c", WRITE, COMMAND.ledgerWrite, ledgerRef(pr.owner, pr.repo, pr.number), old, ledgerMessage(pr), "design", baseline, topLedgerJson(pr), ...migArgs(migration), String(parts.length), ...parts, ...md];
  if (argv.length > 64 || Buffer.byteLength(JSON.stringify(argv), "utf8") > MAX_COMMAND_BYTES) return undefined;
  return { id: COMMAND.ledgerWrite, argv };
}

/**
 * What advancing the design section takes: the commands that first write the files the write reads (a migrated review section,
 * and the section's own files when they do not fit one command; a part set each, design §6.6), then the compare-and-swap itself.
 */
export function ledgerWriteCommands(pr: PullRequest, old: string, baseline: string, json: string, markdown: string, migration: Migration = { from: "none" }): { parts: EnvironmentCommand[]; write: EnvironmentCommand } {
  const migrated = migration.from === "v1" && migration.review !== undefined ? [...partCommands(PART_BASE.ledgerReviewJson, LEDGER_REVIEW_JSON_FILE, migration.review.json), ...partCommands(PART_BASE.ledgerReviewMd, LEDGER_REVIEW_MD_FILE, migration.review.markdown)] : [];
  const single = ledgerWriteCommand(pr, old, baseline, json, markdown, migration);
  if (single !== undefined) return { parts: migrated, write: single };
  const parts = [...migrated, ...partCommands(PART_BASE.ledgerJson, LEDGER_JSON_FILE, json), ...partCommands(PART_BASE.ledgerMd, LEDGER_MD_FILE, markdown)];
  const argv = ["sh", "-c", WRITE, COMMAND.ledgerWrite, ledgerRef(pr.owner, pr.repo, pr.number), old, ledgerMessage(pr), "design", baseline, topLedgerJson(pr), ...migArgs(migration), "files", LEDGER_JSON_FILE, LEDGER_MD_FILE, sha256(json), sha256(markdown)];
  return { parts, write: { id: COMMAND.ledgerWrite, argv } };
}

export interface WrittenLedger {
  ref: string;
  old: string;
  section: string;
  baseline: string;
  top: string;
  /** `-`, `v1` or `v1+review`, with the digests of the migrated review section's files. */
  migration: { mode: string; json: string; markdown: string };
  json: string;
  markdown: string;
  /** The digests of the section's files, for a write that reads them from part-set files. */
  files?: { json: string; markdown: string };
}

/** What a `ledger-write` argv carried (the section's files are empty for a write that reads them from part-set files). */
export function writtenLedger(argv: readonly string[]): WrittenLedger | undefined {
  if (argv[AT.id] !== COMMAND.ledgerWrite) return undefined;
  const head = { ref: argv[AT.ref] ?? "", old: argv[AT.old] ?? "", section: argv[AT.section] ?? "", baseline: argv[AT.baseline] ?? "", top: argv[AT.top] ?? "", migration: { mode: argv[AT.mig] ?? "", json: argv[AT.migJson] ?? "", markdown: argv[AT.migMd] ?? "" } };
  if (argv[AT.mode] === "files") return { ...head, json: "", markdown: "", files: { json: argv[AT.mode + 3] ?? "", markdown: argv[AT.mode + 4] ?? "" } };
  const n = Number(argv[AT.mode]);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return { ...head, json: argv.slice(AT.mode + 1, AT.mode + 1 + n).join(""), markdown: argv.slice(AT.mode + 1 + n).join("") };
}

/** What a section write's record says: the new commit, the value it swapped from, and each section's subtree in the new commit. */
export interface SectionRecord {
  advanced: string;
  cur: string;
  sections: Partial<Record<Section, string>>;
}

export function parseSectionRecord(text: string): SectionRecord | undefined {
  const kv = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = /^(advanced|cur|design|review) (\S+)$/.exec(raw.trim());
    if (m !== null) kv.set(m[1]!, m[2]!);
  }
  const advanced = kv.get("advanced");
  if (advanced === undefined) return undefined;
  return { advanced, cur: kv.get("cur") ?? "", sections: { ...(kv.has("design") ? { design: kv.get("design")! } : {}), ...(kv.has("review") ? { review: kv.get("review")! } : {}) } };
}

// ---- reading the prior ledger ----

/**
 * The part of a prior `ledger.json` (v1, or a v2 section's) a new ledger keeps: its schema, its heads, its questions' ids and keys
 * (not their answers) and its posted items (`findings`, a v2 design section's `items`), which a later run continues from (design §9)
 * and this ledger carries on. A large run's ledger is mostly its Q&A (a #1445-sized one passed 89 KB), past what a command report
 * holds whole, so the command prints only these (`node` reads the JSON; git's own status fails the command, since a pipe would hide it).
 */
const PRIOR_EXTRACT = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const v=JSON.parse(s);const c=(t)=>typeof t==="string"&&t.length>4000?t.slice(0,4000):t;
const qa=(Array.isArray(v.qa)?v.qa:[]).map((q)=>({id:q.id,type:q.type,key:q.key,symbol:q.symbol,item:q.item,status:q.status,state:q.state}));
const clip=(f)=>({...f,body:c(f.body),text:c(f.text)});const findings=(Array.isArray(v.findings)?v.findings:[]).map(clip);const items=Array.isArray(v.items)?v.items.map(clip):undefined;
const r=JSON.stringify({schema:v.schema,heads:v.heads,qa,findings,items}).replace(/[\u007f-￿]/g,(m)=>"\\u"+m.charCodeAt(0).toString(16).padStart(4,"0"));
const n=Math.max(1,Math.ceil(r.length/${PRIOR_CHUNK}));const k=Number(process.argv[1]);
const h=require("crypto").createHash("sha256").update(r).digest("hex");
process.stdout.write("graphloom-prior "+k+" "+n+" "+h+"\n"+r.slice(k*${PRIOR_CHUNK},(k+1)*${PRIOR_CHUNK}))})`;

const ROOT_SHOW = 'set -eu; j=$(git -c core.hooksPath=/dev/null show "$1:ledger.json"); printf \'%s\' "$j" | "$2" -e "$3" "$4" > "$GRAPHLOOM_REPORT_FILE"';
/** A section's file: the same extract, or `graphloom-prior-absent` when the commit has no such section. */
const SECTION_SHOW =
  'set -eu; git -c core.hooksPath=/dev/null cat-file -e "$1^{commit}"; if ! git -c core.hooksPath=/dev/null cat-file -e "$1:$5" 2>/dev/null; then echo graphloom-prior-absent > "$GRAPHLOOM_REPORT_FILE"; exit 0; fi; ' +
  'j=$(git -c core.hooksPath=/dev/null show "$1:$5"); printf \'%s\' "$j" | "$2" -e "$3" "$4" > "$GRAPHLOOM_REPORT_FILE"';

/** The reads of a ledger commit's registries: the top-level `ledger.json` (a v1 ledger's whole registry), and a v2 ledger's sections. */
type PriorPath = "root" | Section;
const READ_NAME: Record<PriorPath, string> = { root: COMMAND.ledgerPrior, design: COMMAND.ledgerPriorDesign, review: COMMAND.ledgerPriorReview };
const READ_FILE: Record<Section, string> = { design: "design/ledger.json", review: "review/ledger.json" };

/**
 * Reads part `k` of the prior ledger's registry (its schema, heads, question keys and posted items): of the top-level `ledger.json`,
 * or of a v2 section's. A file past what one command report holds is read in parts: each command prints a header
 * (`graphloom-prior <k> <parts> <sha256 of the whole>`) and its slice of the registry's ASCII-only JSON, recomputed from the same
 * commit each time, and `priorState` joins them and checks the digest. `node` is the Node binary to run (the plugin's own).
 */
export function priorShowCommand(old: string, node = "node", k = 0, path: PriorPath = "root"): EnvironmentCommand {
  const name = READ_NAME[path];
  const id = k === 0 ? name : `${name}-${k}`;
  if (path === "root") return { id, argv: ["sh", "-c", ROOT_SHOW, name, old, node, PRIOR_EXTRACT, String(k)] };
  return { id, argv: ["sh", "-c", SECTION_SHOW, name, old, node, PRIOR_EXTRACT, String(k), READ_FILE[path]] };
}

/** What part `k` of a registry's JSON (ASCII only) prints, as `priorShowCommand` does: for the stand-ins of a rehearsal and for tests. */
export function priorChunkText(registryJson: string, k: number): string {
  const n = Math.max(1, Math.ceil(registryJson.length / PRIOR_CHUNK));
  return `graphloom-prior ${k} ${n} ${sha256(registryJson)}\n${registryJson.slice(k * PRIOR_CHUNK, (k + 1) * PRIOR_CHUNK)}`;
}

export interface LedgerReading {
  ledger: Ledger;
  /** The record of the read: later writes and reads of the prior are judged against it. */
  run: CommandRun;
}

/** The ledger value the latest `ledger-read` saw. */
export function ledgerRead(evidence: readonly EvidenceRecord[]): LedgerReading | undefined {
  const run = commandRuns(evidence, COMMAND.ledger).at(-1);
  if (run === undefined || !succeeded(run.command)) return undefined;
  const ledger = parseLedger(reportText(run).text);
  return ledger === undefined ? undefined : { ledger, run };
}

export const oldValue = (l: Ledger): string => (l.present ? l.sha : "absent");

export type PriorLedger =
  | { state: "absent" }
  /** Not read whole yet: the commands that read what is missing (the first part, then every later one). */
  | { state: "missing"; next: EnvironmentCommand[] }
  /**
   * Read whole: the two sections (a v1 ledger migrated, design-pr-review-split §5.4), and for a v1 ledger the registry it was
   * migrated from, which a write's migration and its validators recompute from.
   */
  | { state: "read"; layout: "v1" | "v2"; value: Sections; v1?: unknown }
  | { state: "unreadable"; reason: string; run: CommandRun };

/** The most parts one job reads. */
const PRIOR_PARTS_PER_JOB = 16;

type FileState = { state: "missing"; next: EnvironmentCommand[] } | { state: "absent" } | { state: "read"; value: unknown } | { state: "unreadable"; reason: string; run: CommandRun };

/** One registry file of commit `old`, as its part reads hold it. */
function priorFileState(evidence: readonly EvidenceRecord[], old: string, node: string, path: PriorPath): FileState {
  const name = READ_NAME[path];
  const label = path === "root" ? "ledger.json" : READ_FILE[path];
  const runs = commandRuns(evidence).filter((r) => r.command.argv[3] === name && r.command.argv[4] === old);
  const part = (k: number): CommandRun | undefined => runs.filter((r) => r.command.argv[7] === String(k)).at(-1);
  const first = part(0);
  if (first === undefined) return { state: "missing", next: [priorShowCommand(old, node, 0, path)] };
  const text = (run: CommandRun): { text: string } | { problem: string } => {
    if (!succeeded(run.command)) return { problem: `reading ${old.slice(0, 12)}:${label} exited ${run.command.exitCode ?? "on a signal"}` };
    const report = reportText(run);
    return report.truncated ? { problem: `a part of ${label} did not fit the command report` } : { text: report.text };
  };
  const split = (t: string): { k: number; n: number; digest: string; body: string } | undefined => {
    const m = /^graphloom-prior (\d+) (\d+) ([0-9a-f]{64})\n/.exec(t);
    return m === null ? undefined : { k: Number(m[1]), n: Number(m[2]), digest: m[3]!, body: t.slice(m[0].length) };
  };
  const head = text(first);
  if ("problem" in head) return { state: "unreadable", reason: head.problem, run: first };
  if (path !== "root" && head.text.trim() === "graphloom-prior-absent") return { state: "absent" };
  const h = split(head.text);
  if (h === undefined || h.k !== 0 || h.n < 1) return { state: "unreadable", reason: `the first part of ${label} carries no header`, run: first };
  const bodies = [h.body];
  const missing: EnvironmentCommand[] = [];
  for (let k = 1; k < h.n; k += 1) {
    const run = part(k);
    if (run === undefined) {
      missing.push(priorShowCommand(old, node, k, path));
      continue;
    }
    const t = text(run);
    if ("problem" in t) return { state: "unreadable", reason: t.problem, run };
    const p = split(t.text);
    if (p === undefined || p.k !== k || p.n !== h.n || p.digest !== h.digest) return { state: "unreadable", reason: `part ${k} of ${label} is not of the same read`, run };
    bodies[k] = p.body;
  }
  if (missing.length > 0) return { state: "missing", next: missing.slice(0, PRIOR_PARTS_PER_JOB) };
  const whole = bodies.join("");
  if (sha256(whole) !== h.digest) return { state: "unreadable", reason: `the parts of ${label} do not match their digest`, run: first };
  try {
    return { state: "read", value: JSON.parse(whole) as unknown };
  } catch {
    return { state: "unreadable", reason: `${label} is not JSON`, run: first };
  }
}

/**
 * The prior ledger as the `ledger-prior` commands read it from the commit the write swaps from: the top-level `ledger.json` first,
 * then, for a v2 ledger, each section's `ledger.json` (absent for a graph that has not run on the pull request), all from that one
 * commit. A v1 ledger is migrated as it is read, so the rest of the graph sees sections only. A ledger that is there and cannot be
 * read whole is never replaced by one that forgets its heads.
 */
export function priorState(evidence: readonly EvidenceRecord[], old: string, node = process.execPath): PriorLedger {
  if (old === "absent") return { state: "absent" };
  const root = priorFileState(evidence, old, node, "root");
  if (root.state === "missing") return root;
  if (root.state === "unreadable") return { ...root, reason: root.reason === "ledger.json is not JSON" ? "it is not JSON" : root.reason };
  if (root.state === "absent") return { state: "absent" };
  const v = root.value;
  const first = commandRuns(evidence).filter((r) => r.command.argv[3] === COMMAND.ledgerPrior && r.command.argv[4] === old && r.command.argv[7] === "0").at(-1)!;
  if (isObject(v) && v.schema === LEDGER_V1) {
    const m = migrateV1(v);
    return { state: "read", layout: "v1", value: { schema: LEDGER_V2, design: m.design, ...(m.review !== undefined ? { review: m.review } : {}) }, v1: v };
  }
  if (!isObject(v) || v.schema !== LEDGER_V2) return { state: "unreadable", reason: `it is not a ${LEDGER_V1} or ${LEDGER_V2} document`, run: first };
  const sections: Partial<Record<Section, FileState>> = { design: priorFileState(evidence, old, node, "design"), review: priorFileState(evidence, old, node, "review") };
  const next = [...(sections.design!.state === "missing" ? sections.design!.next : []), ...(sections.review!.state === "missing" ? sections.review!.next : [])];
  if (next.length > 0) return { state: "missing", next: next.slice(0, PRIOR_PARTS_PER_JOB) };
  const value: Sections = { schema: LEDGER_V2 };
  for (const s of ["design", "review"] as const) {
    const f = sections[s]!;
    if (f.state === "unreadable") return f;
    if (f.state === "read") {
      if (!isObject(f.value)) return { state: "unreadable", reason: `${READ_FILE[s]} is not a section document`, run: first };
      value[s] = f.value;
    }
  }
  return { state: "read", layout: "v2", value };
}

/** The baselines of the sections at the ledger value a read saw (§5.2): the subtree there, a v1 commit's migrated one, or `absent`. */
export function readBaselines(ledger: Ledger, prior: PriorLedger, pull: Pull): Record<Section, string> | undefined {
  if (!ledger.present) return { design: "absent", review: "absent" };
  if (prior.state !== "read") return undefined;
  if (prior.layout === "v2") return { design: ledger.entries.get("design") ?? "absent", review: ledger.entries.get("review") ?? "absent" };
  const t = migratedTrees(prior.v1, pull, ledger.entries);
  return { design: t.design, review: t.review };
}

/** The migration a write from this read makes: none for an absent or v2 ledger; a v1 ledger's review section otherwise. */
export function migrationOf(prior: PriorLedger, pull: Pull): Migration {
  if (prior.state !== "read" || prior.layout !== "v1") return { from: "none" };
  const review = prior.value.review;
  return { from: "v1", review: review === undefined ? undefined : { json: JSON.stringify(review), markdown: reviewMarkdown(pull) } };
}
