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
import { INVALID, compileCowDebug, officialValidator, isAsyncProduct, type Fn } from "./cow4.js";
import { ZodCompileAsyncError, ZodCompileUnsupportedError, $ZodAsyncError } from "zod4/v4/core";

export interface Compiled<T extends z.ZodType> {
  readonly schema: T;
  /** true = CoW 编译未成功，parse/safeParse 全部直通 stock（语义无损） */
  readonly stock: boolean;
  /** true = 骨架含 async 子树：sync parse/safeParse/validate 抛 $ZodAsyncError，*Async 可用 */
  readonly async: boolean;
  /** CoW 骨架源码（stock 降级时为 null） */
  readonly code: string | null;
  parse(data: unknown): z.output<T>;
  safeParse(
    data: unknown,
  ): { success: true; data: z.output<T> } | { success: false; error: z.ZodError };
  parseAsync(data: unknown): Promise<z.output<T>>;
  safeParseAsync(
    data: unknown,
  ): Promise<{ success: true; data: z.output<T> } | { success: false; error: z.ZodError }>;
  /** 纯校验：通过返回输入原引用（DeepReadonly 提示共享），失败返回 null */
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
    // 递归 / schema catchall / __proto__ / 冷僻特性 → 整树 stock（语义无损降级）
    // （async 不再进入此分支：Task 6 起 async 子树走 async 岛 + await 骨架）
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
    // 官方 sync API 对 async schema 的同款语义（$ZodAsyncError）
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
