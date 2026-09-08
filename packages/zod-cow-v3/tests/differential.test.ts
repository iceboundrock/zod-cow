/**
 * Differential fuzz test — random schema + data, comparing the compiled layer against stock zod:
 *   1. Success/failure parity, and the same thrown error where a callback or an accessor throws
 *   2. On success, output values are deepStrictEqual (key-set semantics aligned: absent optional keys, present-undefined, etc.)
 *   3. Zero input distortion (descriptor-level snapshot before/after parse, and the two instances
 *      compared with each other after the parses where a getter effect mutates the input on both
 *      sides) — never mutate in place, and never freeze the input (readonly freezes a copy, #27)
 *   4. On failure, the issue lists are identical: same order, and per issue every property stock
 *      carries (code, path, message, `fatal`, the check params, a union's nested errors)
 *   5. Decorated inputs (#66, `decorations.ts`): a share of the generated objects, records, arrays
 *      and tuples carry the descriptors stock's rebuild normalizes away (a non-enumerable declared
 *      key, an own symbol key, a counting getter, an inherited enumerable key, a present-undefined
 *      value, an own `__proto__`, a logging Proxy) or an accessor at an index with an effect on the
 *      input (a throw, a rewrite of another index, a shrink or growth of the length), an own
 *      `Symbol.iterator` or a replaced array-iterator `next`. Every read the input can observe is
 *      logged per container and compared with stock's before anything reads the outputs (tuples
 *      exactly; arrays and records through the documented prefix re-read of the copy path, the
 *      array log without stock's iterator reads, #65 and #116; objects on the `get` reads of their
 *      declared keys, and of their undeclared keys on the copy path). Where the compiled output is
 *      a copy, its key set and descriptors are compared with stock's exactly; where it is the input
 *      reference, the documented alias rule applies and only the assembly view is compared.
 *   6. The `.pure` contract: when `compiled.pure` is true, the parse succeeded and the input carries
 *      no undeclared key that forces stock's assembly to copy, the output must be the input reference.
 * Extra statistics: top-level reference sharing rate (CoW hit rate) and the share of cases carrying
 * each decoration, with a floor at the default size so a generator change cannot silently stop
 * producing one.
 *
 * The generator is deterministic: on failure it prints seed/case/desc/input for a direct repro, and
 * `REPRO=seed:case` runs that one case and prints its decorations and event logs.
 */
import assert from "node:assert/strict";
import { deepEqual as assertDeepEqual } from "./harness.js";
import { z } from "zod";
import {
  assemblyCopies,
  type ContainerSpec,
  type Decoration,
  type DecorationKind,
  type Effect,
  INHERITED_KEY,
  type Instance,
  instantiate,
  matchesPrefixReread,
  readsOf,
  register,
  registry,
  snapshotInput,
  specsBelow,
  stockView,
  UNDECLARED_GETTER_KEY,
  withReplacedNext,
} from "./decorations.js";

// `--no-codegen` runs the same cases through the closure skeletons (the fallback used where
// `new Function` is unavailable); the flag must be set before the compiler module loads
const noCodegen = process.argv.includes("--no-codegen");
if (noCodegen) process.env.ZC_V3_CODEGEN = "0";
const { compile } = await import("../src/index.js");
const { resolveLazy } = await import("../src/compile.js");

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

/**
 * The default values the current case's schema owns (every `.default(dv)` wrapper records its
 * value here; reset per case). Stock hands a default to the inner schema, whose containers and
 * dates build fresh output, so a parsed default never aliases the schema's value except through a
 * pass-through leaf (`unknown.default(obj)` returns `obj` itself in stock); the runner requires
 * the compiled output to alias the defaults exactly where stock's does.
 */
let caseDefaults: unknown[] = [];
/**
 * The `catch` fallbacks the current case's schema owns: stock returns the fallback object itself
 * where the inner schema failed, so an output object at the position of a decorated input may be
 * a value of the schema rather than a copy of the input, and the copy-path checks skip it
 */
let caseFallbacks: unknown[] = [];

/** Every object reachable from `v` (objects, arrays, Dates, Map keys and values, Set members) */
function reachable(v: unknown, out = new Set<object>()): Set<object> {
  if (v === null || (typeof v !== "object" && typeof v !== "function") || out.has(v)) return out;
  out.add(v);
  if (v instanceof Map) {
    for (const [k, x] of v) {
      reachable(k, out);
      reachable(x, out);
    }
  } else if (v instanceof Set) {
    for (const x of v) reachable(x, out);
  } else {
    for (const k of Reflect.ownKeys(v)) reachable((v as any)[k], out);
  }
  return out;
}

/** Whether `output` shares an object with the case's default values that the input itself did not carry */
function aliasesDefaults(output: unknown, input: unknown): boolean {
  if (caseDefaults.length === 0) return false;
  const owned = reachable(caseDefaults);
  for (const o of reachable(input)) owned.delete(o);
  for (const o of reachable(output)) if (owned.has(o)) return true;
  return false;
}

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
 * The output comparison: a structural walk of the compiled output against stock's. Map and Set
 * contents are compared in iteration order (stock rebuilds both from the parsed entries in input
 * order, and the order is observable; the harness comparator, like Node's `isDeepStrictEqual`,
 * treats them as unordered and can also mismatch two Sets whose object members are mutually
 * deep-equal, such as two Dates of the same time). A decorated container an output holds by
 * reference is viewed as stock's assembly builds it (`stockView`), so the documented alias rules
 * of the clean path (a non-enumerable declared key, an inherited key a loose object keeps
 * inherited, a surviving symbol key, the input's prototype) do not trip the comparison while
 * anything else does; where such a container was shrunk by its own accessor during the parse
 * (`shrinks`), the compiled output holds it as it then is by reference, or its copy's re-read
 * prefix holds the deleted slots, where stock's fresh array holds what its spread read (the alias
 * rule and the documented second read), so the walk stops there: the two instances' states were
 * compared with each other already. Where the compiled output holds a copy of a decorated
 * container, the copy's key set, descriptors and prototype must be stock's, and an object's
 * undeclared keys must have been read as stock read them. Children are walked by stock's
 * structure, with the input child alongside. Returns the path of the first difference, or null.
 */
