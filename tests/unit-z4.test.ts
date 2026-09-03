/**
 * zod4 前端单元测试 —— 语义锚点 + CoW 引用语义。
 * 与 unit.test.ts（zod3）同构；差异点标注 z4。
 */
import assert from "node:assert/strict";
import { z } from "zod4";
import { test, summary } from "./harness.js";
import { compile, ZcError, ZcNotSupportedError, PROBE4 } from "../src/index-z4.js";
import type { Compiled } from "../src/index-z4.js";

/* ─────────────── 探针金丝：编译器假设 ↔ stock 实际行为 ─────────────── */

test("PROBE4：zod4 语义与编译器假设一致（版本金丝）", () => {
  assert.equal(PROBE4.absentOptionalNotMaterialized, true, "缺席 optional 键应不物化");
  assert.equal(PROBE4.presentUndefKept, true, "present-undefined 应保留");
  assert.equal(PROBE4.outputFollowsShapeOrder, true);
  assert.equal(PROBE4.strictViaCatchallNever, true);
  assert.equal(PROBE4.looseViaCatchallUnknown, true);
  assert.equal(PROBE4.recordRebuilds, true);
  assert.equal(PROBE4.defaultShortCircuits, true, "z4 default 应短路（不校验默认值）");
  assert.equal(PROBE4.catchThrowsPropagate, true, "z4 catch 不应吞异常");
  assert.equal(PROBE4.cleanParseClones, true, "stock clean parse 应产生新对象");
});

/* ─────────────── 叶子节点 ─────────────── */

test("string: min/max/regex 校验", () => {
  const S = z.string().min(2).max(4);
  const c = compile(S);
  assert.equal(c.parse("ab"), "ab");
  assert.throws(() => c.parse("a"), ZcError);
  assert.throws(() => c.parse("abcde"), ZcError);
  assert.throws(() => c.parse(42 as never), ZcError);
  assert.equal(S.safeParse("a").success, false); // 与 stock 一致
});

test("string: email / iso.datetime 格式检查（自带 pattern 内联）", () => {
  const E = z.email();
  const cE = compile(E);
  assert.equal(cE.parse("a@b.co"), "a@b.co");
  assert.equal(cE.safeParse("nope").success, false);
  assert.equal(E.safeParse("nope").success, false);

  const D = z.iso.datetime();
  const cD = compile(D);
  const iso = "2025-06-01T12:00:00Z";
  assert.equal(cD.parse(iso), iso);
  assert.equal(cD.safeParse("2025-06-01").success, false);
  assert.equal(D.safeParse("2025-06-01").success, false);
});

test("string: trim 的 CoW 行为 —— 无空白零拷贝，有空白父层拷贝", () => {
  const O = z.object({ name: z.string().trim() });
  const c = compile(O);

  const clean = { name: "abc" };
  const r1 = c.parse(clean);
  assert.ok(r1 === clean, "trim 无实际变化 → 整树零拷贝");
  assert.ok(r1.name === "abc");

  const dirty = { name: "  abc  " };
  const r2 = c.parse(dirty);
  assert.ok(r2 !== dirty, "trim 产生新值 → 父层浅拷贝");
  assert.equal(r2.name, "abc");
  assert.deepEqual(dirty, { name: "  abc  " }, "输入零失真");
});

test("number: int/min/max/multipleOf/NaN/coerce", () => {
  const N = z.number().int().min(0).max(130);
  const c = compile(N);
  assert.equal(c.parse(42), 42);
  assert.equal(c.safeParse(1.5).success, false);
  assert.equal(c.safeParse(-1).success, false);
  assert.equal(c.safeParse(131).success, false);
  assert.equal(c.safeParse(NaN).success, false);
  assert.equal(N.safeParse(NaN).success, false); // z4: NaN → invalid_type

  assert.equal(compile(z.number().multipleOf(2)).safeParse(3).success, false);
  assert.equal(compile(z.number()).safeParse(Infinity).success, true);

  const C = compile(z.coerce.number());
  assert.equal(C.parse("42"), 42);
  assert.equal(z.coerce.number().parse("42"), 42);
});

