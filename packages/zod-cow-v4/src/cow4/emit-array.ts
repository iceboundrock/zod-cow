/** Array skeleton: element-level reference comparison + conditional slice() copy. */
import type { CodeCtx } from "./codectx.js";
import { containerChecksFn, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { type Fn, isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── array skeleton: element-level reference comparison + conditional slice copy ── */

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
  const awaitKw = elemAsync ? "await " : "";

  const out = ctx.var();
  const dirty = ctx.var();
  const i = ctx.var();
  const e = ctx.var();
  const t = ctx.var();

  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (let ${i} = 0; ${i} < ${accessor}.length; ${i}++) {`);
  ctx.indented(() => {
    ctx.write(`const ${e} = ${accessor}[${i}];`);
    ctx.write(`const ${t} = ${awaitKw}${f}(${e});`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    if (elemPure && !elemIsContainer) {
      // Pure leaf element: value === input, no copy (the validator product returns true and cannot be reference-compared)
      // Container elements go through the sub-skeleton: the product returns the original reference or a new container, so a reference comparison is safe
    } else {
      ctx.write(`if (${t} !== ${e}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = ${accessor}.slice(); }`);
        ctx.write(`${out}[${i}] = ${t};`);
      });
      ctx.write(`}`);
    }
  });
  ctx.write(`}`);

  // The container's own checks (array .min/.max/.length/.refine): both paths, same as the object skeleton
  const checksFn = containerChecksFn(schema);
  if (checksFn) {
    const cName = ctx.addConst(checksFn);
    ctx.write(`if (!${dirty}) {`);
    ctx.indented(() => {
      ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
    ctx.write(`if (${cName}(${out}) === INVALID) return INVALID;`);
  }

  return out;
}
