/**
 * 基准测试（zod4 前端）— 复现 Numeric 文章的 50 万账户场景。
 *
 *   S1（主赛道）: 纯校验 schema（无 default/transform）
 *       - stock zod4 .parse（每 parse 重建整棵输出树）
 *       - stock zod4 + JIT（import "zod4/compile"，官方代码生成入口）
 *       - zc compiled .parse（CoW：干净输入零分配）
 *       - arktype（参照线，不拷贝）
 *   S2（CoW 展示）: 同 schema 但 role 带 default，10% 数据缺 role
 *   S3（脏比例扫描）: role 缺失比例 0% / 25% / 50% / 100%，各一轮
 *
 * 每个变体：1 轮预热 + 3 轮计时（gc() 后开始），报告最优/中位耗时、
 * 运行后 heapUsed 增量（分配压力，gc 前）与 gc 后驻留增量。
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

/* zod4/compile 是 side-effect import，必须在任何 schema 创建之前加载 */
let jitLoaded = false;
try {
  await import("zod4/compile");
  jitLoaded = true;
} catch {
  jitLoaded = false;
}

const { z } = await import("zod4");
const { compile } = await import("../src/index-z4.js");

const N = Number(process.env.BENCH_N ?? 500_000);
const PASSES = 3;

/* ─────────────────────────── 数据生成 ─────────────────────────── */

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

/** 脏负载用：浅拷贝派生（嵌套 address/tags 共享），按比例缺 role → default 注入路径 */
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
const Compiled = compile(AccountsStock);
const CompiledCow = compile(AccountsCow);

/* ─────────────────────────── 测量工具 ─────────────────────────── */

const gc = (): void => {
  (globalThis as any).gc?.();
};

interface Sample {
  ms: number;
  heapDelta: number; // 运行后（gc 前）heapUsed 增量 ≈ 分配压力
  retainedDelta: number; // gc 后增量 ≈ 驻留
}

