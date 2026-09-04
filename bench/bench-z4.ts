/**
 * Benchmark (zc-z4: official codegen + CoW skeletons) — reproduces the 500k-account
 * scenario from the Numeric article.
 *
 * Baselines:
 *   stock zod4 safeParse           interpreter baseline (rebuilds the whole output tree on every parse)
 *   official compileFn parser      official JIT product, stock semantics (always allocates new
 *                                  containers) — the "reuse only, no skeleton" control
 *   official compileFn validator   official assertOnly pure-validation floor (reference for validate)
 *   zc-z4 CoW parse                the subject: official codegen + CoW container skeletons
 *   arktype                        external reference line
 *
 *   S1 (main track):    pure-validation schema (clean input → CoW should return the input reference
 *                       with zero copies)
 *   S2 (CoW showcase):  role carries a default, 10% of the data is missing role
 *   S3 (dirty sweep):   missing-role ratio 0% / 25% / 50% / 100%
 *
 * Per variant: 2 warmup rounds + 3 timed rounds (started after gc()), reporting the median time,
 * the heapUsed delta after the run (allocation pressure, before gc) and the retained delta after gc.
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

const { z } = await import("zod4");
const { compile } = await import("../src/index-z4.js");
const { compileFn } = await import("zod4/v4/core");

const N = Number(process.env.BENCH_N ?? 500_000);
const PASSES = 3;

/* ─────────────────────────── Data generation ─────────────────────────── */

const first = ["Ana", "Bob", "Cid", "Dee", "Eve", "Fay", "Gus", "Hal"];
const cities = ["NYC", "SFO", "SEA", "ATX", "CHI"];
const streets = ["Main St", "Oak Ave", "Elm Rd", "Pine Dr"];

interface RawAccount {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role?: string;
  balance: number;
  createdAt: string;
  tags: string[];
  address: { street: string; city: string; zip: string; country: string };
  active: boolean;
}

function makeAccounts(): RawAccount[] {
  const out: RawAccount[] = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = {
      id: i,
      firstName: first[i % first.length]!,
      lastName: "Doe",
      email: `user${i}@example.com`,
      role: ["admin", "member", "viewer"][i % 3],
      balance: (i % 1000) + 0.5,
      createdAt: `2025-0${1 + (i % 9)}-1${i % 9}T12:00:00.000Z`,
      tags: i % 3 === 0 ? ["a", "b"] : ["c"],
      address: {
        street: `${i % 9999} ${streets[i % streets.length]}`,
        city: cities[i % cities.length]!,
        zip: String(10000 + (i % 89999)),
        country: "US",
      },
      active: i % 2 === 0,
    };
  }
  return out;
}

function deriveMissingRole(accounts: RawAccount[], everyNth: number, offset: number): RawAccount[] {
  if (everyNth <= 0) return accounts;
  return accounts.map((a, i) => {
    if (i % everyNth !== offset % everyNth) return a;
    const { role: _role, ...rest } = a;
    return rest as RawAccount;
  });
}

/* ─────────────────────────── schemas (zod4) ─────────────────────────── */

const AccountStock = z.object({
  id: z.number().int(),
  firstName: z.string().max(64),
  lastName: z.string().max(64),
  email: z.email(),
  role: z.enum(["admin", "member", "viewer"]),
  balance: z.number(),
  createdAt: z.iso.datetime(),
  tags: z.array(z.string()).max(8),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string(), country: z.string() }),
  active: z.boolean(),
});

const AccountCow = z.object({
  id: z.number().int(),
  firstName: z.string().max(64),
  lastName: z.string().max(64),
  email: z.email(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
  balance: z.number(),
  createdAt: z.iso.datetime(),
  tags: z.array(z.string()).max(8),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string(), country: z.string() }),
  active: z.boolean(),
});

const AccountsStock = z.array(AccountStock);
const AccountsCow = z.array(AccountCow);

/* ─────────────────────────── Variants under test ─────────────────────────── */

const stockParser = AccountsStock.safeParse.bind(AccountsStock);
const stockCowParser = AccountsCow.safeParse.bind(AccountsCow);

// Official JIT parser product (stock semantics) and assertOnly validator product (the pure-validation floor)
const officialParser = compileFn(AccountsStock) as (i: unknown) => unknown;
const officialParserCow = compileFn(AccountsCow) as (i: unknown) => unknown;
const officialValidator = compileFn(AccountStock, { assertOnly: true }) as (i: unknown) => unknown;

const Z4Stock = compile(AccountsStock);
const Z4Cow = compile(AccountsCow);

/* ─────────────────────────── Measurement helpers ─────────────────────────── */

const gc = (): void => (globalThis as any).gc?.();

