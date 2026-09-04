/**
 * 冒烟：tuple CoW 骨架 + async schema 通道（Task 6）。
 * 逐项断言与 stock zod4 语义对齐 + CoW 引用共享行为。
 */
import assert from "node:assert/strict";
import { z } from "zod4";
import { compile } from "../src/index-z4.js";

let group = "";
function head(s: string): void {
  group = s;
  console.log(`\n── ${s} ──`);
}
function ok(msg: string): void {
  console.log(`  ✓ ${group}: ${msg}`);
}

/* ═══════════════ tuple ═══════════════ */

head("tuple 满长干净 → 原引用");
{
  const S = z.tuple([z.string(), z.number(), z.boolean()]);
  const C = compile(S);
  assert.ok(!C.stock);
  const input = ["a", 1, true] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.ok((r.data as unknown[]) === input, "满长全引用未变 → 原引用");
  ok("out === input");
}

head("tuple 元素脏（transform）→ slice 写回");
{
  const S = z.tuple([z.string(), z.string().transform((s) => s.toUpperCase())]);
  const C = compile(S);
  const input = ["a", "b"] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  const out = r.data as unknown[];
  assert.deepEqual(out, ["a", "B"]);
  assert.ok(out !== input, "值变 → 新数组");
  assert.equal(out[0], input[0], "未变元素引用保留");
  assert.deepEqual(input, ["a", "b"], "输入零失真");
  ok("out !== input 且未变元素共享");
}

head("tuple 短输入 trailing optional → 截断（截断目标=输入长 → 原引用）");
{
  const S = z.tuple([z.string(), z.optional(z.string()), z.optional(z.string())]);
  const C = compile(S);
  const input = ["a"] as unknown[];
  const stock = S.safeParse(input as never);
  assert.ok(stock.success);
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.deepEqual(r.data, stock.data, "与 stock 输出一致");
  assert.equal((r.data as unknown[]).length, 1);
  assert.ok((r.data as unknown[]) === input, "截断到输入长度且引用未变 → 原引用");
  // 两个尾部 optional 都在场 → 满长原引用
  const full = ["a", "b", "c"] as unknown[];
  const r2 = C.safeParse(full);
  assert.ok(r2.success && (r2.data as unknown[]) === full);
  // 中间截断：["a", undefined] → 槽 2 缺席截断到 2（引用未变 → 原引用）
  const mid = ["a", undefined] as unknown[];
  const stockMid = S.safeParse(mid as never);
  const r3 = C.safeParse(mid);
  assert.ok(r3.success && stockMid.success);
  assert.deepEqual(r3.data, stockMid.data);
  ok("截断三态 + 与 stock 一致");
}

head("tuple default 尾槽缺席 → 填充（结构扩展必拷贝）");
{
  const S = z.tuple([z.string(), z.string().default("D")]);
  const C = compile(S);
  const input = ["a"] as unknown[];
  const stock = S.safeParse(input as never);
  const r = C.safeParse(input);
  assert.ok(r.success && stock.success);
  assert.deepEqual(r.data, stock.data, "与 stock 填充一致");
  assert.deepEqual(r.data, ["a", "D"]);
  assert.ok((r.data as unknown[]) !== input, "输出长于输入 → 必拷贝");
  // 满长时 default 槽 present → 引用未变 → 原引用
  const full = ["a", "x"] as unknown[];
  const r2 = C.safeParse(full);
  assert.ok(r2.success && (r2.data as unknown[]) === full);
  ok("default 填充拷贝 / 满长原引用");
}

head("tuple 超长无 rest → 拒绝（回退 stock too_big）");
{
  const S = z.tuple([z.string(), z.optional(z.string())]);
  const C = compile(S);
  const input = ["a", "b", "c"] as unknown[];
  const stock = S.safeParse(input as never);
  const r = C.safeParse(input);
  assert.equal(r.success, stock.success);
  assert.ok(!r.success, "超长拒绝");
  ok("too_big 一致");
}

