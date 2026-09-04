/** Object skeleton: reference comparison + conditional {...input} copy. */
import { ZodCompileUnsupportedError } from "zod4/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { containerChecksFn, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { requiresPresence } from "./predicates.js";
import { isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── object 骨架：引用比较 + {...input} 条件拷贝 ── */

export function emitCoWObject(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive object");
  seen.add(schema);

  // 容器守卫（官方模板原文）
  ctx.write(
    `if (typeof ${accessor} !== "object" || ${accessor} === null || Array.isArray(${accessor})) return INVALID;`,
  );

  const shape = def.shape;
  const stringKeys = Object.keys(shape);
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  const allKeys: (string | symbol)[] = [...stringKeys, ...symbolKeys];

  // __proto__ 形状键：官方同样拒绝（字面量赋值会改原型）
  if (stringKeys.includes("__proto__"))
    throw new ZodCompileUnsupportedError('object shape key "__proto__"');

  // catchall 模式分类（官方 unknownKeysMode 同款判定）
  let mode: "strip" | "strict" | "loose" = "strip";
  if (def.catchall) {
    const t = def.catchall._zod.def.type;
    if (t === "never") mode = "strict";
    else if ((t === "unknown" || t === "any") && !def.catchall._zod.def.checks?.length)
      mode = "loose";
    else throw new ZodCompileUnsupportedError("schema catchall");
  }

  const dirty = ctx.var();
  const extra = ctx.var();
  ctx.write(`let ${dirty} = false, ${extra} = false;`);

  /** 拷贝分支需要覆写的非纯键 */
  const writeback: { keyExpr: string; outVar: string; inVar: string }[] = [];

  for (const key of allKeys) {
    const child: Node = shape[key];
    const keyExpr = typeof key === "symbol" ? ctx.addConst(key) : escKey(key);
    const inVar = ctx.var();
    // getter 只读一次（官方注释：checks 与输出组装不得二次触发 getter）
    ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);

    // 官方 presence guard：值级快路径无法区分缺席与 undefined 的 required 键
    if (requiresPresence(child)) {
      ctx.write(
        `if (!(${typeof key === "symbol" ? keyExpr : keyExpr} in ${accessor})) return INVALID;`,
      );
    }

    if (isPure(child) && !cowSafeContainerForChild(child)) {
      // 纯净叶子键：官方 assertOnly 产物。输出 === 输入，{...input} 已保真，无写回。
      // （容器键不走此分支：strip 剥离语义需要 CoW 子骨架，见 cowSafeContainerForChild）
      const vFn = officialFn(child, true);
      const v = ctx.addConst(vFn);
      if (isAsyncProduct(vFn)) {
        // 纯键理论上无 async；防御性兼得（async validator await 后输出=输入）
        ctx.async = true;
        ctx.write(`if ((await ${v}(${inVar})) === INVALID) return INVALID;`);
      } else {
        ctx.write(`if (${v}(${inVar}) === INVALID) return INVALID;`);
      }
      continue;
    }

    if (cowSafeContainerForChild(child)) {
      // 容器键（含 optional/nullable 包装）：CoW 子骨架（嵌套 CoW + strip 语义完整）
      const vFn = containerChildFn(child, seen);
      const v = ctx.addConst(vFn);
      const isA = isAsyncProduct(vFn);
      if (isA) ctx.async = true;
      const outVar = ctx.var();
      ctx.write(`const ${outVar} = ${isA ? "await " : ""}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
      // 子骨架干净时返回原引用 → 相等不判脏；脏时新引用 → 判脏 + 写回
      ctx.write(`if (${outVar} !== ${inVar}) ${dirty} = true;`);
      writeback.push({ keyExpr, outVar, inVar });
      continue;
    }

    // 非纯键：官方 parser 产物 + 引用比较判脏
    const vFn = officialFn(child, false);
    const v = ctx.addConst(vFn);
    const isA = isAsyncProduct(vFn);
    if (isA) ctx.async = true;
    const awaitKw = isA ? "await " : "";
    const outVar = ctx.var();
    const optoutOptional = child._zod.optin !== undefined && child._zod.optout === "optional";
    if (optoutOptional) {
      // 官方 optin 分支模板：缺席键不判失败，输出 undefined
      ctx.write(`let ${outVar} = ${awaitKw}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) {`);
      ctx.indented(() => {
        ctx.write(`if (${keyExpr} in ${accessor}) return INVALID;`);
        ctx.write(`${outVar} = undefined;`);
      });
      ctx.write(`}`);
    } else {
      ctx.write(`const ${outVar} = ${awaitKw}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
    }

    // 脏判定：引用比较。输出 undefined 且键缺席 → 视为未变（stock 亦不物化该键）
    ctx.write(
      `if (${outVar} !== ${inVar} && !(${outVar} === undefined && !(${keyExpr} in ${accessor}))) ${dirty} = true;`,
    );
    writeback.push({ keyExpr, outVar, inVar });
  }

  // 多余键探测（官方 for...in 模板：继承键参与，与 runtime 一致）
  if (mode !== "loose" && (mode === "strict" || stringKeys.length > 0 || allKeys.length === 0)) {
    const known = ctx.addConst(new Set(allKeys));
    if (mode === "strict") {
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) return INVALID;`);
      });
      ctx.write(`}`);
    } else {
      // strip：零分配早退探测
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
      // 官方 strip 会丢弃 enumerable own symbol 多余键；{...input} 会保留 → 探测之
      ctx.write(`for (const s of Object.getOwnPropertySymbols(${accessor})) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(s)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
    }
  }

  // 容器自身 checks（.refine/.min 等）：独立校验子程序，
  // 双路径调用对齐 stock 语义（checks 作用于最终输出：干净时=输入，脏时=重建后的 out）
  const checksFn = containerChecksFn(schema);
  const cName = checksFn ? ctx.addConst(checksFn) : null;

  // ═══ CoW 核心：官方模板没有的分支 ═══
  ctx.write(`if (!${dirty} && !${extra}) {`);
  ctx.indented(() => {
    if (cName) ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
    ctx.write(`return ${accessor};`);
  });
  ctx.write(`}`);
  ctx.write(`const out = { ...${accessor} };`);

  for (const { keyExpr, outVar, inVar } of writeback) {
    // 对齐官方 mayOutputUndefined 组装规则：
    //   值变 → 写；输出 undefined 且键缺席 → 不物化；输出 undefined 且键在 → 写 undefined
    ctx.write(`if (${outVar} !== ${inVar}) {`);
    ctx.indented(() => {
      ctx.write(`if (${outVar} !== undefined) out[${keyExpr}] = ${outVar};`);
      ctx.write(`else if (${keyExpr} in ${accessor}) out[${keyExpr}] = undefined;`);
    });
    ctx.write(`}`);
  }

  if (mode === "strip") {
    ctx.write(`if (${extra}) {`);
    ctx.indented(() => {
      const known2 = ctx.addConst(new Set(allKeys));
      ctx.write(`for (const k in ${accessor}) if (!${known2}.has(k)) delete out[k];`);
      ctx.write(
        `for (const s of Object.getOwnPropertySymbols(${accessor})) if (!${known2}.has(s)) delete out[s];`,
      );
    });
    ctx.write(`}`);
  }

  if (cName) ctx.write(`if (${cName}(out) === INVALID) return INVALID;`);

  return "out";
}