interface Sides {
  cowInst: Instance;
  stockInst: Instance;
  cowLogs: Map<number, string[]>;
  stockLogs: Map<number, string[]>;
  /** Every object the schema owns (default values, catch fallbacks): never a copy of the input */
  owned: Set<object>;
}

/** The key set and descriptors of an output object, compared exactly between a compiled copy and stock's output */
const shapeOf = (o: object) => ({
  proto: Object.getPrototypeOf(o),
  descriptors: Reflect.ownKeys(o).map((k) => {
    const d = Object.getOwnPropertyDescriptor(o, k)!;
    return [k, d.enumerable, d.configurable, "value" in d ? d.writable : "accessor"];
  }),
});

function compareOutputs(
  inp: unknown,
  ours: unknown,
  stock: unknown,
  sides: Sides,
  path = "$",
): string | null {
  if (typeof stock !== "object" || stock === null || stock instanceof Date) {
    return assertDeepEqual(ours, stock) ? null : `${path} (value)`;
  }
  if (typeof ours !== "object" || ours === null || ours instanceof Date) return `${path} (kind)`;
  const { cowInst, stockInst } = sides;
  const iinfo = typeof inp === "object" && inp !== null ? cowInst.infos.get(inp) : undefined;
  if (iinfo?.spec.shrinks) return null;
  const sinfo = stockInst.infos.get(stock);
  // Returned by reference where stock's assembly built a copy: allowed only under the documented
  // alias rules, which `assemblyCopies` excludes. Where stock's output is its own instance of the
  // same container (a pass-through option won on both sides) there is no copy to compare with.
  if (
    iinfo !== undefined &&
    ours === inp &&
    sinfo?.spec !== iinfo.spec &&
    assemblyCopies(iinfo.spec, inp as object)
  )
    return `${path} (returned by reference where stock's assembly copies, #${iinfo.spec.id})`;
  if (iinfo !== undefined && ours !== inp && !sides.owned.has(ours)) {
    // The copy of a decorated container: stock's key set, descriptors and prototype exactly, and
    // an object's undeclared keys read as stock read them (once by a loose append, never in strip
    // or strict mode); on the clean path the alias rule applies and only the view is compared
    if (!assertDeepEqual(shapeOf(ours), shapeOf(stock)))
      return `${path} (copy shape #${iinfo.spec.id}: stock ${repr(shapeOf(stock).descriptors)}, ours ${repr(shapeOf(ours).descriptors)})`;
    if (iinfo.spec.kind === "object") {
      const declared = iinfo.spec.declared!;
      const c = readsOf(sides.cowLogs.get(iinfo.spec.id) ?? [], declared, false);
      const s = readsOf(sides.stockLogs.get(iinfo.spec.id) ?? [], declared, false);
      if (!sameList(c, s))
        return `${path} (undeclared reads on the copy path #${iinfo.spec.id}: stock [${s}], ours [${c}])`;
    }
  }
  const child = (i: unknown, o: unknown, s: unknown, p: string) =>
    compareOutputs(i, o, s, sides, `${path}${p}`);
  if (stock instanceof Map) {
    if (!(ours instanceof Map) || ours.size !== stock.size) return `${path} (map)`;
    const so = [...stock];
    const oo = [...ours];
    const io = inp instanceof Map ? [...inp] : [];
    for (let i = 0; i < so.length; i++) {
      const r =
        child(io[i]?.[0], oo[i]![0], so[i]![0], `.key${i}`) ??
        child(io[i]?.[1], oo[i]![1], so[i]![1], `.value${i}`);
      if (r !== null) return r;
    }
    return null;
  }
  if (stock instanceof Set) {
    if (!(ours instanceof Set) || ours.size !== stock.size) return `${path} (set)`;
    const so = [...stock];
    const oo = [...ours];
    const io = inp instanceof Set ? [...inp] : [];
    for (let i = 0; i < so.length; i++) {
      const r = child(io[i], oo[i], so[i], `.member${i}`);
      if (r !== null) return r;
    }
    return null;
  }
  if (ours instanceof Map || ours instanceof Set) return `${path} (kind)`;
  const oinfo = cowInst.infos.get(ours);
  const ov: any = oinfo === undefined ? ours : stockView(ours, oinfo, (x) => x);
  const sv: any = sinfo === undefined ? stock : stockView(stock, sinfo, (x) => x);
  const iv: any =
    iinfo === undefined
      ? typeof inp === "object" && inp !== null
        ? inp
        : undefined
      : stockView(inp as object, iinfo, (x) => x);
  if (Array.isArray(sv) !== Array.isArray(ov)) return `${path} (kind)`;
  if (!Array.isArray(sv) && Object.getPrototypeOf(ov) !== Object.getPrototypeOf(sv))
    return `${path} (prototype)`;
  if (Array.isArray(sv) && ov.length !== sv.length) return `${path}.length`;
  const okeys = Object.keys(ov);
  const skeys = Object.keys(sv);
  if (!sameList(okeys, skeys)) return `${path} (keys [${okeys}] vs [${skeys}])`;
  for (const k of skeys) {
    const r = child(iv?.[k], ov[k], sv[k], Array.isArray(sv) ? `[${k}]` : `.${k}`);
    if (r !== null) return r;
  }
  return null;
}

