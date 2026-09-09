/**
 * Decorated inputs for the zod3 differential fuzzer (#66).
 *
 * The generators of `differential.test.ts` build plain values. For every container they build
 * they may register a *spec* here: what the container is (an object with its mode and declared
 * keys, a record, an array, a tuple) and which decorations it carries (a declared key defined
 * non-enumerable, an own symbol key, a counting getter, an inherited enumerable key, an own
 * `__proto__` data property, a logging Proxy, an accessor at an array index with an effect on the
 * input, an own `Symbol.iterator`, the array iterator protocol replaced on its prototypes for the
 * case with wrappers that log each `iterator` and `next` call on the container the iterator
 * walks). The plain tree is then instantiated twice, once for stock and once for the compiled
 * parser (`instantiate`): an accessor or a Proxy does not survive `structuredClone`, and both
 * parsers must see the same decorations. Each instance keeps one ordered event log per decorated
 * container (the reads of its accessors and Proxy traps, its iterator calls), which the runner
 * compares against stock's before anything reads the outputs, since the compiled output may hold
 * an input container by reference and every later inspection would log again.
 *
 * The module also holds the two views the comparison needs: `snapshotInput` (the descriptor-level
 * state of an instance, for the mutation check; a Proxy is snapshotted through its target, an
 * accessor by its presence) and `stockView` (a decorated container as stock's output assembly
 * would build it: declared keys read by name in shape order, a loose object's `for...in` extras,
 * a record's `for...in` pairs, an array's indices; symbol keys and `__proto__` dropped), which is
 * what the clean path's documented alias rules leave observable.
 */

/** The effect an accessor at an array index, or a Proxy `get` trap at one, applies when read */
export type Effect =
  | { kind: "count" }
  | { kind: "throw" }
  | { kind: "rewriteLater"; at: number; value: unknown }
  | { kind: "rewriteEarlier"; at: number; value: unknown }
  | { kind: "shrink"; length: number }
  | { kind: "grow"; length: number; value: unknown };

export type Decoration =
  // objects and records
  | { kind: "nonEnumDeclared"; key: string }
  | { kind: "symbolKey"; enumerable: boolean; value: unknown }
  | { kind: "getter"; key: string; declared: boolean; value?: unknown }
  | { kind: "inherited"; key: string; value: unknown }
  | { kind: "presentUndefined"; key: string }
  | { kind: "ownProto"; value: unknown }
  | { kind: "proxy" }
  // arrays and tuples
  | { kind: "indexGetter"; index: number; effect: Effect }
  | { kind: "ownIterator" }
  | { kind: "replacedNext" }
  | { kind: "arrayProxy"; effectAt: number; effect: Effect };

export type DecorationKind = Decoration["kind"];

export interface ContainerSpec {
  /** Ordinal of the container in the case, shared by the two instances */
  id: number;
  kind: "object" | "record" | "array" | "tuple";
  /** Objects: the mode and the declared keys in shape order */
  mode?: "strip" | "strict" | "loose";
  declared?: string[];
  decorations: Decoration[];
  /**
   * Whether an accessor or trap of the container changes what its indices hold after the capture
   * read them (a shrink, a rewrite of an earlier index), the effects whose outcome differs from
   * stock's by documentation: where the compiled output holds the container by reference it holds
   * it as it then is (the alias rule of the clean path, #116), while stock's fresh array holds
   * what its spread read. The output comparison stops at such a container returned by reference
   * (the two instances' states are compared with each other instead); a copy is the capture and
   * is compared exactly. A rewrite of a later index and a growth are read alike by both (stock's
   * spread reads the live length and the rewritten slot), so their outcomes are compared
   */
  aliasing?: boolean;
}

/** The symbol key every `symbolKey` decoration uses, so the two instances carry the same key */
export const EXTRA_SYMBOL = Symbol("extra");
/** The key an `inherited` decoration defines on the generated prototype */
export const INHERITED_KEY = "inh";
/** The key an undeclared getter is defined at */
export const UNDECLARED_GETTER_KEY = "g";

