/**
 * Differential fuzz test (zc-z4: official codegen + CoW skeletons vs stock zod4).
 * Compares against stock zod4 on:
 *   1. success/failure parity  2. deepStrictEqual output  3. zero input distortion
 * Also reports top-level reference-sharing rate (CoW hit rate) and stock degradation rate.
 * Failures print seed/case for replay (REPRO=seed:case).
 *
 * Two passes over the same seeds (#43):
 *   1. default options: the generator emits every input, extra own symbol keys included;
 *   2. `ownSymbolKeys: "ignore"`: the generator draws the same random numbers but never emits the
 *      extra own symbol (the one input the option is documented to treat differently from stock),
 *      so every case is the same schema and the same input minus that symbol; the pass also checks
 *      that no generated code carries the own-symbol probe, at any depth (`compiled.code` dumps the
 *      nested skeletons after the top-level one, #46). Its sharing rate is expected at or above the
 *      first pass (the inputs that carried the symbol are clean now).
 */
import assert from "node:assert/strict";
import { deepEqual as assertDeepEqual } from "./harness.js";
import { z } from "zod";
import { MAX_INLINE_KEY_COMPARISONS } from "../src/cow4/codectx.js";
import { compile, type CompileOptions } from "../src/index.js";

interface RNG {
  readonly draws: number;
  next(): number;
  chance(p: number): boolean;
  int(n: number): number;
  pick<T>(arr: readonly T[]): T;
}

function makeRng(seed: number): RNG {
  let s = seed >>> 0 || 1;
  let draws = 0;
  const next = () => {
    draws++;
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    get draws() {
      return draws;
    },
    next,
    chance: (p) => next() < p,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
  };
}

/* ─────────────────────────── data pool ─────────────────────────── */

const ABSENT = Symbol("absent");
const PROPERTY_EXTRA = "propertyExtra";
// Only these prototypes may be normalized on the CoW output's clean path (#99).
const generatedPrototypes = new WeakMap<object, symbol>();

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
 * Mutation view of generated data: descriptors include hidden/symbol keys and array holes.
 * Generated prototypes carry an identity token plus a snapshot of their own descriptors, so neither
 * replacing a prototype nor mutating it in place can disappear behind output normalization.
 */
function snapshotInput(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map)
    return new Map([...v].map(([k, x]) => [snapshotInput(k), snapshotInput(x)]));
  if (v instanceof Set) return new Set([...v].map(snapshotInput));
  const proto = Object.getPrototypeOf(v);
  return {
    prototype: generatedPrototypes.get(proto) ?? proto,
    inherited: generatedPrototypes.has(proto) ? snapshotInput(proto) : undefined,
    extensible: Object.isExtensible(v),
    descriptors: Reflect.ownKeys(v).map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      return [k, "value" in d ? { ...d, value: snapshotInput(d.value) } : d];
    }),
  };
}

/** Whether `v` is an object carrying the extra own symbol, enumerable or not */
function carriesExtraSymbol(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && Object.getOwnPropertySymbols(v).includes(EXTRA_SYMBOL)
  );
}

/**
 * Case description of a value. `JSON.stringify` drops symbol-keyed entries, which the object and
 * enum-record generators emit as declared keys (#61) and every generator as the extra symbol, so
 * own symbol and hidden keys and generated inherited keys are annotated, including inside containers.
 */
function repr(v: unknown): string {
  try {
    return (
      JSON.stringify(v, (_k, x) => {
        if (typeof x === "bigint") return `${x}n`;
        if (x instanceof Date) return Number.isNaN(x.getTime()) ? "Date(NaN)" : x.toISOString();
        if (typeof x === "symbol") return String(x);
        if (x === undefined) return "[undefined]";
        if (x instanceof Map) return { $map: [...x] };
        if (x instanceof Set) return { $set: [...x] };
        if (
          typeof x === "object" &&
          x !== null &&
          (Object.getPrototypeOf(x) === Object.prototype ||
            generatedPrototypes.has(Object.getPrototypeOf(x)))
        ) {
          const shown: Record<string, unknown> = { ...x };
          for (const key of Reflect.ownKeys(x)) {
            const d = Object.getOwnPropertyDescriptor(x, key)!;
            if (!d.enumerable) shown[`[hidden own ${String(key)}]`] = d.value;
            else if (typeof key === "symbol") shown[`[${String(key)}]`] = d.value;
          }
          const proto = Object.getPrototypeOf(x);
          if (generatedPrototypes.has(proto)) shown["[generated prototype]"] = proto;
          return shown;
        }
        return x;
      }) ?? String(v)
    );
  } catch {
    return String(v);
  }
}

/**
 * The output comparison sees Map and Set contents in iteration order: stock rebuilds both from
 * the parsed entries in input order, and the order is observable, so a Map or Set is compared as
 * the ordered list of its entries or members (the harness comparator, like Node's
 * `isDeepStrictEqual`, treats them as unordered and can also mismatch two Sets whose object
 * members are mutually deep-equal, such as two Dates of the same time) (#67).
 */
