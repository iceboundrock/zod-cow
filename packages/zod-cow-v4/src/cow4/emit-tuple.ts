/**
 * Tuple skeleton: mirrors zod's generateTupleCheck with fillLen truncation tracking
 * + CoW decoration.
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import type { CodeCtx } from "./codectx.js";
import { childProduct, emitContainerChecks } from "./emit.js";
import { dropsWhenAbsent, getTupleOptStart } from "./predicates.js";
import type { Node } from "./product.js";

/** The `slice` the sync rest layout replaces by hand (#87); every other function an input answers for `slice` is called */
const NATIVE_SLICE = Array.prototype.slice;
/** Stock's call on the `slice` that was read, made once on the function it answered (second review of #88) */
const NATIVE_APPLY = Reflect.apply;
/** What stock's `for...of` over a plain array runs: the array iterator and its `next`, both data properties, so the
 *  fast path can prove them intact without running any code (fourth review of #88) */
const NATIVE_ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const ARRAY_ITERATOR_PROTOTYPE = Object.getPrototypeOf([][Symbol.iterator]()) as {
  next: unknown;
};
const NATIVE_ARRAY_NEXT = ARRAY_ITERATOR_PROTOTYPE.next;
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

/* ── tuple skeleton: mirrors the official generateTupleCheck + fillLen truncation tracking + CoW decoration ── */