/** Specs by the plain generated container */
export const registry = new WeakMap<object, ContainerSpec>();

export function register(plain: object, spec: ContainerSpec): void {
  registry.set(plain, spec);
}

/** Every registered spec reachable from a plain value, the value's own included */
export function specsBelow(
  v: unknown,
  out: ContainerSpec[] = [],
  seen = new Set<object>(),
): ContainerSpec[] {
  if (typeof v !== "object" || v === null || seen.has(v)) return out;
  seen.add(v);
  const spec = registry.get(v);
  if (spec !== undefined) out.push(spec);
  if (v instanceof Map) {
    for (const [k, x] of v) {
      specsBelow(k, out, seen);
      specsBelow(x, out, seen);
    }
  } else if (v instanceof Set) {
    for (const x of v) specsBelow(x, out, seen);
  } else if (!(v instanceof Date)) {
    for (const k of Object.keys(v)) specsBelow((v as any)[k], out, seen);
  }
  return out;
}

/* ─────────────────────────── instantiation ─────────────────────────── */

export interface InstanceInfo {
  spec: ContainerSpec;
  /** The ordered event log of this container in this instance */
  log: string[];
  /** The raw container behind a Proxy (the container itself otherwise) */
  target: object;
}

export interface Instance {
  root: unknown;
  /** Info by the instance object the parsers see (the Proxy where there is one, and its target) */
  infos: WeakMap<object, InstanceInfo>;
  /** Logs by container id */
  logs: Map<number, string[]>;
  /** Prototypes created for `inherited` decorations */
  prototypes: WeakSet<object>;
  /** Whether a getter or trap effect may have mutated the instance during a parse */
  effectful: boolean;
  /**
   * Whether the case replaces the array iterator protocol on its prototypes around each parse
   * (`withReplacedNext`), logging `iterator` and `next` on the decorated container each iterator
   * walks
   */
  replacedNext: boolean;
  /**
   * Whether accessor and trap effects are live: the runner disarms both instances after the
   * parses, so the inspection of an output that holds an input container by reference (a
   * container the parse never read, under a winning pass-through option) reads plain values
   */
  armed: boolean;
}

const AIP = Object.getPrototypeOf([][Symbol.iterator]()) as { next: () => IteratorResult<unknown> };
const NATIVE_NEXT_DESC = Object.getOwnPropertyDescriptor(AIP, "next")!;
const NATIVE_NEXT = NATIVE_NEXT_DESC.value as (this: unknown) => IteratorResult<unknown>;
// `Array.prototype[Symbol.iterator]` and `Array.prototype.values` are one function object
const NATIVE_ITERATOR_DESC = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
const NATIVE_VALUES_DESC = Object.getOwnPropertyDescriptor(Array.prototype, "values")!;
const NATIVE_VALUES = NATIVE_VALUES_DESC.value as (this: unknown) => object;

/**
 * Replace the array iterator protocol on its prototypes for the duration of `fn`, attributing
 * every call to the decorated container of `inst` it walks: `Array.prototype[Symbol.iterator]`
 * (and `values`, the same function) hands out the native iterator and, when its receiver is a
 * decorated container (a Proxy included, since the receiver is what the call was made on), logs
 * `iterator` on that container and remembers which container the iterator belongs to;
 * `%ArrayIteratorPrototype%.next` logs `next` on the container whose iterator it advances and
 * delegates. Stock's spread of an array or tuple and both skeletons' capture (stock's own spread,
 * #115, #116) run through both, so a container's log holds the same `iterator` and `next` entries
 * on both sides, and a skeleton that reached the prototype's iterator by any other route (a
 * second spread, a `for...of`, `Array.from`, `Array.prototype.values.call`) would log an extra
 * walk on the compiled side, where the runner flags it. Stock's `for...of` over its own result
 * arrays and the engine's loops walk fresh arrays no instance knows, so they log nothing. A `next`
 * on an iterator over a container of the other instance is not logged either: the two parses run
 * under separate installs.
 */
