/**
 * The rest segment of the tuple skeleton: the rest elements over stock's `input.slice(items.length)`, built by hand
 * (#87), and the presence decision after them, following stock's runtime timeline (#88, #96) in both layouts. The
 * sync layout runs the rest elements inside the source (`emitSyncRest`); the async layout starts them from the
 * source before its await (`emitAsyncRestStart`, #94) and runs the same presence decision after the settled results
 * were compared (`emitPresenceDecision`). The fixed-slot segments stay in `emit-tuple.ts`, which calls these with
 * what the segments held; this module takes no part in the `emit.ts` import cycle.
 *
 * Stock's `$ZodTuple` runtime runs every fixed item and keeps each result, reads `input.slice` once and calls it
 * once (the native slice reads the length, then the constructor, then the species off it, then asks `HasProperty`
 * and `Get` per index and builds its result through the species), iterates what came back with `for...of` running
 * the rest element per yield, and only then decides each fixed slot's presence from the live `input.length`
 * (`handleTupleResults`), assembling from the results it holds. The layout does the same, in the same order, and
 * everything user code can reach between two of those steps (a fixed slot's callback, a `slice` getter, a custom
 * `slice`, a species getter or constructor, an array iterator or `next` on the prototypes, a rest callback, a Proxy
 * trap) meets the same state on both sides:
 *
 *   - every fixed slot's result is held in a local, and every fresh output is assembled from those locals, never
 *     from a second read of the input (the async layout's rule, #77);
 *   - `slice` is read once; the native one is run by hand (#87: `Array.prototype.slice` costs a near-constant 30 ns
 *     per call, its species lookup and generic entry, where `new Array(n)` plus a copy loop costs a third at a short
 *     rest) with the same reads in the same order, the length once, converted as `ToLength` converts it, then the
 *     constructor, then the species when the constructor is `Array` (the one property read that can run user code,
 *     made at the point the native slice makes it), then `in` and the read per index and nothing else. When the
 *     constructor is `Array` and the species is `Array` the builtin's remaining steps (`ArrayCreate`, the stores
 *     into it, its length) run no user code, so the copy stands in for them. Any other constructor or species hands
 *     the builtin the reads already made and lets it finish (`nativeSliceFrom`), and any other `slice` is called as
 *     stock calls it;
 *   - whatever `slice` answered is iterated as stock's `for...of` iterates it, the rest element run per yield. Over
 *     the copy, the two reads that iteration makes are made by hand with stock's receivers: `Symbol.iterator` off
 *     the copy, and, when it answered the native array iterator, `next` off the iterator that iterator creates (its
 *     creation runs no user code). When both answer the captured natives the iteration is the copy's elements in
 *     order and runs no user code, so the inline index loop stands in for it (and closes the iterator through its
 *     `return`, read when the rest element throws, as `for...of` would); any other answer continues through a real
 *     `for...of` from the values already read (`restFromMethod`, `restFromIterator`), so the call of the method on
 *     the copy, the object check on its result, the read and call of `next` per step, the reads of `done` and
 *     `value`, the close through `return` and every `TypeError` are the engine's own. So an array iterator or `next`
 *     replaced on its prototype, by a data property or by an accessor that answers by its receiver, meets the same
 *     reads and calls (sixth review of #88: a guard that read the two properties off the prototypes invoked such an
 *     accessor with the prototype as receiver; a descriptor check that invokes nothing costs more than the parse, and
 *     a `for...of` over the copy that verifies each yield against it costs a nanosecond per element);
 *   - after the rest ran, the live length is read once more and, when it or the iteration differs from what the
 *     fixed slots and the copy decided with, stock's `handleTupleResults` is run over the held results: a slot the
 *     new length excludes truncates the output at the first optional-in slot at or past `optoutStart`, a slot it now
 *     covers is materialized from its held result (a slot the skeleton never ran because an earlier one truncated
 *     is run at its stock position anyway, on `undefined`, and held), a rest result the length excludes reaches
 *     the trailing loop that walks `items` past its end and throws the `TypeError` stock throws there. A length
 *     nothing moved and a native iteration take none of that: the inline assembly is that algorithm already.
 *
 * The async layout (#94) takes the same source before its await: `slice` read once, the hand copy or the
 * continuation, and one rest product started per element the copy holds or per value a continuation yields, in
 * stock's order (the fixed slots started, then the slice, then the rest elements inside the iteration, then the
 * `Promise.all`). After the await the live length is read once, the fixed-slot segments decide presence from it
 * over the settled results (every fixed slot's result is held, an absent slot's run on `undefined` included, as
 * stock's `itemResults`), the rest loop compares the settled results with the elements, and the same presence
 * decision runs whenever a continuation ran or the live length differs from the guard's read or the copy's.
 *
 * What remains: the output is the input by reference when nothing forced a copy, so user code that rewrites a slot
 * whose result is already held is visible in that output only (the CoW premise, §5.3 of the deep dive); the number
 * of `length` reads on a Proxy differs from stock's, and a Proxy under-reporting its length keeps the clean path,
 * the input with the elements stock never saw (the known limitation of #95), except that a length converting to
 * `NaN` is never equal to itself, so it takes the presence decision and stock's fresh output; a present slot whose
 * product fails returns to stock at once where stock keeps going and may drop the
 * failure with a truncation the rest moved, and that early exit from a continuation's `for...of` closes a custom
 * iterator through its `return`, which stock's loop, never exiting early, does not call (the inline loop closes on a
 * throw only, as stock's does, the `$ZodAsyncError` of a plain-`Promise` rest result included, which stock's loop
 * does not throw: the #76 route); a `slice` that is not callable throws a `TypeError` on both sides with the
 * engine's message for each call site.
 */