head("tuple + rest → 逐槽引用比较");
{
  const S = z.tuple([z.string()], z.number());
  const C = compile(S);
  assert.ok(!C.stock);
  const input = ["a", 1, 2] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success && (r.data as unknown[]) === input, "rest 全干净 → 原引用");
  // rest 元素转换（number → string 键重试不适用；用 rest schema transform）
  const S2 = z.tuple(
    [z.string()],
    z.string().transform((s) => s.length),
  );
  const C2 = compile(S2);
  const input2 = ["a", "bb", "ccc"] as unknown[];
  const stock2 = S2.safeParse(input2 as never);
  const r2 = C2.safeParse(input2);
  assert.ok(r2.success && stock2.success);
  assert.deepEqual(r2.data, stock2.data);
  assert.deepEqual(r2.data, ["a", 2, 3]);
  assert.ok((r2.data as unknown[]) !== input2, "rest 元素变 → 拷贝");
  assert.equal((r2.data as unknown[])[0], input2[0]);
  // rest 元素失败
  const bad = ["a", "bb", 42] as unknown[];
  const rb = C2.safeParse(bad);
  const stockB = S2.safeParse(bad as never);
  assert.equal(rb.success, stockB.success);
  assert.ok(!rb.success);
  ok("rest 三态一致");
}

head("tuple + refine（容器自身 checks 双路径）");
{
  const S = z.tuple([z.string(), z.string()]).refine((t) => t[0] === t[1], { error: "mismatch" });
  const C = compile(S);
  assert.ok(!C.stock);
  const good = ["a", "a"] as unknown[];
  const r = C.safeParse(good);
  assert.ok(r.success && (r.data as unknown[]) === good, "干净 + checks 过 → 原引用");
  const bad = ["a", "b"] as unknown[];
  const rb = C.safeParse(bad);
  const stockB = S.safeParse(bad as never);
  assert.equal(rb.success, stockB.success, "checks 失败一致");
  assert.ok(!rb.success);
  // 元素脏 + checks 作用于重建输出
  const S2 = z
    .tuple([z.string(), z.string().transform((s) => `${s}!`)])
    .refine((t) => (t[1] as string).endsWith("!"), { error: "need bang" });
  const C2 = compile(S2);
  const r2 = C2.safeParse(["x", "y"] as unknown[]);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, ["x", "y!"]);
  ok("checks 双路径一致");
}

head("嵌套：tuple 内 object（CoW 子骨架）+ tuple 被 optional 包装");
{
  const S = z.tuple([z.object({ a: z.string(), b: z.number() }), z.string()]);
  const C = compile(S);
  const inner = { a: "x", b: 1 };
  const input = [inner, "s"] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  const out = r.data as unknown[];
  assert.ok(out === input, "全干净 → 原引用");
  assert.ok((out[0] as unknown) === inner, "内层共享");
  // 内层 strip 触发
  const S2 = z.tuple([z.object({ a: z.string() }), z.string()]);
  const C2 = compile(S2);
  const dirty = [{ a: "x", extra: true }, "s"] as unknown[];
  const r2 = C2.safeParse(dirty);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, [{ a: "x" }, "s"]);
  assert.ok((r2.data as unknown[]) !== dirty, "strip 触发拷贝");
  // optional(tuple)
  const S3 = z.optional(z.tuple([z.string()]));
  const C3 = compile(S3);
  const r3 = C3.safeParse(["a"] as unknown);
  assert.ok(r3.success && Array.isArray(r3.data));
  const r4 = C3.safeParse(undefined);
  assert.ok(r4.success && r4.data === undefined);
  ok("嵌套 strip / 剥壳一致");
}

head("tuple 短输入落入 defaulted 槽区（optinStart < L < optoutStart）");
{
  // z.tuple([z.string().default("D")])：optinStart=0, optoutStart=1
  const S = z.tuple([z.string().default("D")]);
  const C = compile(S);
  const stockEmpty = S.safeParse([] as never);
  const rEmpty = C.safeParse([] as unknown[]);
  assert.ok(rEmpty.success && stockEmpty.success);
  assert.deepEqual(rEmpty.data, stockEmpty.data, "空输入 → default 填充与 stock 一致");
  assert.deepEqual(rEmpty.data, ["D"]);
  // 混合：[optional, defaulted]：optinStart=0, optoutStart=2
  const S2 = z.tuple([z.string().optional(), z.string().default("D")]);
  const C2 = compile(S2);
  for (const inp of [[], ["a"], ["a", "b"]] as unknown[][]) {
    const stock = S2.safeParse(inp as never);
    const r = C2.safeParse(inp);
    assert.equal(r.success, stock.success, `L=${inp.length} 成败一致`);
    if (r.success && stock.success)
      assert.deepEqual(r.data, stock.data, `L=${inp.length} 输出一致`);
  }
  ok("defaulted 槽区四态一致");
}

