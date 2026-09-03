/**
 * 基准测试（zc-v2：官方 codegen + CoW 修饰）—— 复现 Numeric 文章的 50 万账户场景。
 *
 * 对照组：
 *   stock zod4 safeParse          解释器基线（每 parse 重建整棵输出树）
 *   官方 compileFn parser          官方 JIT 产物、stock 语义（无条件新容器）——「只复用不修饰」对照
 *   官方 compileFn validator       官方 assertOnly 纯校验下限（validate 语义参照）
 *   zc-v2 CoW parse                本次主角：官方 codegen + CoW 容器修饰
 *   zc-v1 CoW parse（Task3 自研）   纵向对比：手写语义 codegen + 解释循环
 *   arktype                        参照线
 *
 *   S1（主赛道）: 纯校验 schema（干净输入 → CoW 应零拷贝原引用返回）
 *   S2（CoW 展示）: role 带 default，10% 数据缺 role
 *   S3（脏比例扫描）: role 缺失比例 0% / 25% / 50% / 100%
 *
 * 每变体：2 轮预热 + 3 轮计时（gc() 后开始），报告中位耗时、
 * 运行后 heapUsed 增量（分配压力，gc 前）与 gc 后驻留增量。
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

const { z } = await import("zod4");
const { compile: compileV1 } = await import("../src/index-z4.js");
const { compileV2 } = await import("../src/index-z4-v2.js");
const { compileFn } = await import("zod4/v4/core");

const N = Number(process.env.BENCH_N ?? 500_000);
const PASSES = 3;

/* ─────────────────────────── 数据生成（与 bench-z4 完全一致） ─────────────────────────── */

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

const V2Stock = compileV2(AccountsStock);
const V2Cow = compileV2(AccountsCow);
const V1Stock = compileV1(AccountsStock);
const V1Cow = compileV1(AccountsCow);

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
console.log(`  zc-v2 stock 降级: ${V2Stock.stock ? "是（异常！）" : "否"}   v1 编译: 正常`);
const data = makeAccounts();

{
  const stockOut = stockParser(data);
  assert.ok(stockOut.success);
  const v2Out = V2Stock.safeParse(data);
  assert.ok(v2Out.success);
  assert.deepStrictEqual(v2Out.data, (stockOut as any).data);
  console.log(
    `  正确性: deepStrictEqual ✓   v2 输出 === 输入引用: ${v2Out.data === data ? "是（零拷贝）" : "否"}`,
  );
}

const s1Stock = measure(() => stockParser(data));
report("stock zod4 safeParse（解释器）", s1Stock);
const s1Official = measure(() => officialParser(data));
report("官方 compileFn parser（JIT·stock 语义）", s1Official);
const s1V2 = measure(() => V2Stock.safeParse(data));
report("zc-v2 CoW parse（官方 codegen+修饰）", s1V2);
const s1V1 = measure(() => V1Stock.safeParse(data));
report("zc-v1 CoW parse（Task3 自研 codegen）", s1V1);

console.log(`\n  比值（中位）:`);
console.log(
  `    stock / 官方parser = ${(medianOf(s1Stock) / medianOf(s1Official)).toFixed(2)}x   ← 官方 JIT 本身的收益`,
);
console.log(
  `    stock / zc-v2      = ${(medianOf(s1Stock) / medianOf(s1V2)).toFixed(2)}x   ← CoW 修饰总收益`,
);
console.log(
  `    官方parser / zc-v2 = ${(medianOf(s1Official) / medianOf(s1V2)).toFixed(2)}x   ← CoW 修饰在 JIT 之上的净收益`,
);
console.log(
  `    zc-v1 / zc-v2      = ${(medianOf(s1V1) / medianOf(s1V2)).toFixed(2)}x   ← 复用官方 codegen vs 自研`,
);

/* ─────────────────────────── S2: CoW 脏负载 ─────────────────────────── */

console.log(`\n═══ S2 CoW 脏负载 · role 带 default · 10% 数据缺 role ═══`);
const dataCow = deriveMissingRole(data, 10, 5);
{
  const stockOut = stockCowParser(dataCow);
  assert.ok(stockOut.success);
  const v2Out = V2Cow.safeParse(dataCow);
  assert.ok(v2Out.success);
  assert.deepStrictEqual(v2Out.data, (stockOut as any).data);
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  console.log(`  正确性: deepStrictEqual ✓   缺 role 占比 ${((injected / N) * 100).toFixed(1)}%`);
}

const s2Stock = measure(() => stockCowParser(dataCow));
report("stock zod4 safeParse（default 场景）", s2Stock);
const s2Official = measure(() => officialParserCow(dataCow));
report("官方 compileFn parser（JIT·default）", s2Official);
const s2V2 = measure(() => V2Cow.safeParse(dataCow));
report("zc-v2 CoW parse（90% 零拷贝）", s2V2);
const s2V1 = measure(() => V1Cow.safeParse(dataCow));
report("zc-v1 CoW parse（Task3）", s2V1);
console.log(
  `\n  比值（中位）: stock/v2 = ${(medianOf(s2Stock) / medianOf(s2V2)).toFixed(2)}x   官方parser/v2 = ${(medianOf(s2Official) / medianOf(s2V2)).toFixed(2)}x   stock/v1 = ${(medianOf(s2Stock) / medianOf(s2V1)).toFixed(2)}x`,
);