export function withReplacedNext<T>(inst: Instance, fn: () => T): T {
  const owners = new WeakMap<object, string[]>();
  const values = function values(this: unknown) {
    const iterator = NATIVE_VALUES.call(this);
    const info = typeof this === "object" && this !== null ? inst.infos.get(this) : undefined;
    if (info !== undefined) {
      info.log.push("iterator");
      owners.set(iterator, info.log);
    }
    return iterator;
  };
  const next = function next(this: unknown) {
    const log = typeof this === "object" && this !== null ? owners.get(this) : undefined;
    if (log !== undefined) log.push("next");
    return NATIVE_NEXT.call(this);
  };
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    ...NATIVE_ITERATOR_DESC,
    value: values,
  });
  Object.defineProperty(Array.prototype, "values", { ...NATIVE_VALUES_DESC, value: values });
  Object.defineProperty(AIP, "next", { ...NATIVE_NEXT_DESC, value: next });
  try {
    return fn();
  } finally {
    Object.defineProperty(AIP, "next", NATIVE_NEXT_DESC);
    Object.defineProperty(Array.prototype, "values", NATIVE_VALUES_DESC);
    Object.defineProperty(Array.prototype, Symbol.iterator, NATIVE_ITERATOR_DESC);
  }
}

/**
 * Build one instance of the plain case input with every registered decoration applied; the two
 * instances of a case carry the same decorations, since both parsers' captures are stock's spread.
 */
export function instantiate(plain: unknown): Instance {
  const inst: Instance = {
    root: undefined,
    infos: new WeakMap(),
    logs: new Map(),
    prototypes: new WeakSet(),
    effectful: false,
    replacedNext: false,
    armed: true,
  };
  inst.root = clone(plain, inst);
  return inst;
}

