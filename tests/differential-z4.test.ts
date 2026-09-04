/**
 * Differential fuzz test (zc-z4: official codegen + CoW skeletons vs stock zod4).
 * Compares against stock zod4 on:
 *   1. success/failure parity  2. deepStrictEqual output  3. zero input distortion
 * Also reports top-level reference-sharing rate (CoW hit rate) and stock degradation rate.
 * Failures print seed/case for replay (REPRO=seed:case).
 */
import { deepEqual as assertDeepEqual } from "./harness.js";
import { z } from "zod4";
import { compile } from "../src/index-z4.js";

interface RNG {
  next(): number;
  chance(p: number): boolean;
  int(n: number): number;
  pick<T>(arr: readonly T[]): T;
}

function makeRng(seed: number): RNG {
  let s = seed >>> 0 || 1;
  const next = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p) => next() < p,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
  };
}

/* ─────────────────────────── 数据池 ─────────────────────────── */

const ABSENT = Symbol("absent");

const STRINGS = [
  "",
  "a",
  "ab",
  "abc",
  "abcd",
  "hello",
  "AB1",
  "a@b.co",
  "  pad  ",
  "aaaab",
  "forbidden",
  "x".repeat(12),
] as const;
const NON_STRINGS = [1, null, true, undefined, 4.5] as const;
const NUMBERS = [0, 1, 2, 3, 7, 10, -1, -7, 4.5, 100, NaN, "5", null] as const;
const BOOLEANS = [true, false, "true", 0, null] as const;
const BIGINTS = [1n, 0n, 99n, -5n, 1, "x", null] as const;
const DATES = [
  new Date(0),
  new Date(1700000000000),
  new Date(NaN),
  "not a date",
  123,
  null,
] as const;

function repr(v: unknown): string {
  try {
    return (
      JSON.stringify(v, (_k, x) => {
        if (typeof x === "bigint") return `${x}n`;
        if (x instanceof Date) return Number.isNaN(x.getTime()) ? "Date(NaN)" : x.toISOString();
        if (typeof x === "symbol") return String(x);
        return x;
      }) ?? String(v)
    );
  } catch {
    return String(v);
  }
}

/* ─────────────────────────── schema 生成器 ─────────────────────────── */

interface Built {
  schema: z.ZodType;
  desc: string;
  /** 返回值可能是 ABSENT（表示该键不出现） */
  gen(rng: RNG): unknown;
}

function bString(rng: RNG): Built {
  let s = z.string();
  let desc = "string";
  let minN = 0;
  if (rng.chance(0.3)) {
    minN = rng.pick([0, 1, 2, 3, 5] as const);
    s = s.min(minN);
    desc += `.min(${minN})`;
  }
  if (rng.chance(0.3)) {
    // z4 用正则编码长度约束，min > max 会在 schema 构建期抛错 → 保证 max >= min
    const n = Math.max(rng.pick([2, 4, 8, 16] as const), minN);
    s = s.max(n);
    desc += `.max(${n})`;
  }
  if (rng.chance(0.12)) {
    s = s.regex(/^[ab]+$/);
    desc += ".regex(/^[ab]+$/)";
  }
  if (rng.chance(0.1)) {
    s = s.email();
    desc += ".email()";
  }
  if (rng.chance(0.1)) {
    s = s.trim();
    desc += ".trim()";
  }
  if (rng.chance(0.08)) {
    s = s.toLowerCase();
    desc += ".toLowerCase()";
  }
  return {
    schema: s,
    desc,
    gen: (r) => (r.chance(0.18) ? r.pick(NON_STRINGS) : r.pick(STRINGS)),
  };
}

function bNumber(rng: RNG): Built {
  let s = z.number();
  let desc = "number";
  if (rng.chance(0.3)) {
    s = s.int();
    desc += ".int()";
  }
  if (rng.chance(0.3)) {
    const n = rng.pick([1, 2, 5, 10] as const);
    s = s.min(n);
    desc += `.min(${n})`;
  }
  if (rng.chance(0.3)) {
    const n = rng.pick([3, 8, 50, 1000] as const);
    s = s.max(n);
    desc += `.max(${n})`;
  }
  if (rng.chance(0.1)) {
    s = s.multipleOf(2);
    desc += ".multipleOf(2)";
  }
  return {
    schema: s,
    desc,
    gen: (r) => (r.chance(0.18) ? r.pick(["nope", null, [], {}] as const) : r.pick(NUMBERS)),
  };
}

