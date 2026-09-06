/** Array skeleton: element-level reference comparison + prefix rebuild at the first change, holes materialized. */
import type { CodeCtx } from "./codectx.js";
import { containerChildFn, emitContainerChecks } from "./emit.js";
import { officialFn } from "./official.js";
import { type Fn, isAsyncProduct, type Node } from "./product.js";
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

  // The first forced change (a changed element or a hole) rebuilds the clean prefix into a fresh
  // array, reading those elements from the input a second time (#36), and every later element is
  // written from the single read the loop makes, so a getter or a hole after the first change is
  // observed exactly as stock observes it. `slice()` did neither: it re-read every element and kept
  // a hole where stock writes an own undefined slot (#67, review of #70). A hole is an index the
  // input does not own (`Object.hasOwn`: an inherited undefined under a hole is still a hole, where
  // `in` called it present); an inherited value under a hole reads as that value and stays the
  // prototype limitation of the clean path (#48).
  const copy = `${dirty} = true; ${out} = new Array(${accessor}.length); for (let j = 0; j < ${i}; j++) ${out}[j] = ${accessor}[j];`;
  const hole = `${e} === undefined && !Object.hasOwn(${accessor}, ${i})`;
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  /** The comparison of element `i`, read once into `e`, against its settled result `res` (a call expression or a local) */
  const emitElement = (res: string): void => {
    if (elemPure && !elemIsContainer) {
      // Pure leaf element: value === input, no copy unless a hole forced one (the validator product returns true and cannot be reference-compared)
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
    const reads = ctx.var();
    const started = ctx.var();
    const settled = ctx.var();
    ctx.write(
      `const ${reads} = new Array(${accessor}.length), ${started} = new Array(${accessor}.length);`,
    );
    ctx.write(`for (let ${i} = 0; ${i} < ${accessor}.length; ${i}++) {`);
    ctx.indented(() => {
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      ctx.write(`${reads}[${i}] = ${e};`);
      ctx.write(`${started}[${i}] = ${f}(${e});`);
    });
    ctx.write(`}`);
    ctx.write(`const ${settled} = await Promise.all(${started});`);
    ctx.write(`for (let ${i} = 0; ${i} < ${accessor}.length; ${i}++) {`);
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
