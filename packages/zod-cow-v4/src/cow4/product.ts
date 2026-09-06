/**
 * Product contract shared by every zod4-line module: the Fn type, the async-product marker
 * and the async-function probes.
 */
import { $ZodAsyncError } from "zod/v4/core";

/* zod4 core types (kept loose; the prototype semantic layer is authoritative) */
export type Node = any;
/** Product contract: output value | INVALID | true(assertOnly); an async product returns Promise<output value | INVALID> */
export type Fn = (input: any) => unknown;

/** Marks a product that returns a Promise (async skeleton) -- attached by buildFn/officialFn/island; call sites emit await based on it */
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

/**
 * A Promise met on the synchronous fast path: stock's own `throwAsync` throws `$ZodAsyncError` there (the
 * interpreter's class, and the one the sync API of a stock schema throws), so a plain function that returns
 * a Promise, which no static detector sees, surfaces as stock's error through the sync entries and is
 * caught by the async entries of `compile()`, which hand that parse to stock's async runtime (fourth review of #76).
 */
export function throwAsync(): never {
  throw new $ZodAsyncError();
}