function bLeaf(rng: RNG): Built {
  const which = rng.int(7);
  switch (which) {
    case 0:
      return bString(rng);
    case 1:
      return bNumber(rng);
    case 2:
      return { schema: z.boolean(), desc: "boolean", gen: (r) => r.pick(BOOLEANS) };
    case 3: {
      const v = rng.pick(["x", "y", 7, true] as const);
      return {
        schema: z.literal(v),
        desc: `literal(${String(v)})`,
        gen: (r) => (r.chance(0.25) ? r.pick(["z", 8, false, null] as const) : v),
      };
    }
    case 4: {
      const vals = rng.pick([["a", "b"] as const, ["x", "y", "z"] as const]);
      return {
        schema: z.enum(vals),
        desc: `enum(${vals.join("|")})`,
        gen: (r) => (r.chance(0.2) ? r.pick(["q", 1, null] as const) : r.pick(vals)),
      };
    }
    case 5:
      return { schema: z.bigint(), desc: "bigint", gen: (r) => r.pick(BIGINTS) };
    default:
      return { schema: z.date(), desc: "date", gen: (r) => r.pick(DATES) };
  }
}

/** z4：default 短路，默认值不校验 —— 但仍取合法值，保证与 z3 生成器行为一致。
 *  async schema 的 sync safeParse 抛 $ZodAsyncError → 放弃探测（default 包装同步放弃）。 */
function validValueFor(b: Built, rng: RNG): unknown {
  for (let i = 0; i < 50; i++) {
    const v = b.gen(rng);
    if (v === ABSENT) continue;
    try {
      if (b.schema.safeParse(v as never).success) return v;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bWrap(rng: RNG, inner: Built): Built {
  const which = rng.int(7);
  if (which === 0) {
    return {
      schema: inner.schema.optional(),
      desc: `${inner.desc}.optional()`,
      gen: (r) => (r.chance(0.3) ? ABSENT : r.chance(0.25) ? undefined : inner.gen(r)),
    };
  }
  if (which === 1) {
    return {
      schema: inner.schema.nullable(),
      desc: `${inner.desc}.nullable()`,
      gen: (r) => (r.chance(0.2) ? null : r.chance(0.15) ? ABSENT : inner.gen(r)),
    };
  }
  if (which === 2) {
    const dv = validValueFor(inner, rng);
    let absentOk = false;
    try {
      absentOk = !inner.schema.safeParse(undefined).success;
    } catch {
      return inner; // async schema：sync 探测不可用 → 放弃 default 包装
    }
    if (dv === undefined && absentOk) {
      return inner; // 无合法默认值时放弃 default 包装
    }
    return {
      schema: inner.schema.default(dv as never),
      desc: `${inner.desc}.default(${repr(dv)})`,
      gen: (r) => (r.chance(0.35) ? ABSENT : inner.gen(r)),
    };
  }
  if (which === 3) {
    return {
      schema: inner.schema.refine((v: unknown) => v !== "forbidden", {
        error: "value is forbidden",
      }),
      desc: `${inner.desc}.refine(≠forbidden)`,
      gen: inner.gen,
    };
  }
  if (which === 5) {
    // Task 6：async refine（成败域与 sync 同构，但走 async 岛）
    return {
      schema: inner.schema.refine(async (v: unknown) => v !== "forbidden", {
        error: "value is forbidden",
      }),
      desc: `${inner.desc}.refine(async ≠forbidden)`,
      gen: inner.gen,
    };
  }
  if (which === 6) {
    // Task 6：async transform（string → string，与 sync transform 同构）
    return {
      schema: inner.schema.transform(async (v: any) => (typeof v === "string" ? `${v}!` : v)),
      desc: `${inner.desc}.transform(async +!)`,
      gen: inner.gen,
    };
  }
  // transform：string → string（纯字符串变换，差分可对齐）
  return {
    schema: inner.schema.transform((v: any) => (typeof v === "string" ? `${v}!` : v)),
    desc: `${inner.desc}.transform(+!)`,
    gen: inner.gen,
  };
}

function bObject(rng: RNG, depth: number): Built {
  const nFields = 1 + rng.int(3);
  const fields: { key: string; built: Built }[] = [];
  for (let i = 0; i < nFields; i++) {
    fields.push({ key: `f${i}`, built: bChild(rng, depth) });
  }
  const modeRoll = rng.int(10);
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) shape[f.key] = f.built.schema;
  let schema: z.ZodType = z.object(shape);
  let modeDesc = "";
  if (modeRoll < 1) {
    schema = z.strictObject(shape);
    modeDesc = ".strict()";
  } else if (modeRoll < 2) {
    schema = z.looseObject(shape);
    modeDesc = ".passthrough()";
  }
  const desc = `object({${fields.map((f) => `${f.key}: ${f.built.desc}`).join(", ")}})${modeDesc}`;
  let extraSeq = 0;
  return {
    schema,
    desc,
    gen: (r) => {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const v = f.built.gen(r);
        if (v !== ABSENT) out[f.key] = v;
      }
      if (r.chance(0.25)) out[`extra${extraSeq++}`] = r.pick([1, "x", null, true] as const); // 多余键
      return out;
    },
  };
}

function bArray(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  let schema = inner.schema.array();
  let desc = `array(${inner.desc})`;
  if (rng.chance(0.25)) {
    schema = schema.min(1);
    desc += ".min(1)";
  }
  if (rng.chance(0.2)) {
    schema = schema.max(3);
    desc += ".max(3)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      const n = r.int(5); // 0..4
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) out.push(v);
      }
      return out;
    },
  };
}