/**
 * The tuple CoW skeleton -- line for line with the official generateTupleCheck; the only difference is rewriting
 * the "unconditional new container" (const out = []) into reference comparison for dirtiness + a prefix rebuild at
 * the first change (in the sync layout without a rest the clean slots before it read from the input a second time,
 * #36; the async layout and the sync rest layout rebuild them from what they hold, #77 and the fourth review of #88;
 * every later slot written from the loop's single read, review of #70):
 *
 *   Length guard (same as the official one, optinStart/optoutStart computed at compile time)
 *   Segment 1 [0, optoutStart): the official unconditional branch out[i] = child(input[i])
 *         → validator check / write back on value reference comparison; absent slots keep the official "materialize" semantics
 *   Segment 2 [optoutStart, N): the official tail-slot gate (out.length === i) + absent truncation / IIFE fill
 *         → the fillLen variable mirrors the official out.length (under CoW the output may still be the input reference,
 *           so .length cannot be read and has to be tracked explicitly)
 *   Segment 3 rest [N, L): the official ungated per-slot write → write back on reference comparison; both layouts
 *         walk stock's `input.slice(N)`, taken after the fixed slots ran and before any rest element runs (#78)
 *
 * Cleanliness: out === input (a copy never happened) ⇔ every slot reference is unchanged, no hole was seen and there
 * was no truncation/fill. Once copied, every visited slot is written.
 * Invariant: out === input ⟹ fillLen === input.length (the truncation/fill paths always copy first).
 *
 * The sync rest layout follows stock's runtime timeline (fourth review of #88, #96). Stock's `$ZodTuple` runtime
 * runs every fixed item and keeps each result, reads `input.slice` once and calls it once (the native slice reads
 * the length, then the constructor, then the species off it, then asks `HasProperty` and `Get` per index and builds
 * its result through the species), iterates what came back with `for...of` running the rest element per yield, and
 * only then decides each fixed slot's presence from the live `input.length` (`handleTupleResults`), assembling from
 * the results it holds. The layout does the same, in the same order, and everything user code can reach between two
 * of those steps (a fixed slot's callback, a `slice` getter, a custom `slice`, a species getter or constructor, an
 * iterator, a rest callback, a Proxy trap) meets the same state on both sides:
 *
 *   - every fixed slot's result is held in a local, and every fresh output is assembled from those locals, never
 *     from a second read of the input (the async layout's rule, #77);
 *   - `slice` is read once; the native one is run by hand (#87: `Array.prototype.slice` costs a near-constant 30 ns
 *     per call, its species lookup and generic entry, where `new Array(n)` plus a copy loop costs a third at a short
 *     rest) with the same reads in the same order, the length once, converted as `ToLength` converts it, then the
 *     constructor, then the species when the constructor is `Array` (the one property read that can run user code,
 *     made at the point the native slice makes it), then `in` and the read per index and nothing else. When the
 *     constructor is `Array` and the species is `Array` the builtin's remaining steps (`ArrayCreate`, the stores
 *     into it, its length, its iteration) run no user code, so the copy stands in for them; a replaced array
 *     iterator or `next` (two data properties compared against the captured ones) sends the copy through `for...of`
 *     instead. Any other constructor or species hands the builtin the reads already made and lets it finish
 *     (`nativeSliceFrom`), and any other `slice` is called as stock calls it; both results are consumed with
 *     `for...of`, the rest element run per yield;
 *   - after the rest ran, the live length is read once more and, when it or the result's source differs from what
 *     the fixed slots decided with, stock's `handleTupleResults` is run over the held results: a slot the new
 *     length excludes truncates the output at the first optional-in slot at or past `optoutStart`, a slot it now
 *     covers is materialized from its held result (a slot the skeleton never ran because an earlier one truncated
 *     is run at its stock position anyway, on `undefined`, and held), a rest result the length excludes reaches
 *     the trailing loop that walks `items` past its end and throws the `TypeError` stock throws there. A length
 *     nothing moved takes none of that: the inline assembly is that algorithm already.
 *
 * What remains: the output is the input by reference when nothing forced a copy, so user code that rewrites a slot
 * whose result is already held is visible in that output only (the CoW premise, §5.3 of the deep dive); the number
 * of `length` reads on a Proxy differs from stock's, and a length that converts to `NaN` is never equal to itself,
 * so it takes the presence decision and stock's fresh output where the other under-reported lengths keep the clean
 * path (#95); a present slot whose product fails returns to stock at once where stock keeps going and may drop the
 * failure with a truncation the rest moved; a `slice` that is not callable throws a `TypeError` on both sides with
 * the engine's message for each call site.
 *
 * Async layout (#71): when a slot or the rest product is async, stock's runtime starts every fixed
 * slot's parse with `input[i]` (an absent slot included) and every rest element's inside its loop,
 * then awaits them together. The skeleton then reads every fixed slot once and starts its product,
 * takes the rest slice and starts every rest element from it, awaits one `Promise.all` over the
 * async ones, and runs the three segments
 * above on the captured reads and the settled results, so a slot with two async children settles in
 * the same round as one with a single child (a sync slot's result is captured in the same pass, in
 * stock's order). Nothing returns between the first start and the `Promise.all`, and nothing is read
 * from the input after it except its length (#77): stock reads `input[i]` and `input.slice(items.length)`
 * before any promise settles but decides presence from the live length in `handleTupleResults`, so
 * the prefix rebuild and the hole test use the captured reads and the slice while the presence
 * guards stay on `input.length`. Its `slice` is the real call, indexed by length (#94).
 */
