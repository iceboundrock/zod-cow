/** Map skeleton: key/value double reference comparison + conditional new Map(input) copy. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── map skeleton: key/value double reference comparison + conditional new Map(input) copy ── */

export function emitCoWMap(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { keyType: Node; valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Map)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (const [kIn, vIn] of ${accessor}) {`);
  ctx.indented(() => {
    // Key: a value position -- a pure key is validated by the validator and its name never changes; an impure key uses the parser product (returning the converted key name); async → await
    const keyProduct = childProduct(def.keyType, childSeen);
    const kf = ctx.addConst(keyProduct.fn);
    const keyAsync = keyProduct.kind === "async";
    if (keyAsync) ctx.async = true;
    const kAwait = keyAsync ? "await " : "";
    let keyExpr = "kIn";
    if (keyProduct.kind === "validator") {
      ctx.write(`if (${kf}(kIn) === INVALID) return INVALID;`);
    } else {
      const ko = ctx.var();
      ctx.write(`const ${ko} = ${kAwait}${kf}(kIn);`);
      ctx.write(`if (${ko} === INVALID) return INVALID;`);
      keyExpr = ko;
    }
    const product = childProduct(def.valueType, childSeen);
    const vf = ctx.addConst(product.fn);
    const vAsync = product.kind === "async";
    if (vAsync) ctx.async = true;
    const vAwait = vAsync ? "await " : "";
    if (product.kind === "validator") {
      ctx.write(`if (${vf}(vIn) === INVALID) return INVALID;`);
      if (keyExpr !== "kIn") {
        // The key was converted but the value did not change: the official output is set(new key, original value) → a changed key name alone means dirty
        ctx.write(`if (${keyExpr} !== kIn) {`);
        ctx.indented(() => {
          ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Map(${accessor}); }`);
          ctx.write(`if (${keyExpr} !== kIn) ${out}.delete(kIn);`);
          ctx.write(`${out}.set(${keyExpr}, vIn);`);
        });
        ctx.write(`}`);
      }
    } else {
      const vo = ctx.var();
      ctx.write(`const ${vo} = ${vAwait}${vf}(vIn);`);
      ctx.write(`if (${vo} === INVALID) return INVALID;`);
      ctx.write(`if (${vo} !== vIn || ${keyExpr} !== kIn) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Map(${accessor}); }`);
        ctx.write(`if (${keyExpr} !== kIn) ${out}.delete(kIn);`);
        ctx.write(`${out}.set(${keyExpr}, ${vo});`);
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
