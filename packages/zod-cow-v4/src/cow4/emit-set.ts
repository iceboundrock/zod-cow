/** Set skeleton: member reference comparison + conditional new Set(input) copy. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── set skeleton: member reference comparison + conditional new Set(input) copy ── */

export function emitCoWSet(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Set)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (const vIn of ${accessor}) {`);
  ctx.indented(() => {
    const product = childProduct(def.valueType, childSeen, ctx.options);
    const f = ctx.addConst(product.fn);
    if (product.kind === "validator") {
      ctx.write(`if (${f}(vIn) === INVALID) return INVALID;`);
    } else {
      const vo = ctx.var();
      if (product.kind === "async") {
        ctx.async = true;
        ctx.write(`const ${vo} = await ${f}(vIn);`);
      } else {
        ctx.write(`const ${vo} = ${f}(vIn);`);
      }
      ctx.write(`if (${vo} === INVALID) return INVALID;`);
      // NaN false positive: vo!==vIn is always true for NaN → over-copies but the result is correct (under SameValueZero, delete/add is equivalent)
      ctx.write(`if (${vo} !== vIn) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Set(${accessor}); }`);
        ctx.write(`${out}.delete(vIn);`);
        ctx.write(`${out}.add(${vo});`);
      });
      ctx.write(`}`);
    }
  });
  ctx.write(`}`);

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