import type { CodeCtx } from "./codectx.js";
import type { Node } from "./product.js";

/** The `slice` the sync rest layout replaces by hand (#87); every other function an input answers for `slice` is called */
const NATIVE_SLICE = Array.prototype.slice;
/** Stock's call on the `slice` that was read, made once on the function it answered (second review of #88) */
const NATIVE_APPLY = Reflect.apply;
/** The reads stock's `handleTupleResults` makes on `items` at parse time (`items[i]._zod.optin`, `.optout`): past the
 *  items the same read throws the engine's own `TypeError`, as stock's does (fourth review of #88) */
const optinOptional = (items: Node[], i: number): boolean => items[i]!._zod.optin === "optional";
const optoutOptional = (items: Node[], i: number): boolean => items[i]!._zod.optout === "optional";

/**
 * The continuation of the native `slice` on an input the hand copy declines (a constructor other than `Array`, a
 * species other than `Array`; fourth review of #88). The skeleton has already made the reads the native slice makes
 * first (`length`, then `constructor`, then the species off an `Array` constructor), each once, at its point; the
 * native builtin then finishes on a facade that answers those reads from what was read and forwards every other
 * question (`HasProperty`, `Get` per index) to the input, so the species construction, the per-index reads, the
 * writes into the constructed result and the errors are the builtin's own, made once. `ctor` is the constructor that
 * was read, or, when it was `Array`, a plain object carrying the species that was read, which the builtin reads back
 * without running the getter again.
 */
function nativeSliceFrom(input: unknown[], length: number, ctor: unknown, start: number): unknown {
  const facade = new Proxy([] as unknown[], {
    get: (_target, key) =>
      key === "length"
        ? length
        : key === "constructor"
          ? ctor
          : (input as unknown as Record<PropertyKey, unknown>)[key],
    has: (_target, key) => key in input,
  });
  return NATIVE_APPLY(NATIVE_SLICE, facade, [start]);
}

/** What stock's `for...of` over a plain array reads and calls: the array iterator and, on the iterator it creates, its
 *  `next`; captured at module load, compared against what the copy answers at parse time (sixth review of #88) */
const NATIVE_ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const ARRAY_ITERATOR_PROTOTYPE = Object.getPrototypeOf([][Symbol.iterator]()) as {
  next: unknown;
};
const NATIVE_ARRAY_NEXT = ARRAY_ITERATOR_PROTOTYPE.next;
/** The native array iterator called on the copy (stock's `Call(method, rest)` once the read answered it): the
 *  iterator's creation, no user code */
const ITERATOR_CALL = Function.prototype.call.bind(NATIVE_ARRAY_ITERATOR) as (copy: unknown[]) => {
  next: unknown;
  return?: unknown;
};

/**
 * `for...of` continued from the `Symbol.iterator` value the copy answered, when it is not the native array iterator:
 * the loop calls it on the copy (stock's `Call(method, rest)`), checks the result is an object, reads its `next`
 * and drives the protocol, every error the engine's own with stock's message (the iterable is named `rest` at the
 * loop, so a value that is not callable throws stock's "rest is not iterable" from the engine).
 */
