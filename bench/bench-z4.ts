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

/* ─────────────────────────── schemas（zod4） ─────────────────────────── */

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

/* ─────────────────────────── 被测变体 ─────────────────────────── */

const stockParser = AccountsStock.safeParse.bind(AccountsStock);
const stockCowParser = AccountsCow.safeParse.bind(AccountsCow);

// 官方 JIT parser 产物（stock 语义）与 assertOnly validator 产物（纯校验下限）
const officialParser = compileFn(AccountsStock) as (i: unknown) => unknown;
const officialParserCow = compileFn(AccountsCow) as (i: unknown) => unknown;
const officialValidator = compileFn(AccountStock, { assertOnly: true }) as (i: unknown) => unknown;

const Z4Stock = compile(AccountsStock);
const Z4Cow = compile(AccountsCow);

/* ─────────────────────────── 测量工具 ─────────────────────────── */

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

/** async 版测量：await 完整 promise 链（S7 async 场景用；同步计时含微任务排空） */
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
    `  ${label.padEnd(44)} median ${median.toFixed(0).padStart(6)}ms   分配压力 ${fmt(heap).padStart(9)}   gc后驻留 ${fmt(retained).padStart(9)}`,
  );
  return median;
}

const medianOf = (samples: Sample[]): number =>
  samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(PASSES / 2)]!;

/* ─────────────────────────── S1: 纯校验主赛道 ─────────────────────────── */

console.log(`\n═══ S1 纯校验 · ${N.toLocaleString()} 账户 · 每变体 ${PASSES} 轮取中位 ═══`);
console.log(`  zc-z4 stock degradation: ${Z4Stock.stock ? "yes (unexpected!)" : "no"}`);
const data = makeAccounts();

{
  const stockOut = stockParser(data);
  assert.ok(stockOut.success);
  const z4Out = Z4Stock.safeParse(data);
  assert.ok(z4Out.success);
  assert.deepStrictEqual(z4Out.data, (stockOut as any).data);
  console.log(
    `  正确性: deepStrictEqual ✓   z4 输出 === 输入引用: ${z4Out.data === data ? "是（零拷贝）" : "否"}`,
  );
}

const s1Stock = measure(() => stockParser(data));
report("stock zod4 safeParse（解释器）", s1Stock);
const s1Official = measure(() => officialParser(data));
report("官方 compileFn parser（JIT·stock 语义）", s1Official);
const s1Z4 = measure(() => Z4Stock.safeParse(data));
report("zc-z4 CoW parse（官方 codegen+修饰）", s1Z4);

console.log(`\n  比值（中位）:`);
console.log(
  `    stock / 官方parser = ${(medianOf(s1Stock) / medianOf(s1Official)).toFixed(2)}x   ← 官方 JIT 本身的收益`,
);
console.log(
  `    stock / zc-z4      = ${(medianOf(s1Stock) / medianOf(s1Z4)).toFixed(2)}x   ← CoW 修饰总收益`,
);
console.log(
  `    官方parser / zc-z4 = ${(medianOf(s1Official) / medianOf(s1Z4)).toFixed(2)}x   ← CoW 修饰在 JIT 之上的净收益`,
);

/* ─────────────────────────── S2: CoW 脏负载 ─────────────────────────── */

console.log(`\n═══ S2 CoW 脏负载 · role 带 default · 10% 数据缺 role ═══`);
const dataCow = deriveMissingRole(data, 10, 5);
{
  const stockOut = stockCowParser(dataCow);
  assert.ok(stockOut.success);
  const z4Out = Z4Cow.safeParse(dataCow);
  assert.ok(z4Out.success);
  assert.deepStrictEqual(z4Out.data, (stockOut as any).data);
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  console.log(`  正确性: deepStrictEqual ✓   缺 role 占比 ${((injected / N) * 100).toFixed(1)}%`);
}

const s2Stock = measure(() => stockCowParser(dataCow));
report("stock zod4 safeParse（default 场景）", s2Stock);
const s2Official = measure(() => officialParserCow(dataCow));
report("官方 compileFn parser（JIT·default）", s2Official);
const s2Z4 = measure(() => Z4Cow.safeParse(dataCow));
report("zc-z4 CoW parse（90% 零拷贝）", s2Z4);
console.log(
  `\n  Ratios (median): stock/z4 = ${(medianOf(s2Stock) / medianOf(s2Z4)).toFixed(2)}x   official parser/z4 = ${(medianOf(s2Official) / medianOf(s2Z4)).toFixed(2)}x`,
);

/* ─────────────────────────── S3: 脏比例扫描 ─────────────────────────── */

