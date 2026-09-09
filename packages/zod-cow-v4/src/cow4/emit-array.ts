/** Array skeleton: element-level reference comparison + prefix rebuild at the first change, an undefined element copied. */
import type { CodeCtx } from "./codectx.js";
import { containerChildFn, emitContainerChecks } from "./emit.js";
import { officialFn } from "./official.js";
import { type Fn, hasPromise, isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── array skeleton: element-level reference comparison + prefix rebuild at the first change ── */

export function emitCoWArray(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const element: Node = schema._zod.def.element;
  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);

  const childSeen = new Set(seen);
  childSeen.add(schema);
  const elemPure = isPure(element);
  const elemIsContainer = cowSafeContainerForChild(element);

  // Element handler: container (including a wrapper chain) → CoW sub-skeleton (strip semantics intact); pure leaf → official validator; everything else → official parser; async → async island
  let elemFn: Fn;
  if (elemIsContainer) {
    elemFn = containerChildFn(element, childSeen, ctx);
  } else {
    elemFn = officialFn(element, elemPure);
  }
  const f = ctx.addConst(elemFn);
  const elemAsync = isAsyncProduct(elemFn);
  if (elemAsync) ctx.async = true;

  const out = ctx.var();
  const dirty = ctx.var();
  const i = ctx.var();
  const e = ctx.var();
  const t = ctx.var();

  // The first forced change (a changed element or an undefined one) rebuilds the clean prefix into
  // a fresh array, reading those elements from the input a second time (#36), and every later
  // element is written from the single read the loop makes, so a getter or a hole after the first
  // change is observed exactly as stock observes it. `slice()` did neither: it re-read every element
  // and kept a hole where stock writes an own undefined slot (#67, review of #70). An element that
  // reads as `undefined` and comes back unchanged is judged dirty without asking whether the index
  // is own (#95): stock's output holds an own `undefined` slot there whether the input held an own
  // `undefined`, a hole, or a hole over an inherited `undefined`, and the own-ness test that told
  // those apart (`Object.hasOwn`) was a `getOwnPropertyDescriptor` trap stock never consults; the
  // reference is lost for an input holding an explicit `undefined` member, the class of `z.nan()`.
  // An inherited value under a hole reads as that value and stays the prototype limitation of the
  // clean path (#48). The async layout below rebuilds the prefix from the reads it captured before
  // the await (#77): a child may mutate the input before its promise settles, and stock, which
  // reads every element once before any promise settles, does not observe that mutation.
  const reads = ctx.var();
  const len0 = ctx.var();
  const copy = elemAsync
    ? `${dirty} = true; ${out} = new Array(${len0}); for (let j = 0; j < ${i}; j++) ${out}[j] = ${reads}[j];`
    : `${dirty} = true; ${out} = new Array(${accessor}.length); for (let j = 0; j < ${i}; j++) ${out}[j] = ${accessor}[j];`;
  const hole = `${e} === undefined`;
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  /** The comparison of element `i`, read once into `e`, against its settled result `res` (a call expression or a local) */
  const emitElement = (res: string): void => {
    if (elemPure && !elemIsContainer) {
      // Pure leaf element: value === input, no copy unless an undefined value forced one (the validator product returns true and cannot be reference-compared)
      ctx.write(`if (${res} === INVALID) return INVALID;`);
      ctx.write(`if (${dirty}) ${out}[${i}] = ${e};`);
      ctx.write(`else if (${hole}) { ${copy} ${out}[${i}] = undefined; }`);
    } else {
      // Container elements go through the sub-skeleton: the product returns the original reference or a new container, so a reference comparison is safe
      ctx.write(`const ${t} = ${res};`);
      ctx.write(`if (${t} === INVALID) return INVALID;`);
      ctx.write(`if (${dirty}) ${out}[${i}] = ${t};`);
      ctx.write(`else if (${t} !== ${e} || (${hole})) { ${copy} ${out}[${i}] = ${t}; }`);
    }
  };
  if (!elemAsync) {
    ctx.write(`for (let ${i} = 0; ${i} < ${accessor}.length; ${i}++) {`);
    ctx.indented(() => {
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      emitElement(`${f}(${e})`);
    });
    ctx.write(`}`);
  } else {
    // Async element (#71): stock's runtime starts every element's parse inside its loop and awaits
    // them together. The first loop reads each element once and starts its product, one
    // `Promise.all` settles them, and the second loop runs the comparisons above on the captured
    // reads and the settled results (the async path allocates two arrays; the sync path none).
    // Nothing is read from the input after the await (#77): the length stock sizes its output with
    // is taken before the loop, the loop bound is live like stock's, and the second loop covers the
    // elements the first one visited.
    const started = ctx.var();
    const settled = ctx.var();
    const n = ctx.var();
    ctx.write(
      `const ${len0} = ${accessor}.length, ${reads} = new Array(${len0}), ${started} = new Array(${len0});`,
    );
    ctx.write(`let ${n} = 0;`);
    ctx.write(`for (; ${n} < ${accessor}.length; ${n}++) {`);
    ctx.indented(() => {
      ctx.write(`const ${e} = ${accessor}[${n}];`);
      ctx.write(`${reads}[${n}] = ${e};`);
      ctx.write(`${started}[${n}] = ${f}(${e});`);
    });
    ctx.write(`}`);
    // No element suspended: the started results are the settled ones and the skeleton completes synchronously (#105)
    ctx.write(`let ${settled} = ${started};`);
    ctx.write(
      `if (${ctx.addConst(hasPromise)}(${started})) ${settled} = yield Promise.all(${started});`,
    );
    ctx.write(`for (let ${i} = 0; ${i} < ${n}; ${i}++) {`);
    ctx.indented(() => {
      ctx.write(`const ${e} = ${reads}[${i}];`);
      emitElement(`${settled}[${i}]`);
    });
    ctx.write(`}`);
  }

  // The container's own checks (array .min/.max/.length/.refine): both paths, same as the object skeleton
  emitContainerChecks(ctx, schema, accessor, out, `!${dirty}`);

  return out;
}
