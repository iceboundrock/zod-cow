/**
 * Differential fuzz test (zc-z4: official codegen + CoW skeletons vs stock zod4).
 * Compares against stock zod4 on:
 *   1. success/failure parity  2. deepStrictEqual output  3. zero input distortion
 * Also reports top-level reference-sharing rate (CoW hit rate) and stock degradation rate.
 * Failures print seed/case for replay (REPRO=seed:case).
 */
import { deepEqual as assertDeepEqual } from "./harness.js";
import { z } from "zod";
import { compile } from "../src/index.js";

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

/**
 * Deep copy of a generated input for the mutation check. `structuredClone` drops symbol-keyed
 * properties, which the object generator emits (declared and extra symbol keys) and the harness
 * comparator does see. The generators only produce plain data: primitives, Date, Array, Map, Set and
 * plain objects with own enumerable keys.
 */
function snapshotInput(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(snapshotInput);
  if (v instanceof Map)
    return new Map([...v].map(([k, x]) => [snapshotInput(k), snapshotInput(x)]));
  if (v instanceof Set) return new Set([...v].map(snapshotInput));
  const out: Record<PropertyKey, unknown> = {};
  for (const k of Reflect.ownKeys(v))
    out[k] = snapshotInput((v as Record<PropertyKey, unknown>)[k]);
  return out;
}

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
  schema: z.ZodType;
  desc: string;
  /** The return value may be ABSENT (meaning the key does not appear) */
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
    // z4 encodes length constraints as regexes, and min > max throws while building the schema → keep max >= min
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

/** z4: default short-circuits and does not validate the default value — but still pick a valid one, to keep the generator behaving like z3.
 *  A sync safeParse on an async schema throws $ZodAsyncError → give up probing (and give up the default wrapper with it). */
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
      return inner; // async schema: sync probing is unavailable → give up the default wrapper
    }
    if (dv === undefined && absentOk) {
      return inner; // no valid default value: give up the default wrapper
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
    // Task 6: async refine (same success/failure domain as sync, but it goes through an async island)
    return {
      schema: inner.schema.refine(async (v: unknown) => v !== "forbidden", {
        error: "value is forbidden",
      }),
      desc: `${inner.desc}.refine(async ≠forbidden)`,
      gen: inner.gen,
    };
  }
  if (which === 6) {
    // Task 6: async transform (string → string, isomorphic to the sync transform)
    return {
      schema: inner.schema.transform(async (v: any) => (typeof v === "string" ? `${v}!` : v)),
      desc: `${inner.desc}.transform(async +!)`,
      gen: inner.gen,
    };
  }
  // transform: string → string (a pure string transform, so the differential stays alignable)
  return {
    schema: inner.schema.transform((v: any) => (typeof v === "string" ? `${v}!` : v)),
    desc: `${inner.desc}.transform(+!)`,
    gen: inner.gen,
  };
}

/** Declared symbol key shared by every object schema that rolls one; the extra own symbol the strip-mode input may carry */
const DECLARED_SYMBOL = Symbol("declared");
const EXTRA_SYMBOL = Symbol("extra");

function bObject(rng: RNG, depth: number): Built {
  // 1 to 3 random fields, as before. 1 in 20 shapes is padded with always-valid string keys to 17
  // to 20 string keys so it crosses the object skeleton's inline-comparison cap and takes the Set
  // fallback; 1 in 10 shapes declares a symbol key so the declared-symbol probe runs, and 1 in 40
  // of those keeps no string key at all (a symbol-only shape, whose strip probe treats every
  // string key as undeclared, #35).
  const symbolOnly = rng.chance(0.025);
  const nFields = symbolOnly ? 0 : 1 + rng.int(3);
  const fields: { key: string | symbol; built: Built }[] = [];
  for (let i = 0; i < nFields; i++) {
    fields.push({ key: `f${i}`, built: bChild(rng, depth) });
  }
  const large = rng.chance(0.05);
  if (large) {
    const padding = 17 - nFields + rng.int(4);
    for (let i = 0; i < padding; i++) {
      fields.push({
        key: `p${i}`,
        built: { schema: z.string(), desc: "string", gen: (r) => r.pick(["p", "q"] as const) },
      });
    }
  }
  const withSymbol = symbolOnly || rng.chance(0.1);
  if (withSymbol) fields.push({ key: DECLARED_SYMBOL, built: bLeaf(rng) });
  const modeRoll = rng.int(10);
  const shape: Record<string | symbol, z.ZodType> = {};
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
  const keyDesc = (f: { key: string | symbol; built: Built }) =>
    `${typeof f.key === "symbol" ? "[sym]" : f.key}: ${f.built.desc}`;
  const shown = large ? [...fields.slice(0, nFields), ...fields.slice(nFields + 1)] : fields;
  const desc = `object({${shown.map(keyDesc).join(", ")}${large ? `, …${fields.length - shown.length} more string keys` : ""}})${modeDesc}`;
  let extraSeq = 0;
  return {
    schema,
    desc,
    gen: (r) => {
      const out: Record<string | symbol, unknown> = {};
      for (const f of fields) {
        const v = f.built.gen(r);
        if (v !== ABSENT) out[f.key] = v;
      }
      if (r.chance(0.25)) out[`extra${extraSeq++}`] = r.pick([1, "x", null, true] as const); // extra key
      // Extra own symbol, strip mode only: strict does not probe own symbols and loose passes them
      // through by reference while stock's rebuild drops them (both listed under known limitations)
      if (modeRoll >= 2 && r.chance(0.1)) out[EXTRA_SYMBOL] = true;
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
  const nFixed = 2 + rng.int(2); // 2–3 required slots
  const items: Built[] = [];
  for (let i = 0; i < nFixed; i++) items.push(bChild(rng, depth));
  // Trailing optional slots (trigger the optoutStart truncation semantics)
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
        // rest is restricted to sync (a leaf + a nullable wrapper):
        // the stock zod4 runtime has a deterministic quirk when building output for an async rest slot —
        // run on nullable(asyncRefine) returns a Promise for any input, and the async write-back of a
        // rest slot produces a sparse array (e.g. ['a', hole, null], where the null value is dropped into a hole).
        // The skeleton emits a dense array (more correct) and does not fake-align with that behavior → the differential avoids async rest.
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
      // Sometimes trim the input short (triggers the trailing absent / defaulted slot-range semantics)
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

/* ─────────────────────────── differential main loop (z4) ─────────────────────────── */

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
    const useAsync = compiled.async; // async skeleton → both sides go through safeParseAsync

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

    const snapshot = snapshotInput(input);

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

/* ─────────────────────────── report ─────────────────────────── */

console.log(`zc-z4 differential test: ${total} cases (seeds=${SEEDS} × ${CASES_PER_SEED})`);
console.log(
  `  success-consistent: ${bothOk}   failure-consistent: ${bothFail}   top-level reference sharing: ${total ? ((refShared / total) * 100).toFixed(1) : "0"}% (${((refShared / Math.max(1, bothOk)) * 100).toFixed(1)}% among successful cases)`,
);
console.log(`  stock degradations (compile gave up): ${stockDowngraded}`);
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} differences (first 10):`);
  for (const f of failures.slice(0, 10)) console.log(`\n${f}`);
  process.exit(1);
} else {
  console.log("  all cases agree with stock zod4 ✓");
}
