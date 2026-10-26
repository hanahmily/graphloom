// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The benchmark report a `bench-gates` command writes, and what the graph does
 * with it. The report is the Measure QL tickets' benchmark evidence
 * (hanahmily/banyandb-ql-design, docs/relational-tickets.md, "Benchmark rules
 * for every ticket"): hard gates that must hold, and timings that are reported
 * and never judged. The graph gates only on the hard gates and on the report
 * being complete; it reads no latency threshold, so no result can pass or fail
 * a timing here.
 *
 * Shape (`ql-bench-report/v1`), written by the ticket's `make bench-ql-report`
 * to `build/bench/ql-report.json` and kept under MAX_BENCH_REPORT_BYTES:
 *
 *   schema        "ql-bench-report/v1"
 *   ticket        e.g. "R01"
 *   environment   { goVersion, commit, baseCommit, seed, cpus, memoryBytes, swapBytes }
 *   budgets       { <name>: bytes or count, ... } the effective admission budgets
 *   preflight     [{ facts, dimensions, fits, peakAccountedBytes, budgetBytes }, ...] one per size
 *   gates         { exactResults:         { checked, mismatches },
 *                   failedTimedCalls:     { count },
 *                   accountedMemory:      { peakBytes, budgetBytes },
 *                   outstandingResources: { count } }
 *   cases         [{ name, size: { facts, dimensions },
 *                    samples: [{ pair, order, variant, nsPerOp, allocBytesPerOp, allocsPerOp,
 *                                retainedBytes, rpcP50Ns?, rpcP95Ns?, rpcCpuNs? }, ...],
 *                    effects: [{ metric, comparison, estimate, ciLow, ciHigh, confidence }, ...] }]
 *
 * The command's own report file holds `{ harness, report }`: the wrapper's
 * record of the container it ran in (image, cpus, memory) and the report as
 * the runner wrote it. A bare report is read too.
 */

export const BENCH_SCHEMA = "ql-bench-report/v1";
/** The run keeps at most 64 KiB of a command's report; the wrapper refuses a bigger one rather than let it be cut. */
export const MAX_BENCH_REPORT_BYTES = 60_000;
/** The two successful sizes every ticket's preflight must prove fit the unchanged budget. */
export const BENCH_SIZES: ReadonlyArray<{ facts: number; dimensions: number }> = [
  { facts: 1_024, dimensions: 64 },
  { facts: 16_384, dimensions: 1_024 },
];
/** Paired, alternated repetitions every case reports. */
export const BENCH_PAIRS = 5;

type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export interface BenchHarness {
  image?: string;
  imageGo?: string;
  cpus?: number;
  memory?: string;
  memorySwap?: string;
}

export interface BenchParsed {
  report: Json;
  harness?: BenchHarness;
}

/** The report in a command's report file: the wrapper's envelope, or a bare report. */
export function parseBenchReport(raw: string): BenchParsed | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problem: "the command's report is not valid JSON (an empty, cut or missing report file)" };
  }
  const top = object(parsed);
  if (top === undefined) return { problem: "the command's report is not a JSON object" };
  const wrapped = object(top.report);
  const report = wrapped ?? top;
  const harness = object(top.harness);
  return { report, ...(wrapped !== undefined && harness !== undefined ? { harness: harness as BenchHarness } : {}) };
}

/**
 * What a case's raw samples lack to be BENCH_PAIRS paired, alternated
 * repetitions: a list of samples (a bare count is not evidence), exactly
 * BENCH_PAIRS distinct `pair` numbers, at least two variants with every pair
 * holding every variant once, one `order` per pair, and that order alternating
 * from one pair to the next.
 */
function pairProblems(samples: unknown): string[] {
  if (!Array.isArray(samples)) return ["samples must list the raw samples, not count them"];
  const rows = samples.map(object);
  if (rows.some((r) => r === undefined || !count(r.pair) || !text(r.variant) || !text(r.order))) return ["every sample needs pair, variant and order"];
  const list = rows as Json[];
  const problems: string[] = [];
  const pairs = [...new Set(list.map((r) => r.pair as number))].sort((a, b) => a - b);
  if (pairs.length !== BENCH_PAIRS) problems.push(`${pairs.length} paired repetition(s), want ${BENCH_PAIRS}`);
  const variants = [...new Set(list.map((r) => r.variant as string))];
  if (variants.length < 2) problems.push("a pair needs two variants measured against each other");
  for (const pair of pairs) {
    const mine = list.filter((r) => r.pair === pair);
    if (variants.some((v) => mine.filter((r) => r.variant === v).length !== 1)) problems.push(`pair ${pair} does not hold each variant exactly once`);
    if (new Set(mine.map((r) => r.order)).size !== 1) problems.push(`pair ${pair} has more than one order`);
  }
  const order = (pair: number) => list.find((r) => r.pair === pair)?.order;
  if (pairs.some((pair, i) => i > 0 && order(pair) === order(pairs[i - 1]!))) problems.push("the pairs' order is not alternated");
  return problems;
}

