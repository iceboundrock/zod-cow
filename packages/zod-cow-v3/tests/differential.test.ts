/**
 * Differential fuzz test — random schema + data, comparing the compiled layer against stock zod:
 *   1. Success/failure parity
 *   2. On success, output values are deepStrictEqual (key-set semantics aligned: absent optional keys, present-undefined, etc.)
 *   3. Zero input distortion (deepStrictEqual snapshot before/after parse) — never mutate in place,
 *      and never freeze the input (readonly freezes a copy, #27)
 *   4. On failure, the issue lists agree on count, codes, paths and messages (the params beyond
 *      those are compared for the fields stock and this line both carry)
 * Extra statistic: top-level reference sharing rate (CoW hit rate).
 *
 * The generator is deterministic: on failure it prints seed/case/desc/input for a direct repro.
 */
import { deepEqual as assertDeepEqual } from "./harness.js";
import { z } from "zod";

// `--no-codegen` runs the same cases through the closure skeletons (the fallback used where
// `new Function` is unavailable); the flag must be set before the compiler module loads
const noCodegen = process.argv.includes("--no-codegen");
if (noCodegen) process.env.ZC_V3_CODEGEN = "0";
const { compile } = await import("../src/index.js");

/* ─────────────────────────── deterministic RNG ─────────────────────────── */

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

/* ─────────────────────────── data pool ─────────────────────────── */

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

/* ─────────────────────────── schema generator ─────────────────────────── */

interface Built {
  schema: z.ZodTypeAny;
  desc: string;
  /** The return value may be ABSENT (meaning the key does not appear) */
  gen(rng: RNG): unknown;
}

function bString(rng: RNG): Built {
  let s = z.string();
  let desc = "string";
  if (rng.chance(0.3)) {
    const n = rng.pick([0, 1, 2, 3, 5] as const);
    s = s.min(n);
    desc += `.min(${n})`;
  }
  if (rng.chance(0.3)) {
    const n = rng.pick([2, 4, 8, 16] as const);
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
  if (rng.chance(0.06)) {
    const n = rng.pick([1, 3, 5] as const);
    s = s.length(n);
    desc += `.length(${n})`;
  }
  if (rng.chance(0.06)) {
    s = s.includes("b");
    desc += '.includes("b")';
  }
  if (rng.chance(0.05)) {
    s = s.startsWith("a", "must start with a");
    desc += '.startsWith("a", msg)';
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
    if (rng.chance(0.3)) {
      s = s.min(n, { message: `at least ${n}` });
      desc += `.min(${n}, msg)`;
    } else {
      s = s.min(n);
      desc += `.min(${n})`;
    }
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
  const which = rng.int(9);
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
    case 6:
      return {
        schema: z.date(),
        desc: "date",
        // A fresh Date per case: a readonly over a date freezes the instance in place (stock too)
        gen: (r) => {
          const v = r.pick(DATES);
          return v instanceof Date ? new Date(v.getTime()) : v;
        },
      };
    case 7: {
      const E = { A: "a", B: "b", C: 3 } as const;
      return {
        schema: z.nativeEnum(E),
        desc: "nativeEnum(A|B|C=3)",
        gen: (r) =>
          r.chance(0.25) ? r.pick(["z", 4, null, true] as const) : r.pick(["a", "b", 3] as const),
      };
    }
    default:
      // create params: a required_error / invalid_type_error map on a plain string
      return {
        schema: z.string({
          required_error: "name required",
          invalid_type_error: "name must be text",
        }),
        desc: "string({required_error, invalid_type_error})",
        gen: (r) => (r.chance(0.3) ? r.pick(NON_STRINGS) : r.pick(STRINGS)),
      };
  }
}

/** When building a default wrapper the default value must pass the inner validation (stock re-validates the default with the inner schema) */
function validValueFor(b: Built, rng: RNG): unknown {
  for (let i = 0; i < 50; i++) {
    const v = b.gen(rng);
    if (v !== ABSENT && b.schema.safeParse(v as never).success) return v;
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
    // No valid default (constraints unsatisfiable): give up on the default wrapper to avoid a degenerate schema
    if (dv === undefined && !inner.schema.safeParse(undefined).success) {
      return inner;
    }
    return {
      schema: inner.schema.default(dv as never),
      desc: `${inner.desc}.default(${repr(dv)})`,
      gen: (r) => (r.chance(0.35) ? ABSENT : inner.gen(r)),
    };
  }
  if (which === 3) {
    return {
      schema: inner.schema.refine((v: unknown) => v !== "forbidden", "value is forbidden"),
      desc: `${inner.desc}.refine(≠forbidden)`,
      gen: inner.gen,
    };
  }
  if (which === 5) {
    const cv = validValueFor(inner, rng);
    return {
      schema: inner.schema.catch(cv as never),
      desc: `${inner.desc}.catch(${repr(cv)})`,
      gen: inner.gen,
    };
  }
  if (which === 6) {
    return {
      schema: inner.schema.readonly(),
      desc: `${inner.desc}.readonly()`,
      gen: inner.gen,
    };
  }
  // transform: string → string (restricted to a pure string transform so the differential stays alignable)
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
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) shape[f.key] = f.built.schema;
  let schema: z.ZodTypeAny = z.object(shape);
  let modeDesc = "";
  if (modeRoll < 1) {
    schema = (schema as z.ZodObject<any>).strict();
    modeDesc = ".strict()";
  } else if (modeRoll < 2) {
    schema = (schema as z.ZodObject<any>).passthrough();
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
      if (r.chance(0.25)) out[`extra${extraSeq++}`] = r.pick([1, "x", null, true] as const); // extra key
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
  return {
    schema: z.record(z.string(), inner.schema),
    desc: `record(string, ${inner.desc})`,
    gen: (r) => {
      const out: Record<string, unknown> = {};
      const keys = ["a", "b", "c", "d"];
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) out[keys[i]!] = v;
      }
      return out;
    },
  };
}