interface Sample {
  ms: number;
  heapDelta: number;
  retainedDelta: number;
}

function measure(fn: () => unknown): Sample[] {
  const samples: Sample[] = [];
  for (let p = -2; p < PASSES; p++) {
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const result = fn();
    const t1 = performance.now();
    const heapAfter = process.memoryUsage().heapUsed;
    gc();
    const heapAfterGc = process.memoryUsage().heapUsed;
    if (p >= 0) {
      samples.push({
        ms: t1 - t0,
        heapDelta: heapAfter - heapBefore,
        retainedDelta: heapAfterGc - heapBefore,
      });
    }
    if (result === undefined) throw new Error("no result");
    (globalThis as any).__last = result;
  }
  return samples;
}

/** Async measurement: awaits the full promise chain (used by the S7 async scenario; the sync timing includes the microtask drain) */
async function measureAsync(fn: () => unknown): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let p = -2; p < PASSES; p++) {
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const result = await fn();
    const t1 = performance.now();
    const heapAfter = process.memoryUsage().heapUsed;
    gc();
    const heapAfterGc = process.memoryUsage().heapUsed;
    if (p >= 0) {
      samples.push({
        ms: t1 - t0,
        heapDelta: heapAfter - heapBefore,
        retainedDelta: heapAfterGc - heapBefore,
      });
    }
    if (result === undefined) throw new Error("no result");
    (globalThis as any).__last = result;
  }
  return samples;
}

function report(label: string, samples: Sample[]): number {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)]!;
  const heap = samples.reduce((m, s) => Math.max(m, s.heapDelta), 0);
  const retained = samples.reduce((m, s) => Math.max(m, s.retainedDelta), 0);
  const fmt = (v: number) =>
    v > 0 ? `+${(v / 1048576).toFixed(1)}MB` : `${(v / 1048576).toFixed(1)}MB`;
  console.log(
    `  ${label.padEnd(44)} median ${median.toFixed(0).padStart(6)}ms   alloc ${fmt(heap).padStart(9)}   retained ${fmt(retained).padStart(9)}`,
  );
  return median;
}

const medianOf = (samples: Sample[]): number =>
  samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(PASSES / 2)]!;

/* ─────────────────────────── S1: pure-validation main track ─────────────────────────── */

console.log(
  `\n═══ S1 pure validation · ${N.toLocaleString()} accounts · median of ${PASSES} rounds per variant ═══`,
);
console.log(`  zc-z4 stock degradation: ${Z4Stock.stock ? "yes (unexpected!)" : "no"}`);
const data = makeAccounts();

{
  const stockOut = stockParser(data);
  assert.ok(stockOut.success);
  const z4Out = Z4Stock.safeParse(data);
  assert.ok(z4Out.success);
  assert.deepStrictEqual(z4Out.data, (stockOut as any).data);
  console.log(
    `  correctness: deepStrictEqual ✓   z4 output === input ref: ${z4Out.data === data ? "yes (zero-copy)" : "no"}`,
  );
}

const s1Stock = measure(() => stockParser(data));
report("stock zod4 safeParse (interpreter)", s1Stock);
const s1Official = measure(() => officialParser(data));
report("official compileFn parser (JIT, stock sem.)", s1Official);
const s1Z4 = measure(() => Z4Stock.safeParse(data));
report("zc-z4 CoW parse (official codegen+skeleton)", s1Z4);

console.log(`\n  Ratios (median):`);
console.log(
  `    stock / official parser = ${(medianOf(s1Stock) / medianOf(s1Official)).toFixed(2)}x   ← gain from the official JIT itself`,
);
console.log(
  `    stock / zc-z4           = ${(medianOf(s1Stock) / medianOf(s1Z4)).toFixed(2)}x   ← total gain from the CoW layer`,
);
console.log(
  `    official parser / zc-z4 = ${(medianOf(s1Official) / medianOf(s1Z4)).toFixed(2)}x   ← net gain of the CoW layer on top of the JIT`,
);

/* ─────────────────────────── S2: CoW dirty load ─────────────────────────── */

console.log(
  `\n═══ S2 CoW dirty load · role carries a default · 10% of the data is missing role ═══`,
);
const dataCow = deriveMissingRole(data, 10, 5);
{
  const stockOut = stockCowParser(dataCow);
  assert.ok(stockOut.success);
  const z4Out = Z4Cow.safeParse(dataCow);
  assert.ok(z4Out.success);
  assert.deepStrictEqual(z4Out.data, (stockOut as any).data);
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  console.log(
    `  correctness: deepStrictEqual ✓   missing-role share ${((injected / N) * 100).toFixed(1)}%`,
  );
}