const sizeName = (s: { facts: number; dimensions: number }): string => `${s.facts.toLocaleString("en-US")}/${s.dimensions.toLocaleString("en-US")}`;
const sizeOf = (v: unknown): { facts: number; dimensions: number } | undefined => {
  const o = object(v);
  return o !== undefined && count(o.facts) && count(o.dimensions) ? { facts: o.facts, dimensions: o.dimensions } : undefined;
};
const sameSize = (a: { facts: number; dimensions: number } | undefined, b: { facts: number; dimensions: number }): boolean => a !== undefined && a.facts === b.facts && a.dimensions === b.dimensions;

/**
 * What the report lacks to be complete evidence, never a judgement of a value:
 * its schema, the frozen environment, the effective budgets, a preflight entry
 * and a case for each shared size, five alternated pairs per case, and an
 * interval for each reported effect.
 */
export function benchIncomplete(report: Json): string[] {
  const missing: string[] = [];
  if (report.schema !== BENCH_SCHEMA) missing.push(`schema is ${JSON.stringify(report.schema ?? null)}, want "${BENCH_SCHEMA}"`);
  const env = object(report.environment);
  if (env === undefined) missing.push("environment is missing");
  else {
    for (const key of ["goVersion", "commit", "baseCommit"]) if (!text(env[key])) missing.push(`environment.${key} is missing`);
    if (!(text(env.seed) || num(env.seed))) missing.push("environment.seed is missing");
    for (const key of ["cpus", "memoryBytes"]) if (!num(env[key])) missing.push(`environment.${key} is missing`);
  }
  const budgets = object(report.budgets);
  if (budgets === undefined || Object.keys(budgets).length === 0 || !Object.values(budgets).every(num)) missing.push("budgets must list the effective admission budgets, as numbers");
  const cases = Array.isArray(report.cases) ? report.cases : [];
  if (cases.length === 0) missing.push("cases is empty");
  const seen: Array<{ facts: number; dimensions: number }> = [];
  cases.forEach((raw, i) => {
    const c = object(raw);
    const name = text(c?.name) ? (c!.name as string) : `cases[${i}]`;
    const size = sizeOf(c?.size);
    if (size === undefined) missing.push(`${name}: size needs facts and dimensions`);
    else seen.push(size);
    for (const problem of pairProblems(c?.samples)) missing.push(`${name}: ${problem}`);
    if (Array.isArray(c?.samples) && !c.samples.every((s) => num(object(s)?.nsPerOp) && num(object(s)?.allocBytesPerOp) && num(object(s)?.retainedBytes))) {
      missing.push(`${name}: every sample needs nsPerOp, allocBytesPerOp and retainedBytes`);
    }
    const effects = Array.isArray(c?.effects) ? (c!.effects as unknown[]) : [];
    if (effects.length === 0) missing.push(`${name}: no paired effect estimate`);
    for (const raw of effects) {
      const e = object(raw);
      if (!text(e?.metric) || !num(e?.estimate) || !num(e?.ciLow) || !num(e?.ciHigh) || (e!.ciLow as number) > (e!.ciHigh as number)) {
        missing.push(`${name}: an effect needs a metric, an estimate and an interval (ciLow <= ciHigh)`);
        break;
      }
    }
  });
  for (const size of BENCH_SIZES) if (!seen.some((s) => sameSize(s, size))) missing.push(`no case at ${sizeName(size)}`);
  return missing;
}

/**
 * The hard gates that do not hold, each with its numbers. A gate that is absent
 * or malformed does not hold. Booleans the report carries are never trusted over
 * the counts and bytes behind them.
 */
