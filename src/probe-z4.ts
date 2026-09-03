/**
 * zod4 行为与结构探针 — 实测 stock zod 4.5.4 的 def 树结构与边界语义，
 * 供 CoW 编译器 (compile-z4.ts) 做差分对齐。
 *
 * 与 probe.ts（zod3）同一方法论：编译器读取探针 flag，zod 版本升级改变
 * "隐式契约"时自动跟随，而不是静默分歧。
 */
import { z } from "zod4";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ──────────────────── def 树结构序列化 ──────────────────── */

function ser(v: any, depth = 0): any {
  if (v === null) return null;
  const t = typeof v;
  if (t === "function") return `ƒ(${v.length})`;
  if (t === "symbol") return v.toString();
  if (t === "bigint") return `${v}n`;
  if (t === "undefined") return "undefined";
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? "NaN" : v.toISOString()})`;
  if (Array.isArray(v)) return depth > 4 ? "[…]" : v.map((x) => ser(x, depth + 1));
  if (t === "object") {
    const zdef = v?._zod?.def;
    if (zdef) {
      const label =
        zdef.check !== undefined ? `$check:${zdef.check}` : `$schema:${zdef.type ?? "?"}`;
      if (depth > 3) return `<${label}>`;
      return { [label]: ser(zdef, depth + 1) };
    }
    if (depth > 4) return "{…}";
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = ser(v[k], depth + 1);
    return o;
  }
  return v;
}

function dumpCheck(chk: any, probeValue: unknown, i: number): void {
  const zi = chk?._zod ?? {};
  console.log(`    check[${i}] def:`, JSON.stringify(ser(zi.def)));
  console.log(`    check[${i}] _zod keys:`, Object.keys(zi).join(","));
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(zi) ?? []);
  console.log(`    check[${i}] proto:`, proto.join(","));
  if (typeof zi.run === "function") {
    console.log(
      `    check[${i}] run src:`,
      zi.run.toString().replace(/\s+/g, " ").slice(0, 280),
    );
    try {
      const p: any = { value: probeValue, issues: [] };
      zi.run(p, undefined);
      console.log(`    check[${i}] probe run(payload, undefined): issues=${p.issues.length}`);
      if (p.issues.length) console.log(`      issue0:`, JSON.stringify(ser(p.issues[0])));
    } catch (e: any) {
      console.log(`    check[${i}] probe run THREW:`, e.message);
    }
  } else {
    console.log(`    check[${i}] NO _zod.run method`);
  }
}

function dump(name: string, schema: any, probeVal: unknown): void {
  console.log(`\n=== ${name} ===`);
  console.log("  def:", JSON.stringify(ser(schema?._zod?.def)));
  console.log("  _zod keys:", Object.keys(schema?._zod ?? {}).join(","));
  const checks = schema?._zod?.def?.checks;
  if (Array.isArray(checks)) {
    for (let i = 0; i < checks.length; i++) dumpCheck(checks[i], probeVal, i);
  }
}

/* ──────────────────── 结构采样 ──────────────────── */

console.log("╔══════════ zod4 结构采样 ══════════╗");
console.log("zod version:", require("zod4/package.json").version);
console.log("z.email:", typeof (z as any).email, "| z.iso:", typeof (z as any).iso);
console.log("z.int:", typeof (z as any).int, "| z.set:", typeof z.set, "| z.map:", typeof z.map);
console.log("z.file:", typeof (z as any).file, "| z.json:", typeof (z as any).json, "| z.custom:", typeof (z as any).custom);
console.log("string._zod run src:", (z.string() as any)._zod.run.toString().replace(/\s+/g, " ").slice(0, 700));

dump("string", z.string(), "");
dump("string.min(3)", z.string().min(3), "ab");
dump("string.trim", z.string().trim(), "  x  ");
dump("string.email", z.string().email(), "bad");
dump("string.lower", z.string().toLowerCase(), "ABC");
dump("number.int.min.max", z.number().int().min(0).max(9), 12);
dump("coerce.number", z.coerce.number(), "12");
dump("bigint.min", z.bigint().min(0n), -1n);
dump("date.min", z.date().min(new Date("2020-01-01")), new Date("2019-01-01"));
dump("symbol", z.symbol(), "x");
dump("nan", z.nan(), 1);
dump("literal", z.literal("a"), "b");
dump("enum", z.enum(["x", "y"]), 1);
dump("boolean", z.boolean(), 1);
dump("object", z.object({ a: z.string() }), {});
dump("array.max(4)", z.array(z.string()).max(4), []);
dump("record", z.record(z.string(), z.number()), {});
dump("tuple", z.tuple([z.string(), z.number()]), ["a"]);
dump("union", z.union([z.string(), z.number()]), true);
dump("optional", z.string().optional(), 1);
dump("default", z.string().default("d"), 1);
dump("catch", z.string().catch("c"), 1);
dump("transform", z.string().transform((s: string) => s.length), "x");
dump("pipe", z.string().pipe(z.number() as any), "x");
dump("lazy", z.lazy(() => z.string()), 1);
dump("refine", z.string().refine((v: string) => v.length > 2), "ab");
dump("map", z.map(z.string(), z.number()), "x");
dump("set", z.set(z.string()), "x");
if (typeof (z as any).readonly === "function") dump("readonly", (z.object({ a: z.string() }) as any).readonly(), {});
if (typeof (z as any).custom === "function") dump("custom", (z as any).custom((v: unknown) => true), 1);
{
  const so: any = z.strictObject({ a: z.string() });
  const lo: any = z.looseObject({ a: z.string() });
  console.log("\n=== object modes ===");
  console.log("  plain object catchall:", JSON.stringify(ser((z.object({ a: z.string() }) as any)._zod.def.catchall)));
  console.log("  strictObject catchall:", JSON.stringify(ser(so._zod.def.catchall)));
  console.log("  looseObject catchall:", JSON.stringify(ser(lo._zod.def.catchall)));
  console.log("  object def keys:", Object.keys((z.object({ a: z.string() }) as any)._zod.def).join(","));
}
{
  const du: any = z.discriminatedUnion("t", [z.object({ t: z.literal("a") }), z.object({ t: z.literal("b") })]);
  console.log("\n=== discriminatedUnion ===");
  console.log("  def keys:", Object.keys(du._zod.def).join(","), "| discriminator:", du._zod.def.discriminator);
}

/* ──────────────────── 行为探针 ──────────────────── */

console.log("\n╔══════════ zod4 行为探针 ══════════╗");
const S = z.object({ a: z.string().optional(), b: z.string() });
console.log("P1 absentOptionalKept(strip):", "a" in (S.parse({ b: "x" }) as object));
console.log("P2 presentUndefKept(strip):", "a" in (S.parse({ b: "x", a: undefined }) as object));
const SP = z.looseObject({ a: z.string().optional(), b: z.string() });
console.log("P3 absentOptionalKept(loose):", "a" in (SP.parse({ b: "x" }) as object));
console.log("P4 presentUndefKept(loose):", "a" in (SP.parse({ b: "x", a: undefined }) as object));
{
  const O = z.object({ x: z.string(), y: z.string() });
  console.log("P5 outputFollowsShapeOrder:", Object.keys(O.parse({ y: "1", x: "2" })).join("") === "xy");
  console.log("P5b stripKeepsShapeOrder:", Object.keys(O.parse({ y: "1", extra: 9, x: "2" })).join("") === "xy");
}
{
  const r = z.strictObject({ a: z.string() }).safeParse({ a: "x", b: 1 } as never);
  console.log("P6 strictIssue:", r.success ? "ok" : JSON.stringify({ code: r.error.issues[0]!.code, path: r.error.issues[0]!.path, keys: (r.error.issues[0] as any).keys, expected: (r.error.issues[0] as any).expected }));
  const all = r.success ? [] : r.error.issues.map((i: any) => `${i.code}@${JSON.stringify(i.path)}`);
  console.log("P6b strictAllIssues:", all.join(" | "));
}
{
  const rin = { k: 1 };
  const rout: any = z.record(z.string(), z.number()).parse(rin);
  console.log("P7 recordRebuilds:", rout !== rin);
}
{
  const r = z.number().safeParse(NaN);
  console.log("P8 z.number() NaN:", r.success ? "accepted" : r.error.issues[0]!.code);
}
{
  const r = z.number().int().default(1.5 as never).safeParse(undefined);
  console.log("P9 default(1.5) on z.number().int():", r.success ? "short-circuit（默认值不校验）" : "validated（默认值过内层）", r.success ? "" : r.error.issues[0]!.code);
}
{
  let keys: string[] = [];
  const r = z.string().transform((v: string, p: any) => {
    keys = Object.keys(p ?? {});
    return v + "!";
  }).safeParse("x");
  console.log("P10 transform payload keys:", keys.join(","), "| result:", r.success ? (r as any).data : "fail");
}
{
  let arg2: any = null;
  z.string().refine(((v: unknown, p: any) => {
    arg2 = { keys: Object.keys(p ?? {}), hasIssues: Array.isArray(p?.issues), addIssue: typeof p?.addIssue === "function" };
    return true;
  }) as any).safeParse("x");
  console.log("P11 refine arg2:", JSON.stringify(arg2));
  const rf = z.string().refine((v: string) => v.length > 2).safeParse("ab");
  console.log("P11b refine fail:", rf.success ? "ok" : JSON.stringify({ code: rf.error.issues[0]!.code }));
  console.log("P11c .check API:", typeof (z.string() as any).check, "| .superRefine:", typeof (z.string() as any).superRefine);
}
{
  const cs: any = z.string().catch("fb");
  console.log("P12 catch def keys:", Object.keys(cs._zod.def).join(","), "| catchValue typeof:", typeof cs._zod.def.catchValue);
  let args: any = null;
  const cs2: any = z.string().catch((a: any) => {
    args = a === undefined ? "undefined" : Object.keys(a).join(",");
    return "fb2";
  });
  const r = cs2.safeParse(123);
  console.log("P12b catch fn args:", args, "| data:", r.success ? (r as any).data : "fail");
  const thrower: any = z.string().refine(() => { throw new Error("boom"); }).catch("fb3");
  try {
    const rt = thrower.safeParse("x");
    console.log("P12c catch swallows throw:", rt.success ? (rt as any).data : "fail");
  } catch (e: any) {
    console.log("P12c catch swallows throw: NO — 异常向上传播:", e.message);
  }
}
console.log("P13 pipe def keys:", Object.keys((z.string().pipe(z.number() as any) as any)._zod.def).join(","));
{
  const em: any = (z as any).email();
  console.log("P14 email check:", JSON.stringify(ser(em._zod.def.checks?.[0]?._zod?.def)));
  const dt: any = (z as any).iso.datetime();
  console.log("P14b datetime check:", JSON.stringify(ser(dt._zod.def.checks?.[0]?._zod?.def)));
}
{
  const uf = z.union([z.string(), z.number()]).safeParse(true);
  console.log("P15 union fail codes:", uf.success ? "ok" : uf.error.issues.map((i: any) => i.code).join(","));
}
console.log("P16 record number key {1:'a'}:", z.record(z.number(), z.string()).safeParse({ 1: "a" } as never).success);
{
  const tr: any = z.tuple([z.string()], z.number());
  console.log("P17 tuple def keys:", Object.keys(tr._zod.def).join(","), "| rest:", JSON.stringify(ser(tr._zod.def.rest)));
}
{
  const asyncS: any = z.string().refine(async () => true);
  console.log("P18 async flag:", asyncS._zod.async, "| sync string:", (z.string() as any)._zod.async);
}
{
  const ddef: any = (z.string().default("d") as any)._zod.def;
  console.log("P19 default defaultValue:", typeof ddef.defaultValue, JSON.stringify(ser(ddef.defaultValue)));
}
{
  const inter = z.intersection(z.object({ p: z.string() }), z.object({ q: z.number() }));
  const r: any = inter.safeParse({ p: "a", q: 1 });
  console.log("P20 intersection objects:", r.success ? JSON.stringify(r.data) : "fail");
}
{
  const cleanIn = { a: "x", b: 1 };
  const cleanOut: any = z.object({ a: z.string(), b: z.number() }).parse(cleanIn);
  console.log("P21 stock clean parse new object:", cleanOut !== cleanIn);
}
{
  // multi-invalid object：issue 收集语义（全部收集 vs 首错即停）
  const r = z.object({ a: z.string(), b: z.number() }).safeParse({ a: 1, b: "x" });
  console.log("P22 multi-invalid issue count:", r.success ? 0 : r.error.issues.length);
}
{
  // run() 返回契约
  const zs: any = z.string();
  const p = { value: "hi", issues: [] as any[] };
  const ret = zs._zod.run(p, undefined);
  console.log("P23 run returns payload itself:", ret === p, "| ret.value:", ret.value, "| issues:", ret.issues?.length);
}
/* ──────────────────── 第二轮补充探针 ──────────────────── */
console.log("\n╔══════════ 补充探针 ══════════╗");
{
  let ctxKeys: string[] = [];
  const s: any = z.string().check((c: any) => {
    ctxKeys = Object.keys(c ?? {});
    if (c?.addIssue) c.addIssue({ code: "custom", message: "x" });
  });
  const r = s.safeParse("abc");
  console.log("S1 .check() ctx keys:", ctxKeys.join(","), "| result:", r.success ? "ok" : r.error.issues[0]!.code);
  console.log("S1b .check() check def:", JSON.stringify(ser(s._zod.def.checks?.[0])));
  console.log("S1c email() top-level def:", JSON.stringify(ser((z as any).email()._zod.def)).slice(0, 300));
  console.log("S1d iso.datetime() def:", JSON.stringify(ser((z as any).iso.datetime()._zod.def)).slice(0, 300));
}
{
  const zi: any = (z as any).int();
  console.log("S2 z.int() def:", JSON.stringify(ser(zi._zod.def)));
  const zfl: any = (z as any).float32?.();
  if (zfl) console.log("S2b z.float32() def:", JSON.stringify(ser(zfl._zod.def)));
}
{
  const uf = z.union([z.string(), z.number()]).safeParse(true);
  console.log("S3 union fail codes:", uf.success ? "ok" : uf.error.issues.map((i: any) => `${i.code}@${JSON.stringify(i.path)}`).join(" | "));
}
console.log("S4 record number key {1:'a'}:", z.record(z.number(), z.string()).safeParse({ 1: "a" } as never).success);
{
  const asyncS: any = z.string().refine(async () => true);
  console.log("S5 async flag:", asyncS._zod.async, "| sync:", (z.string() as any)._zod.async);
}
{
  const inter = z.intersection(z.object({ p: z.string() }), z.object({ q: z.number() }));
  const r: any = inter.safeParse({ p: "a", q: 1 });
  console.log("S6 intersection objects:", r.success ? JSON.stringify(r.data) : "fail", r.success ? "" : r.error.issues[0]!.code);
}
{
  const cleanIn = { a: "x", b: 1 };
  const cleanOut: any = z.object({ a: z.string(), b: z.number() }).parse(cleanIn);
  console.log("S7 stock clean parse new object:", cleanOut !== cleanIn);
  const arr: any = z.array(z.string()).parse(["a"]);
  console.log("S7b stock clean array parse new array:", arr !== (cleanIn && ["a"] ? arr : null) ? "(新数组)" : "");
}
{
  const r = z.object({ a: z.string(), b: z.number() }).safeParse({ a: 1, b: "x" });
  console.log("S8 multi-invalid issue count:", r.success ? 0 : r.error.issues.length, r.success ? "" : r.error.issues.map((i: any) => i.code).join(","));
}
{
  const p = { value: "hi", issues: [] as any[] };
  const ret = (z.string() as any)._zod.run(p, undefined);
  console.log("S9 run returns payload itself:", ret === p, "| ret.value:", JSON.stringify(ret.value), "| issues:", ret.issues?.length);
}
{
  const r = z.array(z.number()).safeParse([1, "a", "b"] as never);
  console.log("S10 array multi-invalid issue count:", r.success ? 0 : r.error.issues.length);
}
{
  const LO = z.looseObject({ a: z.string() });
  const out: any = LO.parse({ zz: 1, a: "x" });
  console.log("S11 loose extras kept:", Object.keys(out).join(","), "| same ref:", out === ({ zz: 1, a: "x" } as any));
}
{
  // optional 包 default 的顺序语义 & undefined 输入
  const o1 = z.string().default("d").optional();
  const o2 = z.string().optional().default("d");
  console.log("S12 default.optional(undefined):", JSON.stringify((o1 as any).parse(undefined)));
  console.log("S12b optional.default(undefined):", JSON.stringify((o2 as any).parse(undefined)));
}
{
  // number_format safeint 边界
  const r1 = z.number().int().safeParse(Number.MAX_SAFE_INTEGER + 1);
  console.log("S13 .int() rejects 2^53:", !r1.success, r1.success ? "" : r1.error.issues[0]!.code);
}
{
  // datetime check 结构（iso.datetime 参数）
  const dt2: any = (z as any).iso.datetime({ offset: true, precision: 3 });
  console.log("S14 datetime(offset,precision) check:", JSON.stringify(ser(dt2._zod.def.checks?.[0]?._zod?.def)).slice(0, 220));
}
{
  // union 成功分支的 issue 截断（信息性）
  const u = z.union([z.string().min(5), z.string().min(1)]);
  const r = u.safeParse("ab");
  console.log("S15 union second branch ok:", r.success);
}
console.log("\nprobe-z4 done.");
