/**
 * zc-z4 public API — the engine is "zod4 official codegen + CoW container skeletons"
 * (tuple skeletons and async schemas supported since Task 6).
 *
 *   compile(schema, options?) returns (options: { ownSymbolKeys?: "probe" | "ignore" }, see cow4/options.ts):
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
import type { z } from "zod";
import {
  INVALID,
  type CompileOptions,
  compileCowDebug,
  officialValidator,
  isAsyncProduct,
  resolveOptions,
  type Fn,
} from "./cow4/index.js";
import { ZodCompileAsyncError, ZodCompileUnsupportedError, $ZodAsyncError } from "zod/v4/core";

export type { CompileOptions };

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

export function compile<T extends z.ZodType>(schema: T, options?: CompileOptions): Compiled<T> {
  const resolved = resolveOptions(options); // throws TypeError on an unknown value, before any codegen
  let cowFn: Fn | null = null;
  let code: string | null = null;
  try {
    const compiled = compileCowDebug(schema, resolved);
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
  type Ok = { success: true; data: z.output<T> };
  type Err = { success: false; error: z.ZodError };
  const ok = (out: unknown): Ok => ({ success: true, data: out as z.output<T> });

  const common = { schema, stock: cowFn === null, async: isAsync, code };

  if (cowFn === null) {
    // Whole-tree degradation: every entry is stock
    return {
      ...common,
      parse: (data) => unwrap(stockParse(data)),
      safeParse: (data) => stockParse(data) as Ok | Err,
      parseAsync: async (data) => unwrap(await stockParseAsync(data)),
      safeParseAsync: async (data) => (await stockParseAsync(data)) as Ok | Err,
      validate: (data) => (stockParse(data).success ? data : null),
    } satisfies Compiled<T>;
  }

  if (isAsync) {
    // Async skeleton: the sync API throws, as stock does; the async entries await the skeleton and fall back to stock
    const fast = cowFn;
    return {
      ...common,
      parse: throwSyncOnAsync,
      safeParse: throwSyncOnAsync,
      validate: throwSyncOnAsync,
      async parseAsync(data) {
        const out = await fast(data);
        if (out !== INVALID) return out as z.output<T>;
        return unwrap(await stockParseAsync(data));
      },
      async safeParseAsync(data) {
        const out = await fast(data);
        if (out !== INVALID) return ok(out);
        return (await stockParseAsync(data)) as Err;
      },
    } satisfies Compiled<T>;
  }

  // Sync skeleton, the common case: the methods hold nothing but the fast path and the stock
  // fallback, so a call is one skeleton call plus the result object (no async or degradation
  // checks per call; the per-record scenarios of bench-v4 see the difference)
  const fast = cowFn;
  const validateFast = validator ?? fast;
  return {
    ...common,
    parse(data) {
      const out = fast(data);
      if (out !== INVALID) return out as z.output<T>;
      return unwrap(stockParse(data));
    },
    safeParse(data) {
      const out = fast(data);
      if (out !== INVALID) return ok(out);
      return stockParse(data) as Err;
    },
    async parseAsync(data) {
      const out = fast(data);
      if (out !== INVALID) return out as z.output<T>;
      return unwrap(stockParse(data));
    },
    async safeParseAsync(data) {
      const out = fast(data);
      if (out !== INVALID) return ok(out);
      return stockParse(data) as Err;
    },
    validate(data) {
      return validateFast(data) !== INVALID ? data : null;
    },
  } satisfies Compiled<T>;
}