const s2Stock = measure(() => stockCowParser(dataCow));
report("stock zod4 safeParse (default scenario)", s2Stock);
const s2Official = measure(() => officialParserCow(dataCow));
report("official compileFn parser (JIT, default)", s2Official);
const s2Z4 = measure(() => Z4Cow.safeParse(dataCow));
report("zc-z4 CoW parse (90% zero-copy)", s2Z4);
console.log(
  `\n  Ratios (median): stock/z4 = ${(medianOf(s2Stock) / medianOf(s2Z4)).toFixed(2)}x   official parser/z4 = ${(medianOf(s2Official) / medianOf(s2Z4)).toFixed(2)}x`,
);

/* ─────────────────────────── S3: dirty-ratio sweep ─────────────────────────── */

console.log(`\n═══ S3 dirty-ratio sweep · missing-role ratio → default injection ═══`);
console.log(
  `  ${"missing".padEnd(8)} ${"stock".padStart(9)} ${"off.JIT".padStart(9)} ${"zc-z4".padStart(9)} ${"stock/z4".padStart(9)}   ${"z4 retain".padStart(9)} ${"stock ret".padStart(10)}`,
);
for (const ratio of [0, 0.25, 0.5, 1.0]) {
  const ds = deriveMissingRole(data, ratio === 0 ? 0 : Math.round(1 / ratio), 3);
  const mStock = medianOf(measure(() => stockCowParser(ds)));
  const mOfficial = medianOf(measure(() => officialParserCow(ds)));
  const mZ4 = medianOf(measure(() => Z4Cow.safeParse(ds)));
  const rs =
    measure(() => stockCowParser(ds)).reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  const rv =
    measure(() => Z4Cow.safeParse(ds)).reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  console.log(
    `  ${(ratio * 100).toFixed(0).padEnd(7)}% ${mStock.toFixed(0).padStart(7)}ms ${mOfficial.toFixed(0).padStart(7)}ms ${mZ4.toFixed(0).padStart(7)}ms ${(mStock / mZ4).toFixed(2).padStart(8)}x   ${rv.toFixed(1).padStart(7)}MB ${rs.toFixed(1).padStart(8)}MB`,
  );
}

/* ─────────────────────────── S5: record/map/set container scenario ─────────────────────────── */

console.log(
  `\n═══ S5 container CoW · record / map / set · ${N.toLocaleString()} rows · median of ${PASSES} rounds per variant ═══`,
);
{
  // Data: 500k records, each with one 4-key record + one 3-entry map + one 3-member set
  const dict = z.record(z.string(), z.number());
  const lookup = z.map(z.string(), z.number());
  const tags = z.set(z.number().int());
  const Row = z.object({
    id: z.number().int(),
    dict,
    lookup,
    tags,
  });
  const rows: {
    id: number;
    dict: Record<string, number>;
    lookup: Map<string, number>;
    tags: Set<number>;
  }[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      dict: { a: i % 97, b: i % 89, c: i % 83, d: i % 79 },
      lookup: new Map([
        ["k1", i % 71],
        ["k2", i % 73],
        ["k3", i % 77],
      ]),
      tags: new Set([i % 3, i % 5, i % 7]),
    };
  }
  const Rows = z.array(Row);
  const RowsZ4 = compile(Rows);
  const rowsParser = compileFn(Rows) as (i: unknown) => unknown;

  const probe = RowsZ4.safeParse(rows);
  assert.ok(probe.success);
  assert.deepStrictEqual(probe.data, (Rows.safeParse(rows) as any).data);
  console.log(
    `  correctness: deepStrictEqual ✓   CoW output === input ref: ${probe.data === rows ? "yes (zero-copy)" : "no"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S5 stock (record+map+set rebuilt per row)", rs);
  const ro = measure(() => rowsParser(rows));
  report("S5 official compileFn parser (JIT, stock)", ro);
  const rv = measure(() => RowsZ4.safeParse(rows));
  report("S5 zc-z4 CoW parse (zero-copy)", rv);
  console.log(
    `  Ratios (median): stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   official parser/z4 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
  );
}

/* ─────────────────────────── S6: tuple scenario ─────────────────────────── */