console.log(`\n═══ S3 脏比例扫描 · role 缺失比例 → default 注入 ═══`);
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

/* ─────────────────────────── S5: record/map/set 容器场景 ─────────────────────────── */

console.log(
  `\n═══ S5 容器 CoW · record / map / set · ${N.toLocaleString()} 条 · 每变体 ${PASSES} 轮取中位 ═══`,
);
{
  // 数据：50 万条记录，每条含一个 4 键 record + 一个 3 条目 map + 一个 3 成员 set
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
    `  正确性: deepStrictEqual ✓   CoW 输出 === 输入引用: ${probe.data === rows ? "是（零拷贝）" : "否"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S5 stock（record+map+set 每条重建）", rs);
  const ro = measure(() => rowsParser(rows));
  report("S5 官方 compileFn parser（JIT·stock）", ro);
  const rv = measure(() => RowsZ4.safeParse(rows));
  report("S5 zc-z4 CoW parse（零拷贝）", rv);
  console.log(
    `  比值（中位）: stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   官方parser/z4 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
  );
}

/* ─────────────────────────── S6: tuple 场景 ─────────────────────────── */

console.log(
  `\n═══ S6 tuple CoW · 坐标/标签 tuple · ${N.toLocaleString()} 条 · 每变体 ${PASSES} 轮取中位 ═══`,
);
{
  // 数据：50 万条，每条含满长 tuple [x,y]（全数字）与 [name, optional tag]
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
    `  正确性: deepStrictEqual ✓   CoW 输出 === 输入引用: ${probe.data === rows ? "是（零拷贝）" : "否"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S6 stock（tuple 每条重建 new 数组）", rs);
  const ro = measure(() => rowsParser(rows));
  report("S6 官方 compileFn parser（JIT·stock）", ro);
  const rv = measure(() => RowsZ4.safeParse(rows));
  report("S6 zc-z4 CoW parse（零拷贝）", rv);
  console.log(
    `  比值（中位）: stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   官方parser/z4 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
  );
}

/* ─────────────────────────── S7: async 场景 ─────────────────────────── */

console.log(
  `\n═══ S7 async CoW · async transform 叶子 · ${(N / 10).toLocaleString()} 条 · 每变体 ${PASSES} 轮取中位 ═══`,
);
{
  // 数据规模：async 每元素一条 microtask 链，N/10 条保持单轮可测量
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
  assert.ok(RowsZ4.async && !RowsZ4.stock, "async 骨架编译成功");

  const probe = await RowsZ4.safeParseAsync(rows);
  const stockProbe = await Rows.safeParseAsync(rows);
  assert.ok(probe.success && stockProbe.success);
  assert.deepStrictEqual(probe.data, stockProbe.data);
  console.log(
    `  正确性: deepStrictEqual ✓   z4 async=${RowsZ4.async}   分配压力（输出 email 全脏 → 每行新对象）`,
  );

  const stockAsync = Rows.safeParseAsync.bind(Rows);
  const rs = await measureAsync(async () => {
    const r = await stockAsync(rows);
    if (!r.success) throw new Error("stock fail");
    return r.data.length;
  });
  report("S7 stock safeParseAsync（async 解释器）", rs);
  const rv = await measureAsync(() => RowsZ4.safeParseAsync(rows));
  report("S7 zc-z4 safeParseAsync（async 骨架+CoW）", rv);
  console.log(
    `  比值（中位）: stock/z4 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   （async 叶子值变 → 拷贝集中在脏行，骨架其余零拷贝）`,
  );
}

/* ─────────────────────────── validate 快路径 ─────────────────────────── */

console.log(`\n═══ S4 validate 纯校验（返回原引用语义） ═══`);
{
  const mVal = measure(() => {
    let ok = 0;
    for (let i = 0; i < N; i++) if (officialValidator(data[i]) !== true) ok++;
    return ok;
  });
  report("官方 assertOnly validator（逐账户）", mVal);
  const mZ4Val = measure(() => {
    let ok = 0;
    for (let i = 0; i < N; i++) if (Z4Stock.validate(data[i]) !== null) ok++;
    return ok;
  });
  report("zc-z4 validate（整树 assertOnly 产物）", mZ4Val);
}

/* ─────────────────────────── arktype 参照 ─────────────────────────── */

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
  report("arktype（参照线，不拷贝）", mArk);
} catch {
  console.log("  arktype 未安装，跳过参照线");
}

console.log("\n注：分配压力 = 运行结束（gc 前）heapUsed 增量；gc后驻留 = gc 后仍占用的增量。");
console.log("    zc-z4 在纯路径上返回输入原引用（≈0 分配、0 驻留）；脏路径仅脏对象浅拷贝。");