export function benchGateFailures(report: Json): string[] {
  const failed: string[] = [];
  const gates = object(report.gates);
  const exact = object(gates?.exactResults);
  if (!count(exact?.checked) || !count(exact?.mismatches)) failed.push("exact results: the report gives no checked and mismatches counts");
  else if (exact.checked === 0) failed.push("exact results: no result was checked against the oracle");
  else if (exact.mismatches !== 0) failed.push(`exact results: ${exact.mismatches} of ${exact.checked} results differ from the oracle`);
  const timed = object(gates?.failedTimedCalls);
  if (!count(timed?.count)) failed.push("failed timed calls: the report gives no count");
  else if (timed.count !== 0) failed.push(`failed timed calls: ${timed.count} timed call(s) failed, and a failure is never a faster observation`);
  const memory = object(gates?.accountedMemory);
  if (!count(memory?.peakBytes) || !count(memory?.budgetBytes) || memory.budgetBytes === 0) failed.push("accounted memory: the report gives no peakBytes and budgetBytes");
  else if (memory.peakBytes > memory.budgetBytes) failed.push(`accounted memory: peak ${memory.peakBytes} bytes exceeds the ${memory.budgetBytes} byte budget`);
  const owned = object(gates?.outstandingResources);
  if (!count(owned?.count)) failed.push("outstanding resources: the report gives no count");
  else if (owned.count !== 0) failed.push(`outstanding resources: ${owned.count} owned resource(s) were not released`);
  const preflight = Array.isArray(report.preflight) ? report.preflight : [];
  for (const size of BENCH_SIZES) {
    const entry = preflight.map(object).find((e) => sameSize(sizeOf(e), size));
    if (entry === undefined) failed.push(`preflight: no entry for ${sizeName(size)}`);
    else if (!count(entry.peakAccountedBytes) || !count(entry.budgetBytes) || entry.budgetBytes === 0) failed.push(`preflight ${sizeName(size)}: the report gives no peakAccountedBytes and budgetBytes`);
    else if (entry.fits !== true || entry.peakAccountedBytes > entry.budgetBytes) failed.push(`preflight ${sizeName(size)}: peak ${entry.peakAccountedBytes} bytes does not fit the ${entry.budgetBytes} byte budget`);
  }
  return failed;
}

/** The one-line account of a report whose gates all hold, for the validator's reason. */
export function benchPassedReason(report: Json): string {
  const gates = object(report.gates)!;
  const exact = object(gates.exactResults)!;
  const memory = object(gates.accountedMemory)!;
  return `every hard gate holds (${exact.checked} results exact, no failed timed call, peak ${memory.peakBytes} of ${memory.budgetBytes} accounted bytes, no outstanding resource, both sizes fit); timings are reported, not judged`;
}

const median = (values: number[]): number | undefined => {
  const sorted = values.filter(num).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const fmt = (v: number | undefined): string => (v === undefined ? "-" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 1_000) / 1_000));
const MAX_TABLE_ROWS = 24;
const MAX_EFFECT_LINES = 24;

/**
 * The pull request's Benchmark section: the hard gates (which held, or the
 * delivery would not have happened) and the timings, labelled reported-only.
 */