/**
 * Whether stock's assembly copies some container of `value` on every path under `schema`, the
 * documented exception of the `.pure` promise: a strip object whose input carries an undeclared
 * enumerable key (own or inherited, stock's `for...in`), an own `__proto__` data property on an
 * object or record (dropped by stock's assembly), an inherited enumerable key on a record
 * (written as own). Judged from the schema and the parsed input, every union option included,
 * since an option earlier than the one the input was generated for may accept it. A `z.lazy` node
 * is read through the engine's memoized `resolveLazy`, so the oracle judges the schema `.pure` was
 * decided on and the getter is not called again (the generator emits no lazy node today).
 */
function mayForceCopy(schema: z.ZodTypeAny, value: unknown): boolean {
  const def: any = (schema as any)._def;
  const obj = typeof value === "object" && value !== null;
  switch (def.typeName) {
    case "ZodObject": {
      if (!obj || Array.isArray(value)) return false;
      if (Object.hasOwn(value, "__proto__")) return true;
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const keys = Object.keys(shape);
      if (def.unknownKeys === "strip") {
        for (const k in value) if (!keys.includes(k)) return true;
      }
      return keys.some((k) => mayForceCopy(shape[k]!, (value as any)[k]));
    }
    case "ZodRecord": {
      if (!obj || Array.isArray(value)) return false;
      if (Object.hasOwn(value, "__proto__")) return true;
      for (const k in value) {
        if (!Object.hasOwn(value, k) || mayForceCopy(def.valueType, (value as any)[k])) return true;
      }
      return false;
    }
    case "ZodArray":
      return Array.isArray(value) && value.some((x) => mayForceCopy(def.type, x));
    case "ZodTuple":
      return (
        Array.isArray(value) &&
        (def.items as z.ZodTypeAny[]).some((it, i) => mayForceCopy(it, value[i]))
      );
    case "ZodMap":
      return (
        value instanceof Map &&
        [...value].some(([k, x]) => mayForceCopy(def.keyType, k) || mayForceCopy(def.valueType, x))
      );
    case "ZodSet":
      return value instanceof Set && [...value].some((x) => mayForceCopy(def.valueType, x));
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return (def.options as z.ZodTypeAny[]).some((o) => mayForceCopy(o, value));
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return mayForceCopy(def.innerType, value);
    case "ZodEffects":
      return mayForceCopy(def.schema, value);
    case "ZodPipeline":
      return mayForceCopy(def.in, value) || mayForceCopy(def.out, value);
    case "ZodBranded":
      return mayForceCopy(def.type, value);
    case "ZodLazy":
      return mayForceCopy(resolveLazy(def), value);
    default:
      return false;
  }
}

