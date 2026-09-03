/**
 * 冒烟测试：v2（官方 codegen + CoW 修饰）的行为与代码 dump。
 */
import assert from "node:assert/strict";
import { z } from "zod4";
import { compileV2 } from "../src/index-z4-v2.js";

/* ── 1. 基础 object：干净输入原引用 ── */
{
  const S = z.object({ a: z.string().max(4), b: z.email(), c: z.enum(["x", "y"]) });
  const C = compileV2(S);
  const input = { a: "abc", b: "u@e.com", c: "x" };
  const out = C.parse(input);
  console.log("── 基础 object ──");
  console.log(
    `  骨架源码:\n${C.code!.split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}`,
  );
  console.log("  干净输入 out === input:", out === input, "（期望 true）");
  assert.equal(out, input);

  // 失败路径：stock 语义（ZodError + issues）
  const bad = C.safeParse({ a: "toolong", b: "u@e.com", c: "x" });
  assert.equal(bad.success, false);
  if (!bad.success) {
    console.log(
      "  失败路径 issues:",
      bad.error.issues.length,
      "path:",
      JSON.stringify(bad.error.issues[0]!.path),
    );
  }

  // validate：官方 assertOnly 整树产物
  console.log("  validate(input) === input:", C.validate(input) === input);
}

/* ── 2. strip：多余键 → 浅拷贝剥离 ── */
{
  const S = z.object({ a: z.string(), b: z.number() });
  const C = compileV2(S);
  const input = { a: "x", b: 1, extra: true, more: 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── strip 多余键 ──");
  console.log("  out === input:", out === input, "（期望 false，多余键被迫拷贝）");
  console.log("  out 键:", Object.keys(out).join(","), "（期望 a,b）");
  console.log("  input 未失真:", "extra" in input && "more" in input);
  assert.notEqual(out, input);
  assert.deepEqual(Object.keys(out).sort(), ["a", "b"]);
  assert.ok("extra" in input && "more" in input);

  // strict：多余键 → 失败
  const Strict = z.strictObject({ a: z.string() });
  const CS = compileV2(Strict);
  assert.equal(CS.safeParse({ a: "x", extra: 1 }).success, false);
  assert.deepEqual(CS.parse({ a: "x" }), { a: "x" });
  console.log("  strict: 多余键拒绝 ✓  干净通过 ✓");
}

/* ── 3. 脏负载：default 注入 → 单键浅拷贝 ── */
{
  const S = z.object({ name: z.string(), role: z.enum(["a", "b"]).default("b") });
  const C = compileV2(S);
  const clean = { name: "n", role: "a" };
  const dirty = { name: "n" }; // 缺 role → default 注入
  const outClean = C.parse(clean);
  const outDirty = C.parse(dirty) as { name: string; role: string };
  console.log("\n── default 注入 ──");
  console.log("  干净 out === clean:", outClean === clean, "（期望 true）");
  console.log(
    "  脏 out.role:",
    outDirty.role,
    " out === dirty:",
    outDirty === dirty,
    "（期望 false）",
  );
  console.log("  dirty 未失真:", !("role" in dirty));
  assert.equal(outClean, clean);
  assert.equal(outDirty.role, "b");
  assert.notEqual(outDirty, dirty);
  assert.ok(!("role" in dirty));
}

/* ── 4. transform → 引用比较自动判脏 ── */
{
  const S = z.object({ n: z.string(), len: z.string().transform((s) => s.length) });
  const C = compileV2(S);
  const input: Record<string, unknown> = { n: "x", len: "abcd" };
  const out = C.parse(input) as { n: string; len: number };
  console.log("\n── transform（pipe）──");
  console.log("  out:", JSON.stringify(out), " out === input:", out === input, "（期望 false）");
  console.log("  input 未失真:", input.len === "abcd");
  assert.deepEqual(out, { n: "x", len: 4 });
  assert.notEqual(out, input);
  assert.equal(input.len, "abcd");
}

/* ── 5. array/object 嵌套：内层干净共享 ── */
{
  const S = z.object({
    name: z.string(),
    tags: z.array(z.string()),
    addr: z.object({ city: z.string(), zip: z.string() }),
  });
  const C = compileV2(S);
  const addr = { city: "NYC", zip: "10001" };
  const input = { name: "n", tags: ["a", "b"], addr };
  const out = C.parse(input) as typeof input;
  console.log("\n── 嵌套共享 ──");
  console.log("  out === input:", out === input);
  console.log("  out.addr === addr:", out.addr === addr, "（嵌套原引用）");
  assert.equal(out, input);
  assert.equal(out.addr, addr);

  // 内层变脏：addr 带多余键 → 仅 addr 浅拷贝，顶层拷贝，tags 共享
  const input2 = { name: "n", tags: ["a", "b"], addr: { city: "NYC", zip: "10001", extra: 1 } };
  const S2 = z.object({
    name: z.string(),
    tags: z.array(z.string()),
    addr: z.object({ city: z.string(), zip: z.string() }),
  });
  const C2 = compileV2(S2);
  const out2 = C2.parse(input2) as typeof input2;
  console.log("  脏 addr: out2 === input2:", out2 === input2, "（期望 false）");
  console.log("  out2.addr === input2.addr:", out2.addr === input2.addr, "（期望 false，被拷贝）");
  console.log("  out2.addr 多余键已剥离:", !("extra" in out2.addr));
  assert.notEqual(out2, input2);
  assert.notEqual(out2.addr, input2.addr);
  assert.ok(!("extra" in out2.addr));
}

/* ── 6. 数组元素 CoW ── */
{
  const S = z.array(z.object({ id: z.number(), name: z.string() }));
  const C = compileV2(S);
  const items = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ];
  const out = C.parse(items) as typeof items;
  console.log("\n── 数组元素 ──");
  console.log("  out === items:", out === items);
  assert.equal(out, items);

  const S2 = z.array(z.object({ id: z.number().int(), n: z.number().default(0) }));
  const C2 = compileV2(S2);
  const items2 = [{ id: 1, n: 5 }, { id: 2 }];
  const out2 = C2.parse(items2) as { id: number; n: number }[];
  console.log("  脏数组: out2 === items2:", out2 === items2, "（期望 false）");
  console.log("  out2[1]:", JSON.stringify(out2[1]), " items2[1] 未失真:", !("n" in items2[1]!));
  assert.notEqual(out2, items2);
  assert.deepEqual(out2[1], { id: 2, n: 0 });
  assert.ok(!("n" in items2[1]!));
}