export function benchSectionLines(label: string, parsed: BenchParsed): string[] {
  const { report, harness } = parsed;
  const env = object(report.environment) ?? {};
  const gates = object(report.gates) ?? {};
  const exact = object(gates.exactResults) ?? {};
  const memory = object(gates.accountedMemory) ?? {};
  const timed = object(gates.failedTimedCalls) ?? {};
  const owned = object(gates.outstandingResources) ?? {};
  const where = harness !== undefined ? `${harness.image ?? "a container"}, ${harness.cpus ?? "?"} CPUs, ${harness.memory ?? "?"} memory, ${harness.memorySwap ?? "no"} memory+swap` : "the benchmark environment";
  const lines = [
    `Reported by ${label} in ${where}. Toolchain ${String(env.goVersion ?? "?")}, commit ${String(env.commit ?? "?").slice(0, 12)} on base ${String(env.baseCommit ?? "?").slice(0, 12)}, fixture seed ${String(env.seed ?? "?")}. The run gated only on the hard gates below; timings are reported and never judged.`,
    "",
    "Hard gates (all held):",
    `- Exact results: ${String(exact.checked)} checked, ${String(exact.mismatches)} differ.`,
    `- Failed timed calls: ${String(timed.count)}.`,
    `- Accounted memory: peak ${String(memory.peakBytes)} of a ${String(memory.budgetBytes)} byte budget.`,
    `- Outstanding owned resources: ${String(owned.count)}.`,
    ...BENCH_SIZES.map((size) => {
      const entry = (Array.isArray(report.preflight) ? report.preflight : []).map(object).find((e) => sameSize(sizeOf(e), size));
      return `- Preflight ${sizeName(size)} fits: peak ${String(entry?.peakAccountedBytes)} of ${String(entry?.budgetBytes)} bytes.`;
    }),
  ];
  const cases = (Array.isArray(report.cases) ? report.cases : []).map(object).filter((c): c is Json => c !== undefined);
  const rows: string[] = [];
  const effects: string[] = [];
  for (const c of cases) {
    const size = sizeOf(c.size);
    const samples = Array.isArray(c.samples) ? (c.samples as unknown[]).map(object).filter((s): s is Json => s !== undefined) : [];
    const variants = [...new Set(samples.map((s) => String(s.variant ?? "")))];
    for (const variant of variants.length > 0 ? variants : [""]) {
      const mine = samples.filter((s) => String(s.variant ?? "") === variant);
      const of = (key: string) => median(mine.map((s) => s[key] as number));
      rows.push(
        `| ${String(c.name)}${variant !== "" ? ` (${variant})` : ""} | ${size !== undefined ? sizeName(size) : "?"} | ${mine.length > 0 ? mine.length : "-"} | ${fmt(of("nsPerOp"))} | ${fmt(of("allocBytesPerOp"))} | ${fmt(of("allocsPerOp"))} | ${fmt(of("retainedBytes"))} | ${fmt(of("rpcP50Ns"))} | ${fmt(of("rpcP95Ns"))} | ${fmt(of("rpcCpuNs"))} |`,
      );
    }
    for (const e of (Array.isArray(c.effects) ? c.effects : []).map(object)) {
      if (e !== undefined) effects.push(`- ${String(c.name)}, ${String(e.metric)}${text(e.comparison) ? ` (${e.comparison})` : ""}: ${fmt(e.estimate as number)} [${fmt(e.ciLow as number)}, ${fmt(e.ciHigh as number)}]${num(e.confidence) ? ` at ${Math.round(e.confidence * 100)}%` : ""}`);
    }
  }
  lines.push("", "Reported only, not gated (medians of the paired samples):", "", "| case | size | pairs | ns/op | alloc B/op | allocs/op | retained B | RPC p50 ns | RPC p95 ns | RPC CPU ns |", "|---|---|---|---|---|---|---|---|---|---|");
  lines.push(...rows.slice(0, MAX_TABLE_ROWS));
  if (rows.length > MAX_TABLE_ROWS) lines.push(`(${rows.length - MAX_TABLE_ROWS} more row(s) are in the run's report)`);
  if (effects.length > 0) {
    lines.push("", "Paired effect estimates with their intervals:", ...effects.slice(0, MAX_EFFECT_LINES));
    if (effects.length > MAX_EFFECT_LINES) lines.push(`(${effects.length - MAX_EFFECT_LINES} more in the run's report)`);
  }
  return lines;
}