function clone(v: unknown, inst: Instance): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const m = new Map<unknown, unknown>();
    for (const [k, x] of v) m.set(clone(k, inst), clone(x, inst));
    return m;
  }
  if (v instanceof Set) {
    const s = new Set<unknown>();
    for (const x of v) s.add(clone(x, inst));
    return s;
  }
  const spec = registry.get(v);
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length); // holes stay holes
    for (const k of Object.keys(v)) (out as any)[k] = clone((v as any)[k], inst);
    return spec === undefined ? out : decorateArray(out, spec, inst);
  }
  const inherited = spec?.decorations.find((d) => d.kind === "inherited");
  let proto: object | null = Object.prototype;
  if (inherited !== undefined && inherited.kind === "inherited") {
    proto = { [inherited.key]: clone(inherited.value, inst) };
    inst.prototypes.add(proto);
  }
  const out = Object.create(proto);
  for (const k of Object.keys(v)) {
    // defineProperty rather than assignment: an own "__proto__" key must stay a data property
    Object.defineProperty(out, k, {
      value: clone((v as any)[k], inst),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return spec === undefined ? out : decorateObject(out, spec, inst);
}

function logOf(spec: ContainerSpec, inst: Instance): string[] {
  let log = inst.logs.get(spec.id);
  if (log === undefined) {
    log = [];
    inst.logs.set(spec.id, log);
  }
  return log;
}

function decorateObject(out: any, spec: ContainerSpec, inst: Instance): object {
  const log = logOf(spec, inst);
  let result: object = out;
  for (const d of spec.decorations) {
    switch (d.kind) {
      case "nonEnumDeclared":
        Object.defineProperty(out, d.key, { enumerable: false });
        break;
      case "symbolKey":
        Object.defineProperty(out, EXTRA_SYMBOL, {
          value: d.value,
          enumerable: d.enumerable,
          writable: true,
          configurable: true,
        });
        break;
      case "getter": {
        const value = d.declared ? out[d.key] : d.value;
        Object.defineProperty(out, d.key, {
          get() {
            log.push(`get ${d.key}`);
            return value;
          },
          enumerable: true,
          configurable: true,
        });
        break;
      }
      case "presentUndefined":
        Object.defineProperty(out, d.key, {
          value: undefined,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      case "ownProto":
        Object.defineProperty(out, "__proto__", {
          value: d.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      case "inherited":
        break; // applied by `clone` when the object was created
      case "proxy":
        // The `get` reads of string keys are the comparable part of an object's trap log: stock's
        // `then` probes, its `key in ctx.data` per shape key and its `for...in` (strict and loose
        // only: stock's strip enumerates nothing) and the skeleton's strip / strict probe are
        // documented asymmetric reads, so the other traps are not logged
        result = new Proxy(out, {
          get(t, k, r) {
            if (typeof k === "string" && k !== "then") log.push(`get ${k}`);
            return Reflect.get(t, k, r);
          },
        });
        break;
      default:
        throw new Error(`decoration ${d.kind} on an object`);
    }
  }
  const info: InstanceInfo = { spec, log, target: out };
  inst.infos.set(out, info);
  if (result !== out) inst.infos.set(result, info);
  return result;
}

function decorateArray(out: any[], spec: ContainerSpec, inst: Instance): object {
  const log = logOf(spec, inst);
  let result: object = out;
  const apply = (effect: Effect, at: number) => {
    if (!inst.armed) return;
    switch (effect.kind) {
      case "count":
        return;
      case "throw":
        throw new RangeError(`read of ${at} threw`);
      case "rewriteLater":
      case "rewriteEarlier":
        out[effect.at] = effect.value;
        return;
      case "shrink":
        if (out.length > effect.length) out.length = effect.length;
        return;
      case "grow":
        for (let j = out.length; j < effect.length; j++) out[j] = effect.value;
        return;
    }
  };
  for (const d of spec.decorations) {
    switch (d.kind) {
      case "indexGetter": {
        const value = out[d.index];
        if (d.effect.kind !== "count") inst.effectful = true;
        Object.defineProperty(out, d.index, {
          get() {
            log.push(`get ${d.index}`);
            apply(d.effect, d.index);
            return value;
          },
          enumerable: true,
          configurable: true,
        });
        break;
      }
      case "ownIterator": {
        // Stock's spread follows an own `Symbol.iterator`, and so does each skeleton's capture
        // (stock's own spread), so both instances carry it and both logs hold its calls
        const values = out.slice();
        Object.defineProperty(out, Symbol.iterator, {
          value: function iterator() {
            log.push("iterator");
            let i = 0;
            return {
              next() {
                log.push("next");
                return i < values.length
                  ? { done: false, value: values[i++] }
                  : { done: true, value: undefined };
              },
            };
          },
          enumerable: false,
          configurable: true,
          writable: true,
        });
        break;
      }
      case "replacedNext":
        // Installed around the parse (`withReplacedNext`): the replacement is global, so every
        // decorated container of the instance is attributed, this one included
        inst.replacedNext = true;
        break;
      case "arrayProxy": {
        if (d.effect.kind !== "count") inst.effectful = true;
        result = new Proxy(out, {
          get(t, k, r) {
            log.push(`get ${String(k)}`);
            if (k === String(d.effectAt)) apply(d.effect, d.effectAt);
            return Reflect.get(t, k, r);
          },
          has(t, k) {
            log.push(`has ${String(k)}`);
            return Reflect.has(t, k);
          },
          ownKeys(t) {
            log.push("ownKeys");
            return Reflect.ownKeys(t);
          },
          getOwnPropertyDescriptor(t, k) {
            log.push(`descriptor ${String(k)}`);
            return Reflect.getOwnPropertyDescriptor(t, k);
          },
          set(t, k, v, r) {
            log.push(`set ${String(k)}`);
            return Reflect.set(t, k, v, r);
          },
          deleteProperty(t, k) {
            log.push(`delete ${String(k)}`);
            return Reflect.deleteProperty(t, k);
          },
          defineProperty(t, k, desc) {
            log.push(`define ${String(k)}`);
            return Reflect.defineProperty(t, k, desc);
          },
        });
        break;
      }
      default:
        throw new Error(`decoration ${d.kind} on an array`);
    }
  }
  const info: InstanceInfo = { spec, log, target: out };
  inst.infos.set(out, info);
  if (result !== out) inst.infos.set(result, info);
  return result;
}

/* ─────────────────────────── views ─────────────────────────── */

/**
 * Descriptor-level snapshot of an instance for the mutation check: every own key with its
 * descriptor (an accessor by its presence, since the two instances hold different functions),
 * the prototype (a generated one by its own snapshot, any other by identity), frozenness. A
 * Proxy is snapshotted through its target, so the snapshot itself runs no trap and no getter.
 * Without `withFrozen` the snapshot leaves out what `Object.freeze` changes (frozenness, the
 * writable and configurable bits): a `readonly` over a pass-through leaf freezes the input in
 * place on both sides (stock behavior, #27), which the pristine comparison must not count as a
 * mutation; the comparison of the two instances after the parses keeps everything.
 */
export function snapshotInput(
  v: unknown,
  inst: Instance,
  withFrozen = true,
  seen = new Map<object, unknown>(),
): unknown {
  if (typeof v !== "object" || v === null) return v;
  const info = inst.infos.get(v);
  const target = info === undefined ? v : info.target;
  const hit = seen.get(target);
  if (hit !== undefined) return hit;
  const frozen = withFrozen ? Object.isFrozen(target) : null;
  if (target instanceof Date) return { $date: target.getTime() };
  if (target instanceof Map) {
    const out = { $map: [] as unknown[], frozen };
    seen.set(target, out);
    for (const [k, x] of target)
      out.$map.push([
        snapshotInput(k, inst, withFrozen, seen),
        snapshotInput(x, inst, withFrozen, seen),
      ]);
    return out;
  }
  if (target instanceof Set) {
    const out = { $set: [] as unknown[], frozen };
    seen.set(target, out);
    for (const x of target) out.$set.push(snapshotInput(x, inst, withFrozen, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(target);
  const out: Record<string, unknown> = {
    array: Array.isArray(target),
    frozen,
    proto: inst.prototypes.has(proto) ? snapshotInput(proto, inst, withFrozen, seen) : proto,
    keys: [] as unknown[],
  };
  seen.set(target, out);
  for (const k of Reflect.ownKeys(target)) {
    // An own iterator is a function object the two instances cannot share; both carry one
    if (k === Symbol.iterator) continue;
    const d = Object.getOwnPropertyDescriptor(target, k)!;
    (out.keys as unknown[]).push([
      k,
      "value" in d
        ? {
            value: snapshotInput(d.value, inst, withFrozen, seen),
            enumerable: d.enumerable,
            writable: withFrozen ? d.writable : null,
            configurable: withFrozen ? d.configurable : null,
          }
        : {
            accessor: true,
            enumerable: d.enumerable,
            configurable: withFrozen ? d.configurable : null,
          },
    ]);
  }
  return out;
}

/**
 * A decorated container as stock's assembly would build it, for the output comparison: what the
 * clean path returns by reference (the input, with whatever the documented alias rules leave on
 * it) and what stock returns (a fresh plain object) agree exactly on this view, and disagree on
 * anything the rules do not cover. `next` views the children (the fuzzer's `orderedView`).
 */
export function stockView(v: object, info: InstanceInfo, next: (x: unknown) => unknown): unknown {
  const spec = info.spec;
  const src: any = v;
  if (spec.kind === "array" || spec.kind === "tuple") {
    const len: number = src.length;
    const out: unknown[] = new Array(len);
    for (let i = 0; i < len; i++) out[i] = next(src[i]);
    return out;
  }
  const out: Record<string, unknown> = {};
  if (spec.kind === "record") {
    // Own keys: a record with an inherited enumerable key is copied by both (the key written as
    // own), so a reference return with the key still inherited is a divergence, not an alias rule
    for (const k of Object.keys(src)) {
      if (k === "__proto__") continue;
      out[k] = next(src[k]);
    }
    return out;
  }
  for (const k of spec.declared!) {
    if (k === "__proto__") continue;
    const value = src[k];
    if (value !== undefined || k in src) out[k] = next(value);
  }
  if (spec.mode === "loose") {
    for (const k in src) {
      if (k === "__proto__" || spec.declared!.includes(k)) continue;
      const value = src[k];
      if (value !== undefined) out[k] = next(value);
    }
  }
  return out;
}

/**
 * Whether stock's assembly copies this container on every path, so the compiled output must never
 * hold it by reference: an own `__proto__` data property (dropped by stock's assembly on an object
 * or a record), an undeclared enumerable key, own or inherited, on a strip object (stock's `for...in`
 * probe sees it and the copy leaves it out), an inherited enumerable key on a record (written as
 * own). A loose object keeps its extras and inherited keys by reference (documented).
 */
export function assemblyCopies(spec: ContainerSpec, v: object): boolean {
  if (spec.kind === "array" || spec.kind === "tuple") return false;
  if (Object.hasOwn(v, "__proto__")) return true;
  if (spec.kind === "record") {
    for (const k in v) if (!Object.hasOwn(v, k)) return true;
    return false;
  }
  if (spec.mode !== "strip") return false;
  for (const k in v) if (!spec.declared!.includes(k)) return true;
  return false;
}

/* ─────────────────────────── read-log models ─────────────────────────── */

const isElementRead = (e: string) => e.startsWith("get ") && e !== "get length";

/**
 * Whether `cow` is `stock` with contiguous blocks inserted, each an optional `get length` (the
 * fresh array's allocation) followed by a subsequence, in order, of the element reads stock made
 * before the block. This is the documented prefix re-read of the record skeleton at the first
 * forced change (#65; the array skeleton's went with its inline timeline, #116), and stock's
 * rebuild mode's up-front length read (the block is then the length read alone, before any
 * element); one block per read pass, so a container a union reads through two record options
 * may carry two. Under a Proxy every read is logged
 * (`complete`), so the block must follow the read of the changed element and may re-read only
 * the elements before that read; an accessor logs one key alone, so the changed element's own
 * read may be unlogged and the block may re-read any logged element before it.
 */
export function matchesPrefixReread(
  cow: readonly string[],
  stock: readonly string[],
  complete: boolean,
): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i === cow.length) return j === stock.length;
    const key = i * (stock.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let ok = j < stock.length && cow[i] === stock[j] && go(i + 1, j + 1);
    if (!ok) {
      const before = stock.slice(0, complete ? Math.max(0, j - 1) : j).filter(isElementRead);
      let b = i;
      if (cow[b] === "get length") {
        b++;
        ok = go(b, j);
      }
      let k = 0;
      while (!ok && b < cow.length) {
        const e = cow[b]!;
        if (!isElementRead(e)) break;
        while (k < before.length && before[k] !== e) k++;
        if (k === before.length) break;
        k++;
        b++;
        ok = go(b, j);
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return go(0, 0);
}

/** The `get` reads of the given keys, in order */
export function readsOf(
  log: readonly string[],
  keys: readonly string[],
  declared: boolean,
): string[] {
  return log.filter((e) => e.startsWith("get ") && keys.includes(e.slice(4)) === declared);
}
