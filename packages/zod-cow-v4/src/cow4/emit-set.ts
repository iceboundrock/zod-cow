/** Set skeleton: member reference comparison + ordered rebuild of the clean prefix at the first change. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── set skeleton: member reference comparison + ordered rebuild of the clean prefix at the first change ── */

export function emitCoWSet(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Set)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  const idx = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0;`);
  ctx.write(`for (const vIn of ${accessor}) {`);
  ctx.indented(() => {
    const product = childProduct(def.valueType, childSeen, ctx);
    const f = ctx.addConst(product.fn);
    if (product.kind === "validator") {
      // A pure member never changes: the loop has no dirty path (the counter stays unused)
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
      // Stock adds the parsed members to a fresh Set in iteration order, so a transformed member
      // that lands on a later member is overwritten by it and the output keeps the input's order.
      // The first forced change rebuilds the clean prefix (the first `idx` members) into an empty
      // Set and every later member is written after it, never `new Set(input)` plus delete/add (#67).
      // NaN false positive: vo !== vIn is always true for NaN → an over-copy with the same members.
      ctx.write(`if (!${dirty}) {`);
      ctx.indented(() => {
        ctx.write(`if (${vo} === vIn) { ${idx}++; continue; }`);
        ctx.write(`${dirty} = true; ${out} = new Set();`);
        ctx.write(
          `let j = 0; for (const m of ${accessor}) { if (j++ === ${idx}) break; ${out}.add(m); }`,
        );
      });
      ctx.write(`}`);
      ctx.write(`${idx}++;`);
      ctx.write(`${out}.add(${vo});`);
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
