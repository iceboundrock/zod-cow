/**
 * Tuple skeleton: mirrors zod's generateTupleCheck with fillLen truncation tracking
 * + CoW decoration.
 */
import { ZodCompileUnsupportedError } from "zod4/v4/core";
import type { CodeCtx } from "./codectx.js";
import { type ChildProduct, childProduct, containerChecksFn } from "./emit.js";
import { dropsWhenAbsent, getTupleOptStart } from "./predicates.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── tuple 骨架：镜像官方 generateTupleCheck + fillLen 截断跟踪 + CoW 修饰 ── */

/**
 * tuple CoW 骨架 —— 与官方 generateTupleCheck 逐行对应，唯一区别是把
 * "无条件新容器"（const out = []）改写为引用比较判脏 + slice 条件拷贝：
 *
 *   长度守卫（官方同款，optinStart/optoutStart 编译期算好）
 *   段 1 [0, optoutStart)：官方无条件分支 out[i] = child(input[i])
 *         → validator 校验 / 值引用比较写回；缺席槽位保留官方"物化"语义
 *   段 2 [optoutStart, N)：官方尾槽门（out.length === i）+ 缺席截断/IIFE 填充
 *         → fillLen 变量镜像官方 out.length（CoW 时输出可能还是输入引用，
 *           不能读 .length，必须显式跟踪）
 *   段 3 rest [N, L)：官方无门控逐槽写 → 引用比较写回
 *
 * 干净判定：out === input（拷贝从未发生）⇔ 全部槽引用未变且无截断/填充。
 * 不变量：out === input ⟹ fillLen === input.length（截断/填充路径必先拷贝）。
 */