/** The base node kinds a schema may read an input through: wrappers unwrapped, unions flattened */
function baseKinds(schema: z.ZodTypeAny, out = new Set<string>()): Set<string> {
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return baseKinds(def.innerType, out);
    case "ZodEffects":
      return baseKinds(def.schema, out);
    case "ZodBranded":
      return baseKinds(def.type, out);
    case "ZodPipeline":
      return baseKinds(def.in, out);
    case "ZodUnion":
      for (const o of def.options as z.ZodTypeAny[]) baseKinds(o, out);
      return out;
    default:
      out.add(def.typeName);
      return out;
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((e, i) => e === b[i]);

/* ─────────────────────────── decorations (#66) ─────────────────────────── */

/**
 * Decorations are rolled for the case input only: `validValueFor` builds the values of a
 * `default` / `catch` wrapper through the same generators, and those must stay plain (stock
 * re-parses a default through the inner schema in rebuild mode, and a decorated default would be
 * parsed identically on both sides without exercising anything)
 */
let decorating = false;
let nextSpecId = 0;
/** The decoration kinds the current case's input carries, for the statistics */
let caseKinds = new Set<string>();

const OBJECT_DECORATION_RATE = 0.35;
const ARRAY_DECORATION_RATE = 0.45;
const UNDECLARED_VALUES = [1, "x", null, true, undefined] as const;

function note(spec: ContainerSpec, d: Decoration): void {
  spec.decorations.push(d);
  caseKinds.add(d.kind);
}

/** An object generated with `declared` keys in shape order; `mode` decides what an undeclared key does */
function decorateObject(
  r: RNG,
  out: Record<string, unknown>,
  mode: "strip" | "strict" | "loose",
  declared: string[],
): void {
  if (!decorating) return;
  const spec: ContainerSpec = { id: nextSpecId++, kind: "object", mode, declared, decorations: [] };
  const present = declared.filter((k) => Object.hasOwn(out, k));
  // A present-undefined declared key: written by stock's assembly (`alwaysSet`), clean here.
  // The `optional` wrapper's generator produces the same shape on its own; both are counted
  for (const k of declared) {
    if (!Object.hasOwn(out, k) && r.chance(0.12)) {
      out[k] = undefined;
      note(spec, { kind: "presentUndefined", key: k });
    }
  }
  if (declared.some((k) => Object.hasOwn(out, k) && out[k] === undefined))
    caseKinds.add("presentUndefined");
  if (r.chance(OBJECT_DECORATION_RATE)) {
    const roll = r.next();
    if (roll < 0.15 && present.length > 0)
      note(spec, { kind: "nonEnumDeclared", key: r.pick(present) });
    else if (roll < 0.3) note(spec, { kind: "symbolKey", enumerable: r.chance(0.5), value: 1 });
    else if (roll < 0.5 && present.length > 0)
      note(spec, { kind: "getter", key: r.pick(present), declared: true });
    else if (roll < 0.6)
      note(spec, {
        kind: "getter",
        key: UNDECLARED_GETTER_KEY,
        declared: false,
        value: r.pick(UNDECLARED_VALUES),
      });
    else if (roll < 0.75)
      note(spec, { kind: "inherited", key: INHERITED_KEY, value: r.pick(UNDECLARED_VALUES) });
    else if (roll < 0.85) note(spec, { kind: "ownProto", value: r.pick(UNDECLARED_VALUES) });
    else note(spec, { kind: "proxy" });
  }
  register(out, spec);
}

/** A record: every enumerable key is a pair; a non-enumerable own key is invisible to stock and the skeleton alike */
function decorateRecord(r: RNG, out: Record<string, unknown>, valueGen: (r: RNG) => unknown): void {
  if (!decorating) return;
  const spec: ContainerSpec = { id: nextSpecId++, kind: "record", decorations: [] };
  const keys = Object.keys(out).filter((k) => k !== "__proto__");
  if (r.chance(OBJECT_DECORATION_RATE)) {
    const roll = r.next();
    if (roll < 0.3 && keys.length > 0)
      note(spec, { kind: "getter", key: r.pick(keys), declared: true });
    else if (roll < 0.5) note(spec, { kind: "symbolKey", enumerable: r.chance(0.5), value: 1 });
    else if (roll < 0.62 && keys.length > 0)
      note(spec, { kind: "nonEnumDeclared", key: r.pick(keys) });
    else if (roll < 0.82) {
      const v = valueGen(r);
      note(spec, { kind: "inherited", key: INHERITED_KEY, value: v === ABSENT ? undefined : v });
    } else note(spec, { kind: "proxy" });
  }
  if (Object.hasOwn(out, "__proto__")) caseKinds.add("ownProto");
  register(out, spec);
}

/** An array or tuple input: an accessor with an effect, an own iterator, a replaced `next`, a Proxy */
function decorateArray(r: RNG, out: unknown[], kind: "array" | "tuple"): void {
  if (!decorating) return;
  const spec: ContainerSpec = { id: nextSpecId++, kind, decorations: [] };
  const len = out.length;
  const effectAt = (i: number): Effect => {
    const roll = r.next();
    if (roll < 0.1) return { kind: "throw" };
    if (roll < 0.3 && i + 1 < len)
      return {
        kind: "rewriteLater",
        at: i + 1 + r.int(len - i - 1),
        value: r.pick(UNDECLARED_VALUES),
      };
    if (roll < 0.45) return { kind: "shrink", length: r.int(len + 1) };
    if (roll < 0.6)
      return { kind: "grow", length: len + 1 + r.int(2), value: r.pick(["x", 1] as const) };
    // The prefix re-read of the array skeleton's copy path would copy a rewritten earlier index
    // where stock's output holds the original (documented, #65): tuples only, whose capture is
    // stock's spread
    if (roll < 0.75 && kind === "tuple" && i > 0)
      return { kind: "rewriteEarlier", at: r.int(i), value: r.pick(UNDECLARED_VALUES) };
    return { kind: "count" };
  };
  if (r.chance(ARRAY_DECORATION_RATE)) {
    const roll = r.next();
    let throwAt = -1;
    if (roll < 0.55 && len > 0) {
      const index = r.int(len);
      const effect = effectAt(index);
      if (effect.kind === "throw") throwAt = index;
      note(spec, { kind: "indexGetter", index, effect });
    } else if (roll < 0.65) note(spec, { kind: "ownIterator" });
    else if (roll < 0.75) note(spec, { kind: "replacedNext" });
    else if (len > 0) {
      const at = r.int(len);
      const eroll = r.next();
      const effect: Effect =
        eroll < 0.2
          ? { kind: "throw" }
          : eroll < 0.4 && at + 1 < len
            ? {
                kind: "rewriteLater",
                at: at + 1 + r.int(len - at - 1),
                value: r.pick(UNDECLARED_VALUES),
              }
            : { kind: "count" };
      if (effect.kind === "throw") throwAt = at;
      note(spec, { kind: "arrayProxy", effectAt: at, effect });
    }
    // A throwing read stops stock's spread before any element is parsed, while the array
    // skeleton parsed the elements before it (#116, documented): their nested logs and effects
    // are one-sided
    if (throwAt > 0 && kind === "array") {
      for (let j = 0; j < throwAt; j++) {
        for (const nested of specsBelow(out[j])) {
          nested.skipLog = true;
          nested.oneSided = true;
        }
      }
    }
  }
  const effects = spec.decorations.flatMap((d) =>
    d.kind === "indexGetter" || d.kind === "arrayProxy" ? [d.effect.kind] : [],
  );
  spec.shrinks = effects.includes("shrink");
  // A throw inside an element's subtree stops the skeleton's loop where stock's spread had read
  // every later index (#116, documented): this array's log is a prefix of stock's, not compared,
  // and an effect of its own past that element ran on stock's side only
  if (
    kind === "array" &&
    specsBelow(out).some(
      (s) =>
        s !== spec &&
        s.decorations.some(
          (d) => (d.kind === "indexGetter" || d.kind === "arrayProxy") && d.effect.kind === "throw",
        ),
    )
  ) {
    spec.skipLog = true;
    if (effects.some((e) => e !== "count" && e !== "throw")) spec.oneSided = true;
  }
  register(out, spec);
}

/** The decorations of a case input, for its id line */
function describeDecorations(plain: unknown): string {
  const parts: string[] = [];
  for (const s of specsBelow(plain)) {
    if (s.decorations.length === 0) continue;
    const ds = s.decorations
      .map((d) => {
        switch (d.kind) {
          case "nonEnumDeclared":
          case "presentUndefined":
            return `${d.kind}(${d.key})`;
          case "symbolKey":
            return `symbolKey(${d.enumerable ? "enumerable" : "hidden"})`;
          case "getter":
            return `getter(${d.key}${d.declared ? "" : `=${repr(d.value)}`})`;
          case "inherited":
            return `inherited(${d.key}=${repr(d.value)})`;
          case "ownProto":
            return `ownProto(${repr(d.value)})`;
          case "indexGetter":
            return `getter(${d.index}: ${repr(d.effect)})`;
          case "arrayProxy":
            return `proxy(${d.effectAt}: ${repr(d.effect)})`;
          default:
            return d.kind;
        }
      })
      .join(", ");
    parts.push(`#${s.id} ${s.kind}${s.mode ? `/${s.mode}` : ""}: ${ds}`);
  }
  return parts.length === 0 ? "" : ` decorations=[${parts.join("; ")}]`;
}

function repr(v: unknown): string {
  try {
    return (
      // The replacer reads the raw value off its holder: JSON.stringify applies `toJSON` (a Date
      // becomes its ISO string, an invalid Date `null`) before handing the value to the replacer
      JSON.stringify({ v }, function (this: any, k, x) {
        const raw = this[k];
        if (typeof raw === "bigint") return `${raw}n`;
        if (typeof raw === "number" && Number.isNaN(raw)) return "NaN";
        if (raw instanceof Date)
          return Number.isNaN(raw.getTime()) ? "Date(NaN)" : raw.toISOString();
        if (raw instanceof Map) return `Map(${repr([...raw])})`;
        if (raw instanceof Set) return `Set(${repr([...raw])})`;
        if (typeof raw === "symbol") return String(raw);
        return x;
      })?.slice(5, -1) ?? String(v)
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

const ANYTHING = [1, "a", null, true, { a: 1 }, [1, 2], undefined] as const;

function bLeaf(rng: RNG): Built {
  const which = rng.int(10);
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
    case 8:
      // A pass-through leaf that accepts a container too: stock returns the input itself, so a
      // readonly above it (directly or through a union / transform / catch) freezes in place
      return {
        schema: z.unknown(),
        desc: "unknown",
        gen: (r) => {
          const v = r.pick(ANYTHING);
          return v !== null && typeof v === "object" ? structuredClone(v) : v;
        },
      };
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
    caseDefaults.push(dv);
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
    caseFallbacks.push(cv);
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
  const mode = modeRoll < 1 ? "strict" : modeRoll < 2 ? "loose" : "strip";
  const declared = fields.map((f) => f.key);
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
      decorateObject(r, out, mode, declared);
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
      // A sparse input now and then: a hole reads as undefined but stock's output owns the index
      if (out.length > 0 && r.chance(0.08)) delete out[r.int(out.length)];
      if (r.chance(0.04)) out.length += 1;
      decorateArray(r, out, "array");
      return out;
    },
  };
}

function bRecord(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  // A key transform that collides with a later key: stock rebuilds in order, the later entry wins
  const renames = rng.chance(0.2);
  const keySchema = renames ? z.string().transform((k) => (k === "a" ? "b" : k)) : z.string();
  return {
    schema: z.record(keySchema, inner.schema),
    desc: `record(${renames ? "string.transform(a→b)" : "string"}, ${inner.desc})`,
    gen: (r) => {
      const out: Record<string, unknown> = {};
      const keys = ["a", "b", "c", "d"];
      const n = r.int(4);
      for (let i = 0; i < n; i++) {
        const v = inner.gen(r);
        if (v !== ABSENT) out[keys[i]!] = v;
      }
      // An own "__proto__" data property (what JSON.parse produces): stock's assembly drops it
      if (r.chance(0.08)) {
        const v = inner.gen(r);
        Object.defineProperty(out, "__proto__", {
          value: v === ABSENT ? undefined : v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      decorateRecord(r, out, inner.gen);
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
      let items = [va === ABSENT ? undefined : va, vb === ABSENT ? undefined : vb];
      if (roll < 0.25 && roll >= 0.2) return r.pick(["x", 1, null, {}] as const);
      if (roll < 0.1) items = items.slice(0, 1);
      else if (roll < 0.2) items = [...items, 1];
      else if (roll < 0.3) {
        // A hole in one slot, or a hole in the slot stock truncates away
        if (r.chance(0.3)) items.push(2);
        delete items[r.int(2)];
      }
      decorateArray(r, items, "tuple");
      return items;
    },
  };
}

function bMap(rng: RNG, depth: number): Built {
  const inner = bChild(rng, depth);
  const renames = rng.chance(0.2);
  const keySchema = renames
    ? z
        .string()
        .min(1)
        .transform((k) => (k === "k0" ? "k1" : k))
    : z.string().min(1);
  return {
    schema: z.map(keySchema, inner.schema),
    desc: `map(string.min(1)${renames ? ".transform(k0→k1)" : ""}, ${inner.desc})`,
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
  if (rng.chance(0.15)) {
    // A member transform that collides with another member: stock adds in order, the later wins
    const schema = z.set(z.number().transform((n) => (n === 1 ? 2 : n)));
    return {
      schema,
      desc: "set(number.transform(1→2))",
      gen: (r) => {
        const out = new Set<unknown>();
        const n = r.int(5);
        for (let i = 0; i < n; i++) out.add(r.pick(NUMBERS));
        return out;
      },
    };
  }
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
      let declared: string[];
      if (roll < 0.575) {
        out.kind = "a";
        const v = a.gen(r);
        if (v !== ABSENT) out.v = v;
        declared = ["kind", "v"];
      } else {
        out.kind = "b";
        const v = b.gen(r);
        if (v !== ABSENT) out.w = v;
        declared = ["kind", "w"];
      }
      if (r.chance(0.2)) out.extra = 1;
      decorateObject(r, out, "strip", declared);
      return out;
    },
  };
}

function bUnion(rng: RNG, depth: number): Built {
  const n = 2 + rng.int(2);
  const branches: Built[] = [];
  const kinds: string[] = [];
  const used = new Set<string>();
  while (branches.length < n) {
    // An option is a leaf or, below the top level, any generated schema (a container, a nested
    // union, a wrapper such as readonly / catch / transform), one option per kind
    const b = depth > 0 && rng.chance(0.4) ? bChild(rng, depth) : bLeaf(rng);
    const tag = b.desc.split(/[.(]/)[0]!;
    if (used.has(tag)) continue;
    used.add(tag);
    branches.push(b);
    kinds.push(b.desc);
  }
  // A union with an array option and a tuple option reads one input through two skeletons whose
  // logs follow different models (the array's prefix re-read without stock's iterator reads, the
  // tuple's exact spread), so such an input's own log is not compared
  const readers = new Set<string>();
  for (const b of branches) baseKinds(b.schema, readers);
  const mixedReaders = readers.has("ZodArray") && readers.has("ZodTuple");
  return {
    schema: z.union(
      branches.map((b) => b.schema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
    ),
    desc: `union(${kinds.join(", ")})`,
    gen: (r) => {
      const v = r.pick(branches).gen(r);
      if (mixedReaders && typeof v === "object" && v !== null) {
        const spec = registry.get(v);
        if (spec !== undefined && (spec.kind === "array" || spec.kind === "tuple"))
          spec.skipLog = true;
      }
      return v;
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
/** `REPRO=seed:case` runs that one case (the RNG stream up to it is replayed) and prints its logs */
const REPRO = process.env.REPRO === undefined ? null : process.env.REPRO.split(":").map(Number);
let total = 0;
let bothOk = 0;
let bothFail = 0;
let refShared = 0;
let refSharedSuccess = 0;
let issueMismatches = 0;
let pureChecked = 0;
const kindCounts = new Map<string, number>();
const failures: string[] = [];

/**
 * Canonical view of an issue list, in collection order: code, path and message per issue, plus
 * every other property the issue carries (`fatal`, the check params; a union's nested errors are
 * compared by their own issue views). Two lists compare equal only when they hold the same issues
 * in the same order, so the order of collection is part of what the fuzzer checks.
 */
function issueView(issues: readonly any[]): string {
  const one = (i: any): string => {
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(i).sort()) {
      if (k === "code" || k === "path" || k === "message") continue;
      if (k === "unionErrors") {
        params[k] = i[k].map((e: any) => issueView(e.issues));
        continue;
      }
      params[k] = i[k];
    }
    return `${i.code}@${repr(i.path)} ${repr(i.message)} ${repr(params)}`;
  };
  return issues.map(one).join(" ; ");
}

/** A thrown error as text: the class and the message must agree between the two sides */
const thrownText = (e: unknown): string =>
  e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);

const ITERATOR_READS = new Set(["iterator", "next", "get Symbol(Symbol.iterator)"]);

/**
 * Pin the oracle itself before any case runs: the prefix re-read model accepts exactly the
 * documented shapes, the stock-assembly view normalizes what the alias rules leave and nothing
 * else, and the state snapshot sees a rewrite, a redefinition and a prototype swap.
 */
function checkOracle(): void {
  const ok = (c: string[], s: string[], complete = true) => matchesPrefixReread(c, s, complete);
  const L = "get length";
  assert(ok(["get 0", "get 1"], ["get 0", "get 1"]), "equal logs");
  assert(ok(["get 0", "get 1", "get 0", "get 2"], ["get 0", "get 1", "get 2"]), "prefix block");
  assert(
    ok(
      [L, "get 0", L, "get 1", L, "get 0", L, "get 2", L],
      [L, "get 0", L, "get 1", L, "get 2", L],
    ),
    "prefix block with the length read",
  );
  assert(ok([L, L, "get 0", L], [L, "get 0", L]), "rebuild mode: the length read alone");
  assert(
    ok(
      ["get 0", "get 1", "get 0", "get 2", "get 0", "get 1", "get 0", "get 2"],
      ["get 0", "get 1", "get 2", "get 0", "get 1", "get 2"],
    ),
    "one block per read pass",
  );
  assert(ok(["get a", "get b", "get a", "get c"], ["get a", "get b", "get c"]), "record keys");
  assert(
    !ok(["get 0", "get 1", "get 1", "get 2"], ["get 0", "get 1", "get 2"]),
    "a re-read of the changed element itself, under a complete log",
  );
  assert(
    ok(["get a", "get a"], ["get a"], false),
    "a block after an unlogged read of the changed key, under an accessor's partial log",
  );
  assert(
    !ok(["get 0", "get 1", "get 2", "get 3"], ["get 0", "get 1", "get 2"]),
    "a read stock never made",
  );
  assert(!ok(["get 0", "get 1"], ["get 0", "get 1", "get 2"]), "a missing read");
  assert(!ok(["get 0", "has 1", "get 1"], ["get 0", "get 1"]), "a has stock never made");
  assert(
    !ok(["get 1", "get 0", "get 2"], ["get 0", "get 1", "get 2"]),
    "an order stock never used",
  );
  assert(
    !ok(["get 0", "get 1", "get 1", "get 0", "get 2"], ["get 0", "get 1", "get 2"]),
    "a block out of order",
  );
  // The stock-assembly view of a decorated object
  const plain = { f0: "x", f1: undefined, extra: 1 };
  const spec: ContainerSpec = {
    id: 0,
    kind: "object",
    mode: "strip",
    declared: ["f0", "f1", "f2"],
    decorations: [
      { kind: "nonEnumDeclared", key: "f0" },
      { kind: "symbolKey", enumerable: true, value: 1 },
      { kind: "inherited", key: INHERITED_KEY, value: 2 },
      { kind: "ownProto", value: 3 },
    ],
  };
  register(plain, spec);
  const inst = instantiate(plain, false);
  const info = inst.infos.get(inst.root as object)!;
  const view = stockView(inst.root as object, info, (x) => x) as Record<string, unknown>;
  assert(
    sameList(Object.keys(view), ["f0", "f1"]),
    "strip view: declared keys only, the non-enumerable one included, present-undefined kept",
  );
  assert(view.f0 === "x" && Object.getOwnPropertySymbols(view).length === 0, "strip view values");
  spec.mode = "loose";
  const loose = stockView(inst.root as object, info, (x) => x) as Record<string, unknown>;
  assert(
    sameList(Object.keys(loose), ["f0", "f1", "extra", INHERITED_KEY]),
    "loose view: extras and the inherited key appended, __proto__ dropped",
  );
  assert(!Object.hasOwn(loose, "__proto__"), "loose view drops an own __proto__");
  // The state snapshot
  const before = snapshotInput(inst.root, inst);
  assert(assertDeepEqual(snapshotInput(inst.root, inst), before), "snapshot is stable");
  (inst.root as any).extra = 2;
  assert(!assertDeepEqual(snapshotInput(inst.root, inst), before), "snapshot sees a rewrite");
  (inst.root as any).extra = 1;
  Object.defineProperty(inst.root as object, "extra", { enumerable: false });
  assert(!assertDeepEqual(snapshotInput(inst.root, inst), before), "snapshot sees a redefinition");
  Object.defineProperty(inst.root as object, "extra", { enumerable: true });
  assert(assertDeepEqual(snapshotInput(inst.root, inst), before), "snapshot restored");
  Object.getPrototypeOf(inst.root)[INHERITED_KEY] = 9;
  assert(
    !assertDeepEqual(snapshotInput(inst.root, inst), before),
    "snapshot sees the generated prototype",
  );
  const frozenView = snapshotInput(inst.root, inst, false);
  Object.freeze(inst.root);
  assert(
    assertDeepEqual(snapshotInput(inst.root, inst, false), frozenView),
    "the pristine snapshot ignores a freeze",
  );
  assert(
    !assertDeepEqual(snapshotInput(inst.root, inst), before),
    "the state snapshot sees a freeze",
  );
}
checkOracle();

/**
 * The event log of one decorated container against stock's (the documented models of the file
 * header): a tuple exactly; an array through the prefix re-read of its copy path and without
 * stock's iterator reads, which the skeleton never makes (#116); a record through the prefix
 * re-read; an object on the ordered `get` reads of its declared keys (its undeclared reads are
 * compared on the copy path by `compareOutputs`).
 */
function compareLog(
  spec: ContainerSpec,
  cow: readonly string[],
  stock: readonly string[],
): string | null {
  if (spec.skipLog) return null;
  const show = () => `\n      stock: ${stock.join(" ")}\n      ours:  ${cow.join(" ")}`;
  const complete = spec.decorations.some((d) => d.kind === "proxy" || d.kind === "arrayProxy");
  switch (spec.kind) {
    case "tuple":
      return sameList(cow, stock) ? null : `EVENT LOG MISMATCH #${spec.id} tuple${show()}`;
    case "array": {
      if (cow.some((e) => ITERATOR_READS.has(e)))
        return `ARRAY ITERATOR CONSULTED #${spec.id}${show()}`;
      const expected = stock.filter((e) => !ITERATOR_READS.has(e));
      return matchesPrefixReread(cow, expected, complete)
        ? null
        : `EVENT LOG MISMATCH #${spec.id} array${show()}`;
    }
    case "record":
      return matchesPrefixReread(cow, stock, complete)
        ? null
        : `EVENT LOG MISMATCH #${spec.id} record${show()}`;
    case "object": {
      const declared = spec.declared!;
      return sameList(readsOf(cow, declared, true), readsOf(stock, declared, true))
        ? null
        : `DECLARED READ MISMATCH #${spec.id}${show()}`;
    }
  }
}

for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = makeRng(seed);
  for (let i = 0; i < CASES_PER_SEED; i++) {
    caseDefaults = [];
    caseFallbacks = [];
    caseKinds = new Set();
    nextSpecId = 0;
    const built = bAny(rng, 3);
    decorating = true;
    let plain = built.gen(rng);
    decorating = false;
    if (plain === ABSENT) plain = undefined; // the top-level wrapper may be absent
    if (REPRO !== null && (seed !== REPRO[0] || i !== REPRO[1])) continue;
    const caseId = `seed=${seed} case=${i} schema=[${built.desc}] input=${repr(plain)}${describeDecorations(plain)}`;
    total++;
    for (const k of caseKinds) kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);

    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(built.schema);
    } catch (e) {
      failures.push(`COMPILE FAILED → ${caseId}\n      ${(e as Error).message}`);
      continue;
    }

    // Two instances of the plain input with the same decorations: stock parses its own, so a
    // getter effect, a `readonly` over a pass-through leaf (which freezes the input in place on
    // both sides, stock behavior) and every read log are compared between the two afterwards
    const specs = specsBelow(plain);
    const stockInst = instantiate(plain, true);
    const cowInst = instantiate(plain, false);
    const input = cowInst.root;
    const pristine = cowInst.effectful ? null : snapshotInput(input, cowInst, false);
    const run = <T>(fn: () => T): T => (stockInst.replacedNext ? withReplacedNext(fn) : fn());

    let stock: z.SafeParseReturnType<unknown, unknown> | null = null;
    let stockThrew: unknown = null;
    let stockDidThrow = false;
    try {
      stock = run(() => built.schema.safeParse(stockInst.root as never));
    } catch (e) {
      stockThrew = e;
      stockDidThrow = true;
    }

    let ours: { success: boolean; data?: unknown; error?: { issues: unknown[] } } | null = null;
    let oursThrew: unknown = null;
    let oursDidThrow = false;
    try {
      const r = run(() => compiled.safeParse(input));
      ours = r.success ? { success: true, data: r.data } : { success: false, error: r.error };
    } catch (e) {
      oursThrew = e;
      oursDidThrow = true;
    }

    // Event logs first: the compiled output may hold an input container by reference, and every
    // inspection below would read its accessors again; the effects are disarmed for those reads
    cowInst.armed = false;
    stockInst.armed = false;
    const cowLogs = new Map([...cowInst.logs].map(([id, l]) => [id, l.slice()]));
    const stockLogs = new Map([...stockInst.logs].map(([id, l]) => [id, l.slice()]));
    if (REPRO !== null) {
      console.log(caseId);
      for (const spec of specs) {
        console.log(
          `  #${spec.id} ${spec.kind}${spec.mode ? `/${spec.mode}` : ""}${spec.skipLog ? " (log not compared)" : ""}${spec.oneSided ? " (one-sided)" : ""}${spec.shrinks ? " (shrinks)" : ""}\n    stock: ${(stockLogs.get(spec.id) ?? []).join(" ")}\n    ours:  ${(cowLogs.get(spec.id) ?? []).join(" ")}`,
        );
      }
      console.log(
        `  pure=${compiled.pure} stock=${stockDidThrow ? `threw ${thrownText(stockThrew)}` : stock!.success} ours=${oursDidThrow ? `threw ${thrownText(oursThrew)}` : ours!.success}` +
          (ours?.success ? ` output=${repr(ours.data)} byReference=${ours.data === input}` : ""),
      );
    }
    let logFailure: string | null = null;
    for (const spec of specs) {
      logFailure = compareLog(spec, cowLogs.get(spec.id) ?? [], stockLogs.get(spec.id) ?? []);
      if (logFailure !== null) break;
    }
    if (logFailure !== null) {
      failures.push(`${logFailure}\n      ${caseId}`);
      continue;
    }

    // Zero input distortion (regardless of success): never mutate in place, and where a getter
    // effect mutates the input by design, the two instances must have been changed the same way
    if (pristine !== null && !assertDeepEqual(snapshotInput(input, cowInst, false), pristine)) {
      failures.push(`INPUT MUTATED → ${caseId}`);
      continue;
    }
    if (!assertDeepEqual(snapshotInput(input, cowInst), snapshotInput(stockInst.root, stockInst))) {
      failures.push(
        `INPUT STATE MISMATCH (frozenness, descriptors or a getter effect) → ${caseId}`,
      );
      continue;
    }

    if (stockDidThrow || oursDidThrow) {
      // A user callback or an accessor threw: the same error must leave both parsers
      if (stockDidThrow !== oursDidThrow || thrownText(stockThrew) !== thrownText(oursThrew)) {
        failures.push(
          `THROW MISMATCH (stock=${stockDidThrow ? thrownText(stockThrew) : "no throw"} ours=${oursDidThrow ? thrownText(oursThrew) : "no throw"}) → ${caseId}`,
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
      const outputDiff = compareOutputs(input, oo, so, {
        cowInst,
        stockInst,
        cowLogs,
        stockLogs,
        owned: reachable([...caseDefaults, ...caseFallbacks]),
      });
      if (outputDiff !== null) {
        failures.push(
          `OUTPUT MISMATCH at ${outputDiff}\n      stock: ${repr(so)}\n      ours:  ${repr(oo)}\n      ${caseId}`,
        );
        continue;
      }
      // The `.pure` contract: the input reference on every successful parse, unless the input
      // carries a key that forces stock's assembly to copy (the documented strip exception)
      if (compiled.pure && !mayForceCopy(built.schema, input)) {
        pureChecked++;
        if (!Object.is(oo, input)) {
          failures.push(`PURE CONTRACT VIOLATED (.pure is true, the output is a copy) → ${caseId}`);
          continue;
        }
      }
      // A parsed default aliases the schema's default value exactly where stock's output does
      // (through a pass-through leaf only; a container default is rebuilt at every level)
      const stockAliases = aliasesDefaults(so, stockInst.root);
      const oursAliases = aliasesDefaults(oo, input);
      if (stockAliases !== oursAliases) {
        failures.push(
          `DEFAULT ALIASING MISMATCH stock=${stockAliases} ours=${oursAliases} → ${caseId}`,
        );
        continue;
      }
      refSharedSuccess++;
      if (Object.is(oo, input)) refShared++;
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
  `differential (${noCodegen ? "closure skeletons, --no-codegen" : "generated skeletons"}): ${total} cases | success=${bothOk} fail=${bothFail} | issue lists compared on every failing case (${issueMismatches} mismatches) | .pure contract checked on ${pureChecked} cases`,
);
if (refSharedSuccess > 0) {
  console.log(
    `CoW top-level reference sharing: ${((refShared / refSharedSuccess) * 100).toFixed(1)}% ` +
      `(${refShared}/${refSharedSuccess} successful cases returned the original input reference)`,
  );
}
/**
 * The share of cases whose input carries each decoration. At the default size or above every
 * kind must reach the floor, so a generator change cannot silently stop producing one (#66).
 */
const DECORATION_KINDS: DecorationKind[] = [
  "nonEnumDeclared",
  "symbolKey",
  "getter",
  "inherited",
  "presentUndefined",
  "ownProto",
  "proxy",
  "indexGetter",
  "ownIterator",
  "replacedNext",
  "arrayProxy",
];
const DECORATION_FLOOR = 0.003;
const shares = DECORATION_KINDS.map(
  (k) => `${k} ${(((kindCounts.get(k) ?? 0) / total) * 100).toFixed(1)}%`,
);
console.log(`decorated inputs (share of cases): ${shares.join(", ")}`);
if (total >= 20000) {
  for (const k of DECORATION_KINDS) {
    const count = kindCounts.get(k) ?? 0;
    if (count < total * DECORATION_FLOOR)
      failures.push(
        `DECORATION FLOOR: ${k} appeared in ${count} of ${total} cases, below ${DECORATION_FLOOR * 100}%`,
      );
  }
}
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES (first 5):`);
  for (const f of failures.slice(0, 5)) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("all cases agree with stock zod ✓");
}