/* ─────────────────────────── S3: 脏比例扫描 ─────────────────────────── */

console.log(`\n═══ S3 脏比例扫描 · role 缺失比例 → default 注入 ═══`);
console.log(
  `  ${"缺失比例".padEnd(8)} ${"stock".padStart(8)} ${"官方JIT".padStart(8)} ${"zc-v2".padStart(8)} ${"zc-v1".padStart(8)} ${"stock/v2".padStart(8)}   ${"v2驻留".padStart(8)} ${"stock驻留".padStart(9)}`,
);
for (const ratio of [0, 0.25, 0.5, 1.0]) {
  const ds = deriveMissingRole(data, ratio === 0 ? 0 : Math.round(1 / ratio), 3);
  const mStock = medianOf(measure(() => stockCowParser(ds)));
  const mOfficial = medianOf(measure(() => officialParserCow(ds)));
  const mV2 = medianOf(measure(() => V2Cow.safeParse(ds)));
  const mV1 = medianOf(measure(() => V1Cow.safeParse(ds)));
  const rs =
    measure(() => stockCowParser(ds)).reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  const rv =
    measure(() => V2Cow.safeParse(ds)).reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  console.log(
    `  ${(ratio * 100).toFixed(0).padEnd(7)}% ${mStock.toFixed(0).padStart(7)}ms ${mOfficial.toFixed(0).padStart(7)}ms ${mV2.toFixed(0).padStart(7)}ms ${mV1.toFixed(0).padStart(7)}ms ${(mStock / mV2).toFixed(2).padStart(7)}x   ${rv.toFixed(1).padStart(7)}MB ${rs.toFixed(1).padStart(8)}MB`,
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
  const RowsV2 = compileV2(Rows);
  const rowsParser = compileFn(Rows) as (i: unknown) => unknown;

  const probe = RowsV2.safeParse(rows);
  assert.ok(probe.success);
  assert.deepStrictEqual(probe.data, (Rows.safeParse(rows) as any).data);
  console.log(
    `  正确性: deepStrictEqual ✓   CoW 输出 === 输入引用: ${probe.data === rows ? "是（零拷贝）" : "否"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S5 stock（record+map+set 每条重建）", rs);
  const ro = measure(() => rowsParser(rows));
  report("S5 官方 compileFn parser（JIT·stock）", ro);
  const rv = measure(() => RowsV2.safeParse(rows));
  report("S5 zc-v2 CoW parse（零拷贝）", rv);
  console.log(
    `  比值（中位）: stock/v2 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   官方parser/v2 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
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
  const RowsV2 = compileV2(Rows);
  const rowsParser = compileFn(Rows) as (i: unknown) => unknown;

  const probe = RowsV2.safeParse(rows);
  assert.ok(probe.success);
  assert.deepStrictEqual(probe.data, (Rows.safeParse(rows) as any).data);
  console.log(
    `  正确性: deepStrictEqual ✓   CoW 输出 === 输入引用: ${probe.data === rows ? "是（零拷贝）" : "否"}`,
  );

  const rs = measure(() => Rows.safeParse(rows));
  report("S6 stock（tuple 每条重建 new 数组）", rs);
  const ro = measure(() => rowsParser(rows));
  report("S6 官方 compileFn parser（JIT·stock）", ro);
  const rv = measure(() => RowsV2.safeParse(rows));
  report("S6 zc-v2 CoW parse（零拷贝）", rv);
  console.log(
    `  比值（中位）: stock/v2 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   官方parser/v2 = ${(medianOf(ro) / medianOf(rv)).toFixed(2)}x`,
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
  const RowsV2 = compileV2(Rows);
  assert.ok(RowsV2.async && !RowsV2.stock, "async 骨架编译成功");

  const probe = await RowsV2.safeParseAsync(rows);
  const stockProbe = await Rows.safeParseAsync(rows);
  assert.ok(probe.success && stockProbe.success);
  assert.deepStrictEqual(probe.data, stockProbe.data);
  console.log(
    `  正确性: deepStrictEqual ✓   v2 async=${RowsV2.async}   分配压力（输出 email 全脏 → 每行新对象）`,
  );

  const stockAsync = Rows.safeParseAsync.bind(Rows);
  const rs = await measureAsync(async () => {
    const r = await stockAsync(rows);
    if (!r.success) throw new Error("stock fail");
    return r.data.length;
  });
  report("S7 stock safeParseAsync（async 解释器）", rs);
  const rv = await measureAsync(() => RowsV2.safeParseAsync(rows));
  report("S7 zc-v2 safeParseAsync（async 骨架+CoW）", rv);
  console.log(
    `  比值（中位）: stock/v2 = ${(medianOf(rs) / medianOf(rv)).toFixed(2)}x   （async 叶子值变 → 拷贝集中在脏行，骨架其余零拷贝）`,
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
  const mV2Val = measure(() => {
    let ok = 0;
    for (let i = 0; i < N; i++) if (V2Stock.validate(data[i]) !== null) ok++;
    return ok;
  });
  report("zc-v2 validate（整树 assertOnly 产物）", mV2Val);
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
console.log("    zc-v2 在纯路径上返回输入原引用（≈0 分配、0 驻留）；脏路径仅脏对象浅拷贝。");