function bTuple(rng: RNG, depth: number): Built {
  const a = bChild(rng, depth);
  const b = bChild(rng, depth);
  return {
    schema: z.tuple([a.schema, b.schema]),
    desc: `tuple(${a.desc}, ${b.desc})`,
    gen: (r) => {
      const roll = r.next();
      const va = a.gen(r);
      const vb = b.gen(r);
      const items = [va === ABSENT ? undefined : va, vb === ABSENT ? undefined : vb];
      if (roll < 0.1) return items.slice(0, 1);
      if (roll < 0.2) return [...items, 1];
      if (roll < 0.25) return r.pick(["x", 1, null, {}] as const);
      return items;
    },
  };
}

function bMap(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  return {
    schema: z.map(z.string().min(1), inner.schema),
    desc: `map(string.min(1), ${inner.desc})`,
    gen: (r) => {
      if (r.chance(0.1)) return r.pick([{}, [], "x"] as const);
      const m = new Map<unknown, unknown>();
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        m.set(r.chance(0.1) ? "" : r.chance(0.1) ? i : `k${i}`, v === ABSENT ? undefined : v);
      }
      return m;
    },
  };
}

function bSet(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  let schema = z.set(inner.schema);
  let desc = `set(${inner.desc})`;
  if (rng.chance(0.3)) {
    schema = schema.max(2);
    desc += ".max(2)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      if (r.chance(0.1)) return r.pick([[], {}, 1] as const);
      const out = new Set<unknown>();
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        out.add(v === ABSENT ? undefined : v);
      }
      return out;
    },
  };
}

