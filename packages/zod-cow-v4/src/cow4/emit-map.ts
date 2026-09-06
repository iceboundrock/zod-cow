/** Map skeleton: key/value double reference comparison + ordered rebuild of the clean prefix at the first change. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── map skeleton: key/value double reference comparison + ordered rebuild of the clean prefix at the first change ── */

export function emitCoWMap(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { keyType: Node; valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Map)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  const idx = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0;`);
  ctx.write(`for (const [kIn, vIn] of ${accessor}) {`);
  ctx.indented(() => {
    // Key: a value position -- a pure key is validated by the validator and its name never changes; an impure key uses the parser product (returning the converted key name); async → await
    const keyProduct = childProduct(def.keyType, childSeen, ctx);
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
    const product = childProduct(def.valueType, childSeen, ctx);
    const vf = ctx.addConst(product.fn);
    const vAsync = product.kind === "async";
    if (vAsync) ctx.async = true;
    const vAwait = vAsync ? "await " : "";
    let valExpr = "vIn";
    if (product.kind === "validator") {
      ctx.write(`if (${vf}(vIn) === INVALID) return INVALID;`);
    } else {
      const vo = ctx.var();
      ctx.write(`const ${vo} = ${vAwait}${vf}(vIn);`);
      ctx.write(`if (${vo} === INVALID) return INVALID;`);
      valExpr = vo;
    }
    // Both pure: the name and the value never change, so the loop has no dirty path
    if (keyExpr === "kIn" && valExpr === "vIn") return;
    // Stock sets the parsed pairs into a fresh Map in iteration order, so a transformed key that
    // collides with a later entry is overwritten by it and the output keeps the input's order.
    // The first forced change rebuilds the clean prefix (the first `idx` pairs) into an empty Map
    // and every later pair is written after it, never `new Map(input)` plus delete/set (#67).
    const clean = [
      keyExpr !== "kIn" ? `${keyExpr} === kIn` : "",
      valExpr !== "vIn" ? `${valExpr} === vIn` : "",
    ]
      .filter(Boolean)
      .join(" && ");
    ctx.write(`if (!${dirty}) {`);
    ctx.indented(() => {
      ctx.write(`if (${clean}) { ${idx}++; continue; }`);
      ctx.write(`${dirty} = true; ${out} = new Map();`);
      ctx.write(
        `let j = 0; for (const e of ${accessor}) { if (j++ === ${idx}) break; ${out}.set(e[0], e[1]); }`,
      );
    });
    ctx.write(`}`);
    ctx.write(`${idx}++;`);
    ctx.write(`${out}.set(${keyExpr}, ${valExpr});`);
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