function restFromMethod(method: unknown, copy: unknown[]): Iterable<unknown> {
  return typeof method === "function"
    ? { [Symbol.iterator]: () => NATIVE_APPLY(method, copy, []) as Iterator<unknown> }
    : ({ [Symbol.iterator]: method } as unknown as Iterable<unknown>);
}

/**
 * `for...of` continued from the native array iterator over the copy and the `next` it answered, when that is not the
 * native one: the loop calls that `next` on the iterator per step, reads `done` and `value` off what it returned,
 * and on an abrupt exit closes through the iterator's own `return`, read off it when needed (`GetMethod`), every
 * error the engine's own with stock's message.
 */
function restFromIterator(
  iterator: { next: unknown; return?: unknown },
  next: unknown,
): Iterable<unknown> {
  return {
    [Symbol.iterator]: () =>
      (typeof next === "function"
        ? {
            next: () => NATIVE_APPLY(next, iterator, []),
            get return() {
              const r = iterator.return;
              return typeof r === "function"
                ? (...args: unknown[]) => NATIVE_APPLY(r, iterator, args)
                : r;
            },
          }
        : { next }) as Iterator<unknown>,
  };
}

/** Stock's `IteratorClose` on the iterator the inline loop stood in for, when the rest element threw: `return` is
 *  read off the iterator and, when callable, called, its result and any error discarded in favor of the throw */
function closeOnThrow(iterator: { return?: unknown }): void {
  try {
    const r = iterator.return;
    if (r !== undefined && r !== null)
      NATIVE_APPLY(r as (...args: unknown[]) => unknown, iterator, []);
  } catch {}
}

/** What both rest layouts hand the slice source */
export interface RestSource {
  ctx: CodeCtx;
  /** The input expression */
  accessor: string;
  /** `items.length` */
  N: number;
  /** The local receiving the hand copy of the rest (`null` when the native slice was not run by hand) */
  restReads: string;
}

/** The locals the slice source leaves for the presence decision */
export interface RestSourceVars {
  /** The copy's one length read, converted as `ToLength` converts it (set when the native `slice` was read) */
  len: string;
  /** Whether the inline index loop ran (a custom `slice` may answer `undefined`, so the iterable local cannot tell) */
  inline: string;
  /** The iterable a continuation consumes with `for...of`; unset when the inline index loop stood in for it */
  iterable: string;
}

/**
 * The source of the rest elements, shared by both layouts: `slice` is read once; the native one is run by hand when
 * the constructor is `Array` and the species is `Array`, with the reads the native slice makes, in its order; every
 * other case is a continuation (the native builtin finished on the facade, or what the custom `slice` answered). The
 * copy is iterated by the inline index loop `emitInline` emits (inside the `try` that closes the iterator when a
 * rest element throws) when the two reads stock's `for...of` makes, made here with stock's receivers, answer the
 * native array iterator and its `next`, and through a `for...of` continued from what they answered otherwise. The
 * caller consumes a continuation with `for...of` over an iterable named `rest` when `inline` is false.
 */