export function emitCoWTuple(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def as { items: Node[]; rest?: Node };
  const items: Node[] = def.items;
  const rest: Node | undefined = def.rest;
  const N = items.length;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive tuple");
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);
  const optinStart = getTupleOptStart(items, "optin");
  const optoutStart = getTupleOptStart(items, "optout");
  // 长度守卫（官方同款）：无 rest 时 [optinStart, N]，有 rest 时 >= optinStart
  if (rest) {
    ctx.write(`if (${accessor}.length < ${optinStart}) return INVALID;`);
  } else {
    ctx.write(
      `if (${accessor}.length < ${optinStart} || ${accessor}.length > ${N}) return INVALID;`,
    );
  }

  // 每个固定槽位的产物（编译期生成一次；键位/元素位/值位统一走 childProduct）
  const itemProducts = items.map((it) => childProduct(it, childSeen));

  const out = ctx.var();
  const fillLen = ctx.var();
  ctx.write(`let ${out} = ${accessor};`);

  /** 值形态槽（parser/cow/async 产物）：判 INVALID + 引用比较 + 首脏 slice 写回。
   *  eVar=null 表示缺席槽（官方无条件 out[i] = 产出，含 undefined 物化/结构扩展）→ 无条件写。 */
  const emitValueSlot = (
    p: ChildProduct,
    argExpr: string,
    idxExpr: string,
    eVar: string | null,
  ): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    const t = ctx.var();
    ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${argExpr});`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    if (eVar === null) {
      // 缺席槽：官方无条件写 out[i]（t === undefined 时也物化，保持输出长度/内容一致）
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = ${t};`);
    } else {
      ctx.write(`if (${t} !== ${eVar}) {`);
      ctx.indented(() => {
        ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
        ctx.write(`${out}[${idxExpr}] = ${t};`);
      });
      ctx.write(`}`);
    }
  };
  /** 校验形态槽（validator 产物）：只答成败；缺席时官方照样物化 out[i] = undefined（纯子树输出=输入=undefined） */
  const emitValidatorSlot = (
    p: ChildProduct,
    argExpr: string,
    idxExpr: string,
    present: boolean,
  ): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`if ((${isA ? "await " : ""}${f}(${argExpr})) === INVALID) return INVALID;`);
    if (!present) {
      // absent + validator（纯 optional 等）：stock 物化 undefined 槽（输出长度 i+1 > 输入）→ 必写
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = undefined;`);
    }
  };
  /** 官方截断三态（out.length = i 的 CoW 版）：已拷贝 → 实截；原引用且目标≠输入长 → 拷后截；原引用且目标=输入长 → 输出=输入，无操作 */
  const emitTruncate = (i: number): void => {
    ctx.write(`if (${out} !== ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`} else if (${i} !== ${accessor}.length) {`);
    ctx.indented(() => {
      ctx.write(`${out} = ${accessor}.slice();`);
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`}`);
  };

  /* 段 1：无条件槽 [0, optoutStart) —— 官方 `out[i] = compileChild(...)` */
  for (let i = 0; i < optoutStart; i++) {
    const p = itemProducts[i]!;
    ctx.write(`{`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      // 缺席判定编译期不可知（input.length 运行时值）→ present 分支运行时守卫
      ctx.write(`if (${i} < ${accessor}.length) {`);
      ctx.indented(() => {
        if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
        else emitValueSlot(p, e, String(i), e);
      });
      ctx.write(`} else {`);
      ctx.indented(() => {
        // 缺席（i >= input.length）：官方照样跑 child(undefined)（IIFE 等价语义）
        if (p.kind === "validator") emitValidatorSlot(p, "undefined", String(i), false);
        else emitValueSlot(p, "undefined", String(i), null);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }
  // 段 1 结束：官方 out.length = optoutStart（顺序填充），fillLen 镜像之
  ctx.write(`let ${fillLen} = ${optoutStart};`);

  /* 段 2：尾槽 [optoutStart, N) —— 官方门控 + 缺席截断/IIFE 填充 */
  for (let i = optoutStart; i < N; i++) {
    const p = itemProducts[i]!;
    const drop = dropsWhenAbsent(items[i]!); // 编译期已知 → 只发射实际分支
    ctx.write(`{`);
    ctx.indented(() => {
      ctx.write(`if (${fillLen} === ${i}) {`);
      ctx.indented(() => {
        ctx.write(`if (${i} < ${accessor}.length) {`);
        ctx.indented(() => {
          const e = ctx.var();
          ctx.write(`const ${e} = ${accessor}[${i}];`);
          if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
          else emitValueSlot(p, e, String(i), e);
          ctx.write(`${fillLen} = ${i + 1};`);
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          if (drop) {
            // 官方 dropsWhenAbsent 分支：out.length = i（截断）
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else if (p.kind === "validator") {
            // 纯子树槽缺席：child(undefined) 校验（纯 optional 系恒过，防御 INVALID）→ 输出=undefined → 官方截断
            const f = ctx.addConst(p.fn);
            const isA = (p as ChildProduct).kind === "async"; // 防御（validator 产物恒同步）
            if (isA) ctx.async = true;
            ctx.write(`if ((${isA ? "await " : ""}${f}(undefined)) === INVALID) return INVALID;`);
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else {
            // 官方 IIFE 分支：branch = child(undefined)；INVALID/undefined → 截断，有值 → out[i] = branch（结构扩展）
            const f = ctx.addConst(p.fn);
            const isA = p.kind === "async";
            if (isA) ctx.async = true;
            const t = ctx.var();
            ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(undefined);`);
            ctx.write(`if (${t} === INVALID || ${t} === undefined) {`);
            ctx.indented(() => {
              ctx.write(`${fillLen} = ${i};`);
              emitTruncate(i);
            });
            ctx.write(`} else {`);
            ctx.indented(() => {
              ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
              ctx.write(`${out}[${i}] = ${t};`);
              ctx.write(`${fillLen} = ${i + 1};`);
            });
            ctx.write(`}`);
          }
        });
        ctx.write(`}`);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }

  /* 段 3：rest [N, L) —— 官方无门控逐槽写 */
  if (rest) {
    const restProduct = childProduct(rest, childSeen);
    const f = ctx.addConst(restProduct.fn);
    const isA = restProduct.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`for (let i = ${N}; i < ${accessor}.length; i++) {`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[i];`);
      if (restProduct.kind === "validator") {
        ctx.write(`if ((${isA ? "await " : ""}${f}(${e})) === INVALID) return INVALID;`);
      } else {
        const t = ctx.var();
        ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${e});`);
        ctx.write(`if (${t} === INVALID) return INVALID;`);
        ctx.write(`if (${t} !== ${e}) {`);
        ctx.indented(() => {
          ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
          ctx.write(`${out}[i] = ${t};`);
        });
        ctx.write(`}`);
      }
    });
    ctx.write(`}`);
  }

  // 容器自身 checks（tuple .refine 纯谓词）：双路径同 object/array 骨架
  const checksFn = containerChecksFn(schema);
  if (checksFn) {
    const cName = ctx.addConst(checksFn);
    const isA = isAsyncProduct(checksFn);
    const awaitKw = isA ? "await " : "";
    ctx.write(`if (${out} === ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if ((${awaitKw}${cName}(${accessor})) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
    ctx.write(`if ((${awaitKw}${cName}(${out})) === INVALID) return INVALID;`);
  } else {
    ctx.write(`if (${out} === ${accessor}) return ${accessor};`);
  }

  return out;
}