/* ── 7. optional/nullable/union 纯净键 ── */
{
  const S = z.object({
    a: z.string().optional(),
    b: z.number().nullable(),
    c: z.union([z.string(), z.number()]),
  });
  const C = compileV2(S);
  const i1 = { b: null, c: "s" }; // a 缺席
  const o1 = C.parse(i1);
  console.log("\n── optional/nullable/union ──");
  console.log("  缺席 optional: out === input:", o1 === i1);
  assert.equal(o1, i1);
  const i2 = { a: undefined, b: 1, c: 2 };
  const o2 = C.parse(i2) as typeof i2;
  assert.equal(o2, i2);
  console.log("  present-undefined 保留:", "a" in o2);
}

/* ── 8. 顶层 array + 非纯元素 transform ── */
{
  const S = z.array(z.string().transform((s) => s.toUpperCase()));
  const C = compileV2(S);
  const out = C.parse(["a", "b"]) as string[];
  console.log("\n── 数组元素 transform ──");
  console.log("  out:", JSON.stringify(out));
  assert.deepEqual(out, ["A", "B"]);
}

/* ── 9. 降级：schema catchall / 递归 / async ── */
{
  const Catchall = z.object({ a: z.string() }).catchall(z.number());
  const CC = compileV2(Catchall);
  console.log("\n── 降级 ──");
  console.log("  catchall schema → stock:", CC.stock, "（期望 true）");
  assert.equal(CC.stock, true);

  type Tree = { v: string; children?: Tree[] };
  const Tree: any = z.object({ v: z.string(), children: z.array(z.lazy(() => Tree)).optional() });
  const CT = compileV2(Tree);
  console.log("  递归 → stock:", CT.stock);
  const treeInput: Tree = { v: "root", children: [{ v: "leaf" }] };
  const treeOut = CT.safeParse(treeInput);
  assert.ok(treeOut.success);
  console.log("  递归 stock 语义正常 ✓");

  const Async = z.string().refine(async (s) => s.length > 0);
  const CA = compileV2(Async);
  console.log(
    "  async refine → stock:",
    CA.stock,
    "async 通道:",
    CA.async,
    "（Task 6 起不再整树降级，期望 stock=false async=true）",
  );
  assert.equal(CA.stock, false);
  assert.equal(CA.async, true);
  // sync API 对 async 骨架抛 $ZodAsyncError（官方同款语义）
  let syncThrew = false;
  try {
    CA.parse("hello");
  } catch (e: any) {
    syncThrew = e.constructor.name === "$ZodAsyncError";
  }
  assert.ok(syncThrew, "sync parse 应抛 $ZodAsyncError");
  const asyncOut = await CA.parseAsync("hello");
  assert.equal(asyncOut, "hello"); // 纯子树输出 = 输入原引用
  console.log("  async parseAsync 原引用返回 ✓  sync API 抛 $ZodAsyncError ✓");
}

console.log("\n全部冒烟断言通过 ✓");
