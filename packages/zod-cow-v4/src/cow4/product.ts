/**
 * Product contract shared by every zod4-line module: the Fn type, the async-product marker
 * and the async-function probes.
 */
import { ZodCompileAsyncError } from "zod/v4/core";

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

export function throwAsync(): never {
  throw new ZodCompileAsyncError("async function on the synchronous fast path");
}