function orderedView(v: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return v;
  const hit = seen.get(v);
  if (hit !== undefined) return hit;
  if (v instanceof Map) {
    const out = { $map: [] as unknown[] };
    seen.set(v, out);
    for (const [k, x] of v) out.$map.push([orderedView(k, seen), orderedView(x, seen)]);
    return out;
  }
  if (v instanceof Set) {
    const out = { $set: [] as unknown[] };
    seen.set(v, out);
    for (const x of v) out.$set.push(orderedView(x, seen));
    return out;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length); // holes stay holes
    seen.set(v, out);
    for (const k of Object.keys(v)) (out as any)[k] = orderedView((v as any)[k], seen);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  const generated = generatedPrototypes.has(proto);
  if (proto !== Object.prototype && proto !== null && !generated) return v; // class instance: as it is
  const out = Object.create(generated ? Object.prototype : proto);
  seen.set(v, out);
  for (const k of Object.keys(v)) {
    Object.defineProperty(out, k, {
      value: orderedView((v as any)[k], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/* ─────────────────────────── schema generator ─────────────────────────── */

/** The colliding key / member transform of #67: `"a"` lands on `"b"`, so a later `"b"` entry must win and the order must hold */
const COLLIDE = (k: string): string => (k === "a" ? "b" : k);

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

/**
 * Number of entries the value carries: array length, Map / Set size, own enumerable string keys
 * of any other object, -1 for a primitive. Stock hands a refine the rebuilt output and the
 * skeleton hands it the input reference or its copy; both carry the same enumerable keys.
 */
function entryCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (typeof v === "object" && v !== null) return Object.keys(v).length;
  return -1;
}

/**
 * The predicate every refine wrapper attaches: it rejects the string "forbidden" and any container
 * with exactly three entries, so a refine that the skeleton dropped on a wrapper around a container
 * shows up as a success-parity failure (#56). Before #56 the container part was missing and a
 * dropped refine on `optional(object)` was invisible to the fuzzer.
 */
function wrapperRefine(v: unknown): boolean {
  return v !== "forbidden" && entryCount(v) !== 3;
}

/**
 * A check attached to the wrapper (or leaf) `inner` rather than a schema layer: a sync or async
 * `.refine` with the predicate above, or an overwrite that upper-cases a string value and hands
 * anything else back unchanged (#57). Shared by `bWrap` and the second-wrapper draw of `bChild`.
 */
function bCheck(inner: Built, kind: "refine" | "asyncRefine" | "overwrite"): Built {
  if (kind === "refine") {
    return {
      schema: inner.schema.refine(wrapperRefine, { error: "value is forbidden" }),
      desc: `${inner.desc}.refine(≠forbidden, entries≠3)`,
      gen: inner.gen,
    };
  }
  if (kind === "asyncRefine") {
    // Task 6: async refine (same success/failure domain as sync, but it goes through an async island)
    return {
      schema: inner.schema.refine(async (v: unknown) => wrapperRefine(v), {
        error: "value is forbidden",
      }),
      desc: `${inner.desc}.refine(async ≠forbidden, entries≠3)`,
      gen: inner.gen,
    };
  }
  return {
    schema: inner.schema.overwrite((v: any) => (typeof v === "string" ? v.toUpperCase() : v)),
    desc: `${inner.desc}.overwrite(upper)`,
    gen: inner.gen,
  };
}

/**
 * A non-callback check attached to an optional / nullable layer through `.check()` (#69): a length / size /
 * range rule picked by the kind of the inner schema (unwrapped of its own optional / nullable layers), so the
 * rule reads a property the value has. Stock's compiler answers such a wrapper differently from its runtime on
 * the shortcut value (`undefined` / `null`: a length / size check throws, a range check passes where the
 * runtime fails), which the wrapper generators below hit on every shortcut draw. zod's typings reject the
 * shape (`HasLength` admits no undefined / null), so the schema is cast; the runtime accepts it. The one
 * generator per kind keeps the check attached to the wrapper, never to the inner leaf.
 */
function bWrapperCheck(rng: RNG, wrapped: z.ZodType, desc: string): [z.ZodType, string] | null {
  let cur: any = wrapped;
  while (cur._zod.def.type === "optional" || cur._zod.def.type === "nullable") {
    cur = cur._zod.def.innerType;
  }
  const t: string = cur._zod.def.type;
  const n = rng.int(3);
  const attach = (check: unknown, label: string): [z.ZodType, string] => [
    (wrapped as any).check(check) as z.ZodType,
    `${desc}.check(${label})`,
  ];
  if (t === "string" || t === "array" || t === "tuple" || t === "object" || t === "record") {
    return rng.chance(0.5)
      ? attach(z.minLength(n), `minLength(${n})`)
      : attach(z.maxLength(n + 1), `maxLength(${n + 1})`);
  }
  if (t === "set" || t === "map") {
    return rng.chance(0.5)
      ? attach(z.minSize(n), `minSize(${n})`)
      : attach(z.maxSize(n + 1), `maxSize(${n + 1})`);
  }
  if (t === "number") {
    return rng.chance(0.5) ? attach(z.gt(n), `gt(${n})`) : attach(z.lt(n + 1), `lt(${n + 1})`);
  }
  return null;
}

function bWrap(rng: RNG, inner: Built): Built {
  const which = rng.int(8);
  if (which === 7) return bCheck(inner, "overwrite");
  if (which === 3) return bCheck(inner, "refine");
  if (which === 5) return bCheck(inner, "asyncRefine");
  if (which === 0) {
    // One optional layer in four carries a length / size / range check (#69); the draw is made before
    // the check so the RNG stream stays the same whether or not the inner kind admits one
    const withCheck = rng.chance(0.25);
    const checked = withCheck
      ? bWrapperCheck(rng, inner.schema.optional(), `${inner.desc}.optional()`)
      : null;
    return {
      schema: checked ? checked[0] : inner.schema.optional(),
      desc: checked ? checked[1] : `${inner.desc}.optional()`,
      gen: (r) => (r.chance(0.3) ? ABSENT : r.chance(0.25) ? undefined : inner.gen(r)),
    };
  }
  if (which === 1) {
    const withCheck = rng.chance(0.25);
    const checked = withCheck
      ? bWrapperCheck(rng, inner.schema.nullable(), `${inner.desc}.nullable()`)
      : null;
    return {
      schema: checked ? checked[0] : inner.schema.nullable(),
      desc: checked ? checked[1] : `${inner.desc}.nullable()`,
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
  if (which === 6) {
    // Task 6 / #70: async transform (string → string, isomorphic to the sync transform) whose
    // promise settles after 0 to 2 extra microtask hops decided by the value (`asyncBang`), so
    // sibling entries of a set, map or record settle out of iteration order and stock's
    // settlement-order writes are exercised
    return {
      schema: inner.schema.transform(asyncBang),
      desc: `${inner.desc}.transform(async +!, hops by value)`,
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

/** Declared symbol key shared by every object schema that rolls one; the extra own symbol an input of any mode may carry */
const DECLARED_SYMBOL = Symbol("declared");
const EXTRA_SYMBOL = Symbol("extra");
/** Pass switch: the "ignore" pass keeps the RNG stream and drops only the emission of EXTRA_SYMBOL */
let emitExtraSymbol = true;

/**
 * Extra own symbol on a record input (#51), enumerable or not, one in ten; the object generator
 * emits the enumerable form itself. Draws the same random numbers whether or not the pass emits it.
 * On an enum-keyed record stock drops either form on every path (its `for...in` never sees a
 * symbol); on a string-keyed record stock rejects the enumerable form as a key and drops the
 * non-enumerable one, which the comparator does not see (it compares enumerable keys only), so
 * the runner checks the presence of this symbol on the top-level output separately.
 */
function maybeExtraSymbol(out: object, r: RNG): void {
  const emit = r.chance(0.1);
  const hidden = r.chance(0.5);
  if (!emit || !emitExtraSymbol) return;
  if (hidden) Object.defineProperty(out, EXTRA_SYMBOL, { value: true, enumerable: false });
  else (out as Record<symbol, unknown>)[EXTRA_SYMBOL] = true;
}

/**
 * One dimension of an aimed configuration: the aimed value three times in four, so the aim comes up
 * in about a third of the draws while every other combination still occurs (review of #99, F1–F3).
 */
const aimed = (r: RNG, toward: boolean): boolean => (toward ? r.chance(0.75) : r.chance(0.25));

/**
 * The reserved undeclared key on a generated input, own or inherited. `aimLoose` is `null` on an
 * object whose schema carries no undeclared property check: the key is then non-enumerable, the form
 * that is invisible to stock and costs no clean path (#48). On a checked object the two dimensions
 * follow the aim, because the two reads of such a key are observable in opposite configurations
 * (`observableClass`): the loose scan reads an enumerated key and is only observable when its value
 * is not a string, the clean path's prototype read only when stock's `for...in` does not yield the
 * key and its value is a string. Before #99's review the key was only ever defined non-enumerably,
 * so the loose scan never ran at all (F2).
 */
function defineReserved(target: object, r: RNG, aimLoose: boolean | null): void {
  const string = aimLoose === null ? r.chance(0.5) : aimed(r, !aimLoose);
  Object.defineProperty(target, PROPERTY_EXTRA, {
    value: string ? r.pick(STRINGS) : r.pick(NON_STRINGS),
    enumerable: aimLoose !== null && aimed(r, aimLoose),
    writable: true,
    configurable: true,
  });
}

/**
 * One generated input object whose schema carries the undeclared property check, read off the object
 * itself rather than matched in the replay string (review of #99, F4). `enumerated` is stock's own
 * probe (`for...in`, so an inherited key counts and a non-enumerable own key shadows one);
 * `extraEnumerated` and `extraSymbol` mark the two decorations that take the skeleton off the clean
 * path, where the reads below happen — another undeclared enumerable key in strip mode (strict
 * rejects it on both sides), and the extra own symbol this pass emits, in every mode (#42).
 */
interface PropertyCase {
  mode: "strip" | "strict" | "loose";
  optional: boolean;
  present: boolean;
  enumerated: boolean;
  stringValue: boolean;
  extraEnumerated: boolean;
  extraSymbol: boolean;
}
const propertyCases: PropertyCase[] = [];

/**
 * The two configurations in which a wrong read of the undeclared key is observable at all. `safeParse`
 * retries stock on `INVALID` (`packages/zod-cow-v4/src/index.ts`), so a compiled false rejection is
 * repaired before the comparison runs and only "compiled accepts what stock rejects" can be seen:
 *
 *   protoRead   a required check in strip / strict mode over a key stock's `for...in` does not yield,
 *               whose value is a string, on an object the skeleton can still return by reference —
 *               stock's assembly leaves the key out, so its check fails, while reading the input
 *               instead of the prototype of a fresh object passes (review of #98);
 *   looseScan   an optional check in loose mode over an enumerated key whose value is not a string —
 *               stock's assembly appends the key, so its check fails, while a skeleton that dropped
 *               loose's enumerated read sees `undefined` and passes.
 */
function observableClass(c: PropertyCase): "protoRead" | "looseScan" | null {
  if (c.extraSymbol) return null;
  if (
    !c.optional &&
    c.mode !== "loose" &&
    c.present &&
    !c.enumerated &&
    !c.extraEnumerated &&
    c.stringValue
  )
    return "protoRead";
  if (c.mode === "loose" && c.optional && c.enumerated && !c.stringValue) return "looseScan";
  return null;
}
/**
 * True while the case's input is being generated. `validValueFor`'s default probing runs the same
 * generators for values that are stored on a schema and never parsed as an input, so both the
 * property-case record and the prototype registry below take only what the case input holds.
 */
let generatingCaseInput = false;
/** Prototypes the current case's input carries, for the copy-path check of `generatedPrototypeEscaped` */
const inputPrototypes = new Set<object>();

function recordPropertyCase(
  out: object,
  mode: "strip" | "strict" | "loose",
  optional: boolean,
  declared: Set<string | symbol>,
): void {
  if (!generatingCaseInput) return;
  const proto = Object.getPrototypeOf(out);
  const present =
    Object.getOwnPropertyDescriptor(out, PROPERTY_EXTRA) !== undefined ||
    (generatedPrototypes.has(proto) &&
      Object.getOwnPropertyDescriptor(proto, PROPERTY_EXTRA) !== undefined);
  let enumerated = false;
  let extraEnumerated = false;
  for (const k in out) {
    if (k === PROPERTY_EXTRA) enumerated = true;
    else if (!declared.has(k)) extraEnumerated = true;
  }
  propertyCases.push({
    mode,
    optional,
    present,
    enumerated,
    stringValue: typeof (out as Record<string, unknown>)[PROPERTY_EXTRA] === "string",
    extraEnumerated,
    extraSymbol: carriesExtraSymbol(out),
  });
}

function bObject(rng: RNG, depth: number): Built {
  // 1 to 3 random fields, as before. 1 in 20 shapes is padded with always-valid string keys to one
  // to four keys above the object skeleton's inline-comparison cap (`MAX_INLINE_KEY_COMPARISONS`,
  // 17 to 20 keys at the cap of #33, 33 to 36 since #34) so it takes the Set fallback; 1 in 10
  // shapes declares a symbol key so the declared-symbol probe runs, and 1 in 40
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
    const padding = MAX_INLINE_KEY_COMPARISONS + 1 - nFields + rng.int(4);
    for (let i = 0; i < padding; i++) {
      fields.push({
        key: `p${i}`,
        built: { schema: z.string(), desc: "string", gen: (r) => r.pick(["p", "q"] as const) },
      });
    }
  }
  const withSymbol = symbolOnly || rng.chance(0.1);
  if (withSymbol) fields.push({ key: DECLARED_SYMBOL, built: bLeaf(rng) });
  // One object in five carries a `z.property` check and half of those name the reserved undeclared
  // key; the declared-key branch keeps the other half, at four times the rate it ran at before #99.
  // An undeclared draw is aimed at one of the two observable configurations (`observableClass`),
  // which is why it is made before the mode: the loose scan's aim wants loose mode, an optional
  // check and an enumerated non-string key, the prototype read's aim wants strip or strict mode, a
  // required check and a hidden string key, and each of those four dimensions is perturbed one time
  // in four. Left to the background rates — one in forty, the 8/1/1 mode distribution, an
  // independent key form — each configuration came up about once per pass and neither mutant of the
  // two reads was caught at 20 000 or 50 000 cases (review of #99, F1/F2/F3/F6).
  const propertyDraw = !symbolOnly && rng.chance(0.2);
  const undeclaredDraw = propertyDraw && rng.chance(0.5);
  const aimLoose = undeclaredDraw ? rng.chance(0.5) : null;
  const modeRoll = rng.int(10);
  const mode =
    aimLoose !== null
      ? aimed(rng, aimLoose)
        ? "loose"
        : rng.chance(0.5)
          ? "strict"
          : "strip"
      : modeRoll < 1
        ? "strict"
        : modeRoll < 2
          ? "loose"
          : "strip";
  const shape: Record<string | symbol, z.ZodType> = {};
  for (const f of fields) shape[f.key] = f.built.schema;
  let schema: z.ZodType =
    mode === "strict"
      ? z.strictObject(shape)
      : mode === "loose"
        ? z.looseObject(shape)
        : z.object(shape);
  const modeDesc = mode === "strict" ? ".strict()" : mode === "loose" ? ".passthrough()" : "";
  const keyDesc = (f: { key: string | symbol; built: Built }) =>
    `${typeof f.key === "symbol" ? "[sym]" : f.key}: ${f.built.desc}`;
  const shown = large ? [...fields.slice(0, nFields), ...fields.slice(nFields + 1)] : fields;
  let desc = `object({${shown.map(keyDesc).join(", ")}${large ? `, …${fields.length - shown.length} more string keys` : ""}})${modeDesc}`;
  // The declared-key branch keeps the first-field optional string wrapper with a length check (#69
  // inside a schema-bearing check, review of #84): stock's compiler compiles the carried schema inline,
  // so the subtree walks must descend into it. Since #85 the object keeps its skeleton and runs the
  // carried schema's verdict-only product on the held value of the key (an island here, since the
  // wrapper follows the runtime); a first field that is not a string fails `invalid_type` on both
  // sides. The undeclared branch names a key no shape declares, so the value the check sees is the one
  // the clean path holds for an undeclared key (review of #98). Both draws come after every other draw
  // of the shape; like any added draw they shift the RNG stream from here on.
  let undeclaredOptional = false;
  if (propertyDraw) {
    if (aimLoose !== null) {
      undeclaredOptional = aimed(rng, aimLoose);
      schema = (schema as any).check(
        z.property(PROPERTY_EXTRA, undeclaredOptional ? z.string().optional() : z.string()),
      );
      desc += `.check(property(${PROPERTY_EXTRA}, string${undeclaredOptional ? ".optional()" : ""}))`;
    } else {
      const carried = bWrapperCheck(rng, z.string().optional(), "string.optional()");
      if (carried) {
        schema = (schema as any).check(z.property("f0", carried[0] as any)) as z.ZodType;
        desc = `${desc}.check(property(f0, ${carried[1]}))`;
      }
    }
  }
  let extraSeq = 0;
  const declaredKeys = new Set<string | symbol>(fields.map((f) => f.key));
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
      // The reserved key, inherited and own, independent of mode and symbol policy (an own key may
      // shadow an inherited one). An object whose schema carries the undeclared property check is
      // decorated far more often, since neither read of that key is observable while the key is
      // absent; every other object keeps the background rate and the non-enumerable form, which is
      // invisible to stock and costs no clean path (#48).
      if (r.chance(undeclaredDraw ? 0.5 : 0.1)) {
        const proto = {};
        defineReserved(proto, r, aimLoose);
        generatedPrototypes.set(proto, Symbol("generated prototype"));
        if (generatingCaseInput) inputPrototypes.add(proto);
        Object.setPrototypeOf(out, proto);
      }
      if (r.chance(undeclaredDraw ? 0.8 : 0.25)) defineReserved(out, r, aimLoose);
      // Extra own symbol, in every mode: stock's rebuild drops it and the skeleton probes for it
      // before returning the input by reference (strip since #33, strict and loose since #42), so
      // the default pass expects stock's output; the "ignore" pass never emits it
      if (r.chance(0.1) && emitExtraSymbol) out[EXTRA_SYMBOL] = true;
      if (undeclaredDraw) recordPropertyCase(out, mode, undeclaredOptional, declaredKeys);
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
      // Sparse inputs (#67): a trailing hole, or an inner one; stock owns every index of its output
      if (r.chance(0.1)) out.length = out.length + 1;
      if (out.length > 1 && r.chance(0.1)) delete out[r.int(out.length)];
      return out;
    },
  };
}

/**
 * Declaration-driven records (#37): string or numeric enum keys, strict or loose, 2 to 3 declared
 * keys or two above the inline key-comparison cap (`MAX_INLINE_KEY_COMPARISONS`, so the probe is
 * the hoisted Set). Inputs drop a
 * declared key now and then (stock materializes it, or rejects it when the value is required) and
 * sometimes carry an undeclared key, which strict rejects and loose keeps. One in five declares the
 * shared symbol next to the string or numeric keys, as a symbol value of the enum's entries form
 * (`z.enum({ K0: "k0", S: sym })`), and one in forty declares nothing but that symbol through
 * `z.literal(sym)` (#61): a declared symbol turns the own-symbol probe into its hoisted-`Set` form
 * (`emitOwnSymbolProbe`), which the string-only generator never reached. The input carries the
 * declared symbol as an enumerable data property, like every other declared key: a declared key the
 * input defines as non-enumerable comes back as it is on the clean path (#48, pinned by smoke group
 * 16), so the generator never defines one that way.
 */
function bEnumRecord(rng: RNG, inner: Built): Built {
  const numeric = rng.chance(0.5);
  const symbolOnly = rng.chance(0.025);
  const withSymbol = symbolOnly || rng.chance(0.2);
  const n = symbolOnly ? 0 : rng.chance(0.15) ? MAX_INLINE_KEY_COMPARISONS + 2 : 2 + rng.int(2);
  const values: (string | number | symbol)[] = Array.from({ length: n }, (_, i) =>
    numeric ? i + 1 : `k${i}`,
  );
  if (withSymbol) values.push(DECLARED_SYMBOL);
  const keySchema = symbolOnly
    ? z.literal(DECLARED_SYMBOL as never)
    : z.enum(
        Object.fromEntries(
          values.map((v) => [typeof v === "symbol" ? "S" : `K${String(v)}`, v]),
        ) as Record<string, string>,
      );
  const loose = rng.chance(0.3);
  const schema = loose
    ? z.looseRecord(keySchema as any, inner.schema)
    : z.record(keySchema as any, inner.schema);
  const keyDesc = symbolOnly
    ? "literal[sym]"
    : `enum[${numeric ? "number" : "string"} x${n}${withSymbol ? " + sym" : ""}]`;
  return {
    schema,
    desc: `${loose ? "looseRecord" : "record"}(${keyDesc}, ${inner.desc})`,
    gen: (r) => {
      const out: Record<string | symbol, unknown> = {};
      for (const v of values) {
        if (r.chance(0.1)) continue;
        const x = inner.gen(r);
        if (x !== ABSENT) out[typeof v === "symbol" ? v : String(v)] = x;
      }
      if (r.chance(0.2)) out[numeric && r.chance(0.5) ? "99" : "extra"] = r.chance(0.5) ? 1 : "e";
      maybeExtraSymbol(out, r);
      maybeOwnProto(out, r);
      return out;
    },
  };
}

/**
 * An own "__proto__" data property, as JSON.parse produces (#67), one in ten: stock's assembly
 * skips that key on every path, so a clean input carrying it must still be copied
 */
function maybeOwnProto(out: object, r: RNG): void {
  if (!r.chance(0.1)) return;
  Object.defineProperty(out, "__proto__", {
    value: 1,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function bRecord(rng: RNG, depth: number): Built {
  // Colliding key transform (#67): keys drawn from a pool where "a" lands on a later "b"
  const colliding = rng.chance(0.15);
  const inner = colliding ? bCollidingValue(rng) : bChild(rng, depth);
  if (!colliding && rng.chance(0.3)) return bEnumRecord(rng, inner);
  const numericKeys = !colliding && rng.chance(0.15);
  const keySchema: z.ZodType = colliding
    ? z.string().transform(COLLIDE)
    : numericKeys
      ? z.number()
      : z.string();
  const keyDesc = colliding ? "string.transform(a→b)" : numericKeys ? "number" : "string";
  return {
    schema: z.record(keySchema as any, inner.schema),
    desc: `record(${keyDesc}, ${inner.desc})`,
    gen: (r) => {
      const out: Record<string, unknown> = {};
      const keys = ["a", "b", "c", "d"];
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) out[numericKeys ? String(r.int(4)) : keys[i]!] = v;
      }
      maybeExtraSymbol(out, r);
      maybeOwnProto(out, r);
      return out;
    },
  };
}

/**
 * The async string transform: settles after 0 to 2 extra microtask hops decided by the value (the
 * character codes of a string, the magnitude of a number), so two sibling entries usually settle in
 * a different order than they were started (#70)
 */
async function asyncBang(v: unknown): Promise<unknown> {
  let hops = 0;
  if (typeof v === "string") for (let c = 0; c < v.length; c++) hops += v.charCodeAt(c);
  else if (typeof v === "number" && Number.isFinite(v)) hops = Math.abs(Math.trunc(v));
  for (let h = 0; h < hops % 3; h++) await null;
  return typeof v === "string" ? `${v}!` : v;
}

/**
 * A leaf value for the colliding variants: sync, nullable, a sync transform or an async transform.
 * Stock's runtime writes a sync value inside its loop and an async one when its promise settles, so
 * with a key collision an earlier async pair overwrites a later sync one; the skeletons follow the
 * same schedule since #70, so the colliding key variants exercise async values too
 */
function bCollidingValue(rng: RNG): Built {
  const leaf = bLeaf(rng);
  const which = rng.int(4);
  if (which === 3) {
    return {
      schema: leaf.schema.transform(asyncBang),
      desc: `${leaf.desc}.transform(async +!, hops by value)`,
      gen: leaf.gen,
    };
  }
  if (which === 0) {
    return {
      schema: leaf.schema.nullable(),
      desc: `${leaf.desc}.nullable()`,
      gen: (r) => (r.chance(0.2) ? null : leaf.gen(r)),
    };
  }
  if (which === 1) {
    return {
      schema: leaf.schema.transform((v: any) => (typeof v === "string" ? `${v}!` : v)),
      desc: `${leaf.desc}.transform(+!)`,
      gen: leaf.gen,
    };
  }
  return leaf;
}

/** A key transform that collides with a later key (`"a"` → `"b"`), so the copy must keep stock's order and let the later entry win (#67) */
function bCollidingMap(rng: RNG, inner: Built): Built {
  let schema = z.map(z.string().transform(COLLIDE), inner.schema);
  let desc = `map(string.transform(a→b), ${inner.desc})`;
  if (rng.chance(0.2)) {
    schema = schema.min(1);
    desc += ".min(1)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      const m = new Map<string, unknown>();
      const n = 1 + r.int(3);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) m.set(r.pick(["a", "b", "c"] as const), v);
      }
      return m;
    },
  };
}

function bMap(rng: RNG, depth: number): Built {
  if (rng.chance(0.15)) return bCollidingMap(rng, bCollidingValue(rng));
  const inner = bChild(rng, depth);
  const key = rng.chance(0.8) ? z.string() : z.number();
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

/** A member transform that lands on a later member (`"a"` → `"b"`), so the copy must keep stock's order and let the later member win (#67) */
function bCollidingSet(rng: RNG): Built {
  let schema = z.set(z.string().transform(COLLIDE));
  let desc = "set(string.transform(a→b))";
  if (rng.chance(0.3)) {
    schema = schema.min(1);
    desc += ".min(1)";
  }
  return {
    schema,
    desc,
    gen: (r) => {
      const st = new Set<string>();
      const n = 1 + r.int(3);
      for (let i = 0; i < n; i++) st.add(r.pick(["a", "b", "c"] as const));
      return st;
    },
  };
}

function bSet(rng: RNG, depth: number): Built {
  if (rng.chance(0.15)) return bCollidingSet(rng);
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
      // A hole in a fixed slot (#67): read as undefined, written as an own slot by stock
      if (out.length > 0 && r.chance(0.1)) delete out[r.int(out.length)];
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

/**
 * Unions (#47): 2 to 3 options drawn from the ordinary child generator, so object branches (with
 * their extra keys and extra own symbols), arrays of objects, wrapped and async options all occur
 * next to leaves; 1 in 4 is a discriminated union of two object branches on a literal `kind` key.
 * The input follows one option at random, so extra keys reach a strip-object branch; the
 * discriminated variant now and then carries an extra key, the extra own symbol or an unknown tag.
 */
function bUnion(rng: RNG, depth: number): Built {
  if (rng.chance(0.25)) {
    const branches = (["a", "b"] as const).map((kind) => ({ kind, built: bChild(rng, depth) }));
    const schema = z.discriminatedUnion(
      "kind",
      branches.map((b) => z.object({ kind: z.literal(b.kind), v: b.built.schema })) as never,
    );
    const desc = `discriminatedUnion(kind, [${branches
      .map((b) => `{kind: ${b.kind}, v: ${b.built.desc}}`)
      .join(", ")}])`;
    return {
      schema,
      desc,
      gen: (r) => {
        const b = r.pick(branches);
        const out: Record<string | symbol, unknown> = { kind: r.chance(0.05) ? "c" : b.kind };
        const v = b.built.gen(r);
        if (v !== ABSENT) out.v = v;
        if (r.chance(0.25)) out.extra = r.pick([1, "x", null] as const);
        if (r.chance(0.1) && emitExtraSymbol) out[EXTRA_SYMBOL] = true;
        return out;
      },
    };
  }
  const n = 2 + rng.int(2);
  const options: Built[] = [];
  for (let i = 0; i < n; i++) options.push(bChild(rng, depth));
  // A plain union whose options mix an object with a set, map or date is a documented divergence
  // (README, known limitations, review of #70): a Set, Map or Date the object option accepts comes
  // back by reference where stock rebuilds a plain object. Such an option is replaced by a string
  // leaf; the draw happens only for the mix, so the RNG stream is untouched elsewhere.
  if (options.some((o) => acceptsInstances(o.schema))) {
    for (let i = 0; i < options.length; i++) {
      if (feedsInstances(options[i]!.schema)) options[i] = bString(rng);
    }
  }
  return {
    schema: z.union(options.map((o) => o.schema) as never),
    desc: `union([${options.map((o) => o.desc).join(", ")}])`,
    gen: (r) => r.pick(options).gen(r),
  };
}

/** The schemas a wrapper, pipe or union layer holds directly (the layers `bWrap` and `bUnion` stack) */
function layerInner(s: z.ZodType): z.ZodType[] {
  const def: any = (s as any)._zod.def;
  if (def.innerType) return [def.innerType];
  if (def.type === "pipe") return [def.in];
  if (def.type === "union") return def.options;
  return [];
}

/** Whether the generator feeds the schema Set, Map or Date instances: a set, map or date under the layers above */
function feedsInstances(s: z.ZodType): boolean {
  const t: string = (s as any)._zod.def.type;
  if (t === "set" || t === "map" || t === "date") return true;
  return layerInner(s).some(feedsInstances);
}

/** Whether the schema accepts a class instance as a plain object: an object under the layers above (a record rejects it) */
function acceptsInstances(s: z.ZodType): boolean {
  if ((s as any)._zod.def.type === "object") return true;
  return layerInner(s).some(acceptsInstances);
}

function bChild(rng: RNG, depth: number): Built {
  const inner = depth <= 0 ? bLeaf(rng) : bAny(rng, depth - 1);
  if (!rng.chance(0.4)) return inner;
  const wrapped = bWrap(rng, inner);
  // One wrapped child in three gets a check on top of its wrapper (a sync or async refine, an
  // overwrite), so a check on an optional / nullable layer above a container occurs
  // (`optional(object).refine(...)`, #56); a single wrapper never put one there.
  if (!rng.chance(0.33)) return wrapped;
  return bCheck(wrapped, rng.pick(["refine", "asyncRefine", "overwrite"] as const));
}

function bAny(rng: RNG, depth: number): Built {
  const roll = rng.next();
  if (depth <= 0) return bLeaf(rng);
  if (roll < 0.34) return bLeaf(rng);
  if (roll < 0.5) return bObject(rng, depth);
  if (roll < 0.6) return bArray(rng, depth);
  if (roll < 0.7) return bTuple(rng, depth);
  if (roll < 0.78) return bRecord(rng, depth);
  if (roll < 0.84) return bMap(rng, depth);
  if (roll < 0.89) return bSet(rng, depth);
  if (roll < 0.95) return bUnion(rng, depth);
  return bWrap(rng, bLeaf(rng));
}

/**
 * Every object the compiled output exposes that carries a prototype of the case's input must be an
 * object of that input, returned by reference: `orderedView` normalizes a generated prototype away
 * before the comparison (stock assembles a plain object where the CoW clean path returns the input),
 * so a copy that ever assembled with `Object.create(Object.getPrototypeOf(input))` would be invisible
 * to the comparator. The object skeleton's copy is an object literal today, so this cannot happen;
 * the check pins it (review of #99, F5). Only the input's prototypes are considered: a schema's
 * default value is generated the same way and legitimately reaches the output without being in the
 * input at all.
 */
function collectObjects(v: unknown, into: Set<object>, seen = new Set<object>()): void {
  if (typeof v !== "object" || v === null) return;
  if (seen.has(v)) return;
  seen.add(v);
  into.add(v);
  if (v instanceof Map) {
    for (const [k, x] of v) {
      collectObjects(k, into, seen);
      collectObjects(x, into, seen);
    }
    return;
  }
  if (v instanceof Set) {
    for (const x of v) collectObjects(x, into, seen);
    return;
  }
  if (v instanceof Date) return;
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if ("value" in d) collectObjects(d.value, into, seen);
  }
}

function generatedPrototypeEscaped(output: unknown, input: unknown): boolean {
  if (inputPrototypes.size === 0) return false;
  const inputObjects = new Set<object>();
  collectObjects(input, inputObjects);
  const outputObjects = new Set<object>();
  collectObjects(output, outputObjects);
  for (const o of outputObjects) {
    if (inputPrototypes.has(Object.getPrototypeOf(o)) && !inputObjects.has(o)) return true;
  }
  return false;
}

/* ─────────────────────────── differential main loop (z4) ─────────────────────────── */

// Pin the oracle itself: output normalization must not weaken the mutation check or hide class instances.
function checkInputViews(): void {
  const proto = Object.defineProperty({}, PROPERTY_EXTRA, {
    value: "inherited",
    configurable: true,
  });
  generatedPrototypes.set(proto, Symbol("generated prototype"));
  const input = Object.create(proto, {
    f0: { value: "x", enumerable: true },
    [PROPERTY_EXTRA]: { value: undefined, writable: true, configurable: true },
  });
  const nested = [new Map([["x", new Set([input])]])];
  assert(
    assertDeepEqual(orderedView(nested), orderedView([new Map([["x", new Set([{ f0: "x" }])]])])),
  );
  const before = snapshotInput(nested);
  assert(assertDeepEqual(snapshotInput(nested), before));
  input[PROPERTY_EXTRA] = 1;
  assert(!assertDeepEqual(snapshotInput(nested), before));
  input[PROPERTY_EXTRA] = undefined;
  Object.defineProperty(input, PROPERTY_EXTRA, { enumerable: true });
  assert(!assertDeepEqual(snapshotInput(nested), before));
  Object.defineProperty(input, PROPERTY_EXTRA, { enumerable: false });
  Object.defineProperty(proto, PROPERTY_EXTRA, { value: "changed" });
  assert(!assertDeepEqual(snapshotInput(nested), before));
  Object.defineProperty(proto, PROPERTY_EXTRA, { value: "inherited" });
  const replacement = Object.create(Object.prototype, Object.getOwnPropertyDescriptors(proto));
  generatedPrototypes.set(replacement, Symbol("generated prototype"));
  Object.setPrototypeOf(input, replacement);
  assert(!assertDeepEqual(snapshotInput(nested), before));
  Object.setPrototypeOf(input, proto);
  assert(assertDeepEqual(snapshotInput(nested), before));
  assert(repr(nested).includes("[hidden own propertyExtra]"));
  assert(repr(nested).includes("[generated prototype]"));
  assert(repr(nested).includes("inherited"));
  class Other {
    f0 = "x";
  }
  assert(!assertDeepEqual(orderedView(new Other()), orderedView({ f0: "x" })));
  assert(!assertDeepEqual(snapshotInput([undefined]), snapshotInput(new Array(1))));
  assert(
    !assertDeepEqual(
      orderedView(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
      orderedView(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ),
  );
  console.log(
    "Input-view helper checks passed (hidden values/descriptors, prototype state/identity, replay, class and order guards)",
  );
  // Independent seeds exercise the actual generator, without changing either differential stream.
  // Deterministic, so it cannot flake, and it stops as soon as everything is covered: the 30
  // combinations and 20 objects of each observable class are reached in 224 of the
  // 20 000-seed budget (the run prints the count it used), so a later generator change that shifts the stream has that much slack
  // before this guard needs re-tuning (review of #99, F8).
  const covered = new Set<string>();
  const observed = { protoRead: 0, looseScan: 0 };
  let seedsUsed = 0;
  generatingCaseInput = true;
  for (
    let seed = 1;
    seed <= 20_000 && (covered.size < 30 || observed.protoRead < 20 || observed.looseScan < 20);
    seed++
  ) {
    seedsUsed = seed;
    const rng = makeRng(seed);
    const built = bObject(rng, 0);
    if (!built.desc.includes(`property(${PROPERTY_EXTRA},`)) continue;
    const def = (built.schema as z.ZodObject)._zod.def;
    assert(!Object.hasOwn(def.shape, PROPERTY_EXTRA));
    const mode = def.catchall?._zod.def.type ?? "strip";
    covered.add(`${mode}:${built.desc.endsWith("string.optional()))") ? "optional" : "required"}`);
    for (let i = 0; i < 20; i++) {
      propertyCases.length = 0;
      const input = built.gen(rng) as object;
      for (const [kind, target] of [
        ["own", input],
        ["inherited", Object.getPrototypeOf(input)],
      ] as const) {
        const d = Object.getOwnPropertyDescriptor(target, PROPERTY_EXTRA);
        if (!d) continue;
        covered.add(
          `${mode}:${kind}:${typeof d.value === "string" ? "string" : "non-string"}:${d.enumerable ? "enumerable" : "hidden"}`,
        );
      }
      for (const c of propertyCases) {
        const observable = observableClass(c);
        if (observable) observed[observable]++;
      }
    }
  }
  generatingCaseInput = false;
  propertyCases.length = 0;
  inputPrototypes.clear();
  assert.equal(
    covered.size,
    30,
    "every object mode must draw both checks and every own/inherited value-kind/enumerability form",
  );
  assert(
    observed.protoRead >= 20 && observed.looseScan >= 20,
    `the generator must keep reaching both configurations in which a wrong undeclared-key read is observable (${JSON.stringify(observed)})`,
  );
  console.log(
    `Generator coverage checks passed in ${seedsUsed} seeds (3 modes x required/optional checks x own/inherited enumerable/hidden string/non-string keys, and both observable classes)`,
  );
}
checkInputViews();

const SEEDS = Number(process.env.SEEDS ?? 200);
const CASES_PER_SEED = Number(process.env.CASES ?? 100);
const REPRO = process.env.REPRO ?? null;

interface PassStats {
  label: string;
  total: number;
  bothOk: number;
  bothFail: number;
  refShared: number;
  stockDowngraded: number;
  failures: string[];
  rngDraws: number[];
  propertyCoverage: { protoRead: number; looseScan: number };
}

async function runPass(
  label: string,
  compileOptions: CompileOptions | undefined,
  withExtraSymbol: boolean,
): Promise<PassStats> {
  let total = 0;
  let bothOk = 0;
  let bothFail = 0;
  let refShared = 0;
  let stockDowngraded = 0;
  const failures: string[] = [];
  const rngDraws: number[] = [];
  // Structural, per checked object rather than matched in the replay string of the case (review of
  // #99, F4); `protoRead` / `looseScan` are the observable classes of `observableClass`.
  const propertyCoverage = {
    cases: 0,
    nonObjectRoot: 0,
    union: 0,
    async: 0,
    objects: 0,
    required: 0,
    optional: 0,
    keyPresent: 0,
    enumerated: 0,
    protoRead: 0,
    looseScan: 0,
  };

  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = makeRng(seed);
    for (let i = 0; i < CASES_PER_SEED; i++) {
      // Default-value probing may retry a generated record when its extra symbol is rejected.
      // Build identical schemas/defaults in both passes; omit symbols only from the case input.
      emitExtraSymbol = true;
      const built = bAny(rng, 3);
      emitExtraSymbol = withExtraSymbol;
      propertyCases.length = 0;
      inputPrototypes.clear();
      generatingCaseInput = true;
      let input = built.gen(rng);
      generatingCaseInput = false;
      if (input === ABSENT) input = undefined;
      if (REPRO && `${seed}:${i}` !== REPRO) continue;
      rngDraws.push(rng.draws);
      const caseId = `[${label}] seed=${seed} case=${i} schema=[${built.desc}] input=${repr(input)}`;
      total++;

      const compiled = compile(built.schema, compileOptions);
      if (compiled.stock) stockDowngraded++;
      if (
        compileOptions?.ownSymbolKeys === "ignore" &&
        compiled.code?.includes("getOwnPropertySymbols")
      ) {
        failures.push(
          `OWN-SYMBOL PROBE EMITTED (at some depth) UNDER ownSymbolKeys: "ignore" → ${caseId}`,
        );
        continue;
      }
      const useAsync = compiled.async; // async skeleton → both sides go through safeParseAsync
      if (propertyCases.length > 0) {
        propertyCoverage.cases++;
        if (built.schema._zod.def.type !== "object") propertyCoverage.nonObjectRoot++;
        if (/union\(|discriminatedUnion\(/.test(built.desc)) propertyCoverage.union++;
        if (useAsync) propertyCoverage.async++;
        for (const c of propertyCases) {
          propertyCoverage.objects++;
          propertyCoverage[c.optional ? "optional" : "required"]++;
          if (c.present) propertyCoverage.keyPresent++;
          if (c.enumerated) propertyCoverage.enumerated++;
          const observable = observableClass(c);
          if (observable) propertyCoverage[observable]++;
        }
      }

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

      if (!assertDeepEqual(snapshotInput(input), snapshot)) {
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
        // Map and Set contents are compared in iteration order on every parse. On an async parse
        // stock's runtime writes a sync entry when it is parsed and an async one when its promise
        // settles (`Set {"a", 1}` under `set(union([string.refine(async …), number]))` comes back as
        // `Set {1, "a"}`), and the set, map and iterating-record skeletons follow that schedule (#70)
        const view = orderedView;
        if (!assertDeepEqual(view(ours!.data), view(stock!.data))) {
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
        // The comparator sees enumerable keys only: pin the extra symbol's presence on the
        // top-level output directly, so a non-enumerable one surviving by reference is caught (#51)
        if (
          carriesExtraSymbol(input) &&
          carriesExtraSymbol(ours!.data) !== carriesExtraSymbol(stock!.data)
        ) {
          failures.push(
            `EXTRA OWN SYMBOL MISMATCH stock=${carriesExtraSymbol(stock!.data)} ours=${carriesExtraSymbol(ours!.data)} → ${caseId}`,
          );
          continue;
        }
        if (generatedPrototypeEscaped(ours!.data, input)) {
          failures.push(`GENERATED PROTOTYPE ON A COPIED OBJECT → ${caseId}`);
          continue;
        }
        if (ours!.data === input) refShared++;
      } else {
        bothFail++;
      }
    }
  }
  console.log(
    `  ${label}: undeclared-property coverage (cases, then one entry per checked object): ${JSON.stringify(propertyCoverage)}`,
  );
  return {
    label,
    total,
    bothOk,
    bothFail,
    refShared,
    stockDowngraded,
    failures,
    rngDraws,
    propertyCoverage,
  };
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

/* ─────────────────────────── run + report ─────────────────────────── */

const passes = [
  await runPass("default options", undefined, true),
  await runPass(
    'ownSymbolKeys: "ignore", no extra own symbol in the inputs',
    { ownSymbolKeys: "ignore" },
    false,
  ),
];

console.log(
  `zc-z4 differential test: ${passes[0]!.total} cases (seeds=${SEEDS} × ${CASES_PER_SEED}) × ${passes.length} passes`,
);
let failed = 0;
for (const p of passes) {
  const { total, bothOk, bothFail, refShared, stockDowngraded, failures } = p;
  console.log(`  pass: ${p.label}`);
  console.log(
    `    success-consistent: ${bothOk}   failure-consistent: ${bothFail}   top-level reference sharing: ${total ? ((refShared / total) * 100).toFixed(1) : "0"}% (${((refShared / Math.max(1, bothOk)) * 100).toFixed(1)}% among successful cases)`,
  );
  console.log(`    stock degradations (compile gave up): ${stockDowngraded}`);
  console.log(`    top-level references shared: ${refShared} / ${total}`);
  if (failures.length > 0) {
    failed += failures.length;
    console.log(`\n✗ ${failures.length} differences in pass "${p.label}" (first 10):`);
    for (const f of failures.slice(0, 10)) console.log(`\n${f}`);
  }
}
const [base, ignore] = passes as [PassStats, PassStats];
// The two passes must draw the same random numbers per case, so the "ignore" pass fuzzes the same
// schemas and inputs as the first and the sharing invariant below compares like with like. Reported
// through the run's own accounting rather than thrown, and by the first divergent case rather than a
// diff of two 20 000-element arrays (review of #99, F7).
const divergentCase =
  base.rngDraws.length === ignore.rngDraws.length
    ? base.rngDraws.findIndex((d, i) => ignore.rngDraws[i] !== d)
    : Math.min(base.rngDraws.length, ignore.rngDraws.length);
if (divergentCase !== -1) {
  failed++;
  console.log(
    `\n✗ the symbol-option passes consumed different RNG streams: first divergence at case index ${divergentCase} (default drew ${base.rngDraws[divergentCase] ?? "nothing"}, ignore drew ${ignore.rngDraws[divergentCase] ?? "nothing"})`,
  );
}
// A floor on the two observable classes at the code-default size and above (review of #99, F1/F3):
// the acceptance criterion for the undeclared property draw is a mutation test — re-introduce the
// pre-#98 `input[key]` read, or drop loose's enumerated read, in `emitCoWObject`'s `heldValue` and
// the run must fail — and both mutants are only visible through an object in one of these two
// configurations. A generator change that erodes the aim silently would take the mutants back out of
// reach; at 200 x 100 cases the aimed rates leave about four times this margin.
if (SEEDS * CASES_PER_SEED >= 20_000 && !REPRO) {
  for (const p of passes) {
    for (const cls of ["protoRead", "looseScan"] as const) {
      if (p.propertyCoverage[cls] < 20) {
        failed++;
        console.log(
          `\n✗ pass "${p.label}" generated only ${p.propertyCoverage[cls]} objects in the ${cls} configuration; the undeclared property draw no longer puts a regression of that read in reach`,
        );
      }
    }
  }
}
if (ignore.refShared < base.refShared) {
  failed++;
  console.log(
    `\n✗ the "ignore" pass shared fewer top-level references (${ignore.refShared}) than the default pass (${base.refShared}); the option must not lose a CoW path`,
  );
}
if (failed > 0) {
  process.exit(1);
} else {
  console.log("  all cases of every pass agree with stock zod4 ✓");
}