function bRecord(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  const numericKeys = rng.chance(0.15);
  const keySchema: z.ZodType = numericKeys ? z.number() : z.string();
  return {
    schema: z.record(keySchema as any, inner.schema),
    desc: `record(${numericKeys ? "number" : "string"}, ${inner.desc})`,
    gen: (r) => {
      const out: Record<string, unknown> = {};
      const keys = ["a", "b", "c", "d"];
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) out[numericKeys ? String(r.int(4)) : keys[i]!] = v;
      }
      return out;
    },
  };
}

function bMap(rng: RNG, depth: number): Built {
  const key = rng.chance(0.8) ? z.string() : z.number();
  const inner = bChild(rng, depth);
  let schema = z.map(key as any, inner.schema);
  let desc = `map(${rng.chance(0.8) ? "string" : "number"}, ${inner.desc})`;
  if (rng.chance(0.2)) {
    schema = schema.min(1);
    desc += ".min(1)";
  }
  if (rng.chance(0.15)) {
    schema = schema.max(3);
    desc += ".max(3)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      const m = new Map<unknown, unknown>();
      const n = r.int(4);
      const keys = ["a", "b", "c"];
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) m.set(key === z.string() ? keys[i]! : r.int(3), v);
      }
      return m;
    },
  };
}

function bSet(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  let schema = z.set(inner.schema);
  let desc = `set(${inner.desc})`;
  if (rng.chance(0.2)) {
    schema = schema.min(1);
    desc += ".min(1)";
  }
  if (rng.chance(0.15)) {
    schema = schema.max(3);
    desc += ".max(3)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      const st = new Set<unknown>();
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) st.add(v);
      }
      return st;
    },
  };
}

