/** Map skeleton: key/value double reference comparison + conditional new Map(input) copy. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── map 骨架：键/值双引用比较 + new Map(input) 条件拷贝 ── */

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
    // 键：值位置 —— 纯键用 validator 校验 + 键名恒不变；非纯键用 parser 产物（返回转换后键名）；async → await
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
        // 键被转换但值没变：官方输出 set(新键, 原值) → 键名变化即脏
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
