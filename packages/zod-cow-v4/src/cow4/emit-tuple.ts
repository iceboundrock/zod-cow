/**
 * Tuple skeleton: mirrors zod's generateTupleCheck with fillLen truncation tracking
 * + CoW decoration.
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import type { CodeCtx } from "./codectx.js";
import { type ChildProduct, childProduct, containerChecksFn } from "./emit.js";
import { dropsWhenAbsent, getTupleOptStart } from "./predicates.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── tuple skeleton: mirrors the official generateTupleCheck + fillLen truncation tracking + CoW decoration ── */

/**
 * The tuple CoW skeleton -- line for line with the official generateTupleCheck; the only difference is rewriting
 * the "unconditional new container" (const out = []) into reference comparison for dirtiness + conditional slice copy:
 *
 *   Length guard (same as the official one, optinStart/optoutStart computed at compile time)
 *   Segment 1 [0, optoutStart): the official unconditional branch out[i] = child(input[i])
 *         → validator check / write back on value reference comparison; absent slots keep the official "materialize" semantics
 *   Segment 2 [optoutStart, N): the official tail-slot gate (out.length === i) + absent truncation / IIFE fill
 *         → the fillLen variable mirrors the official out.length (under CoW the output may still be the input reference,
 *           so .length cannot be read and has to be tracked explicitly)
 *   Segment 3 rest [N, L): the official ungated per-slot write → write back on reference comparison
 *
 * Cleanliness: out === input (a copy never happened) ⇔ every slot reference is unchanged and there was no truncation/fill.
 * Invariant: out === input ⟹ fillLen === input.length (the truncation/fill paths always copy first).
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

  const out = ctx.var();
  const fillLen = ctx.var();
  ctx.write(`let ${out} = ${accessor};`);

  /** Value-shaped slot (parser/cow/async product): test for INVALID + reference comparison + slice write-back at the first dirt.
   *  eVar=null marks an absent slot (the official code unconditionally does out[i] = result, including materializing undefined / extending the shape) → write unconditionally. */
  const emitValueSlot = (
    p: ChildProduct,
    argExpr: string,
    idxExpr: string,
    eVar: string | null,
  ): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    const t = ctx.var();
    ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${argExpr});`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    if (eVar === null) {
      // Absent slot: the official code writes out[i] unconditionally (materializing even when t === undefined, keeping output length/content identical)
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = ${t};`);
    } else {
      ctx.write(`if (${t} !== ${eVar}) {`);
      ctx.indented(() => {
        ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
        ctx.write(`${out}[${idxExpr}] = ${t};`);
      });
      ctx.write(`} else if (${eVar} === undefined && !(${idxExpr} in ${accessor})) {`);
      ctx.indented(() => emitHole(idxExpr));
      ctx.write(`}`);
    }
  };
  /** A hole: stock writes every slot it visits, so an index absent from the input is an own undefined in its output, where `slice()` keeps the hole (#67) */
  const emitHole = (idxExpr: string): void => {
    ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
    ctx.write(`${out}[${idxExpr}] = undefined;`);
  };
  /** Check-shaped slot (validator product): answers pass/fail only; when absent the official code still materializes out[i] = undefined (a pure subtree's output = input = undefined) */
  const emitValidatorSlot = (
    p: ChildProduct,
    argExpr: string,
    idxExpr: string,
    present: boolean,
  ): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`if ((${isA ? "await " : ""}${f}(${argExpr})) === INVALID) return INVALID;`);
    if (present) {
      // argExpr is the local holding the value read from the slot: a hole is materialized
      ctx.write(`if (${argExpr} === undefined && !(${idxExpr} in ${accessor})) {`);
      ctx.indented(() => emitHole(idxExpr));
      ctx.write(`}`);
    } else {
      // absent + validator (pure optional and friends): stock materializes an undefined slot (output length i+1 > input) → must write
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = undefined;`);
    }
  };
  /** The official truncation in three states (the CoW version of out.length = i): already copied → truncate for real; original reference with target ≠ the input length → copy then truncate; original reference with target = the input length → output = input, no operation */
  const emitTruncate = (i: number): void => {
    ctx.write(`if (${out} !== ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`} else if (${i} !== ${accessor}.length) {`);
    ctx.indented(() => {
      ctx.write(`${out} = ${accessor}.slice();`);
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`}`);
  };

  /* Segment 1: unconditional slots [0, optoutStart) -- the official `out[i] = compileChild(...)` */
  for (let i = 0; i < optoutStart; i++) {
    const p = itemProducts[i]!;
    ctx.write(`{`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      if (i < optinStart) {
        // The length guard already proved input.length >= optinStart: the slot is present, so the
        // runtime present/absent split below is skipped for it (this `return` leaves the indented
        // callback for this slot only, not the loop over the slots)
        if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
        else emitValueSlot(p, e, String(i), e);
        return;
      }
      // Absence is not knowable at compile time (input.length is a runtime value) → the present branch is guarded at runtime
      ctx.write(`if (${i} < ${accessor}.length) {`);
      ctx.indented(() => {
        if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
        else emitValueSlot(p, e, String(i), e);
      });
      ctx.write(`} else {`);
      ctx.indented(() => {
        // Absent (i >= input.length): the official code still runs child(undefined) (semantics equivalent to the IIFE)
        if (p.kind === "validator") emitValidatorSlot(p, "undefined", String(i), false);
        else emitValueSlot(p, "undefined", String(i), null);
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
          const e = ctx.var();
          ctx.write(`const ${e} = ${accessor}[${i}];`);
          if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
          else emitValueSlot(p, e, String(i), e);
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
            const f = ctx.addConst(p.fn);
            const isA = (p as ChildProduct).kind === "async"; // defensive (a validator product is always sync)
            if (isA) ctx.async = true;
            ctx.write(`if ((${isA ? "await " : ""}${f}(undefined)) === INVALID) return INVALID;`);
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else {
            // The official IIFE branch: branch = child(undefined); INVALID/undefined → truncate, a value → out[i] = branch (extends the shape)
            const f = ctx.addConst(p.fn);
            const isA = p.kind === "async";
            if (isA) ctx.async = true;
            const t = ctx.var();
            ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(undefined);`);
            ctx.write(`if (${t} === INVALID || ${t} === undefined) {`);
            ctx.indented(() => {
              ctx.write(`${fillLen} = ${i};`);
              emitTruncate(i);
            });
            ctx.write(`} else {`);
            ctx.indented(() => {
              ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
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

  /* Segment 3: rest [N, L) -- the official ungated per-slot write */
  if (rest) {
    const restProduct = childProduct(rest, childSeen, ctx);
    const f = ctx.addConst(restProduct.fn);
    const isA = restProduct.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`for (let i = ${N}; i < ${accessor}.length; i++) {`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[i];`);
      if (restProduct.kind === "validator") {
        ctx.write(`if ((${isA ? "await " : ""}${f}(${e})) === INVALID) return INVALID;`);
        ctx.write(`if (${e} === undefined && !(i in ${accessor})) {`);
        ctx.indented(() => emitHole("i"));
        ctx.write(`}`);
      } else {
        const t = ctx.var();
        ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${e});`);
        ctx.write(`if (${t} === INVALID) return INVALID;`);
        ctx.write(`if (${t} !== ${e}) {`);
        ctx.indented(() => {
          ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
          ctx.write(`${out}[i] = ${t};`);
        });
        ctx.write(`} else if (${e} === undefined && !(i in ${accessor})) {`);
        ctx.indented(() => emitHole("i"));
        ctx.write(`}`);
      }
    });
    ctx.write(`}`);
  }

  // The container's own checks (tuple .refine pure predicates): both paths, same as the object/array skeletons
  const checksFn = containerChecksFn(schema);
  if (checksFn) {
    const cName = ctx.addConst(checksFn);
    const isA = isAsyncProduct(checksFn);
    const awaitKw = isA ? "await " : "";
    ctx.write(`if (${out} === ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if ((${awaitKw}${cName}(${accessor})) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
    ctx.write(`if ((${awaitKw}${cName}(${out})) === INVALID) return INVALID;`);
  } else {
    ctx.write(`if (${out} === ${accessor}) return ${accessor};`);
  }

  return out;
}
