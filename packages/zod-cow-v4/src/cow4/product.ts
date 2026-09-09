/**
 * Product contract shared by every zod4-line module: the Fn type, the async-product marker
 * and the async-function probes.
 */
import { $ZodAsyncError } from "zod/v4/core";

/* zod4 core types (kept loose; the prototype semantic layer is authoritative) */
export type Node = any;
/** Product contract: output value | INVALID | true(assertOnly); an async product returns Promise<output value | INVALID> */
export type Fn = (input: any) => unknown;

/**
 * Marks a product that may return a Promise (an async skeleton or island) -- attached by buildFn/officialFn/island;
 * call sites emit their await sites based on it. Such a product answers synchronously when nothing it ran returned
 * a Promise, as stock's runtime does (#105): the call sites test the result before suspending on it.
 */
export const ZC_ASYNC = Symbol.for("zc-z4.async");

export function markAsync(fn: Fn): Fn {
  (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] = true;
  return fn;
}

export function isAsyncProduct(fn: Fn | null | undefined): boolean {
  return !!fn && (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] === true;
}

/**
 * The runtime of an async skeleton (#105). `buildFn` emits an async skeleton as a generator whose every await
 * site yields a Promise it met (`CodeCtx.awaitExpr`: a result that is not a Promise is used in place, so the
 * generator yields Promises only), and this driver runs it the way stock's runtime runs a parse: synchronously
 * to the end when nothing yielded, which answers the value itself, so a container whose async-typed child never
 * ran (an empty set, an absent optional key, a `null` under a nullable wrapper) completes synchronously and
 * keeps its place in a parent writing in settlement order; otherwise a Promise that resumes the generator one
 * microtask hop after each yielded Promise settles (`then` on it, the hop an `await` costs) and settles with
 * the generator's return value, the hops an async function's `await` and return cost, so a member that did
 * suspend settles in the round it settled in before. A rejection resumes the generator with a throw at its
 * yield, as `await` does, and one it does not catch rejects the result.
 */
export function drive(it: Generator<unknown, unknown, unknown>): unknown {
  const first = it.next();
  if (first.done) return first.value;
  return new Promise((resolve, reject) => {
    const step = (r: IteratorResult<unknown, unknown>): void => {
      if (r.done) resolve(r.value);
      else (r.value as Promise<unknown>).then(onValue, onError);
    };
    const onValue = (v: unknown): void => {
      let r: IteratorResult<unknown, unknown>;
      try {
        r = it.next(v);
      } catch (e) {
        reject(e);
        return;
      }
      step(r);
    };
    const onError = (e: unknown): void => {
      let r: IteratorResult<unknown, unknown>;
      try {
        r = it.throw(e);
      } catch (e2) {
        reject(e2);
        return;
      }
      step(r);
    };
    step(first);
  });
}

/** Whether a started result among `results` is a Promise: the async layouts settle them together only then (#105) */
export function hasPromise(results: unknown[]): boolean {
  for (let i = 0; i < results.length; i++) if (results[i] instanceof Promise) return true;
  return false;
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
 * generated code calls (inside an official product) reports a returned Promise from stock's `throwAsync`, which this
 * layer cannot mark, so that stays the signal; its own throw is recorded too, through the wrapper
 * `collectCallbackSlots` / `installWrappers` (`official.ts`) put on the callback's `def` slot for the duration of the
 * compile (#80). The one callback throw still unrecorded is a `.default()` / `.prefault()` value factory, a getter
 * no wrapper reaches, which still takes the fallback.
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