function emitRestSource(src: RestSource, emitInline: () => void): RestSourceVars {
  const { ctx, accessor, N, restReads } = src;
  const sliceFn = ctx.var();
  const len = ctx.var();
  const ctor = ctx.var();
  const species = ctx.var();
  const iterable = ctx.var();
  const inline = ctx.var();
  ctx.write(`const ${sliceFn} = ${accessor}.slice;`);
  ctx.write(
    `let ${len}, ${ctor}, ${species}, ${iterable}, ${restReads} = null, ${inline} = false;`,
  );
  ctx.write(`if (${sliceFn} === ${ctx.addConst(NATIVE_SLICE)}) {`);
  ctx.indented(() => {
    // The native slice's reads, in its order: `LengthOfArrayLike` (one read, `ToNumber` once; `ToLength` floors a
    // fraction and gives an empty copy for NaN, a negative or a short input, a BigInt or a Symbol throws the
    // `TypeError` `ToNumber` throws), then `ArraySpeciesCreate` reads the constructor and, off an `Array`
    // constructor, the species (the built-in getter, or a getter installed on `Array`: the one read that runs user
    // code, made here where the builtin makes it, once)
    ctx.write(`${len} = +${accessor}.length;`);
    ctx.write(`${ctor} = ${accessor}.constructor;`);
    ctx.write(`if (${ctor} === Array && (${species} = Array[Symbol.species]) === Array) {`);
    ctx.indented(() => {
      // `ArrayCreate` and the builtin's stores run no user code: the copy stands in for them. `in` then the read per
      // index is slice's `HasProperty` then `Get` (a Proxy whose `has` denies an index gets a hole there), a slot
      // written when `in` answered so a hole stays a hole; an `undefined` the copy holds, own or not, is judged
      // dirty by the rest loop without an own-ness probe (`isHole`, #95)
      ctx.write(`${restReads} = new Array(${len} > ${N} ? Math.floor(${len}) - ${N} : 0);`);
      ctx.write(`for (let j = 0; j < ${restReads}.length; j++) {`);
      ctx.indented(() => {
        ctx.write(`if ((${N} + j) in ${accessor}) ${restReads}[j] = ${accessor}[${N} + j];`);
      });
      ctx.write(`}`);
      // Stock's `for...of` over its slice result: the read of `Symbol.iterator` with the result as receiver, its
      // call, the read of `next` with the iterator as receiver, made here on the copy, once each. The native pair
      // iterates the copy element by element and runs no user code, so the index loop stands in for it; any other
      // answer continues through `for...of` from the values read
      const method = ctx.var();
      const iterator = ctx.var();
      const next = ctx.var();
      ctx.write(`const ${method} = ${restReads}[Symbol.iterator];`);
      ctx.write(`if (${method} === ${ctx.addConst(NATIVE_ARRAY_ITERATOR)}) {`);
      ctx.indented(() => {
        ctx.write(`const ${iterator} = ${ctx.addConst(ITERATOR_CALL)}(${restReads});`);
        ctx.write(`const ${next} = ${iterator}.next;`);
        ctx.write(`if (${next} === ${ctx.addConst(NATIVE_ARRAY_NEXT)}) {`);
        ctx.indented(() => {
          ctx.write(`${inline} = true;`);
          // A throw from the rest element leaves stock's `for...of` through `IteratorClose`; the index loop does the same
          ctx.write(`try {`);
          ctx.indented(emitInline);
          ctx.write(`} catch (err) {`);
          ctx.indented(() => {
            ctx.write(`${ctx.addConst(closeOnThrow)}(${iterator});`);
            ctx.write(`throw err;`);
          });
          ctx.write(`}`);
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          ctx.write(`${iterable} = ${ctx.addConst(restFromIterator)}(${iterator}, ${next});`);
        });
        ctx.write(`}`);
      });
      ctx.write(`} else {`);
      ctx.indented(() => {
        ctx.write(`${iterable} = ${ctx.addConst(restFromMethod)}(${method}, ${restReads});`);
      });
      ctx.write(`}`);
    });
    ctx.write(`} else {`);
    ctx.indented(() => {
      // Another constructor (a subclass instance, an own or inherited `constructor`, another realm's `Array`) or
      // another species: the builtin finishes from the reads made above, without repeating any of them
      ctx.write(
        `${iterable} = ${ctx.addConst(nativeSliceFrom)}(${accessor}, ${len}, ${ctor} === Array ? { [Symbol.species]: ${species} } : ${ctor}, ${N});`,
      );
    });
    ctx.write(`}`);
  });
  ctx.write(`} else {`);
  ctx.indented(() => {
    // Any other `slice` (an own one, a subclass override, a replaced `Array.prototype.slice`): the call stock's
    // runtime makes, on the function that was read
    ctx.write(`${iterable} = ${ctx.addConst(NATIVE_APPLY)}(${sliceFn}, ${accessor}, [${N}]);`);
  });
  ctx.write(`}`);
  return { len, inline, iterable };
}

/** What the presence decision runs over */
export interface PresenceDecision {
  ctx: CodeCtx;
  /** The input expression */
  accessor: string;
  /** The output local: the input until the first forced change, the copy after it */
  out: string;
  items: Node[];
  /** `items.length` */
  N: number;
  optoutStart: number;
  /** The local holding the rest elements the inline rest loop walked (the copy, or in the async layout a
   *  continuation's yields) */
  restReads: string;
  /** The local holding the live length, read by the caller after the rest ran */
  live: string;
  /** Per fixed slot the local holding its result (stock's `itemResults`) */
  held: string[];
  /** The sync layout's local holding a continuation's rest results (`null` at parse time when the inline loop ran);
   *  absent in the async layout, whose rest loop wrote every rest result into the copy or left the elements standing */
  results?: string;
  /** The condition under which stock's algorithm runs over the held results */
  condition: string;
}