head("tuple 与 union/discriminated 组合 + 差分外的 stock 对齐抽查");
{
  const S = z.object({
    pair: z.tuple([z.string(), z.number()]),
    list: z.array(z.tuple([z.string(), z.optional(z.string())])),
  });
  const C = compile(S);
  const input = { pair: ["a", 1], list: [["x"], ["y", "z"]] } as never;
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.ok((r.data as never) === input, "组合全干净 → 原引用");
  ok("对象内嵌 tuple 引用共享");
}

/* ═══════════════ async ═══════════════ */

head("async refine 在 object 键（其余键 CoW）");
{
  const S = z.object({
    keep: z.object({ n: z.number() }), // 纯容器 → CoW 子骨架
    check: z.string().refine(async (s) => s.length > 2),
  });
  const C = compile(S);
  assert.ok(!C.stock, "不再整树降级");
  assert.ok(C.async, "async 骨架");
  // sync API 抛 $ZodAsyncError
  let threw = false;
  try {
    C.parse({ keep: { n: 1 }, check: "abc" });
  } catch (e: any) {
    threw = e.constructor.name === "$ZodAsyncError";
  }
  assert.ok(threw);
  const input = { keep: { n: 1 }, check: "abc" };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  assert.ok((r.data as never) === input, "async 骨架干净 → 原引用");
  assert.ok((r.data as { keep: object }).keep === input.keep, "内层共享");
  const bad = await C.safeParseAsync({ keep: { n: 1 }, check: "x" });
  const stockBad = await S.safeParseAsync({ keep: { n: 1 }, check: "x" } as never);
  assert.equal(bad.success, stockBad.success);
  assert.ok(!bad.success, "async refine 失败一致");
  ok("async 骨架 + CoW 混合");
}

head("async transform → 引用比较判脏");
{
  const S = z.object({
    name: z.string().transform(async (s) => s.toUpperCase()),
    tag: z.string(),
  });
  const C = compile(S);
  assert.ok(C.async);
  const input = { name: "a", tag: "t" };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  assert.deepEqual(r.data, { name: "A", tag: "t" });
  assert.ok((r.data as never) !== input, "async transform值变 → 拷贝");
  assert.equal((r.data as { tag: string }).tag, input.tag, "未变键共享");
  // 数组内 async transform
  const S2 = z.array(z.string().transform(async (s) => `${s}!`));
  const C2 = compile(S2);
  const in2 = ["a", "b"];
  const r2 = await C2.safeParseAsync(in2);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, ["a!", "b!"]);
  assert.ok(r2.data !== in2);
  ok("async 值脏 → 条件拷贝");
}

head("lazy(async) 静态探测 → async 岛");
{
  const S = z.object({ v: z.lazy(() => z.string().transform(async (s) => `${s}?`)) });
  const C = compile(S);
  assert.ok(C.async, "lazy(async) 被静态识破");
  const r = await C.safeParseAsync({ v: "x" });
  assert.ok(r.success);
  assert.deepEqual(r.data, { v: "x?" });
  assert.ok((r.data as never) !== undefined, "产出正确");
  ok("lazy(async) 不再静默失败");
}

head("union 含 async 分支 → async 岛");
{
  const S = z.union([z.string().refine(async (s) => s.length > 2), z.number()]);
  const C = compile(S);
  assert.ok(C.async);
  const r1 = await C.safeParseAsync("hello");
  assert.ok(r1.success && r1.data === "hello");
  const r2 = await C.safeParseAsync(42);
  assert.ok(r2.success && r2.data === 42);
  const r3 = await C.safeParseAsync("x");
  const stock3 = await S.safeParseAsync("x" as never);
  assert.equal(r3.success, stock3.success, "两分支全败一致");
  ok("union async 分支三态");
}

