/**
 * Tuple skeleton: mirrors zod's generateTupleCheck with fillLen truncation tracking
 * + CoW decoration.
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import type { CodeCtx } from "./codectx.js";
import { childProduct, emitContainerChecks } from "./emit.js";
import { dropsWhenAbsent, getTupleOptStart } from "./predicates.js";
import type { Node } from "./product.js";

/* ── tuple skeleton: mirrors the official generateTupleCheck + fillLen truncation tracking + CoW decoration ── */

/**
 * The tuple CoW skeleton -- line for line with the official generateTupleCheck; the only difference is rewriting
 * the "unconditional new container" (const out = []) into reference comparison for dirtiness + a prefix rebuild at
 * the first change (in the sync layout the clean slots before it read from the input a second time, #36; the async
 * layout rebuilds them from its captured reads, #77; every later slot written from the loop's single read, review of #70):
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
 * The rest slice (#78): stock's runtime takes `const rest = input.slice(items.length)` after it started every
 * fixed slot and before it runs any rest element, so a sync rest callback that mutates a later rest slot is
 * not observed by stock, while a fixed slot's callback that mutates a rest slot before the slice is. Both
 * layouts take the same slice at the same point and walk it: the rest loop reads its elements off the slice,
 * a rest hole is `Object.hasOwn` on the slice, and the prefix rebuild takes the rest part from it. It is the
 * one allocation on the clean path of a tuple with a rest element (a tuple without one allocates nothing).
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
 * guards stay on `input.length`.
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

  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);
  const optinStart = getTupleOptStart(items, "optin");
  const optoutStart = getTupleOptStart(items, "optout");
  // Length guard (same as the official one): [optinStart, N] without rest, >= optinStart with rest
  if (rest) {
    ctx.write(`if (${accessor}.length < ${optinStart}) return INVALID;`);
  } else {
    ctx.write(
      `if (${accessor}.length < ${optinStart} || ${accessor}.length > ${N}) return INVALID;`,
    );
  }

  // The product for each fixed slot (generated once at compile time; key/element/value positions all go through childProduct)
  const itemProducts = items.map((it) => childProduct(it, childSeen, ctx));
  const restProduct = rest ? childProduct(rest, childSeen, ctx) : null;
  const restFn = restProduct ? ctx.addConst(restProduct.fn) : "";
  const anyAsync = itemProducts.some((p) => p.kind === "async") || restProduct?.kind === "async";
  if (anyAsync) ctx.async = true;

  const out = ctx.var();
  const fillLen = ctx.var();
  ctx.write(`let ${out} = ${accessor};`);

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
   *  holding the clean prefix [0, idxExpr). The sync layout reads the fixed slots from the input a second time (#36) and
   *  the rest part from the slice (#78); the async layout takes both from its captured reads (#77). Every later slot is
   *  written from the loop's single read (review of #70) */
  const copyAt = (idxExpr: string): string => {
    if (!anyAsync) {
      if (idxExpr !== "i") {
        return `if (${out} === ${accessor}) { ${out} = []; for (let j = 0; j < ${idxExpr}; j++) ${out}[j] = ${accessor}[j]; }`;
      }
      // Inside the rest loop the fixed prefix is [0, N) in full: an absent fixed slot copied through its truncation / fill
      return `if (${out} === ${accessor}) { ${out} = []; for (let j = 0; j < ${N}; j++) ${out}[j] = ${accessor}[j]; for (let j = ${N}; j < i; j++) ${out}[j] = ${restReads}[j - ${N}]; }`;
    }
    if (idxExpr !== "i") {
      // A clean prefix holds present, unchanged slots only (an absent slot, a hole or a truncation copies), so the captured reads are the prefix
      return `if (${out} === ${accessor}) ${out} = [${slotRead.slice(0, Number(idxExpr)).join(", ")}];`;
    }
    return `if (${out} === ${accessor}) { ${out} = [${slotRead.join(", ")}]; for (let j = ${N}; j < i; j++) ${out}[j] = ${restReads}[j - ${N}]; }`;
  };
  /** A hole: an index the input does not own (`Object.hasOwn`, so an inherited undefined under a hole is one too); a
   *  rest element's is read off the slice, which kept it (#77, #78), and the async layout decided a fixed slot's before
   *  the await */
  const isHole = (eVar: string, idxExpr: string): string => {
    if (idxExpr === "i") return `${eVar} === undefined && !Object.hasOwn(${restReads}, i - ${N})`;
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
    ctx.write(`} else if (${i} !== ${accessor}.length) {`);
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
      ctx.write(`if (${i} < ${accessor}.length) {`);
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
    ctx.write(`{`);
    ctx.indented(() => {
      // The first tail slot always sees fillLen === optoutStart (set just above): no gate to emit
      const gated = i > optoutStart;
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
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else if (p.kind === "validator") {
            // Pure-subtree slot absent: check child(undefined) (the pure optional family always passes; INVALID guarded defensively) → output = undefined → the official truncation
            ctx.write(`if ((${slotCall(i, "undefined")}) === INVALID) return INVALID;`);
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else {
            // The official IIFE branch: branch = child(undefined); INVALID/undefined → truncate, a value → out[i] = branch (extends the shape)
            const t = ctx.var();
            ctx.write(`const ${t} = ${slotCall(i, "undefined")};`);
            ctx.write(`if (${t} === INVALID || ${t} === undefined) {`);
            ctx.indented(() => {
              ctx.write(`${fillLen} = ${i};`);
              emitTruncate(i);
            });
            ctx.write(`} else {`);
            ctx.indented(() => {
              ctx.write(copyAt(String(i)));
              ctx.write(`${out}[${i}] = ${t};`);
              ctx.write(`${fillLen} = ${i + 1};`);
            });
            ctx.write(`}`);
          }
        });
        ctx.write(`}`);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }

  /* Segment 3: rest [N, L) -- the official ungated per-slot write over stock's slice, taken here in the sync layout
     (after every fixed slot ran, before any rest element runs, #78) and before the await in the async one (#77) */
  if (rest && restProduct) {
    if (!anyAsync) ctx.write(`const ${restReads} = ${accessor}.slice(${N});`);
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
  }

  // The container's own checks (tuple .refine pure predicates): both paths, same as the object/array skeletons
  if (!emitContainerChecks(ctx, schema, accessor, out, `${out} === ${accessor}`)) {
    ctx.write(`if (${out} === ${accessor}) return ${accessor};`);
  }

  return out;
}
