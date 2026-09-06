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

/**
 * The `$ZodAsyncError`s a caller's callback threw, or rejected with, through this layer's own call sites: the
 * predicates the checks subroutine calls, the promises it settles, the run of an island (its rejection and a throw
 * that leaves it synchronously, `runIsland` in `official.ts`). The class is
 * public, so a callback can throw it itself (a nested sync parse of an async schema does), and such a throw is the
 * caller's: stock rejects with it after one call. The async entries of `compile()` rethrow a recorded error and
 * treat only an unrecorded one as the fast path's Promise signal (fifth review of #76). A callback that stock's own
 * generated code calls (inside an official product) is not recorded: its Promise signal comes from stock's `throwAsync`,
 * which this layer cannot mark, so both stay the signal there (#80).
 */
const callerAsyncErrors = new WeakSet<object>();

/** Records a `$ZodAsyncError` that came out of a caller's callback and rethrows whatever came out. */
export function rethrowCallerError(e: unknown): never {
  if (e instanceof $ZodAsyncError) callerAsyncErrors.add(e);
  throw e;
}

/** The fast path's Promise signal: a `$ZodAsyncError` no callback of this layer's call sites threw. */
export function isPromiseSignal(e: unknown): boolean {
  return e instanceof $ZodAsyncError && !callerAsyncErrors.has(e);
}
