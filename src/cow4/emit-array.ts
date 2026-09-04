/** Array skeleton: element-level reference comparison + conditional slice() copy. */
import type { CodeCtx } from "./codectx.js";
import { containerChecksFn, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { type Fn, isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── array 骨架：元素级引用比较 + slice 条件拷贝 ── */

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

  // 元素处理函数：容器（含包装链）→ CoW 子骨架（strip 语义完整）；纯净叶子 → 官方 validator；其余 → 官方 parser；async → async 岛
  let elemFn: Fn;
  if (elemIsContainer) {
    elemFn = containerChildFn(element, childSeen);
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
      // 纯叶子元素：值 === 输入，无拷贝（validator 产物返回 true，不可引用比较）
      // 容器元素走子骨架：产物返回原引用或新容器，引用比较安全
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

  // 容器自身 checks（array .min/.max/.length/.refine）：双路径同 object 骨架
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