/** What the planner and the implementer are told about the benchmark runner and its report: the schema and the rules. */
export const BENCH_GUIDANCE = [
  "The controller's final step runs `make bench-ql-report` once, after code review has converged, in a container with 4 CPUs, 8 GiB of memory and no extra swap (docker run --cpus=4 --memory=8g --memory-swap=8g, on a golang image of go.mod's toolchain, the checkout mounted read-write and the module cache read-only, module downloads off: GOPROXY=off). This ticket's change adds that make target and the runner behind it (a repository-level Makefile target, or one the root Makefile includes); it must write the report to build/bench/ql-report.json, which the repository already ignores. A checkout without the target fails the final step with a message naming it, and the change comes back to you.",
  `Benchmark rules (docs/relational-tickets.md, "Benchmark rules for every ticket", and the ticket's focused benchmark section of the same document; the context documents above hold them): freeze the toolchain, commits, fixture seed, parameters, effective admission budgets, four CPUs, 8 GiB and no extra swap; time only successful queries and keep deliberate overload and recovery apart; verify the full results against an independent oracle before accepting a timing sample (an error or a timeout is a failure, never a faster observation); use the two fixed successful sizes 1,024 facts/64 dimension rows and 16,384 facts/1,024 dimension rows, and prove in a preflight that both fit the unchanged budget; use five paired repetitions with alternated order (one \`order\` per pair, odd pairs "AB", even "BA", both variants in each pair), keep the raw samples as a list and report paired effect estimates with uncertainty; record kernel ns/op, allocated bytes/op, retained operator bytes and RPC p50/p95/CPU where applicable; process RSS is separate from tracked memory; benchmark-only reference or disable switches must never become public language or API options. Correctness, bounded memory and cleanup are hard gates; timings are reported, never gated. Do not declare gates passed from a median or change a threshold after seeing results.`,
  `The report is JSON, schema "${BENCH_SCHEMA}", under ${MAX_BENCH_REPORT_BYTES} bytes (the run keeps at most 64 KiB of it): {"schema":"${BENCH_SCHEMA}","ticket":"R01","environment":{"goVersion","commit","baseCommit","seed","cpus","memoryBytes","swapBytes"},"budgets":{"<name>":number,...},"preflight":[{"facts":1024,"dimensions":64,"fits":true,"peakAccountedBytes":n,"budgetBytes":n},{"facts":16384,"dimensions":1024,...}],"gates":{"exactResults":{"checked":n,"mismatches":0},"failedTimedCalls":{"count":0},"accountedMemory":{"peakBytes":n,"budgetBytes":n},"outstandingResources":{"count":0}},"cases":[{"name","size":{"facts","dimensions"},"samples":[{"pair":1,"order":"AB","variant","nsPerOp","allocBytesPerOp","allocsPerOp","retainedBytes","rpcP50Ns","rpcP95Ns","rpcCpuNs"}, ...],"effects":[{"metric","comparison","estimate","ciLow","ciHigh","confidence"}]}]}.`,
  "The controller passes the ticket only when the command exits 0 and every hard gate holds in the report: results exact (checked > 0, mismatches 0), no failed timed call, accounted peak within its budget, no outstanding owned resource, and a preflight entry that fits for both sizes; and the report is complete (the environment, the budgets, a case at each size with exactly five alternated pairs, each holding every variant once, and an interval for each effect). It never judges a latency, and the pull request's Benchmark section shows the timings as reported only. A benchmark that cannot meet a gate is a defect to fix, not a threshold to move.",
].join("\n");

/**
 * A complete, passing report, the shape a ticket's runner writes, for the
 * qualification cases and the rehearsal's stub runner. `patch` edits it in
 * place; nothing here is a measurement.
 */
export function exampleBenchReport(patch: (report: Record<string, unknown>) => void = () => undefined): Record<string, unknown> {
  const samples = (base: number) =>
    Array.from({ length: BENCH_PAIRS }, (_, i) => i + 1).flatMap((pair) =>
      ["operator", "reference"].map((variant) => ({
        pair,
        order: pair % 2 === 1 ? "AB" : "BA",
        variant,
        nsPerOp: base * (variant === "operator" ? 1 : 40) + pair,
        allocBytesPerOp: 4_096,
        allocsPerOp: 12,
        retainedBytes: 65_536,
        rpcP50Ns: 900_000,
        rpcP95Ns: 1_400_000,
        rpcCpuNs: 700_000,
      })),
    );
  const report: Record<string, unknown> = {
    schema: BENCH_SCHEMA,
    ticket: "R01",
    environment: { goVersion: "go1.26.10", commit: "a".repeat(40), baseCommit: "b".repeat(40), seed: 20_261_024, cpus: 4, memoryBytes: 8_589_934_592, swapBytes: 0 },
    budgets: { queryBytes: 268_435_456, perOperatorBytes: 134_217_728 },
    preflight: BENCH_SIZES.map((size, i) => ({ ...size, fits: true, peakAccountedBytes: 1_000_000 * (i + 1), budgetBytes: 268_435_456 })),
    gates: {
      exactResults: { checked: 52_224, mismatches: 0 },
      failedTimedCalls: { count: 0 },
      accountedMemory: { peakBytes: 2_000_000, budgetBytes: 268_435_456 },
      outstandingResources: { count: 0 },
    },
    cases: BENCH_SIZES.map((size, i) => ({
      name: "join-unique",
      size,
      samples: samples(800 * (i + 1)),
      effects: [{ metric: "nsPerOp", comparison: "operator-vs-reference", estimate: -0.97, ciLow: -0.98, ciHigh: -0.96, confidence: 0.95 }],
    })),
  };
  patch(report);
  return report;
}
