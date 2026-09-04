/**
 * Skeleton codegen core: node dispatch, child-product selection and container-check
 * subroutines. Forms an import cycle with the emit-*.ts skeletons (mutual recursion through
 * hoisted function declarations only; nothing in the cycle runs at module load).
 */
import { compileFn, ZodCompileAsyncError, ZodCompileUnsupportedError } from "zod4/v4/core";
import { buildFn, CodeCtx } from "./codectx.js";
import { emitCoWArray } from "./emit-array.js";
import { emitCoWMap } from "./emit-map.js";
import { emitCoWObject } from "./emit-object.js";
import { emitCoWRecord } from "./emit-record.js";
import { emitCoWSet } from "./emit-set.js";
import { emitCoWTuple } from "./emit-tuple.js";
import { makeAsyncIsland, officialFn } from "./official.js";
import { type Fn, isAsyncFn, isAsyncProduct, type Node, throwAsync } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ═══════════════════ 骨架 codegen ═══════════════════ */

/**
 * 子树编译成独立产物函数（容器子骨架递归入口），失败 → 官方产物/island。
 * seen 向下传递：编译期循环引用防护。
 */
function subFn(schema: Node, seen: Set<Node>): Fn {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set(seen));
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/** 子节点产物的四种形态 */
export type ChildProduct =
  | { kind: "validator"; fn: Fn } // 官方 assertOnly：只答成败，输出=输入（不可当值用）
  | { kind: "parser"; fn: Fn } // 官方 parser：返回输出值（stock 语义），配合引用比较判脏
  | { kind: "cow"; fn: Fn } // 本层容器子骨架：干净返回原引用，脏返回新容器
  | { kind: "async"; fn: Fn }; // async 岛/async 子骨架：返回 Promise<输出 | INVALID>，调用位发射 await

function productOf(fn: Fn, syncKind: "parser" | "cow"): ChildProduct {
  return isAsyncProduct(fn) ? { kind: "async", fn } : { kind: syncKind, fn };
}

/**
 * 键位/元素位/值位通用的子节点产物选择（object 键循环、array 元素循环、
 * record 值循环、map 键值、set 成员、tuple 槽位全部走这里）：
 *   容器（含 optional/nullable 包装链）→ CoW 子骨架（strip 语义完整）；
 *   纯净叶子 → 官方 validator；其余 → 官方 parser；async 子树 → async 岛。
 */
export function childProduct(child: Node, seen: Set<Node>): ChildProduct {
  if (cowSafeContainerForChild(child)) {
    try {
      return productOf(subFn(child, seen), "cow");
    } catch (e) {
      if (e instanceof ZodCompileUnsupportedError) throw e; // 递归/冷僻特性：向上由上层降级
      // ZodCompileAsyncError 及其它产物生成失败 → 官方产物（async 自动转 async 岛）
      return productOf(officialFn(child, false), "parser");
    }
  }
  const pure = isPure(child);
  const fn = officialFn(child, pure);
  if (isAsyncProduct(fn)) return { kind: "async", fn };
  return { kind: pure ? "validator" : "parser", fn };
}

/**
 * 容器自身 checks 的校验子程序（独立产物函数，只答成败）。
 * 支持：custom(def.fn 谓词，官方 generateCustomRefineCheck 同款模板) /
 * min_length / max_length / length_equals（array .length）。
 * 返回 null 表示存在骨架处理不了的 check（调用方应已通过 checksAreCowSafe 拦截）。
 */
export function containerChecksFn(schema: Node): Fn | null {
  const checks: Node[] = schema._zod.def.checks ?? [];
  if (checks.length === 0) return null;
  const ctx = new CodeCtx();
  for (const check of checks) {
    const d = check._zod?.def ?? check;
    if (d.check === "custom" && d.fn) {
      // 官方 generateCustomRefineCheck 的 def.fn 分支同款；
      // async 谓词在 async 骨架（ctx.async）中发射 await，同步骨架中抛错（官方语义）
      const asyncFn = isAsyncFn(d.fn);
      const fnC = ctx.addConst(d.fn);
      const res = ctx.var();
      if (asyncFn) {
        ctx.async = true;
        ctx.write(`const ${res} = await ${fnC}(input);`);
      } else {
        const throwAsyncC = ctx.addConst(throwAsync);
        ctx.write(`const ${res} = ${fnC}(input);`);
        ctx.write(`if (${res} instanceof Promise) ${throwAsyncC}();`);
      }
      ctx.write(`if (!${res}) return INVALID;`);
      continue;
    }
    if (d.check === "min_length") {
      ctx.write(`if (input.length < ${Number(d.minimum)}) return INVALID;`);
      continue;
    }
    if (d.check === "max_length") {
      ctx.write(`if (input.length > ${Number(d.maximum)}) return INVALID;`);
      continue;
    }
    if (d.check === "length_equals") {
      ctx.write(`if (input.length !== ${Number(d.length)}) return INVALID;`);
      continue;
    }
    if (d.check === "min_size") {
      ctx.write(`if (input.size < ${Number(d.minimum)}) return INVALID;`);
      continue;
    }
    if (d.check === "max_size") {
      ctx.write(`if (input.size > ${Number(d.maximum)}) return INVALID;`);
      continue;
    }
    if (d.check === "size_equals") {
      ctx.write(`if (input.size !== ${Number(d.size)}) return INVALID;`);
      continue;
    }
    return null; // 不可表达的 check —— 调用方负责已用 checksAreCowSafe 拦截
  }
  ctx.write("return true;");
  return buildFn(ctx);
}