/**
 * Stock's `handleTupleResults`: presence from the live length, read after the rest ran. Under `condition` (a
 * continuation ran, or the live length differs from a read the fixed slots or the copy decided with) it runs over
 * the held results: the leading loop truncates at the first optional-in slot at or past `optoutStart` the length
 * excludes (or an excluded slot whose run failed), reports a covered slot's failure, and writes every result it
 * passes; the rest results follow; the trailing loop drops trailing `undefined` results of optional-out slots the
 * length excludes and, past `items`, throws where stock throws (the same read on the same `items`, so the engine's
 * own `TypeError` and message). Otherwise the inline assembly stands, being that algorithm for a length that holds.
 */
function emitPresenceDecision(d: PresenceDecision): void {
  const { ctx, accessor, out, items, N, optoutStart, restReads, live, held: slotOut, results } = d;
  ctx.write(`if (${d.condition}) {`);
  ctx.indented(() => {
    const itemsConst = ctx.addConst(items);
    const held = ctx.var();
    const final = ctx.var();
    const fromOut = ctx.var();
    ctx.write(`const ${held} = [${slotOut.join(", ")}];`);
    ctx.write(`const ${final} = [];`);
    ctx.write(`let i = 0;`);
    ctx.write(`for (; i < ${N}; i++) {`);
    ctx.indented(() => {
      ctx.write(`const present = i < ${live};`);
      ctx.write(
        `if (!present && i >= ${optoutStart} && ${ctx.addConst(optinOptional)}(${itemsConst}, i)) break;`,
      );
      ctx.write(
        `if (${held}[i] === INVALID) { if (!present && i >= ${optoutStart}) break; return INVALID; }`,
      );
      ctx.write(`${final}[i] = ${held}[i];`);
    });
    ctx.write(`}`);
    ctx.write(`if (i === ${N}) {`);
    ctx.indented(() => {
      // The rest results: the continuation's, or the inline loop's, which wrote every one into the copy when it
      // copied and left the copy's elements standing (each equal to its result) when it did not
      ctx.write(`const ${fromOut} = ${out} !== ${accessor};`);
      if (results !== undefined) {
        ctx.write(
          `const rs = ${results} !== null ? ${results} : ${fromOut} ? ${out} : ${restReads}, off = ${results} === null && ${fromOut} ? ${N} : 0, k = ${results} !== null ? ${results}.length : ${restReads}.length;`,
        );
      } else {
        ctx.write(
          `const rs = ${fromOut} ? ${out} : ${restReads}, off = ${fromOut} ? ${N} : 0, k = ${restReads}.length;`,
        );
      }
      ctx.write(`for (let j = 0; j < k; j++) ${final}[${N} + j] = rs[off + j];`);
    });
    ctx.write(`}`);
    ctx.write(`for (let j = ${final}.length - 1; j >= ${live}; j--) {`);
    ctx.indented(() => {
      ctx.write(
        `if (${ctx.addConst(optoutOptional)}(${itemsConst}, j) && ${final}[j] === undefined) ${final}.length = j; else break;`,
      );
    });
    ctx.write(`}`);
    ctx.write(`${out} = ${final};`);
  });
  ctx.write(`}`);
}

/** What the fixed-slot segments of `emitCoWTuple` hold for the sync rest layout */
export interface SyncRestLayout extends RestSource {
  /** The output local: the input until the first forced change, the copy after it */
  out: string;
  items: Node[];
  optoutStart: number;
  /** The rest product's hoisted name and whether it is a validator (answers pass / fail only) */
  restFn: string;
  restIsValidator: boolean;
  /** The guard's length read, and per fixed slot the local holding the read its presence was decided from */
  guardLen: string;
  slotLen: string[];
  /** Per fixed slot the local holding its result (stock's `itemResults`) */
  slotOut: string[];
  /** Emits the inline rest body for the copy's element in local `e` at index `i` (the index loop's variable): the
   *  rest product's call, the reference comparison and the write into the copy */
  emitRestBody: (e: string) => void;
}

/**
 * Segment 3 of the sync rest layout and the presence decision after it (the header's timeline): the source above,
 * its inline index loop running the rest body per copy element, a continuation's result consumed with `for...of`
 * like stock's and its rest results collected. Then the live length is read once and stock's `handleTupleResults`
 * runs over the held results whenever a continuation ran or the length differs from any read the fixed slots and
 * the copy decided with.
 */
