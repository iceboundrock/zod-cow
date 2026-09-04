/**
 * Official-product wrappers: assertOnly validator, parser, runtime island and async island
 * (the per-subtree degradation chain).
 */
import { $ZodAsyncError, INVALID, compileFn, ZodCompileAsyncError } from "zod4/v4/core";
import { type Fn, isAsyncFn, markAsync, type Node } from "./product.js";

/* ═══════════════════ 官方产物获取（降级链） ═══════════════════ */

function makeIsland(schema: Node): Fn {
  // 官方 runtimeRun 等价：子树黑盒执行，失败 → INVALID。
  // async 经此岛到达同步快路径 → 抛 $ZodAsyncError（官方 compile.js throwAsync 同款语义：
  // 返回 INVALID 会被 union 读成分支拒绝，必须让 throw 存活）。
  return (value: unknown): unknown => {
    const r = schema._zod.run({ value, issues: [] }, {});
    if (r && typeof r.then === "function") throw new $ZodAsyncError();
    return r.issues.length === 0 ? r.value : INVALID;
  };
}

/**
 * async 子树通道：返回 Promise<输出值 | INVALID> 的黑盒岛。
 * 骨架在调用位发射 await 并把 CodeCtx.async 置真 → 整个骨架变 async 函数。
 */
export function makeAsyncIsland(schema: Node): Fn {
  return markAsync(async (value: unknown): Promise<unknown> => {
    const r = await schema._zod.run({ value, issues: [] }, {});
    return r.issues.length === 0 ? r.value : INVALID;
  });
}

/**
 * lazy(async·…) 的静态 async 探测：官方 generateLazyCheck 是 runtime island，
 * compileFn 对它不抛 ZodCompileAsyncError，async 会被 Promise 静默传出去 ——
 * 必须在编译期识破，改走 async 岛。其余类型的 async 官方 compileFn 自会抛错，无需此函数。
 */
function subtreeHasAsync(schema: Node, seen: Set<Node> = new Set()): boolean {
  if (seen.has(schema)) return false; // 递归子树（lazy 自引用）——async 与否由首个展开判定
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") {
    try {
      if (subtreeHasAsync(def.getter(), seen)) return true;
    } catch {
      return true; // getter 抛错 → 保守按 async 处理（正确性无损）
    }
  }
  if (isAsyncFn(def.fn) || isAsyncFn(def.transform)) return true;
  const checks: Node[] = def.checks ?? [];
  for (const c of checks) {
    const d = c._zod?.def ?? c;
    if (isAsyncFn(d.fn) || isAsyncFn(c._zod?.check)) return true;
  }
  const kids: Node[] = [];
  if (def.innerType) kids.push(def.innerType);
  if (def.element) kids.push(def.element);
  if (def.keyType) kids.push(def.keyType);
  if (def.valueType) kids.push(def.valueType);
  if (def.in) kids.push(def.in);
  if (def.out) kids.push(def.out);
  if (def.left) kids.push(def.left);
  if (def.right) kids.push(def.right);
  if (def.rest) kids.push(def.rest);
  if (def.catchall) kids.push(def.catchall);
  if (def.items) kids.push(...def.items);
  if (def.options) kids.push(...def.options);
  if (def.shape) {
    for (const k of Object.keys(def.shape)) kids.push(def.shape[k]);
    for (const s of Object.getOwnPropertySymbols(def.shape)) kids.push(def.shape[s]);
  }
  return kids.some((k) => subtreeHasAsync(k, seen));
}

/**
 * 取子树的官方产物。pure → assertOnly validator（校验语义完整，输出=输入）；
 * 否则 → parser（stock 语义输出）。产物生成失败时逐级降级。
 * async 不再向上抛（Task 6）：官方 compileFn 抛 ZodCompileAsyncError 的子树
 * 改走 async 岛（返回 Promise，调用位 await）；lazy(async·…) 由静态探测补漏。
 */
export function officialFn(schema: Node, pure: boolean): Fn {
  // 官方对 lazy 产物是 runtime island，内部 async 编译期不报错 → 静态补漏
  if (schema._zod.def.type === "lazy" && subtreeHasAsync(schema)) {
    return makeAsyncIsland(schema);
  }
  if (pure) {
    try {
      return compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema); // isPure 白名单已拦 async，防御性兼得
      // 其余 → 落到 parser（输出值没人读时无害，只是多构造）
    }
  }
  try {
    return compileFn(schema) as Fn;
  } catch (e) {
    if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema);
    return makeIsland(schema);
  }
}

/** 整树官方 assertOnly 产物（validate 快路径），失败 → null */
export function officialValidator(schema: Node): Fn | null {
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } catch {
    return null;
  }
}