function bTuple(rng: RNG, depth: number): Built {
  const nFixed = 2 + rng.int(2); // 2–3 必填槽
  const items: Built[] = [];
  for (let i = 0; i < nFixed; i++) items.push(bChild(rng, depth));
  // 尾部 optional 槽（触发 optoutStart 截断语义）
  const nOpt = rng.chance(0.4) ? 1 + rng.int(2) : 0;
  for (let i = 0; i < nOpt; i++) {
    const inner = bChild(rng, depth);
    items.push({
      schema: inner.schema.optional(),
      desc: `${inner.desc}.optional()`,
      gen: (r) => (r.chance(0.3) ? ABSENT : inner.gen(r)),
    });
  }
  const rest = rng.chance(0.18)
    ? (() => {
        // rest 限定 sync（叶子 + nullable 包装）：
        // stock zod4 runtime 对 async rest 槽的输出构造有确定性 quirk ——
        // nullable(asyncRefine) 的 run 对任何输入返回 Promise，rest 槽异步写回
        // 产生稀疏数组（如 ['a', hole, null]，null 值被丢成 hole）。
        // 骨架输出稠密数组（更正确），不假性对齐此行为 → 差分规避 async rest。
        const leaf = bLeaf(rng);
        const useNullable = rng.chance(0.3);
        const schema = useNullable ? leaf.schema.nullable() : leaf.schema;
        const desc = useNullable ? `${leaf.desc}.nullable()` : leaf.desc;
        const innerGen = leaf.gen;
        return {
          schema,
          desc,
          gen: (r: RNG) => (useNullable && r.chance(0.2) ? null : innerGen(r)),
        };
      })()
    : null;
  const schemas = items.map((b) => b.schema) as [z.ZodType, ...z.ZodType[]];
  const schema = rest ? (z.tuple(schemas, rest.schema as never) as z.ZodType) : z.tuple(schemas);
  const desc = `tuple([${items.map((b) => b.desc).join(", ")}]${rest ? `, rest: ${rest.desc}` : ""})`;
  let trimSeq = 0;
  return {
    schema,
    desc,
    gen: (r) => {
      const out: unknown[] = [];
      for (const b of items) {
        const v = b.gen(r);
        if (v !== ABSENT) out.push(v);
      }
      // 概率把输入裁短（触发 trailing absent / defaulted 槽区语义）
      if (r.chance(0.15)) out.length = Math.max(0, out.length - 1 - r.int(2));
      if (rest) {
        const extra = r.int(3);
        for (let i = 0; i < extra; i++) {
          const v = rest.gen(r);
          if (v !== ABSENT) out.push(v);
        }
      }
      void trimSeq++;
      return out;
    },
  };
}

function bChild(rng: RNG, depth: number): Built {
  const inner = depth <= 0 ? bLeaf(rng) : bAny(rng, depth - 1);
  return rng.chance(0.4) ? bWrap(rng, inner) : inner;
}

function bAny(rng: RNG, depth: number): Built {
  const roll = rng.next();
  if (depth <= 0) return bLeaf(rng);
  if (roll < 0.36) return bLeaf(rng);
  if (roll < 0.52) return bObject(rng, depth);
  if (roll < 0.62) return bArray(rng, depth);
  if (roll < 0.72) return bTuple(rng, depth);
  if (roll < 0.8) return bRecord(rng, depth);
  if (roll < 0.86) return bMap(rng, depth);
  if (roll < 0.91) return bSet(rng, depth);
  return bWrap(rng, bLeaf(rng));
}

/* ─────────────────────────── 差分主循环（z4） ─────────────────────────── */