export function emitSyncRest(layout: SyncRestLayout): void {
  const { ctx, accessor, N, restReads, restFn, guardLen, slotLen } = layout;
  const { len, inline, iterable } = emitRestSource(layout, () => {
    ctx.write(`for (let i = ${N}; i < ${N} + ${restReads}.length; i++) {`);
    ctx.indented(() => {
      ctx.write(`const e = ${restReads}[i - ${N}];`);
      layout.emitRestBody("e");
    });
    ctx.write(`}`);
  });
  /** The continuation's rest results, in yield order */
  const results = ctx.var();
  ctx.write(`let ${results} = null;`);
  ctx.write(`if (!${inline}) {`);
  ctx.indented(() => {
    ctx.write(`${results} = [];`);
    // `rest`, block-scoped: the name stock's runtime iterates, so a non-iterable throws the engine's `TypeError`
    // with stock's message
    ctx.write(`const rest = ${iterable};`);
    ctx.write(`for (const e of rest) {`);
    ctx.indented(() => {
      if (layout.restIsValidator) {
        ctx.write(`if ((${restFn}(e)) === INVALID) return INVALID;`);
        ctx.write(`${results}.push(e);`);
      } else {
        ctx.write(`const t = ${restFn}(e);`);
        ctx.write(`if (t === INVALID) return INVALID;`);
        ctx.write(`${results}.push(t);`);
      }
    });
    ctx.write(`}`);
  });
  ctx.write(`}`);
  // A length nothing moved since the guard, the fixed slots and the copy read it (the copy's read compared as the
  // number it was converted to) leaves the inline assembly
  const live = ctx.var();
  ctx.write(`const ${live} = ${accessor}.length;`);
  const holds = [
    ...[guardLen, ...slotLen.filter((v) => v !== guardLen)].map((v) => `${live} === ${v}`),
    `+${live} === ${len}`,
  ].join(" && ");
  emitPresenceDecision({
    ...layout,
    live,
    held: layout.slotOut,
    results,
    condition: `${results} !== null || !(${holds})`,
  });
}

/** What the async layout hands the rest start before its await */
export interface AsyncRestStart extends RestSource {
  /** The local receiving one started rest product per element, in stock's order */
  restStarted: string;
  /** The rest product's hoisted name */
  restFn: string;
}

/**
 * The async layout's segment 3 before the await (#94): the source above, its inline loop starting one rest product
 * per copy element, a continuation consumed with `for...of` like stock's, each yield kept in `restReads` and its
 * product started. The rest loop after the await then compares the settled results with `restReads`, and
 * `emitAsyncRestDecision` runs the presence decision.
 */
export function emitAsyncRestStart(start: AsyncRestStart): RestSourceVars {
  const { ctx, restReads, restStarted, restFn } = start;
  ctx.write(`const ${restStarted} = [];`);
  const vars = emitRestSource(start, () => {
    ctx.write(`for (let j = 0; j < ${restReads}.length; j++) {`);
    ctx.indented(() => {
      ctx.write(`${restStarted}.push(${restFn}(${restReads}[j]));`);
    });
    ctx.write(`}`);
  });
  ctx.write(`if (!${vars.inline}) {`);
  ctx.indented(() => {
    ctx.write(`${restReads} = [];`);
    // `rest`, block-scoped: the name stock's runtime iterates, so a non-iterable throws the engine's `TypeError`
    // with stock's message
    ctx.write(`const rest = ${vars.iterable};`);
    ctx.write(`for (const e of rest) {`);
    ctx.indented(() => {
      ctx.write(`${restReads}.push(e);`);
      ctx.write(`${restStarted}.push(${restFn}(e));`);
    });
    ctx.write(`}`);
  });
  ctx.write(`}`);
  return vars;
}

/** What the async layout hands the presence decision after its rest loop */
export interface AsyncRestDecision extends Omit<PresenceDecision, "condition"> {
  /** The guard's length read, before the fixed slots started */
  guardLen: string;
  /** The source's locals */
  source: RestSourceVars;
}

/**
 * The async layout's presence decision (#94): stock's algorithm over the held results whenever a continuation ran
 * (its rest results may sit under a truncated prefix or past the live length) or the live length, read once after
 * the await and used by every fixed-slot gate, differs from the guard's read or from the copy's converted one (a
 * callback moved it before settling); a length that holds leaves the inline assembly.
 */
export function emitAsyncRestDecision(d: AsyncRestDecision): void {
  const { live, guardLen, source } = d;
  emitPresenceDecision({
    ...d,
    condition: `!${source.inline} || !(${live} === ${guardLen} && +${live} === ${source.len})`,
  });
}
