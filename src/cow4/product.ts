/**
 * Product contract shared by every zod4-line module: the Fn type, the async-product marker
 * and the async-function probes.
 */
import { ZodCompileAsyncError } from "zod4/v4/core";

/* zod4 core 类型（宽松处理，prototype 语义层为准） */
export type Node = any;
/** 产物契约：输出值 | INVALID | true(assertOnly)；async 产物返回 Promise<输出值 | INVALID> */
export type Fn = (input: any) => unknown;

/** 产物返回 Promise（async 骨架）的标记 —— buildFn/officialFn/island 挂载，调用点据此发射 await */
export const ZC_ASYNC = Symbol.for("zc-z4.async");

export function markAsync(fn: Fn): Fn {
  (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] = true;
  return fn;
}

export function isAsyncProduct(fn: Fn | null | undefined): boolean {
  return !!fn && (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] === true;
}

export function isAsyncFn(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn.constructor.name === "AsyncFunction" ||
      (fn as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] === "AsyncFunction")
  );
}

export function throwAsync(): never {
  throw new ZodCompileAsyncError("async function on the synchronous fast path");
}
