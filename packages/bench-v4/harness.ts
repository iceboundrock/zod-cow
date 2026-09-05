/**
 * Measurement harness shared by the bench-v4 scenarios.
 *
 * Every scenario is a list of candidates measured against identical input. A candidate is either
 * a runnable (`run`) or an explicit `N/A` with the reason it cannot be measured equivalently; the
 * reason is printed in the scenario output and in the final tables, never an empty cell.
 *
 * Methodology (identical for every candidate):
 *   - schema construction, JIT compilation and fixture construction happen before `runScenario`
 *     is called, so the timed region holds only steady-state execution;
 *   - WARMUP warmup rounds, discarded, then PASSES timed rounds; both counts are rounded up to a
 *     multiple of the runnable-candidate count (`balancedRounds`);
 *   - every round runs the candidates in an order rotated by the round index, and because the
 *     round count is a multiple of the candidate count the schedule is a set of complete Latin
 *     squares: every candidate occupies every position (first … last) equally often, so a
 *     position effect (JIT, thermal or heap history, which gc() does not reset) lands on every
 *     candidate alike;
 *   - every round starts after gc(); alloc = heapUsed delta at the end of the call (before gc),
 *     retained = heapUsed delta still held after gc;
 *   - median elapsed time over the timed rounds, max alloc / retained over the timed rounds.
 *
 * The `run` function of a candidate must verify its own result (e.g. `success === true`) and
 * throw on a rejection: a silent schema/input mismatch would otherwise time an error path and
 * look fast.
 */
import { performance } from "node:perf_hooks";

/**
 * Minimum timed rounds per candidate (`BENCH_PASSES`, a positive integer). A scenario rounds it up
 * to a multiple of its runnable-candidate count so the rotated order forms complete rotations.
 */
export const PASSES = Number(process.env.BENCH_PASSES ?? 3);
if (!Number.isInteger(PASSES) || PASSES < 1) {
  throw new Error(
    `BENCH_PASSES must be a positive integer, got ${JSON.stringify(process.env.BENCH_PASSES)}`,
  );
}
export const WARMUP = 2;

/** Smallest multiple of `n` that is at least `min`: the rounds needed for complete rotations */
export const balancedRounds = (min: number, n: number): number =>
  n === 0 ? 0 : Math.ceil(min / n) * n;

/** Column of the summary tables a candidate belongs to */
export type Column = "stock" | "official" | "zc" | "ark";

export const COLUMN_TITLES: Record<Column, string> = {
  stock: "stock Zod 4",
  official: "official JIT",
  zc: "zod-cow-v4",
  ark: "ArkType",
};

export interface Runnable {
  column: Column;
  label: string;
  /** Sync or async body; an async body is awaited inside the timed region */
  run: () => unknown;
  /** Set when the measurement is not equivalent to the other columns (kept out of the ratios) */
  nonEquivalent?: string;
}

export interface NotApplicable {
  column: Column;
  label: string;
  /** Short reason, printed as `N/A — <reason>` in the scenario output and the summary tables */
  na: string;
  /** Optional longer explanation, printed under the scenario line only */
  detail?: string;
}

export type Candidate = Runnable | NotApplicable;

export interface Sample {
  ms: number;
  alloc: number;
  retained: number;
}

export interface Measured {
  column: Column;
  label: string;
  medianMs: number;
  alloc: number;
  retained: number;
  samples: Sample[];
  nonEquivalent?: string;
}

export type Result = Measured | (NotApplicable & { medianMs?: undefined });

export interface ScenarioRun {
  id: string;
  title: string;
  results: Result[];
}

export const isNA = (r: Result): r is NotApplicable => "na" in r;
export const isMeasured = (r: Result): r is Measured => !("na" in r);

const gc = (): void => {
  const g = (globalThis as any).gc;
  if (typeof g !== "function") throw new Error("run with --expose-gc");
  g();
};

async function sampleOnce(run: () => unknown): Promise<Sample> {
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  let result = run();
  if (result instanceof Promise) result = await result;
  const t1 = performance.now();
  const heapAfter = process.memoryUsage().heapUsed;
  if (result === undefined) throw new Error("candidate returned undefined");
  (globalThis as any).__last = result; // keep the output alive until the retained reading
  gc();
  const heapAfterGc = process.memoryUsage().heapUsed;
  (globalThis as any).__last = undefined;
  return { ms: t1 - t0, alloc: heapAfter - heapBefore, retained: heapAfterGc - heapBefore };
}

export const fmtMB = (bytes: number): string => {
  const mb = bytes / 1048576;
  return `${mb > 0 ? "+" : ""}${mb.toFixed(1)}MB`;
};

export const fmtMs = (ms: number): string => `${ms.toFixed(0)}ms`;

export function medianOf(samples: Sample[]): number {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const mid = ms.length >> 1;
  return ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
}

/**
 * Warm up every runnable candidate, then take at least PASSES samples per candidate in complete
 * rotations of the candidate order and print one line per candidate (N/A candidates print their
 * reason).
 */