function measure(_label: string, fn: () => unknown): Sample[] {
  const samples: Sample[] = [];
  for (let p = -1; p < PASSES; p++) {
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const result = fn(); // 保留结果，防止死代码消除
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

function report(label: string, samples: Sample[]): { best: number; median: number } {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const best = ms[0]!;
  const median = ms[Math.floor(ms.length / 2)]!;
  const heap = samples.reduce((m, s) => Math.max(m, s.heapDelta), 0);
  const retained = samples.reduce((m, s) => Math.max(m, s.retainedDelta), 0);
  const fmt = (v: number) => (v > 0 ? `+${(v / 1048576).toFixed(1)}MB` : `${(v / 1048576).toFixed(1)}MB`);
  console.log(
    `  ${label.padEnd(38)} best ${best.toFixed(0).padStart(6)}ms   median ${median
      .toFixed(0)
      .padStart(6)}ms   分配压力 ${fmt(heap).padStart(10)}   gc后驻留 ${fmt(retained).padStart(10)}`,
  );
  return { best, median };
}

const median = (samples: Sample[]) => samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(PASSES / 2)]!;

/* ─────────────────────────── S1: 纯校验主赛道 ─────────────────────────── */

console.log(`\n═══ S1 纯校验 · ${N.toLocaleString()} 账户 · zod4 ${(z as any)._zod ? "" : ""}· 每变体 ${PASSES} 轮 ═══`);
console.log(`  JIT (zod4/compile): ${jitLoaded ? "已加载" : "不可用"}`);
const data = makeAccounts();

// 正确性预检：输出值必须与 stock 一致
{
  const stockOut = AccountsStock.safeParse(data);
  assert.ok(stockOut.success);
  const cowOut = Compiled.safeParse(data);
  assert.ok(cowOut.success);
  assert.deepStrictEqual(cowOut.data, stockOut.data);
  console.log(
    `  正确性: deepStrictEqual ✓   CoW 输出 === 输入引用: ${cowOut.data === data ? "是（零拷贝）" : "否"}`,
  );
}

const s1Stock = measure("stock zod4 parse", () => AccountsStock.parse(data));
report("stock zod4 parse（重建输出树）", s1Stock);
const s1Cow = measure("zc compiled parse（CoW）", () => Compiled.parse(data));
report("zc compiled parse（CoW 零拷贝）", s1Cow);
console.log(`  → 加速比 (stock/zc): ${(median(s1Stock) / median(s1Cow)).toFixed(2)}x（按中位）`);

// JIT 参照线
if (jitLoaded) {
  try {
    const s1Jit = measure("stock zod4 + JIT parse", () => AccountsStock.parse(data));
    report("stock zod4 + JIT parse（官方 codegen）", s1Jit);
  } catch (e) {
    console.log(`  JIT parse 失败，跳过: ${(e as Error).message}`);
  }
}

// arktype 参照线（可选）
try {
  const { type } = await import("arktype");
  const At = type({
    id: "number",
    firstName: "string<=64",
    lastName: "string<=64",
    email: "string.email",
    role: "'admin'|'member'|'viewer'",
    balance: "number",
    createdAt: "string", // arktype 的 datetime 关键词语义不同，取 string 近似
    tags: "string[]",
    address: { street: "string", city: "string", zip: "string", country: "string" },
    active: "boolean",
  }).array();
  const s1Ark = measure("arktype（参照线，不拷贝）", () => At(data));
  report("arktype（参照线，不拷贝）", s1Ark);
  console.log(`  → zc vs arktype: ${(median(s1Cow) / median(s1Ark)).toFixed(2)}x（按中位）`);
} catch {
  console.log("  arktype 未安装，跳过参照线");
}

/* ─────────────────────────── S2: CoW 脏负载 ─────────────────────────── */

console.log(`\n═══ S2 CoW 脏负载 · role 带 default · 10% 数据缺 role ═══`);
const dataCow = deriveMissingRole(data, 10, 5);
{
  const stockOut = AccountsCow.safeParse(dataCow);
  assert.ok(stockOut.success);
  const cowOut = CompiledCow.safeParse(dataCow);
  assert.ok(cowOut.success);
  assert.deepStrictEqual(cowOut.data, stockOut.data);
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  console.log(`  正确性: deepStrictEqual ✓   缺 role 占比 ${((injected / N) * 100).toFixed(1)}%`);
}

const s2Stock = measure("stock zod4 parse（default 场景）", () => AccountsCow.parse(dataCow));
report("stock zod4 parse（default 场景）", s2Stock);
const s2Cow = measure("zc compiled parse（CoW: 90%零拷贝）", () => CompiledCow.parse(dataCow));
report("zc compiled parse（CoW: 90%零拷贝）", s2Cow);
console.log(`  → 加速比: ${(median(s2Stock) / median(s2Cow)).toFixed(2)}x（按中位）`);

if (jitLoaded) {
  try {
    const s2Jit = measure("stock zod4 + JIT（default 场景）", () => AccountsCow.parse(dataCow));
    report("stock zod4 + JIT（default 场景）", s2Jit);
  } catch {
    /* skip */
  }
}

/* ─────────────────────────── S3: 脏比例扫描 ─────────────────────────── */

console.log(`\n═══ S3 脏比例扫描 · role 缺失比例 → default 注入 · 每变体 ${PASSES} 轮取中位 ═══`);
console.log(`  ${"缺失比例".padEnd(8)} ${"stock".padStart(9)} ${"zc CoW".padStart(9)} ${"加速比".padStart(8)}   ${"stock驻留".padStart(11)} ${"zc驻留".padStart(11)}`);
for (const ratio of [0, 0.25, 0.5, 1.0]) {
  const ds = deriveMissingRole(data, ratio === 0 ? 0 : Math.round(1 / ratio), 3);
  const sStock = measure("s", () => AccountsCow.safeParse(ds));
  const sCow = measure("c", () => CompiledCow.safeParse(ds));
  // 正确性抽查
  const rs = AccountsCow.safeParse(ds);
  const rc = CompiledCow.safeParse(ds);
  assert.ok(rs.success && rc.success);
  assert.deepStrictEqual(rc.data, rs.data);
  const mS = median(sStock);
  const mC = median(sCow);
  const rS = sStock.reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  const rC = sCow.reduce((m, s) => Math.max(m, s.retainedDelta), 0) / 1048576;
  console.log(
    `  ${(ratio * 100).toFixed(0).padEnd(7)}% ${mS.toFixed(0).padStart(8)}ms ${mC.toFixed(0).padStart(8)}ms ${(mS / mC).toFixed(2).padStart(7)}x   ${(rS).toFixed(1).padStart(9)}MB ${(rC).toFixed(1).padStart(9)}MB`,
  );
}

console.log("\n注：分配压力 = 运行结束（gc 前）heapUsed 增量，包含垃圾 + 驻留；");
console.log("    stock 每轮都重建整棵输出树，CoW 在纯路径上返回输入原引用（≈0 分配）。");
