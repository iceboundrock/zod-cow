/**
 * zc-z4 public API — the engine is "zod4 official codegen + CoW container skeletons"
 * (tuple skeletons and async schemas supported since Task 6).
 *
 *   compile(schema) returns:
 *     .parse(data)      CoW semantics: returns the output on success (clean input === the input reference)
 *     .safeParse(data)  non-throwing variant; the failure path is stock safeParse (official issues/ZodError)
 *     .parseAsync(data)       async variant (the only usable entry when the skeleton holds an async subtree)
 *     .safeParseAsync(data)   async variant
 *     .validate(data)   pure validation: official whole-tree assertOnly product; returns the input
 *                       reference when it passes, null when it fails
 *     .code             generated CoW skeleton source (for debugging)
 *     .stock            stock degradation flag (true = this layer gave up, everything goes through stock)
 *     .async            true = the skeleton holds an async subtree, so the sync API throws
 *                       $ZodAsyncError (same semantics as stock)
 */
import type { z } from "zod4";
import {
  INVALID,
  compileCowDebug,
  officialValidator,
  isAsyncProduct,
  type Fn,
} from "./cow4/index.js";
import { ZodCompileAsyncError, ZodCompileUnsupportedError, $ZodAsyncError } from "zod4/v4/core";

export interface Compiled<T extends z.ZodType> {
  readonly schema: T;
  /** true = CoW compilation did not succeed, so parse/safeParse pass straight through to stock (no loss of semantics) */
  readonly stock: boolean;
  /** true = the skeleton holds an async subtree: sync parse/safeParse/validate throw $ZodAsyncError, the *Async variants work */
  readonly async: boolean;
  /** CoW skeleton source (null when degraded to stock) */
  readonly code: string | null;
  parse(data: unknown): z.output<T>;
  safeParse(
    data: unknown,
  ): { success: true; data: z.output<T> } | { success: false; error: z.ZodError };
  parseAsync(data: unknown): Promise<z.output<T>>;
  safeParseAsync(
    data: unknown,
  ): Promise<{ success: true; data: z.output<T> } | { success: false; error: z.ZodError }>;
  /** Pure validation: on success returns the original input reference (typed `unknown`; unlike the zod3 line there is no DeepReadonly view), null on failure */
  validate(data: unknown): unknown;
}

type SyncResult = { success: boolean; data?: unknown; error?: z.ZodError };

export function compile<T extends z.ZodType>(schema: T): Compiled<T> {
  let cowFn: Fn | null = null;
  let code: string | null = null;
  try {
    const compiled = compileCowDebug(schema);
    cowFn = compiled.fn;
    code = compiled.code;
  } catch (e) {
    // recursion / schema catchall / __proto__ / exotic features → whole-tree stock (degradation with no loss of semantics)
    // (async no longer reaches this branch: since Task 6 an async subtree uses an async island + an awaiting skeleton)
    if (!(e instanceof ZodCompileAsyncError) && !(e instanceof ZodCompileUnsupportedError)) {
      throw e;
    }
  }

  const isAsync = isAsyncProduct(cowFn);
  const validator = cowFn && !isAsync ? officialValidator(schema) : null;
  const stockParse = (
    schema as unknown as { safeParse: (d: unknown) => SyncResult }
  ).safeParse.bind(schema);
  const stockParseAsync = (
    schema as unknown as { safeParseAsync: (d: unknown) => Promise<SyncResult> }
  ).safeParseAsync.bind(schema);

  const throwSyncOnAsync = (): never => {
    // Same semantics as the official sync API on an async schema ($ZodAsyncError)
    throw new $ZodAsyncError();
  };

  const unwrap = (r: SyncResult): z.output<T> => {
    if (r.success) return r.data as z.output<T>;
    throw r.error;
  };
  const unwrapAsync = async (r: SyncResult | Promise<SyncResult>): Promise<z.output<T>> => {
    const rr = await r;
    return unwrap(rr);
  };

  return {
    schema,
    stock: cowFn === null,
    async: isAsync,
    code,
    parse(data: unknown): z.output<T> {
      if (isAsync) throwSyncOnAsync();
      if (cowFn) {
        const out = cowFn(data);
        if (out !== INVALID) return out as z.output<T>;
      }
      return unwrap(stockParse(data));
    },
    safeParse(data: unknown) {
      if (isAsync) throwSyncOnAsync();
      if (cowFn) {
        const out = cowFn(data);
        if (out !== INVALID)
          return { success: true, data: out } as { success: true; data: z.output<T> };
      }
      return stockParse(data) as { success: false; error: z.ZodError };
    },
    async parseAsync(data: unknown): Promise<z.output<T>> {
      if (cowFn) {
        const out = await cowFn(data);
        if (out !== INVALID) return out as z.output<T>;
      }
      return isAsync ? unwrapAsync(stockParseAsync(data)) : unwrap(stockParse(data));
    },
    async safeParseAsync(data: unknown) {
      if (cowFn) {
        const out = await cowFn(data);
        if (out !== INVALID)
          return { success: true, data: out } as { success: true; data: z.output<T> };
      }
      const r = isAsync ? await stockParseAsync(data) : stockParse(data);
      return r as { success: false; error: z.ZodError };
    },
    validate(data: unknown) {
      if (isAsync) throwSyncOnAsync();
      if (validator) return validator(data) !== INVALID ? data : null;
      if (cowFn) return cowFn(data) !== INVALID ? data : null;
      return (stockParse(data) as { success: boolean }).success ? data : null;
    },
  } satisfies Compiled<T>;
}
