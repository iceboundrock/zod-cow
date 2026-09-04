/**
 * zc-z4 —— CoW 容器修饰层（复用 zod4 官方 codegen 作为语义后端）。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  设计原则：zod4（>=4.1）自带的 JIT 编译器（src/v4/core/compile.ts，
 *  经 "zod/compile" 或 z.compile() 暴露）已经把全部校验/变换语义编译成
 *  单体函数。本层不再自研语义 codegen，只做三件事：
 *
 *  1. 纯度分析（保守白名单）：判定一棵子树的 parse 输出是否必然 === 输入。
 *     纯净子树 → 直接复用官方 assertOnly 产物（bag.validator 同款，
 *     校验语义完整、零输出构造）；非纯净子树 → 复用官方 parser 产物，
 *     用引用比较（out !== in）检测"值产生器"是否实际点火。
 *
 *  2. 容器 CoW 骨架 codegen（object/array 两种）：唯一自研的代码生成，
 *     把官方"无条件新容器"（const out = {...} / new Array(n)）改写为
 *     "引用比较判脏 + 条件浅拷贝"——干净输入返回原引用，被迫才拷贝。
 *     键序/键存在性由 {...input} 扩展天然保真；strip/strict/loose 的
 *     多余键规则与官方 for...in + Set 模板逐行对齐。
 *
 *  3. 失败回退：任何 INVALID 只回传哨兵，顶层统一回退 stock safeParse ——
 *     issues/path/error map/ZodError 构造 100% 官方，零语义复刻。
 *     与全局 "zod/compile" shim 共存：回退路径自动享受官方 JIT。
 *
 *  降级链（每棵子树独立）：
 *    assertOnly 产物 → parser 产物 → runtime island（黑盒 _zod.run）
 *    → 整树 stock（async/递归等本层完全不管的情形）。
 *
 *  复用的官方内部 API（zod4/v4/core 公开 re-export，版本锚点 4.5.4）：
 *    compileFn(schema, { assertOnly?, debug? })  单体函数生成
 *    INVALID                                     失败哨兵
 *    ZodCompileUnsupportedError / ZodCompileAsyncError
 * ═══════════════════════════════════════════════════════════════════
 */
import { INVALID } from "zod4/v4/core";
import { buildFn, CodeCtx } from "./codectx.js";
import { emitNode } from "./emit.js";
import type { Fn, Node } from "./product.js";

export { officialValidator } from "./official.js";
export { type Fn, isAsyncProduct, ZC_ASYNC } from "./product.js";

/* ═══════════════════ 顶层编译 ═══════════════════ */

/** 生成 CoW 单体函数；不可编译（async/递归/冷僻特性）时抛出，由调用方整树降级 */
export function compileCowFn(schema: Node): Fn {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/** 同上，但返回 [函数, 源码]，供 debug dump */
export function compileCowDebug(schema: Node): { fn: Fn; code: string } {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return { fn: buildFn(ctx), code: ctx.lines.join("\n") };
}

export { INVALID };