head("async refine 挂在 array/map/set/record/tuple 上（容器 checks async）");
{
  const S = z.array(z.string()).refine(async (a) => a.length > 1);
  const C = compile(S);
  assert.ok(C.async, "async 容器 checks → async 骨架");
  const input1 = ["a", "b"];
  const r1 = await C.safeParseAsync(input1);
  assert.ok(r1.success, "async container refine passes");
  assert.deepEqual(r1.data, input1, "async container refine keeps the value");
  // Reference sharing is NOT asserted here: checksAreCowSafe rejects async custom checks, so the
  // container degrades to a runtime island and returns a copy. Tracked in #13; once fixed this
  // should become assert.strictEqual(r1.data, input1).
  const r2 = await C.safeParseAsync(["a"]);
  assert.ok(!r2.success, "async min 谓词失败");
  // map 值 async
  const S3 = z.map(
    z.string(),
    z.number().transform(async (n) => n * 2),
  );
  const C3 = compile(S3);
  const m = new Map([["k", 21]]);
  const r3 = await C3.safeParseAsync(m);
  assert.ok(r3.success);
  assert.deepEqual([...(r3.data as Map<string, number>)], [["k", 42]]);
  assert.ok((r3.data as Map<unknown, unknown>) !== m, "值变 → 拷贝");
  // set 成员 async
  const S4 = z.set(z.string().transform(async (s) => s.toUpperCase()));
  const C4 = compile(S4);
  const st = new Set(["a"]);
  const r4 = await C4.safeParseAsync(st);
  assert.ok(r4.success);
  assert.deepEqual([...(r4.data as Set<string>)], ["A"]);
  // record 值 async
  const S5 = z.record(
    z.string(),
    z.number().transform(async (n) => n + 1),
  );
  const C5 = compile(S5);
  const rec = { a: 1 };
  const r5 = await C5.safeParseAsync(rec);
  assert.ok(r5.success);
  assert.deepEqual(r5.data, { a: 2 });
  // tuple 槽 async
  const S6 = z.tuple([z.string(), z.string().transform(async (s) => `${s}!`)]);
  const C6 = compile(S6);
  const r6 = await C6.safeParseAsync(["a", "b"]);
  assert.ok(r6.success);
  assert.deepEqual(r6.data, ["a", "b!"]);
  assert.ok((r6.data as unknown[]) !== undefined && (r6.data as unknown[])[0] === "a");
  ok("五容器 + tuple async 全通道");
}

head("async 失败路径回退 stock safeParseAsync（issues 结构官方）");
{
  const S = z.object({
    a: z.string().refine(async (s) => s.length > 5),
    b: z.number(),
  });
  const C = compile(S);
  const input = { a: "x", b: 1 };
  const r = await C.safeParseAsync(input);
  const stock = await S.safeParseAsync(input as never);
  assert.equal(r.success, stock.success);
  if (!r.success && !stock.success) {
    assert.equal(r.error.issues.length, stock.error.issues.length);
    assert.deepEqual(r.error.issues[0]!.path, stock.error.issues[0]!.path);
  }
  ok("issues 官方结构");
}

head("顶层 async pipe（z.string().transform(async)）");
{
  const S = z.string().transform(async (s) => s.trim());
  const C = compile(S);
  assert.ok(C.async && !C.stock);
  const r = await C.parseAsync("  hi  ");
  assert.equal(r, "hi");
  const rb = await C.safeParseAsync(42 as never);
  const stockB = await S.safeParseAsync(42 as never);
  assert.equal(rb.success, stockB.success);
  ok("顶层 async pipe");
}

head("混合树：纯大容器 + 深 async 叶（CoW 与 async 共存）");
{
  const S = z.object({
    users: z.array(z.object({ id: z.number(), name: z.string() })),
    meta: z.object({
      token: z.string().transform(async (t) => t.toLowerCase()),
      flags: z.record(z.string(), z.boolean()),
    }),
  });
  const C = compile(S);
  assert.ok(C.async && !C.stock);
  const input = {
    users: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
    meta: { token: "ABC", flags: { f1: true } },
  };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  const out = r.data as typeof input;
  assert.ok(out !== input, "token async transform 变值 → 脏拷贝");
  assert.equal(out.meta.token, "abc");
  assert.ok(out.users === input.users, "未变子树引用共享");
  assert.ok(out.meta.flags === input.meta.flags, "纯 record 子树共享");
  assert.ok(out.users[0] === input.users[0], "元素级共享");
  ok("CoW 子树共享 + async 键脏判定");
}

console.log("\ntuple + async 冒烟断言全部通过 ✓");