export async function runScenario(
  id: string,
  title: string,
  candidates: Candidate[],
): Promise<ScenarioRun> {
  console.log(`\n═══ ${id} · ${title} ═══`);
  const runnables = candidates.filter((c): c is Runnable => "run" in c);
  const n = runnables.length;
  const rotated = (round: number) => runnables.map((_, i) => runnables[(i + round) % n]!);
  const warmupRounds = balancedRounds(WARMUP, n);
  const rounds = balancedRounds(PASSES, n);
  console.log(
    `  ${n} candidates · ${warmupRounds} warmup + ${rounds} timed rounds, order rotated every round (each candidate holds each position ${rounds / n}× in the timed rounds)`,
  );
  for (let w = 0; w < warmupRounds; w++) for (const c of rotated(w)) await sampleOnce(c.run);

  const samples = new Map<Runnable, Sample[]>(runnables.map((c) => [c, []]));
  for (let p = 0; p < rounds; p++) {
    for (const c of rotated(p)) samples.get(c)!.push(await sampleOnce(c.run));
  }

  const results: Result[] = candidates.map((c) => {
    if ("na" in c) return c;
    const s = samples.get(c)!;
    return {
      column: c.column,
      label: c.label,
      medianMs: medianOf(s),
      alloc: s.reduce((m, x) => Math.max(m, x.alloc), 0),
      retained: s.reduce((m, x) => Math.max(m, x.retained), 0),
      samples: s,
      nonEquivalent: c.nonEquivalent,
    };
  });

  for (const r of results) {
    if (isNA(r)) {
      console.log(`  ${r.label.padEnd(46)} N/A — ${r.na}`);
      if (r.detail) console.log(`  ${"".padEnd(46)} ${r.detail}`);
      continue;
    }
    const tag = r.nonEquivalent ? "   [non-equivalent reference: excluded from ratios]" : "";
    console.log(
      `  ${r.label.padEnd(46)} median ${fmtMs(r.medianMs).padStart(8)}   alloc ${fmtMB(r.alloc).padStart(9)}   retained ${fmtMB(r.retained).padStart(9)}${tag}`,
    );
  }
  return { id, title, results };
}

/** The equivalent (not N/A, not non-equivalent) measurement of a column, if any */
export function equivalent(run: ScenarioRun, column: Column): Measured | undefined {
  return run.results.find(
    (x): x is Measured => x.column === column && isMeasured(x) && !x.nonEquivalent,
  );
}

/**
 * Ratio `a / b` as text: values above 1 mean `a` took longer than `b` (so with b = zod-cow, a
 * ratio above 1 means zod-cow was faster). Not computed for N/A or non-equivalent measurements.
 */
export function ratio(a: Measured | undefined, b: Measured | undefined): string {
  if (!a || !b) return "n/a";
  return `${(a.medianMs / b.medianMs).toFixed(2)}x`;
}

/** Ratio line printed under a scenario, against the zod-cow column */
export function printRatios(run: ScenarioRun): void {
  const zc = equivalent(run, "zc");
  if (!zc) return;
  const parts = (["stock", "official", "ark"] as Column[])
    .map((c) => {
      const r = equivalent(run, c);
      return r ? `${COLUMN_TITLES[c]} / zod-cow = ${ratio(r, zc)}` : undefined;
    })
    .filter(Boolean);
  console.log(`  Ratios (median; >1 = zod-cow faster): ${parts.join("   ")}`);
}

/* ───────────── summary tables (markdown, so they paste into the docs) ───────────── */

function markdownTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(" | ")} |`;
  const sep = `| ${widths.map((w, i) => (i === 0 ? "-".repeat(w) : `${"-".repeat(w - 1)}:`)).join(" | ")} |`;
  return [line(header), sep, ...rows.map(line)].join("\n");
}

const COLUMNS: Column[] = ["stock", "official", "zc", "ark"];

/**
 * One summary cell. A column may hold an N/A entry and a non-equivalent reference measurement
 * side by side (S5, ArkType); both are rendered so the reference timing is not confined to the
 * scenario output.
 */
function cell(run: ScenarioRun, column: Column, pick: (m: Measured) => string): string {
  const rs = run.results.filter((x) => x.column === column);
  if (rs.length === 0) return "N/A — not part of this scenario";
  return rs
    .map((r) => {
      if (isNA(r)) return `N/A — ${r.na}`;
      return r.nonEquivalent ? `(${pick(r)}, non-equivalent reference)` : pick(r);
    })
    .join(" ");
}

export function printSummary(runs: ScenarioRun[]): void {
  const header = ["Scenario", ...COLUMNS.map((c) => COLUMN_TITLES[c])];
  console.log("\n═══ Summary: median elapsed time (lower is better) ═══\n");
  console.log(
    markdownTable(
      header,
      runs.map((run) => [run.id, ...COLUMNS.map((c) => cell(run, c, (m) => fmtMs(m.medianMs)))]),
    ),
  );

  console.log("\n═══ Summary: allocation pressure / retained after GC ═══\n");
  console.log(
    markdownTable(
      header,
      runs.map((run) => [
        run.id,
        ...COLUMNS.map((c) => cell(run, c, (m) => `${fmtMB(m.alloc)} / ${fmtMB(m.retained)}`)),
      ]),
    ),
  );

  console.log(
    "\n═══ Summary: ratios against zod-cow-v4 (median; values above 1 mean the other library took longer, i.e. zod-cow was faster) ═══\n",
  );
  console.log(
    markdownTable(
      ["Scenario", "stock / zod-cow", "official JIT / zod-cow", "ArkType / zod-cow"],
      runs.map((run) => {
        const zc = equivalent(run, "zc");
        return [
          run.id,
          ratio(equivalent(run, "stock"), zc),
          ratio(equivalent(run, "official"), zc),
          ratio(equivalent(run, "ark"), zc),
        ];
      }),
    ),
  );
  console.log(
    "\n`n/a` = not computed: the column is N/A in that scenario or measures a non-equivalent reference.",
  );
}
