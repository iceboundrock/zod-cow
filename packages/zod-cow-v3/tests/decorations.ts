/**
 * Decorated inputs for the zod3 differential fuzzer (#66).
 *
 * The generators of `differential.test.ts` build plain values. For every container they build
 * they may register a *spec* here: what the container is (an object with its mode and declared
 * keys, a record, an array, a tuple) and which decorations it carries (a declared key defined
 * non-enumerable, an own symbol key, a counting getter, an inherited enumerable key, an own
 * `__proto__` data property, a logging Proxy, an accessor at an array index with an effect on the
 * input, an own `Symbol.iterator`, a replaced array-iterator `next`). The plain tree is then
 * instantiated twice, once for stock and once for the compiled parser (`instantiate`): an
 * accessor or a Proxy does not survive `structuredClone`, and both parsers must see the same
 * decorations. Each instance keeps one ordered event log per decorated container (the reads of
 * its accessors and Proxy traps, its iterator calls), which the runner compares against stock's
 * before anything reads the outputs, since the compiled output may hold an input container by
 * reference and every later inspection would log again.
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
   * Whether the container's log is comparable. An array read that throws stops stock's spread
   * before any element is parsed, while the array skeleton parsed the elements before it (#116,
   * documented): the containers nested at those indices log on one side only, and so do their
   * effects (`oneSided`, which also takes them out of the state comparison). A throw inside an
   * element's subtree stops the skeleton's loop where stock's spread had read every later index,
   * so an array above such a throw logs a prefix of stock's reads and is skipped as well, and its
   * own effects past that element are one-sided too. A container read by both an array option
   * and a tuple option of one union follows two models in one log and is skipped
   */
  skipLog?: boolean;
  oneSided?: boolean;
  /**
   * Whether an accessor or trap of the container shrinks the input when read, the one effect
   * whose outcome differs from stock's by documentation: where the compiled output holds the
   * container by reference it holds it as it then is (the alias rule of the clean path), where
   * it copies, the prefix re-read at the first change finds the slots the shrink deleted (#65),
   * while stock's fresh array holds what its spread read before the shrink. The output
   * comparison stops at such a container; the two instances' states are compared with each
   * other instead. A rewrite of a later index and a growth are read alike by both (stock's spread
   * reads the live length and the rewritten slot), so their outcomes are compared
   */
  shrinks?: boolean;
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
  /** Whether the case replaces the array iterator's `next` around each parse */
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
const NATIVE_NEXT = NATIVE_NEXT_DESC.value as () => IteratorResult<unknown>;

/**
 * Replace `%ArrayIteratorPrototype%.next` with a delegating wrapper for the duration of `fn`.
 * Stock's spread and the tuple skeleton's spread (stock's own) consult it, and so does stock's
 * `for...of` over its own results, so the count is not comparable; the outcome is.
 */
export function withReplacedNext<T>(fn: () => T): T {
  Object.defineProperty(AIP, "next", {
    ...NATIVE_NEXT_DESC,
    value: function next(this: unknown) {
      return NATIVE_NEXT.call(this);
    },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(AIP, "next", NATIVE_NEXT_DESC);
  }
}

/**
 * Build one instance of the plain case input with every registered decoration applied. The
 * `stockSide` instance leaves out the decorations the array skeleton is documented to ignore
 * (an own `Symbol.iterator`, #116): stock would follow them where the skeleton reads by index,
 * so the compiled instance carries them and the runner asserts they were never consulted.
 */
export function instantiate(plain: unknown, stockSide: boolean): Instance {
  const inst: Instance = {
    root: undefined,
    infos: new WeakMap(),
    logs: new Map(),
    prototypes: new WeakSet(),
    effectful: false,
    replacedNext: false,
    armed: true,
  };
  inst.root = clone(plain, inst, stockSide);
  return inst;
}

function clone(v: unknown, inst: Instance, stockSide: boolean): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const m = new Map<unknown, unknown>();
    for (const [k, x] of v) m.set(clone(k, inst, stockSide), clone(x, inst, stockSide));
    return m;
  }
  if (v instanceof Set) {
    const s = new Set<unknown>();
    for (const x of v) s.add(clone(x, inst, stockSide));
    return s;
  }
  const spec = registry.get(v);
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length); // holes stay holes
    for (const k of Object.keys(v)) (out as any)[k] = clone((v as any)[k], inst, stockSide);
    return spec === undefined ? out : decorateArray(out, spec, inst, stockSide);
  }
  const inherited = spec?.decorations.find((d) => d.kind === "inherited");
  let proto: object | null = Object.prototype;
  if (inherited !== undefined && inherited.kind === "inherited") {
    proto = { [inherited.key]: clone(inherited.value, inst, stockSide) };
    inst.prototypes.add(proto);
  }
  const out = Object.create(proto);
  for (const k of Object.keys(v)) {
    // defineProperty rather than assignment: an own "__proto__" key must stay a data property
    Object.defineProperty(out, k, {
      value: clone((v as any)[k], inst, stockSide),
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

function decorateArray(
  out: any[],
  spec: ContainerSpec,
  inst: Instance,
  stockSide: boolean,
): object {
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
        // Stock's spread follows an own `Symbol.iterator`; the array skeleton reads by index
        // (#116, documented), so the compiled instance alone carries it and must never call it.
        // The tuple skeleton evaluates stock's spread, so its instance carries it on both sides.
        if (stockSide && spec.kind === "array") break;
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
  if (info?.spec.oneSided) return { $oneSided: info.spec.id };
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
    // The own iterator is a decoration the compiled instance alone carries on an array (#116)
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
 * before the block. This is the documented prefix re-read of the array and record skeletons at
 * the first forced change (#65), and stock's rebuild mode's up-front length read (the block is
 * then the length read alone, before any element); one block per read pass, so a container a
 * union reads through two array options may carry two. Under a Proxy every read is logged
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
