/**
 * 冒烟：record/map/set CoW 骨架行为。
 */
import assert from "node:assert/strict";
import { z } from "zod4";
import { compileV2 } from "../src/index-z4-v2.js";

/* ── record：bare-string 键 ── */
{
  const S = z.record(z.string(), z.number());
  const C = compileV2(S);
  const input = { a: 1, b: 2 };
  console.log("── record bare-string ──");
  console.log("  干净 out === input:", C.parse(input) === input);
  assert.equal(C.parse(input), input);

  const S2 = z.record(z.string(), z.object({ n: z.number(), flag: z.boolean() }));
  const C2 = compileV2(S2);
  const inner = { n: 1, flag: true };
  const input2 = { a: inner, b: { n: 2, flag: false } };
  const out2 = C2.parse(input2) as typeof input2;
  console.log("  嵌套 object 值: out === input:", out2 === input2, " out.a === inner:", out2.a === inner);
  assert.equal(out2, input2);
  assert.equal(out2.a, inner);

  // 值含 default → 脏
  const S3 = z.record(z.string(), z.object({ n: z.number(), tag: z.string().default("x") }));
  const C3 = compileV2(S3);
  const input3 = { a: { n: 1 } };
  const out3 = C3.parse(input3) as any;
  console.log("  值 default 注入: out.a.tag =", out3.a.tag, " input 未失真:", !("tag" in input3.a));
  assert.equal(out3.a.tag, "x");
  assert.ok(!("tag" in input3.a));
}

/* ── record：数值键重试（键名转换） ── */
{
  const S = z.record(z.number(), z.string());
  const C = compileV2(S);
  const input = { 1: "a", 2: "b" }; // JS 对象键恒为字符串 "1","2"
  const out = C.parse(input) as Record<string, string>;
  console.log("\n── record 数值键（键名转换） ──");
  console.log("  out:", JSON.stringify(out), " out === input:", out === input, "（stock 键名也是数字→字符串化）");
  assert.deepEqual(out, input);
  // stock 对照：stock 也输出字符串化键
  const stockOut = (S as any).parse(input);
  assert.deepEqual(out, stockOut);
}

/* ── record：enum 键声明驱动 ── */
{
  const S = z.record(z.enum(["a", "b"]), z.number());
  const C = compileV2(S);
  const input = { a: 1, b: 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── record enum 键（声明驱动） ──");
  console.log("  干净 out === input:", out === input);
  assert.equal(out, input);

  const input2 = { a: 1, b: 2, extra: 3 }; // 未知键 → stock strict 拒绝
  assert.equal(C.safeParse(input2).success, false);
  const input3 = { a: 1 }; // 缺声明键 b → stock 拒绝（required）
  assert.equal(C.safeParse(input3).success, false);
  // 缺失但值 optional → stock 物化 undefined → 脏
  const S2 = z.record(z.enum(["a", "b"]), z.number().optional());
  const C2 = compileV2(S2);
  const input4 = { a: 1 };
  const out4 = C2.parse(input4) as any;
  console.log("  缺 b + optional 值: out.b =", out4.b, " out === input:", out4 === input, "（stock 物化 undefined → 必脏）");
  assert.equal(out4.b, undefined);
  assert.notEqual(out4, input4);
  assert.ok(!("b" in input4));
}

/* ── record：string format 键（general path，键名不变） ── */
{
  const S = z.record(z.email(), z.number());
  const C = compileV2(S);
  const input = { "a@b.co": 1, "c@d.co": 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── record email 键（general，键名不变） ──");
  console.log("  out === input:", out === input);
  assert.equal(out, input);
}

/* ── map ── */
{
  const S = z.map(z.string(), z.number());
  const C = compileV2(S);
  const input = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  const out = C.parse(input) as Map<string, number>;
  console.log("\n── map ──");
  console.log("  干净 out === input:", out === input);
  assert.equal(out, input);

  const S2 = z.map(z.string(), z.object({ n: z.number(), tag: z.string().default("t") }));
  const C2 = compileV2(S2);
  const input2 = new Map([["a", { n: 1 }]]);
  const out2 = C2.parse(input2) as Map<string, any>;
  console.log("  值 default 注入: out.get('a').tag =", out2.get("a")!.tag, " input 未失真:", !("tag" in input2.get("a")!));
  assert.equal(out2.get("a")!.tag, "t");
  assert.notEqual(out2, input2);
  assert.ok(!("tag" in input2.get("a")!));

  // Map 自身 checks
  const S3 = z.map(z.string(), z.number()).min(1);
  const C3 = compileV2(S3);
  assert.equal(C3.parse(input) === input, true);
  assert.equal(C3.safeParse(new Map()).success, false);
  console.log("  .min(1) size check ✓");
}

/* ── set ── */
{
  const S = z.set(z.number());
  const C = compileV2(S);
  const input = new Set([1, 2, 3]);
  const out = C.parse(input) as Set<number>;
  console.log("\n── set ──");
  console.log("  干净 out === input:", out === input);
  assert.equal(out, input);

  const S2 = z.set(z.object({ n: z.number(), tag: z.string().default("s") }));
  const C2 = compileV2(S2);
  const item = { n: 1 };
  const input2 = new Set([item]);
  const out2 = C2.parse(input2) as Set<any>;
  console.log("  成员 default 注入: out.size =", out2.size, " input 未失真:", !("tag" in item));
  assert.equal(out2.size, 1);
  assert.equal([...out2][0]!.tag, "s");
  assert.notEqual(out2, input2);
  assert.ok(!("tag" in item));

  const S3 = z.set(z.string()).max(2);
  const C3 = compileV2(S3);
  const s3in = new Set(["a"]);
  assert.equal(C3.parse(s3in), s3in);
  assert.equal(C3.safeParse(new Set(["a", "b", "c"])).success, false);
  console.log("  .max(2) size check ✓");
}

/* ── 顶层/键位/元素位的容器组合 ── */
{
  const S = z.object({
    dict: z.record(z.string(), z.number()).optional(),
    lookup: z.map(z.string(), z.boolean()).nullable(),
    tags: z.set(z.string()),
  });
  const C = compileV2(S);
  const input = {
    dict: { a: 1 },
    lookup: new Map([["k", true]]),
    tags: new Set(["x"]),
  };
  const out = C.parse(input) as typeof input;
  console.log("\n── 容器组合（optional record / nullable map / set） ──");
  console.log("  out === input:", out === input);
  console.log("  out.dict === input.dict:", out.dict === input.dict);
  console.log("  out.lookup === input.lookup:", out.lookup === input.lookup);
  assert.equal(out, input);
  assert.equal(out.dict, input.dict);
  assert.equal(out.lookup, input.lookup);
}

console.log("\nrecord/map/set 冒烟断言全部通过 ✓");