const SEEDS = Number(process.env.SEEDS ?? 200);
const CASES_PER_SEED = Number(process.env.CASES ?? 100);
const REPRO = process.env.REPRO ?? null;
let total = 0;
let bothOk = 0;
let bothFail = 0;
let refShared = 0;
let stockDowngraded = 0;
const failures: string[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = makeRng(seed);
  for (let i = 0; i < CASES_PER_SEED; i++) {
    const built = bAny(rng, 3);
    let input = built.gen(rng);
    if (input === ABSENT) input = undefined;
    if (REPRO && `${seed}:${i}` !== REPRO) continue;
    const caseId = `seed=${seed} case=${i} schema=[${built.desc}] input=${repr(input)}`;
    total++;

    const compiled = compile(built.schema);
    if (compiled.stock) stockDowngraded++;
    const useAsync = compiled.async; // async 骨架 → 双侧走 safeParseAsync

    if (REPRO) {
      console.log("=== REPRO ===");
      console.log("desc:", built.desc);
      console.log("input:", repr(input));
      console.log("stock:", compiled.stock, "async:", compiled.async);
      console.log(
        `cow code:\n${(compiled.code ?? "(stock)")
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")}`,
      );
    }

    const snapshot = structuredClone(input);

    let stock: { success: boolean; data?: unknown; error?: { issues: unknown[] } } | null = null;
    let stockThrew: Error | null = null;
    try {
      const rp = useAsync
        ? (
            built.schema as unknown as { safeParseAsync: (d: unknown) => Promise<never> }
          ).safeParseAsync(input)
        : built.schema.safeParse(input as never);
      const r = (await rp) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
      stock = r.success
        ? { success: true, data: r.data }
        : { success: false, error: r.error as never };
    } catch (e) {
      stockThrew = e as Error;
    }

    let ours: { success: boolean; data?: unknown; error?: { issues: unknown[] } } | null = null;
    let oursThrew: Error | null = null;
    try {
      const rp = useAsync ? compiled.safeParseAsync(input) : compiled.safeParse(input);
      const r = (await rp) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
      ours = r.success
        ? { success: true, data: r.data }
        : { success: false, error: r.error as never };
    } catch (e) {
      oursThrew = e as Error;
    }

    if (!assertDeepEqual(input, snapshot)) {
      failures.push(`INPUT MUTATED → ${caseId}`);
      continue;
    }

    if (stockThrew !== null || oursThrew !== null) {
      if ((stockThrew === null) !== (oursThrew === null)) {
        failures.push(
          `THROW MISMATCH (stock=${stockThrew?.message} ours=${oursThrew?.message}) → ${caseId}`,
        );
      }
      continue;
    }

    if (stock!.success !== ours!.success) {
      failures.push(
        `SUCCESS MISMATCH stock=${stock!.success} ours=${ours!.success}\n      ${caseId}` +
          (ours!.success
            ? `\n      stock issues: ${JSON.stringify((stock!.error as any)?.issues?.slice(0, 3))}`
            : `\n      ours issues: ${JSON.stringify((ours!.error as any)?.issues?.slice(0, 3))}\n      cow code:\n${(
                compiled.code ?? "(stock)"
              )
                .split("\n")
                .map((l) => `        ${l}`)
                .join("\n")}`),
      );
      continue;
    }

    if (stock!.success) {
      bothOk++;
      if (!assertDeepEqual(ours!.data, stock!.data)) {
        failures.push(
          `OUTPUT MISMATCH\n      stock: ${repr(stock!.data)}\n      ours:  ${repr(ours!.data)}\n      ${caseId}\n      def: ${defRepr(built.schema)}\n      cow code:\n${(
            compiled.code ?? "(stock)"
          )
            .split("\n")
            .map((l) => `        ${l}`)
            .join("\n")}`,
        );
        continue;
      }
      if (ours!.data === input) refShared++;
    } else {
      bothFail++;
    }
  }
}

function defRepr(schema: any, depth = 0): string {
  try {
    if (depth > 4) return "…";
    const d = schema?._zod?.def ?? {};
    const parts: string[] = [d.type ?? d.check ?? "?"];
    for (const k of [
      "innerType",
      "element",
      "in",
      "out",
      "keyType",
      "valueType",
      "left",
      "right",
    ]) {
      if (d[k]) parts.push(`${k}=${defRepr(d[k], depth + 1)}`);
    }
    if (d.options)
      parts.push(`options=[${d.options.map((o: any) => defRepr(o, depth + 1)).join(",")}]`);
    if (d.checks)
      parts.push(`checks=[${d.checks.map((c: any) => (c?._zod?.def ?? c)?.check).join(",")}]`);
    return parts.join("(") + ")".repeat(parts.length - 1);
  } catch {
    return "?";
  }
}

/* ─────────────────────────── 报告 ─────────────────────────── */

console.log(`zc-z4 差分测试: ${total} cases (seeds=${SEEDS} × ${CASES_PER_SEED})`);
console.log(
  `  成功一致: ${bothOk}   失败一致: ${bothFail}   顶层引用共享率: ${total ? ((refShared / total) * 100).toFixed(1) : "0"}%（成功 case 中 ${((refShared / Math.max(1, bothOk)) * 100).toFixed(1)}%）`,
);
console.log(`  stock 降级（compile 放弃编译）: ${stockDowngraded} 次`);
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 个差异（前 10 个）:`);
  for (const f of failures.slice(0, 10)) console.log(`\n${f}`);
  process.exit(1);
} else {
  console.log("  全部与 stock zod4 一致 ✓");
}