/**
 * 容器（object/array）在键位/元素位的处理：必须走 CoW 子骨架，
 * 绝不能用官方 assertOnly 产物 —— 官方 validator 会跳过多余键剥离
 * （strip 是输出构造行为，不影响校验成败），导致 strip 语义丢失。
 * 子骨架内完整处理 strip/strict/loose，干净时返回原引用。
 */
export function containerChildFn(child: Node, seen: Set<Node>): Fn {
  try {
    return subFn(child, seen);
  } catch (e) {
    if (e instanceof ZodCompileUnsupportedError) throw e; // 递归等：向上由外层决定降级层级
    return officialFn(child, false); // 官方 parser 产物（async 自动转 async 岛），stock 语义正确性无损
  }
}

/**
 * optional/nullable 包装链包着的容器骨架：沿链发射壳检查（null→null，
 * undefined→undefined，值透传），到容器后走普通 CoW 骨架。
 */
function emitBoxedContainer(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  let cur: Node = schema;
  for (;;) {
    const def = cur._zod.def;
    if (def.type === "nullable") {
      ctx.write(`if (${accessor} === null) return ${accessor};`);
      cur = def.innerType;
      continue;
    }
    if (def.type === "optional") {
      ctx.write(`if (${accessor} === undefined) return ${accessor};`);
      cur = def.innerType;
      continue;
    }
    break;
  }
  const t2: string = cur._zod.def.type;
  if (t2 === "object") return emitCoWObject(ctx, cur, accessor, seen);
  if (t2 === "array") return emitCoWArray(ctx, cur, accessor, seen);
  if (t2 === "tuple") return emitCoWTuple(ctx, cur, accessor, seen);
  if (t2 === "record") return emitCoWRecord(ctx, cur, accessor, seen);
  if (t2 === "map") return emitCoWMap(ctx, cur, accessor, seen);
  return emitCoWSet(ctx, cur, accessor, seen);
}

/**
 * 向 ctx 发射 schema 的校验/CoW 代码，返回输出 accessor（needsValue=false 时可能为 null）。
 * seen：编译期循环引用防护 —— 递归子树不再展开，交官方产物/岛。
 */
export function emitNode(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  needsValue: boolean,
  seen: Set<Node>,
): string | null {
  const def = schema._zod.def;
  const t: string = def.type;
  if (needsValue) {
    // 容器（含 optional/nullable 包装链）→ CoW 骨架
    if (
      (t === "object" ||
        t === "array" ||
        t === "tuple" ||
        t === "record" ||
        t === "map" ||
        t === "set" ||
        t === "optional" ||
        t === "nullable") &&
      cowSafeContainerForChild(schema)
    ) {
      return emitBoxedContainer(ctx, schema, accessor, seen);
    }
  }
  // 其余一切类型：官方产物黑盒调用
  const pure = isPure(schema);
  if (pure) {
    // 纯子树：官方 assertOnly 产物只答成败，输出 = 输入引用（纯度定义）。
    // validator 产物不可得时落官方 parser（值可能≠输入，走非纯路径）；
    // 纯子树理论上无 async（白名单已拦），防御性兼得转 async 岛。
    let v: Fn | null = null;
    try {
      v = compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) {
        const f = ctx.addConst(makeAsyncIsland(schema));
        ctx.async = true;
        ctx.write(`if ((await ${f}(${accessor})) === INVALID) return INVALID;`);
        // 纯子树校验通过 ⇒ 输出 = 输入引用，accessor 即输出
        return needsValue ? accessor : null;
      }
      v = null;
    }
    if (v) {
      const c = ctx.addConst(v);
      ctx.write(`if (${c}(${accessor}) === INVALID) return INVALID;`);
      return needsValue ? accessor : null;
    }
  }
  const fnC = officialFn(schema, false);
  const fn = ctx.addConst(fnC);
  if (isAsyncProduct(fnC)) ctx.async = true;
  const awaitKw = isAsyncProduct(fnC) ? "await " : "";
  if (!needsValue) {
    ctx.write(`if ((${awaitKw}${fn}(${accessor})) === INVALID) return INVALID;`);
    return null;
  }
  const out = ctx.var();
  ctx.write(`const ${out} = ${awaitKw}${fn}(${accessor});`);
  ctx.write(`if (${out} === INVALID) return INVALID;`);
  return out;
}