export function emitCoWTuple(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def as { items: Node[]; rest?: Node };
  const items: Node[] = def.items;
  const rest: Node | undefined = def.rest;
  const N = items.length;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive tuple");
  const childSeen = new Set(seen);
  childSeen.add(schema);

  // The product for each fixed slot (generated once at compile time; key/element/value positions all go through childProduct)
  const itemProducts = items.map((it) => childProduct(it, childSeen, ctx));
  const restProduct = rest ? childProduct(rest, childSeen, ctx) : null;
  const restFn = restProduct ? ctx.addConst(restProduct.fn) : "";
  const anyAsync = itemProducts.some((p) => p.kind === "async") || restProduct?.kind === "async";
  if (anyAsync) ctx.async = true;
  /** The sync rest layout: results held, presence decided after the rest (see the header) */
  const syncRest = !!rest && !anyAsync;

  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);
  const optinStart = getTupleOptStart(items, "optin");
  const optoutStart = getTupleOptStart(items, "optout");
  /** Sync rest layout: the guard's length read, one of the reads the presence decision after the rest is checked against */
  const guardLen = syncRest ? ctx.var() : "";
  // Length guard (same as the official one): [optinStart, N] without rest, >= optinStart with rest
  if (syncRest) {
    ctx.write(`const ${guardLen} = ${accessor}.length;`);
    ctx.write(`if (${guardLen} < ${optinStart}) return INVALID;`);
  } else if (rest) {
    ctx.write(`if (${accessor}.length < ${optinStart}) return INVALID;`);
  } else {
    ctx.write(
      `if (${accessor}.length < ${optinStart} || ${accessor}.length > ${N}) return INVALID;`,
    );
  }

  const out = ctx.var();
  const fillLen = ctx.var();
  ctx.write(`let ${out} = ${accessor};`);
  /** Sync rest layout: the local holding fixed slot i's result, what stock's `handleTupleResults` assembles from
   *  (`itemResults`): the product's output, a validator slot's read, `undefined` for an absent slot that supplies
   *  nothing, INVALID for an absent slot whose run on `undefined` failed (stock drops that failure with the
   *  truncation, unless the rest moved the length over the slot) */
  const slotOut: string[] = [];
  /** Sync rest layout: the local holding the length read fixed slot i decided its presence from (slots from
   *  optinStart on; the guard's read decides for the ones before it) */
  const slotLen: string[] = [];
  if (syncRest && N > 0) {
    for (let i = 0; i < N; i++) {
      slotOut.push(ctx.var());
      slotLen.push(i < optinStart ? guardLen : ctx.var());
    }
    ctx.write(`let ${slotOut.join(", ")};`);
    const gated = slotLen.filter((v) => v !== guardLen);
    if (gated.length > 0) ctx.write(`let ${gated.join(", ")};`);
  }
  /** The fixed slot's result written into its `slotOut` local, when the layout keeps one */
  const keepSlot = (idxExpr: string, valueExpr: string): void => {
    if (idxExpr !== "i" && slotOut.length > 0)
      ctx.write(`${slotOut[Number(idxExpr)]} = ${valueExpr};`);
  };
  /** The length fixed slot i's presence is decided from: the held read in the sync rest layout, the live one elsewhere */
  const lenAt = (i: number): string => (syncRest ? slotLen[i]! : `${accessor}.length`);

  /** Async layout: the local holding the single read of fixed slot i, the one holding whether it was a hole, and the one holding its settled result */
  const slotRead: string[] = [];
  const slotHole: string[] = [];
  const slotResult: string[] = [];
  /** The rest elements: stock's `input.slice(items.length)`, taken after the fixed slots ran (started, in the async
   *  layout) and before any rest product runs, holes preserved, indexed by `i - N` (#78); the async layout's local
   *  holding their settled results */
  const restReads = rest ? ctx.var() : "";
  const restResults = anyAsync && rest ? ctx.var() : "";
  if (anyAsync) {
    const started: string[] = [];
    for (let i = 0; i < N; i++) {
      const e = ctx.var();
      const h = ctx.var();
      const r = ctx.var();
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      ctx.write(`const ${h} = ${e} === undefined && !Object.hasOwn(${accessor}, ${i});`);
      ctx.write(`const ${r} = ${ctx.addConst(itemProducts[i]!.fn)}(${e});`);
      slotRead.push(e);
      slotHole.push(h);
      started.push(r);
      slotResult.push(itemProducts[i]!.kind === "async" ? ctx.var() : r);
    }
    const restStarted = rest ? ctx.var() : "";
    if (rest) {
      // Stock slices the rest before it runs any rest element, so a rest callback that mutates a later rest slot
      // is not observed (second review of #76, #78); a fixed slot's callback that ran before the slice is, like stock
      ctx.write(`const ${restReads} = ${accessor}.slice(${N}), ${restStarted} = [];`);
      ctx.write(`for (let i = 0; i < ${restReads}.length; i++) {`);
      ctx.indented(() => {
        ctx.write(`${restStarted}.push(${restFn}(${restReads}[i]));`);
      });
      ctx.write(`}`);
    }
    const settledVars: string[] = [];
    const startedVars: string[] = [];
    for (let i = 0; i < N; i++) {
      if (itemProducts[i]!.kind !== "async") continue;
      settledVars.push(slotResult[i]!);
      startedVars.push(started[i]!);
    }
    if (rest && restProduct!.kind === "async") {
      settledVars.push(`...${restResults}`);
      startedVars.push(`...${restStarted}`);
    }
    ctx.write(
      `const [${settledVars.join(", ")}] = await Promise.all([${startedVars.join(", ")}]);`,
    );
    if (rest && restProduct!.kind !== "async") {
      ctx.write(`const ${restResults} = ${restStarted};`);
    }
  }
  /** The single read of fixed slot i: emitted here in the sync layout, captured above in the async one */
  const readSlot = (i: number): string => {
    if (anyAsync) return slotRead[i]!;
    const e = ctx.var();
    ctx.write(`const ${e} = ${accessor}[${i}];`);
    return e;
  };
  /** The result of fixed slot i's product on `argExpr`: the call in the sync layout, the settled local in the async one
   *  (started on `input[i]`, which is what an absent slot's `undefined` reads as) */
  const slotCall = (i: number, argExpr: string): string =>
    anyAsync ? slotResult[i]! : `${ctx.addConst(itemProducts[i]!.fn)}(${argExpr})`;

  /** The first forced change at slot `idxExpr` (a fixed slot's literal index, or `i` inside the rest loop): a fresh array
   *  holding the clean prefix [0, idxExpr). The sync layout without a rest reads the fixed slots from the input a second
   *  time (#36); the sync rest layout takes them from the held results and the rest part from the copy (fourth review of
   *  #88); the async layout takes both from its captured reads (#77). Every later slot is written from the loop's single
   *  read (review of #70). A clean prefix holds present, unchanged slots only (an absent slot, a hole or a truncation
   *  copies), so what was read and held is the prefix */
  const copyAt = (idxExpr: string): string => {
    if (syncRest) {
      if (idxExpr !== "i") {
        return `if (${out} === ${accessor}) ${out} = [${slotOut.slice(0, Number(idxExpr)).join(", ")}];`;
      }
      return `if (${out} === ${accessor}) { ${out} = [${slotOut.join(", ")}]; for (let j = ${N}; j < i; j++) ${out}[j] = ${restReads}[j - ${N}]; }`;
    }
    if (!anyAsync) {
      if (idxExpr !== "i") {
        return `if (${out} === ${accessor}) { ${out} = []; for (let j = 0; j < ${idxExpr}; j++) ${out}[j] = ${accessor}[j]; }`;
      }
      // Inside the rest loop the fixed prefix is [0, N) in full: an absent fixed slot copied through its truncation / fill
      return `if (${out} === ${accessor}) { ${out} = []; for (let j = 0; j < ${N}; j++) ${out}[j] = ${accessor}[j]; for (let j = ${N}; j < i; j++) ${out}[j] = ${restReads}[j - ${N}]; }`;
    }
    if (idxExpr !== "i") {
      return `if (${out} === ${accessor}) ${out} = [${slotRead.slice(0, Number(idxExpr)).join(", ")}];`;
    }
    return `if (${out} === ${accessor}) { ${out} = [${slotRead.join(", ")}]; for (let j = ${N}; j < i; j++) ${out}[j] = ${restReads}[j - ${N}]; }`;
  };
  /** A hole: an index the input does not own (`Object.hasOwn`, so an inherited undefined under a hole is one too); a
   *  rest element's is read off the slice, which kept it (#77, #78), and the async layout decided a fixed slot's before
   *  the await. The sync layout's hand copy holds an own slot wherever `in` answered (slice's `HasProperty`), so an
   *  `undefined` the copy owns still asks the input whether it owns the index, the probe every array position makes
   *  on an `undefined` value, from here rather than from the copy loop, so a rest element whose output differs never
   *  raises it (third review of #88); the async layout reads nothing from the input after its await (#77) and keeps
   *  the slice's answer */
  const isHole = (eVar: string, idxExpr: string): string => {
    if (idxExpr === "i") {
      const onCopy = `!Object.hasOwn(${restReads}, i - ${N})`;
      return anyAsync
        ? `${eVar} === undefined && ${onCopy}`
        : `${eVar} === undefined && (${onCopy} || !Object.hasOwn(${accessor}, i))`;
    }
    if (!anyAsync) return `${eVar} === undefined && !Object.hasOwn(${accessor}, ${idxExpr})`;
    return slotHole[Number(idxExpr)]!;
  };
  /** Value-shaped slot (parser/cow/async product), its result `res` (a call expression or a settled local): test for
   *  INVALID + reference comparison + prefix rebuild at the first dirt.
   *  eVar=null marks an absent slot (the official code unconditionally does out[i] = result, including materializing undefined / extending the shape) → write unconditionally. */
  const emitValueSlot = (res: string, idxExpr: string, eVar: string | null): void => {
    const t = ctx.var();
    ctx.write(`const ${t} = ${res};`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    keepSlot(idxExpr, t);
    if (eVar === null) {
      // Absent slot: the official code writes out[i] unconditionally (materializing even when t === undefined, keeping output length/content identical)
      ctx.write(copyAt(idxExpr));
      ctx.write(`${out}[${idxExpr}] = ${t};`);
    } else {
      ctx.write(`if (${out} !== ${accessor}) ${out}[${idxExpr}] = ${t};`);
      ctx.write(`else if (${t} !== ${eVar} || (${isHole(eVar, idxExpr)})) {`);
      ctx.indented(() => {
        ctx.write(copyAt(idxExpr));
        ctx.write(`${out}[${idxExpr}] = ${t};`);
      });
      ctx.write(`}`);
    }
  };
  /** A hole: stock writes every slot it visits, so an index absent from the input is an own undefined in its output (#67) */
  const emitHole = (idxExpr: string): void => {
    ctx.write(copyAt(idxExpr));
    ctx.write(`${out}[${idxExpr}] = undefined;`);
  };
  /** Check-shaped slot (validator product), its result `res`: answers pass/fail only; when absent (eVar=null) the official code
   *  still materializes out[i] = undefined (a pure subtree's output = input = undefined) */
  const emitValidatorSlot = (res: string, idxExpr: string, eVar: string | null): void => {
    ctx.write(`if ((${res}) === INVALID) return INVALID;`);
    if (eVar !== null) {
      // eVar is the local holding the value read from the slot: written once copied, a hole is materialized
      keepSlot(idxExpr, eVar);
      ctx.write(`if (${out} !== ${accessor}) ${out}[${idxExpr}] = ${eVar};`);
      ctx.write(`else if (${isHole(eVar, idxExpr)}) {`);
      ctx.indented(() => emitHole(idxExpr));
      ctx.write(`}`);
    } else {
      // absent + validator (pure optional and friends): stock materializes an undefined slot (output length i+1 > input) → must write
      ctx.write(copyAt(idxExpr));
      ctx.write(`${out}[${idxExpr}] = undefined;`);
    }
  };
  /** The official truncation in three states (the CoW version of out.length = i): already copied → truncate for real; original reference with target ≠ the input length → the prefix [0, i) is the copy; original reference with target = the input length → output = input, no operation */
  const emitTruncate = (i: number): void => {
    ctx.write(`if (${out} !== ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`} else if (${i} !== ${lenAt(i)}) {`);
    ctx.indented(() => {
      ctx.write(copyAt(String(i)));
    });
    ctx.write(`}`);
  };

  /* Segment 1: unconditional slots [0, optoutStart) -- the official `out[i] = compileChild(...)` */
  for (let i = 0; i < optoutStart; i++) {
    const p = itemProducts[i]!;
    ctx.write(`{`);
    ctx.indented(() => {
      const e = readSlot(i);
      if (i < optinStart) {
        // The length guard already proved input.length >= optinStart: the slot is present, so the
        // runtime present/absent split below is skipped for it (this `return` leaves the indented
        // callback for this slot only, not the loop over the slots)
        if (p.kind === "validator") emitValidatorSlot(slotCall(i, e), String(i), e);
        else emitValueSlot(slotCall(i, e), String(i), e);
        return;
      }
      // Absence is not knowable at compile time (input.length is a runtime value) → the present branch is guarded at runtime
      if (syncRest) ctx.write(`${slotLen[i]} = ${accessor}.length;`);
      ctx.write(`if (${i} < ${lenAt(i)}) {`);
      ctx.indented(() => {
        if (p.kind === "validator") emitValidatorSlot(slotCall(i, e), String(i), e);
        else emitValueSlot(slotCall(i, e), String(i), e);
      });
      ctx.write(`} else {`);
      ctx.indented(() => {
        // Absent (i >= input.length): the official code still runs child(undefined) (semantics equivalent to the IIFE)
        if (p.kind === "validator") emitValidatorSlot(slotCall(i, "undefined"), String(i), null);
        else emitValueSlot(slotCall(i, "undefined"), String(i), null);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }
  // End of segment 1: officially out.length = optoutStart (filled in order), mirrored by fillLen
  ctx.write(`let ${fillLen} = ${optoutStart};`);

  /* Segment 2: tail slots [optoutStart, N) -- the official gate + absent truncation / IIFE fill */
  for (let i = optoutStart; i < N; i++) {
    const p = itemProducts[i]!;
    const drop = dropsWhenAbsent(items[i]!); // known at compile time → emit only the branch that applies
    // The first tail slot always sees fillLen === optoutStart (set just above): no gate to emit
    const gated = i > optoutStart;
    /** The official truncation of an absent slot: `out.length = i` */
    const emitAbsentTruncate = (): void => {
      ctx.write(`${fillLen} = ${i};`);
      emitTruncate(i);
    };
    /** The official IIFE branch on its result `t`: INVALID/undefined → truncate, a value → out[i] = t (extends the shape) */
    const emitFill = (t: string): void => {
      ctx.write(`if (${t} === INVALID || ${t} === undefined) {`);
      ctx.indented(emitAbsentTruncate);
      ctx.write(`} else {`);
      ctx.indented(() => {
        ctx.write(copyAt(String(i)));
        ctx.write(`${out}[${i}] = ${t};`);
        ctx.write(`${fillLen} = ${i + 1};`);
      });
      ctx.write(`}`);
    };
    ctx.write(`{`);
    ctx.indented(() => {
      if (syncRest) {
        // The sync rest layout runs every slot at its stock position, gated or not, and holds its result: stock's
        // runtime runs every item before the rest and decides presence after it, so a slot an earlier truncation
        // gates out of the assembly here may still be assembled by `handleTupleResults` when the rest moved the
        // length over it (fourth review of #88). Only the assembly stays behind the official gate
        if (slotLen[i] !== guardLen) ctx.write(`${slotLen[i]} = ${accessor}.length;`);
        ctx.write(`if (${i} < ${slotLen[i]}) {`);
        ctx.indented(() => {
          const e = readSlot(i);
          const t = p.kind === "validator" ? e : ctx.var();
          if (p.kind === "validator") {
            ctx.write(`if ((${slotCall(i, e)}) === INVALID) return INVALID;`);
          } else {
            ctx.write(`const ${t} = ${slotCall(i, e)};`);
            ctx.write(`if (${t} === INVALID) return INVALID;`);
          }
          keepSlot(String(i), t);
          ctx.write(gated ? `if (${fillLen} === ${i}) {` : `{`);
          ctx.indented(() => {
            if (p.kind === "validator") {
              ctx.write(`if (${out} !== ${accessor}) ${out}[${i}] = ${e};`);
              ctx.write(`else if (${isHole(e, String(i))}) {`);
              ctx.indented(() => emitHole(String(i)));
              ctx.write(`}`);
            } else {
              ctx.write(`if (${out} !== ${accessor}) ${out}[${i}] = ${t};`);
              ctx.write(`else if (${t} !== ${e} || (${isHole(e, String(i))})) {`);
              ctx.indented(() => {
                ctx.write(copyAt(String(i)));
                ctx.write(`${out}[${i}] = ${t};`);
              });
              ctx.write(`}`);
            }
            ctx.write(`${fillLen} = ${i + 1};`);
          });
          ctx.write(`}`);
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          if (drop) {
            // The official dropsWhenAbsent branch: nothing runs, the held result stays `undefined` (what the item's run
            // on `undefined` supplies), out.length = i
            ctx.write(gated ? `if (${fillLen} === ${i}) {` : `{`);
            ctx.indented(emitAbsentTruncate);
            ctx.write(`}`);
          } else if (p.kind === "validator") {
            // Pure-subtree slot absent: check child(undefined) (the pure optional family always passes; INVALID guarded defensively) → output = undefined → the official truncation
            ctx.write(`if ((${slotCall(i, "undefined")}) === INVALID) return INVALID;`);
            ctx.write(gated ? `if (${fillLen} === ${i}) {` : `{`);
            ctx.indented(emitAbsentTruncate);
            ctx.write(`}`);
          } else {
            // The official IIFE branch, its result held as it came (INVALID included: stock drops that failure with the
            // truncation, and reports it when the rest moved the length over the slot)
            ctx.write(`${slotOut[i]} = ${slotCall(i, "undefined")};`);
            ctx.write(gated ? `if (${fillLen} === ${i}) {` : `{`);
            ctx.indented(() => emitFill(slotOut[i]!));
            ctx.write(`}`);
          }
        });
        ctx.write(`}`);
        return;
      }
      ctx.write(gated ? `if (${fillLen} === ${i}) {` : `{`);
      ctx.indented(() => {
        ctx.write(`if (${i} < ${accessor}.length) {`);
        ctx.indented(() => {
          const e = readSlot(i);
          if (p.kind === "validator") emitValidatorSlot(slotCall(i, e), String(i), e);
          else emitValueSlot(slotCall(i, e), String(i), e);
          ctx.write(`${fillLen} = ${i + 1};`);
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          if (drop) {
            // The official dropsWhenAbsent branch: out.length = i (truncation)
            emitAbsentTruncate();
          } else if (p.kind === "validator") {
            // Pure-subtree slot absent: check child(undefined) (the pure optional family always passes; INVALID guarded defensively) → output = undefined → the official truncation
            ctx.write(`if ((${slotCall(i, "undefined")}) === INVALID) return INVALID;`);
            emitAbsentTruncate();
          } else {
            // The official IIFE branch: branch = child(undefined); INVALID/undefined → truncate, a value → out[i] = branch (extends the shape)
            const t = ctx.var();
            ctx.write(`const ${t} = ${slotCall(i, "undefined")};`);
            emitFill(t);
          }
        });
        ctx.write(`}`);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }

  /**
   * The sync rest layout's segment 3 and the presence decision after it (the header's timeline). `slice` is read
   * once; the native one is run by hand when the constructor is `Array` and the species is `Array`, with the reads
   * the native slice makes, in its order, and the copy consumed by the inline rest loop when the array iterator is
   * intact; every other case is a continuation that consumes an iterable with `for...of` like stock (the copy under
   * a replaced iterator, the native builtin finished on the facade, or what the custom `slice` answered) and collects
   * the rest results. Then the live length is read once and stock's `handleTupleResults` runs over the held results
   * whenever a continuation ran or the length differs from any read the fixed slots and the copy decided with.
   */
  const emitSyncRest = (emitRestLoop: () => void): void => {
    const sliceFn = ctx.var();
    const len = ctx.var();
    const ctor = ctx.var();
    const species = ctx.var();
    /** The iterable a continuation consumes; `undefined` when the inline rest loop ran on the copy */
    const iterable = ctx.var();
    /** Whether the inline rest loop ran (a custom `slice` may answer `undefined`, so the iterable local cannot tell) */
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
        // written when `in` answered so a hole stays a hole; the own-ness question an `undefined` raises for the CoW
        // decision is asked from the rest loop's hole test (`isHole`, #95)
        ctx.write(`${restReads} = new Array(${len} > ${N} ? Math.floor(${len}) - ${N} : 0);`);
        ctx.write(`for (let j = 0; j < ${restReads}.length; j++) {`);
        ctx.indented(() => {
          ctx.write(`if ((${N} + j) in ${accessor}) ${restReads}[j] = ${accessor}[${N} + j];`);
        });
        ctx.write(`}`);
        // Stock's `for...of` over that array runs the array iterator and its `next`: both data properties, compared
        // against the captured ones after the copy (the last user code before stock reads them is the per-index
        // read); replaced, the copy is consumed with `for...of` like stock's result
        ctx.write(
          `if (Array.prototype[Symbol.iterator] === ${ctx.addConst(NATIVE_ARRAY_ITERATOR)} && ${ctx.addConst(ARRAY_ITERATOR_PROTOTYPE)}.next === ${ctx.addConst(NATIVE_ARRAY_NEXT)}) {`,
        );
        ctx.indented(() => {
          ctx.write(`${inline} = true;`);
          emitRestLoop();
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          ctx.write(`${iterable} = ${restReads};`);
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
        if (restProduct!.kind === "validator") {
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
    // Stock's `handleTupleResults`: presence from the live length, read here, after the rest ran. A length nothing
    // moved since the guard, the fixed slots and the copy read it (the copy's read compared as the number it was
    // converted to) leaves the inline assembly, which is that algorithm for a length that holds; otherwise it runs
    // over the held results: the leading loop truncates at the first
    // optional-in slot at or past `optoutStart` the length excludes (or an excluded slot whose run failed), reports a
    // covered slot's failure, and writes every result it passes; the rest results follow; the trailing loop drops
    // trailing `undefined` results of optional-out slots the length excludes and, past `items`, throws where stock
    // throws (the same read on the same `items`, so the engine's own `TypeError` and message)
    const live = ctx.var();
    ctx.write(`const ${live} = ${accessor}.length;`);
    const holds = [
      ...[guardLen, ...slotLen.filter((v) => v !== guardLen)].map((v) => `${live} === ${v}`),
      `+${live} === ${len}`,
    ].join(" && ");
    ctx.write(`if (${results} !== null || !(${holds})) {`);
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
        ctx.write(
          `const rs = ${results} !== null ? ${results} : ${fromOut} ? ${out} : ${restReads}, off = ${results} === null && ${fromOut} ? ${N} : 0, k = ${results} !== null ? ${results}.length : ${restReads}.length;`,
        );
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
  };

  /* Segment 3: rest [N, L) -- the official ungated per-slot write over stock's slice, taken here in the sync layout
     (after every fixed slot ran, before any rest element runs, #78) and before the await in the async one (#77) */
  if (rest && restProduct) {
    /** The rest loop over the slice in `restReads` (the settled results in the async layout): the official ungated
     *  per-slot write, decorated with the reference comparison and the prefix rebuild at the first dirt */
    const emitRestLoop = (): void => {
      ctx.write(`for (let i = ${N}; i < ${N} + ${restReads}.length; i++) {`);
      ctx.indented(() => {
        // The sync layout calls the rest product on the sliced element in the loop; the async one reads its settled result
        const e = ctx.var();
        ctx.write(`const ${e} = ${restReads}[i - ${N}];`);
        const res = anyAsync ? `${restResults}[i - ${N}]` : `${restFn}(${e})`;
        if (restProduct.kind === "validator") {
          ctx.write(`if ((${res}) === INVALID) return INVALID;`);
          ctx.write(`if (${out} !== ${accessor}) ${out}[i] = ${e};`);
          ctx.write(`else if (${isHole(e, "i")}) {`);
          ctx.indented(() => emitHole("i"));
          ctx.write(`}`);
        } else {
          const t = ctx.var();
          ctx.write(`const ${t} = ${res};`);
          ctx.write(`if (${t} === INVALID) return INVALID;`);
          ctx.write(`if (${out} !== ${accessor}) ${out}[i] = ${t};`);
          ctx.write(`else if (${t} !== ${e} || (${isHole(e, "i")})) {`);
          ctx.indented(() => {
            ctx.write(copyAt("i"));
            ctx.write(`${out}[i] = ${t};`);
          });
          ctx.write(`}`);
        }
      });
      ctx.write(`}`);
    };
    if (anyAsync) {
      emitRestLoop();
    } else {
      emitSyncRest(emitRestLoop);
    }
  }

  // The container's own checks (tuple .refine pure predicates): both paths, same as the object/array skeletons
  if (!emitContainerChecks(ctx, schema, accessor, out, `${out} === ${accessor}`)) {
    ctx.write(`if (${out} === ${accessor}) return ${accessor};`);
  }

  return out;
}