test("number: safeint 上界（.int() 的 number_format 语义）", () => {
  const c = compile(z.number().int());
  assert.equal(c.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false); // stock: too_big
  assert.equal(z.number().int().safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
});

test("bigint / date / boolean / symbol / nan / null / undefined", () => {
  assert.equal(compile(z.bigint()).parse(1n), 1n);
  assert.equal(compile(z.bigint().min(0n)).safeParse(-1n).success, false);
  assert.equal(z.bigint().min(0n).safeParse(-1n as never).success, false);

  const d = new Date(0);
  assert.ok(compile(z.date()).parse(d) === d, "Date 原引用透传");
  assert.equal(compile(z.date()).safeParse("nope" as never).success, false);
  assert.equal(compile(z.date().min(new Date("2020-01-01"))).safeParse(new Date("2019-01-01")).success, false);
  assert.equal(z.date().min(new Date("2020-01-01")).safeParse(new Date("2019-01-01") as never).success, false);

  assert.equal(compile(z.boolean()).parse(true), true);
  assert.equal(compile(z.boolean()).safeParse(1).success, false);
  assert.equal(compile(z.symbol()).safeParse("x" as never).success, false);
  assert.equal(compile(z.nan()).parse(NaN), NaN);
  assert.equal(compile(z.nan()).safeParse(1).success, false);
  assert.equal(compile(z.null()).parse(null), null);
  assert.equal(compile(z.undefined()).parse(undefined), undefined);
  const anyInput = { whatever: [1, 2] };
  assert.equal(compile(z.any()).parse(anyInput), anyInput);
  assert.equal(compile(z.never()).safeParse(1).success, false);
});

test("literal / enum", () => {
  const L = z.literal("hello");
  const cL = compile(L);
  assert.equal(cL.parse("hello"), "hello");
  assert.equal(cL.safeParse("world").success, false);
  assert.equal(L.safeParse("world").success, false);

  const M = z.literal(["a", "b"] as never);
  const cM = compile(M);
  assert.equal(cM.parse("a"), "a");
  assert.equal(cM.safeParse("c").success, false);
  assert.equal(M.safeParse("c" as never).success, false);

  const E = z.enum(["admin", "user"]);
  const cE = compile(E);
  assert.equal(cE.parse("admin"), "admin");
  assert.equal(cE.safeParse("root").success, false);
  assert.equal(E.safeParse("root" as never).success, false);
});

/* ─────────────── object：CoW 引用语义 ─────────────── */

test("object: 干净输入 → 顶层与嵌套均为原引用（零拷贝）", () => {
  const S = z.object({
    name: z.string(),
    tags: z.array(z.string()),
    address: z.object({ city: z.string() }),
  });
  const c = compile(S);
  const input = { name: "a", tags: ["x"], address: { city: "NYC" } };
  const out = c.parse(input) as any;
  assert.ok(out === input, "顶层原引用");
  assert.ok(out.address === input.address, "嵌套原引用");
  assert.ok(out.tags === input.tags);
  assert.equal(c.pure, true);
});

test("object: strip 多余键 → 新对象，输入零失真，值与 stock 一致", () => {
  const S = z.object({ a: z.string() });
  const c = compile(S);
  const input = { a: "x", extra: 1, extra2: "y" } as any;
  const out = c.parse(input) as any;
  assert.ok(out !== input);
  assert.deepEqual(Object.keys(out).sort(), ["a"]);
  assert.deepEqual(input, { a: "x", extra: 1, extra2: "y" });
  assert.deepEqual(out, S.parse(input));
});

test("object: strict 多余键 → unrecognized_keys（keys 字段）", () => {
  const S = z.strictObject({ a: z.string() });
  const c = compile(S);
  try {
    c.parse({ a: "x", b: 1 });
    assert.fail("should throw");
  } catch (e) {
    const issues = (e as ZcError).issues;
    const iss = issues.find((i) => i.code === "unrecognized_keys");
    assert.ok(iss, "应有 unrecognized_keys issue");
    assert.deepEqual(iss.keys, ["b"]);
  }
  assert.equal(S.safeParse({ a: "x", b: 1 }).success, false);
});

test("object: loose 透传 → 原引用保留（含多余键）", () => {
  const S = z.looseObject({ a: z.string() });
  const c = compile(S);
  const input = { a: "x", zz: 1 } as any;
  const out = c.parse(input) as any;
  assert.ok(out === input, "loose 干净 → 原引用");
  assert.deepEqual(out, S.parse(input));
});

test("object: 缺席 optional 不物化；present-undefined 保留（z4 语义）", () => {
  const S = z.object({ a: z.string().optional(), b: z.string() });
  const c = compile(S);
  const absent = c.parse({ b: "x" }) as any;
  assert.ok(absent === ({ b: "x" } as any) || !("a" in absent), "缺席 optional 不物化");
  assert.equal("a" in absent, false);
  assert.deepEqual(absent, S.parse({ b: "x" }));

  const present = c.parse({ b: "x", a: undefined }) as any;
  assert.ok("a" in present, "present-undefined 保留");
  assert.deepEqual(present, S.parse({ b: "x", a: undefined }));
});

test("object: 缺席必填键 → 失败（invalid_type）", () => {
  const S = z.object({ a: z.string() });
  const c = compile(S);
  const r = c.safeParse({});
  assert.equal(r.success, false);
  assert.equal(S.safeParse({}).success, false);
});

test("object: 嵌套 default —— 只拷贝脏路径，兄弟子树共享", () => {
  const S = z.object({
    keep: z.object({ v: z.number() }),
    maybe: z.object({ v: z.number().default(9) }),
  });
  const c = compile(S);
  const keepObj = { v: 1 };
  const maybeObj = {}; // 缺席 v → default 注入
  const input = { keep: keepObj, maybe: maybeObj };
  const out = c.parse(input) as any;
  assert.ok(out !== input, "default 注入 → 顶层拷贝");
  assert.ok(out.keep === keepObj, "兄弟子树共享");
  assert.ok(out.maybe !== maybeObj, "脏子树拷贝");
  assert.equal(out.maybe.v, 9);
  assert.deepEqual(input, { keep: keepObj, maybe: maybeObj }, "输入零失真");
  assert.deepEqual(out, S.parse(input));
  assert.equal(c.pure, false);
});

test("object: catchall schema（mode 3）", () => {
  const S = z.object({ a: z.string() }).catchall(z.number());
  const c = compile(S);
  const input = { a: "x", n: 1, m: 2 };
  const out = c.parse(input) as any;
  assert.deepEqual(out, S.parse(input));
  const r2 = c.safeParse({ a: "x", n: "not-a-number" });
  assert.equal(r2.success, false);
  assert.equal(S.safeParse({ a: "x", n: "not-a-number" as never }).success, false);
});

test("object: 失败后继续收集全部 issue（表单语义，与 stock 一致）", () => {
  const S = z.object({ a: z.string(), b: z.number() });
  const c = compile(S);
  try {
    c.parse({ a: 1 as never, b: "x" as never });
    assert.fail("should throw");
  } catch (e) {
    assert.ok((e as ZcError).issues.length >= 2, "应收集两个 issue");
  }
  assert.equal(S.safeParse({ a: 1 as never, b: "x" as never }).error!.issues.length >= 2, true);
});

/* ─────────────── array / tuple / record / map / set ─────────────── */

test("array: 干净 → 原引用；脏元素 → slice 拷贝", () => {
  const S = z.object({ v: z.number().default(0) }).array();
  const c = compile(S);
  const a = { v: 1 };
  const b = {}; // 触发 default
  const input = [a, b];
  const out = c.parse(input) as any;
  assert.ok(out !== input, "default → 数组拷贝");
  assert.ok(out[0] === a, "干净元素共享");
  assert.ok(out[1] !== b);
  assert.deepEqual(out, S.parse(input));

  const clean = [{ v: 1 }, { v: 2 }];
  assert.ok(c.parse(clean) === clean, "全干净 → 原引用");
});

test("array: min/max 长度检查", () => {
  const c = compile(z.array(z.string()).min(1).max(2));
  assert.equal(c.safeParse([]).success, false);
  assert.equal(c.safeParse(["a", "b", "c"]).success, false);
  assert.deepEqual(c.parse(["a"]), ["a"]);
});

test("tuple: 定长 + rest", () => {
  const T = z.tuple([z.string(), z.number()]);
  const c = compile(T);
  const input = ["a", 1];
  assert.ok(c.parse(input) === input, "tuple 干净 → 原引用");
  assert.equal(c.safeParse(["a"]).success, false);
  assert.equal(c.safeParse(["a", 1, 2]).success, false);
  assert.equal(T.safeParse(["a"] as never).success, false);

  const R = z.tuple([z.string()], z.number());
  const cR = compile(R);
  assert.deepEqual(cR.parse(["a", 1, 2]), R.parse(["a", 1, 2] as never));
  assert.equal(cR.safeParse(["a", "x"]).success, false);
  assert.equal(R.safeParse(["a", "x"] as never).success, false);
});

test("record: string 键 / number 键 / 枚举键 / 键校验失败", () => {
  const R1 = z.record(z.string(), z.number());
  const c1 = compile(R1);
  const input = { a: 1, b: 2 };
  const out = c1.parse(input) as any;
  assert.ok(out === input, "record 干净 → 原引用（stock 重建但值等价）");
  assert.deepEqual(out, R1.parse(input));

  const R2 = z.record(z.number(), z.string());
  const c2 = compile(R2);
  assert.deepEqual(c2.parse({ 1: "x" }), R2.parse({ 1: "x" }));
  assert.equal(c2.safeParse({ abc: "x" }).success, false);
  assert.equal(R2.safeParse({ abc: "x" } as never).success, false);

  const R3 = z.record(z.enum(["a", "b"]), z.number());
  const c3 = compile(R3);
  // z4 语义：声明键全部必填（values 驱动，缺 b → invalid_type）
  assert.equal(c3.safeParse({ a: 1 }).success, false);
  assert.equal(R3.safeParse({ a: 1 } as never).success, false);
  assert.deepEqual(c3.parse({ a: 1, b: 2 }), R3.parse({ a: 1, b: 2 }));
  assert.equal(c3.safeParse({ zz: 1 }).success, false);
  assert.equal(R3.safeParse({ zz: 1 } as never).success, false);
});

test("map / set: CoW + 尺寸检查", () => {
  const M = z.map(z.string(), z.number());
  const cM = compile(M);
  const m = new Map([["a", 1]]);
  assert.ok(cM.parse(m) === m, "Map 干净 → 原引用");
  assert.equal(cM.safeParse("x" as never).success, false);
  assert.equal(M.safeParse("x" as never).success, false);

  const S = z.set(z.string());
  const cS = compile(S);
  const s = new Set(["a"]);
  assert.ok(cS.parse(s) === s, "Set 干净 → 原引用");
  assert.equal(cS.safeParse(new Set([1 as never])).success, false);
  const SS = z.set(z.string()).max(2);
  assert.equal(compile(SS).safeParse(new Set(["a", "b", "c"])).success, false);
  assert.equal(SS.safeParse(new Set(["a", "b", "c"]) as never).success, false);
});

/* ─────────────── union / lazy ─────────────── */

test("union: 首个成功分支胜出；全败 → invalid_union", () => {
  const U = z.union([z.string().min(5), z.string().min(1)]);
  const c = compile(U);
  assert.equal(c.parse("ab"), "ab"); // 第二分支
  assert.equal(c.parse("abcde"), "abcde"); // 第一分支
  assert.equal(c.safeParse(9 as never).success, false);
  assert.equal(U.safeParse(9 as never).success, false);
});

test("lazy: 递归树（自引用 schema）", () => {
  const Tree: any = z.object({
    v: z.number(),
    children: z.lazy(() => Tree.array()).optional(),
  });
  const c = compile(Tree);
  const leaf = { v: 1 };
  const root = { v: 0, children: [{ v: 2, children: [leaf] }, { v: 3 }] };
  const out = c.parse(root) as any;
  assert.ok(out === root, "递归干净 → 原引用");
  assert.ok(out.children![0]!.children![0] === leaf, "深层叶子共享");
  assert.deepEqual(out, Tree.parse(root));

  // 缺必填 v 的分支节点 → 失败
  const broken: any = { v: 0, children: [{ v: 2 }, {}] };
  assert.equal(c.safeParse(broken).success, false);
  assert.equal(Tree.safeParse(broken).success, false);
});

/* ─────────────── 包装类节点：z4 语义 ─────────────── */

test("optional / nullable", () => {
  const O = compile(z.string().optional());
  assert.equal(O.parse(undefined), undefined);
  assert.equal(O.parse("x"), "x");
  const N = compile(z.string().nullable());
  assert.equal(N.parse(null), null);
  assert.equal(N.safeParse(undefined).success, false);
});

test("default: z4 短路语义 —— 默认值不再过内层校验（与 z3 相反）", () => {
  // 1.5 不是合法 int，但 z4 default 短路 → 成功
  const D = z.number().int().default(1.5 as never);
  const c = compile(D);
  assert.equal(c.parse(undefined), 1.5);
  assert.equal(D.parse(undefined), 1.5);
  assert.equal(c.pure, false);

  // 正常路径仍走内层
  assert.throws(() => c.parse(2.5 as never), ZcError);
});

test("default: 函数形式（惰性求值）与 stock 对齐", () => {
  const D = z.date().default((() => new Date(0)) as never);
  const c = compile(D);
  const out = c.parse(undefined);
  assert.deepEqual(out, D.parse(undefined));
  assert.ok(out instanceof Date);
});

test("catch: 校验失败兜底；异常向上传播（z4 语义，与 z3 相反）", () => {
  const C = z.string().catch("fb");
  const c = compile(C);
  assert.equal(c.parse(123 as never), "fb");
  assert.equal(C.parse(123 as never), "fb");

  const T: any = z.string().refine(() => {
    throw new Error("boom");
  }).catch("fb2");
  const cT = compile(T);
  assert.throws(() => cT.parse("x"), /boom/, "z4 catch 不吞异常");
  assert.throws(() => T.safeParse("x"), /boom/);
});

test("readonly: 输出浅冻结（与 stock 一致）", () => {
  const R = z.object({ a: z.string() }).readonly();
  const c = compile(R);
  const input = { a: "x" };
  const out = c.parse(input) as any;
  assert.ok(Object.isFrozen(out), "输出被冻结");
  assert.ok(out === input, "原引用（注意：冻结的是输入对象本身，与 stock 语义一致）");
});

test("pipe: in 的输出作为 out 的输入（z4 语义）", () => {
  const P = z.string().pipe(z.number() as any);
  const c = compile(P);
  // out 校验的是 in 的输出（string）→ z.number() 必然失败，与 stock 一致
  assert.equal(c.safeParse("42").success, false);
  assert.equal(P.safeParse("42").success, false);

  const TP = z.string().transform(Number).pipe(z.number().int());
  const cTP = compile(TP);
  assert.equal(cTP.parse("42"), 42);
  assert.equal(cTP.safeParse("4.5").success, false);
  assert.equal(TP.safeParse("4.5").success, false);

  // pipe 干净透传：number→number
  const NP = z.number().pipe(z.number().int());
  const cNP = compile(NP);
  assert.equal(cNP.parse(7), 7);
  assert.equal(cNP.safeParse(7.5).success, false);
});

test("transform: 脏传播 + addIssue 失败路径", () => {
  const T = z.object({
    n: z.string().transform((s) => s.length),
  });
  const c = compile(T);
  const input = { n: "abc" };
  const out = c.parse(input) as any;
  assert.ok(out !== input, "transform 产出新值 → 拷贝");
  assert.equal(out.n, 3);
  assert.deepEqual(out, T.parse(input));

  const F = z.string().transform((_v, payload) => {
    payload.issues.push({ code: "custom", message: "nope", input: _v });
    return _v;
  });
  const cF = compile(F);
  assert.equal(cF.safeParse("x").success, false);
  assert.equal(F.safeParse("x").success, false);
});

test("refine / .check(): 纯谓词不判脏", () => {
  const R = z.object({ v: z.string().refine((s) => s.length > 1) });
  const c = compile(R);
  const input = { v: "abc" };
  assert.ok(c.parse(input) === input, "refine 通过 → 零拷贝");
  assert.equal(c.safeParse({ v: "a" }).success, false);

  const C = z.string().check((ctx: any) => {
    if (ctx.value.length < 2) ctx.issues.push({ code: "custom", message: "too short", input: ctx.value });
  });
  const cC = compile(C);
  assert.equal(cC.parse("abc"), "abc");
  assert.equal(cC.safeParse("a").success, false);
  assert.equal(C.safeParse("a").success, false);
});

test("optional(default): 缺席/undefined 输入时 default 在 optional 下点火（z4 optin=defaulted 传播）", () => {
  const S = z.string().trim().default("a").optional();
  const c = compile(S);
  assert.equal(c.parse(undefined), "a");
  assert.equal(S.parse(undefined), "a");
  assert.equal(c.parse("abc"), "abc");

  const A = z.array(z.enum(["a", "b"]).default("a").optional());
  const cA = compile(A);
  const input = [undefined, undefined];
  assert.deepEqual(cA.parse(input), A.parse([undefined, undefined]));
  assert.deepEqual(cA.parse(input), ["a", "a"]);

  // 普通 optional 不受影响：undefined 透传
  const P = compile(z.string().optional());
  assert.equal(P.parse(undefined), undefined);
});

/* ─────────────── API / 错误形态 ─────────────── */

test("ZcError 携带 issues（code/path/message）", () => {
  const c = compile(z.object({ a: z.string() }));
  try {
    c.parse({ a: 1 as never });
    assert.fail("should throw");
  } catch (e) {
    const err = e as ZcError;
    assert.equal(err.issues.length, 1);
    assert.equal(err.issues[0]!.code, "invalid_type");
    assert.deepEqual(err.issues[0]!.path, ["a"]);
  }
});

test("safeParse / validate 形态", () => {
  const c: Compiled<z.ZodType> = compile(z.object({ a: z.string() }));
  const ok = c.safeParse({ a: "x" });
  assert.ok(ok.success && (ok.data as any).a === "x");
  const bad = c.safeParse({ a: 1 as never });
  assert.ok(!bad.success && bad.error.issues.length === 1);
  const v = c.validate({ a: "y" });
  assert.equal((v as any).a, "y");
});

test("compile 拒绝 intersection（不支持，显式报错）", () => {
  assert.throws(() => compile(z.intersection(z.object({ p: z.string() }), z.object({ q: z.number() }))), ZcNotSupportedError);
});

test("compile 拒绝 async refine（运行时检测）", () => {
  const A: any = z.string().refine(async () => true);
  const c = compile(A);
  assert.throws(() => c.parse("x"), ZcNotSupportedError);
});

test("compile 拒绝未支持的 def.type（file/templateLiteral）", () => {
  assert.throws(() => compile(z.file() as never), ZcNotSupportedError);
  const TL: any = (z as any).templateLiteral?.(["a", z.string()]);
  if (TL) assert.throws(() => compile(TL), ZcNotSupportedError);
});

test("__proto__ 防护：strip 输出不携带原型污染键", () => {
  const c = compile(z.object({ a: z.string() }));
  const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}');
  const out = c.parse(input) as any;
  assert.equal(Object.keys(out).sort().join(","), "a");
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(out, (z.object({ a: z.string() }) as any).parse(input));
});

summary("unit-z4");