function bDiscriminated(rng: RNG, depth: number): Built {
  const a = bChild(rng, depth);
  const b = bChild(rng, depth);
  const A = z.object({ kind: z.literal("a"), v: a.schema });
  const B = z.object({ kind: z.literal("b"), w: b.schema });
  return {
    schema: z.discriminatedUnion("kind", [A, B]),
    desc: `discriminatedUnion(kind, {a, v: ${a.desc}}, {b, w: ${b.desc}})`,
    gen: (r) => {
      const roll = r.next();
      if (roll < 0.1) return { kind: "c" };
      if (roll < 0.15) return r.pick([null, 1, "a"] as const);
      const out: Record<string, unknown> = {};
      if (roll < 0.575) {
        out.kind = "a";
        const v = a.gen(r);
        if (v !== ABSENT) out.v = v;
      } else {
        out.kind = "b";
        const v = b.gen(r);
        if (v !== ABSENT) out.w = v;
      }
      if (r.chance(0.2)) out.extra = 1;
      return out;
    },
  };
}

function bUnion(rng: RNG, _depth: number): Built {
  const n = 2 + rng.int(2);
  const branches: Built[] = [];
  const kinds: string[] = [];
  const used = new Set<string>();
  while (branches.length < n) {
    const b = bLeaf(rng);
    const tag = b.desc.split(/[.(]/)[0]!;
    if (used.has(tag)) continue;
    used.add(tag);
    branches.push(b);
    kinds.push(b.desc);
  }
  return {
    schema: z.union(
      branches.map((b) => b.schema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
    ),
    desc: `union(${kinds.join(", ")})`,
    gen: (r) => r.pick(branches).gen(r),
  };
}

function bChild(rng: RNG, depth: number): Built {
  const inner = depth <= 0 ? bLeaf(rng) : bAny(rng, depth - 1);
  return rng.chance(0.4) ? bWrap(rng, inner) : inner;
}

function bAny(rng: RNG, depth: number): Built {
  const roll = rng.next();
  if (depth <= 0) return bLeaf(rng);
  if (roll < 0.4) return bLeaf(rng);
  if (roll < 0.58) return bObject(rng, depth);
  if (roll < 0.68) return bArray(rng, depth);
  if (roll < 0.74) return bRecord(rng, depth);
  if (roll < 0.8) return bUnion(rng, depth);
  if (roll < 0.85) return bTuple(rng, depth);
  if (roll < 0.89) return bMap(rng, depth);
  if (roll < 0.93) return bSet(rng, depth);
  if (roll < 0.96) return bDiscriminated(rng, depth);
  return bWrap(rng, bLeaf(rng));
}

/* ─────────────────────────── differential main loop ─────────────────────────── */

const SEEDS = Number(process.env.SEEDS ?? 200);
const CASES_PER_SEED = Number(process.env.CASES ?? 100); // 20 000 cases in total
let total = 0;
let bothOk = 0;
let bothFail = 0;
let refShared = 0;
let refSharedSuccess = 0;
let issueMismatches = 0;
const failures: string[] = [];

/**
 * Canonical view of an issue list: code, path and message per issue, plus the params both sides
 * carry (a union's nested errors are compared by their own issue views), sorted so the order of
 * collection does not matter.
 */
function issueView(issues: readonly any[]): string {
  const one = (i: any): string => {
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(i).sort()) {
      if (k === "code" || k === "path" || k === "message" || k === "fatal") continue;
      if (k === "unionErrors") {
        params[k] = i[k].map((e: any) => issueView(e.issues));
        continue;
      }
      params[k] = i[k];
    }
    return `${i.code}@${repr(i.path)} ${repr(i.message)} ${repr(params)}`;
  };
  return issues.map(one).sort().join(" ; ");
}

for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = makeRng(seed);
  for (let i = 0; i < CASES_PER_SEED; i++) {
    const built = bAny(rng, 3);
    let input = built.gen(rng);
    if (input === ABSENT) input = undefined; // the top-level wrapper may be absent
    const caseId = `seed=${seed} case=${i} schema=[${built.desc}] input=${repr(input)}`;
    total++;

    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(built.schema);
    } catch (e) {
      failures.push(`COMPILE FAILED → ${caseId}\n      ${(e as Error).message}`);
      continue;
    }

    const snapshot = structuredClone(input);
    // Stock parses its own clone: a readonly over a pass-through leaf freezes the input in place on
    // both sides (stock behavior), so frozenness is compared between the two inputs afterwards
    const stockInput = structuredClone(input);

    let stock: z.SafeParseReturnType<unknown, unknown> | null = null;
    let stockThrew: Error | null = null;
    try {
      stock = built.schema.safeParse(stockInput as never);
    } catch (e) {
      stockThrew = e as Error;
    }

    let ours: { success: boolean; data?: unknown; error?: { issues: unknown[] } } | null = null;
    let oursThrew: Error | null = null;
    try {
      const r = compiled.safeParse(input);
      ours = r.success ? { success: true, data: r.data } : { success: false, error: r.error };
    } catch (e) {
      oursThrew = e as Error;
    }

    // Zero input distortion (regardless of success) — never mutate in place
    if (!assertDeepEqual(input, snapshot)) {
      failures.push(`INPUT MUTATED → ${caseId}`);
      continue;
    }

    if (stockThrew !== null || oursThrew !== null) {
      // A user callback threw: only require "both throw or neither throws"
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
            ? `\n      stock issues: ${JSON.stringify((stock as any).error?.issues?.slice(0, 3))}`
            : `\n      ours issues: ${JSON.stringify((ours!.error as any)?.issues?.slice(0, 3))}`),
      );
      continue;
    }

    // Never freeze the caller's input where stock does not (readonly freezes a copy for containers, #27)
    if (
      input !== null &&
      typeof input === "object" &&
      Object.isFrozen(input) !== Object.isFrozen(stockInput as object)
    ) {
      failures.push(
        `INPUT FROZENNESS MISMATCH stock=${Object.isFrozen(stockInput as object)} ours=${Object.isFrozen(input)} → ${caseId}`,
      );
      continue;
    }

    if (stock!.success) {
      bothOk++;
      const so = stock!.data;
      const oo = ours!.data;
      if (
        so !== null &&
        typeof so === "object" &&
        Object.isFrozen(so) !== Object.isFrozen(oo as object)
      ) {
        failures.push(
          `FROZENNESS MISMATCH stock=${Object.isFrozen(so)} ours=${Object.isFrozen(oo as object)} → ${caseId}`,
        );
        continue;
      }
      if (!assertDeepEqual(ours!.data, stock!.data)) {
        failures.push(
          `OUTPUT MISMATCH\n      stock: ${repr(stock!.data)}\n      ours:  ${repr(ours!.data)}\n      ${caseId}`,
        );
        continue;
      }
      refSharedSuccess++;
      if (ours!.data === input) refShared++;
    } else {
      bothFail++;
      const sv = issueView((stock as any).error.issues);
      const ov = issueView((ours!.error as any).issues);
      if (sv !== ov) {
        issueMismatches++;
        failures.push(`ISSUE MISMATCH\n      stock: ${sv}\n      ours:  ${ov}\n      ${caseId}`);
      }
    }
  }
}

console.log(
  `differential (${noCodegen ? "closure skeletons, --no-codegen" : "generated skeletons"}): ${total} cases | success=${bothOk} fail=${bothFail} | issue lists compared on every failing case (${issueMismatches} mismatches)`,
);
if (refSharedSuccess > 0) {
  console.log(
    `CoW top-level reference sharing: ${((refShared / refSharedSuccess) * 100).toFixed(1)}% ` +
      `(${refShared}/${refSharedSuccess} successful cases returned the original input reference)`,
  );
}
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES (first 5):`);
  for (const f of failures.slice(0, 5)) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("all cases agree with stock zod ✓");
}