console.log(
  `\n═══ S6 tuple CoW · coordinate/label tuples · ${N.toLocaleString()} rows · median of ${PASSES} rounds per variant ═══`,
);
{
  // Data: 500k rows, each with a full-length tuple [x,y] (all numbers) and [name, optional tag]
  const Point = z.tuple([z.number(), z.number()]);
  const Label = z.tuple([z.string(), z.optional(z.string())]);
  const Row = z.object({ id: z.number().int(), point: Point, label: Label });
  const rows: { id: number; point: [number, number]; label: [string, string?] }[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      point: [i % 360, i % 180],
      label: i % 2 === 0 ? [`L${i % 97}`, `T${i % 31}`] : [`L${i % 97}`],
    };
  }
  const Rows = z.array(Row);
  const RowsZ4 = compile(Rows);
  const rowsParser = compileFn(Rows) as (i: unknown) => unknown;

  const probe = RowsZ4.safeParse(rows);
  assert.ok(probe.success);
  assert.deepStrictEqual(probe.data, (Rows.safeParse(rows) as any).data);
  console.log(
    `  correctness: deepStrictEqual ✓   CoW output === input ref: ${probe.data === rows ? "yes (zero-copy)" : "no"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S6 stock (tuple: a new array per row)", rs);
  const ro = measure(() => rowsParser(rows));
  report("S6 official compileFn parser (JIT, stock)", ro);
  const rv = measure(() => RowsZ4.safeParse(rows));
  report("S6 zc-z4 CoW parse (zero-copy)", rv);
  console.log(
    `  Ratios (median): stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   official parser/z4 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
  );
}

/* ─────────────────────────── S7: async scenario ─────────────────────────── */

console.log(
  `\n═══ S7 async CoW · async transform leaf · ${(N / 10).toLocaleString()} rows · median of ${PASSES} rounds per variant ═══`,
);
{
  // Data size: async adds one microtask chain per element; N/10 rows keeps a single round measurable
  const M = N / 10;
  const Row = z.object({
    id: z.number().int(),
    email: z.string().transform(async (e) => e.toLowerCase()),
    score: z.number(),
  });
  const rows: { id: number; email: string; score: number }[] = new Array(M);
  for (let i = 0; i < M; i++) rows[i] = { id: i, email: `USER${i}@EXAMPLE.COM`, score: i % 100 };
  const Rows = z.array(Row);
  const RowsZ4 = compile(Rows);
  assert.ok(RowsZ4.async && !RowsZ4.stock, "async skeleton compiled");

  const probe = await RowsZ4.safeParseAsync(rows);
  const stockProbe = await Rows.safeParseAsync(rows);
  assert.ok(probe.success && stockProbe.success);
  assert.deepStrictEqual(probe.data, stockProbe.data);
  console.log(
    `  correctness: deepStrictEqual ✓   z4 async=${RowsZ4.async}   allocation pressure (output email is always dirty → a new object per row)`,
  );

  const stockAsync = Rows.safeParseAsync.bind(Rows);
  const rs = await measureAsync(async () => {
    const r = await stockAsync(rows);
    if (!r.success) throw new Error("stock fail");
    return r.data.length;
  });
  report("S7 stock safeParseAsync (async interpreter)", rs);
  const rv = await measureAsync(() => RowsZ4.safeParseAsync(rows));
  report("S7 zc-z4 safeParseAsync (async skeleton+CoW)", rv);
  console.log(
    `  Ratios (median): stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   (the async leaf changes the value → copies concentrate on dirty rows, the rest of the skeleton is zero-copy)`,
  );
}

/* ─────────────────────────── validate fast path ─────────────────────────── */

console.log(`\n═══ S4 validate pure validation (returns-the-input-reference semantics) ═══`);
{
  const mVal = measure(() => {
    let ok = 0;
    for (let i = 0; i < N; i++) if (officialValidator(data[i]) !== true) ok++;
    return ok;
  });
  report("official assertOnly validator (per account)", mVal);
  const mZ4Val = measure(() => {
    let ok = 0;
    for (let i = 0; i < N; i++) if (Z4Stock.validate(data[i]) !== null) ok++;
    return ok;
  });
  report("zc-z4 validate (whole-tree assertOnly fn)", mZ4Val);
}

/* ─────────────────────────── arktype reference ─────────────────────────── */

try {
  const { type } = await import("arktype");
  const At = type({
    id: "number",
    firstName: "string<=64",
    lastName: "string<=64",
    email: "string.email",
    role: "'admin'|'member'|'viewer'",
    balance: "number",
    createdAt: "string",
    tags: "string[]",
    address: { street: "string", city: "string", zip: "string", country: "string" },
    active: "boolean",
  }).array();
  const mArk = measure(() => At(data));
  report("arktype (reference line, no copying)", mArk);
} catch {
  console.log("  arktype not installed, skipping the reference line");
}

console.log(
  "\nNote: alloc = the heapUsed delta at the end of the run (before gc); retained = the delta still held after gc.",
);
console.log(
  "    zc-z4 returns the input reference on the pure path (≈0 allocated, 0 retained); the dirty path shallow-copies only the dirty objects.",
);
